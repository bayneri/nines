/**
 * Exact modeled availability.
 *
 * The random inputs of one request are an outage bit per instance (fixed for
 * the whole request) and a transient coin per attempt. Given the outage
 * bits, every call is a function of its own attempts' coins, and two
 * different calls never share a coin, so all calls are independent. The
 * request's success probability for a fixed outage state is therefore exact
 * from one walk of the graph, and modeled availability is the sum over outage
 * states weighted by their probability.
 *
 * Instances within one class (see compile.ts) are interchangeable, so a state
 * is a count of down instances per class, each Binomial(size, outage).
 * States are enumerated by total outages until the remaining probability is
 * below `tolerance`; that remainder is reported as `truncation`, a bound on
 * the error. The enumerated sum is a lower bound: the true value lies in
 * [value, value + truncation].
 */
import { type CompiledEdge, type CompiledModel, type CompiledNode, compile } from './compile';
import type { Inputs } from './inputs';
import { atLeast, binomialAtLeast, binomialPmf } from './probability';
import type { Topology } from './topology';

export interface AvailabilityResult {
  /** P(the request succeeds). Degraded responses (a soft dependency failed) count as successes. */
  availability: number;
  /** P(the request succeeds with every call, soft ones included, answering in full). */
  fullFidelity: number;
  /** Probability of the outage states not enumerated; both figures are exact to within this. */
  truncation: number;
  statesEvaluated: number;
}

export interface ModelOptions {
  /** Stop enumerating outage states once the rest have at most this probability. */
  tolerance?: number;
  /** Hard cap on outage states evaluated. */
  maxStates?: number;
}

/** Deepest number of simultaneous outages ever enumerated. */
const MAX_DEPTH = 64;

export function modelAvailability(topology: Topology, inputs: Inputs, options: ModelOptions = {}): AvailabilityResult {
  return evaluate(compile(topology, inputs), options);
}

/**
 * Napkin math assumes every failure is independent: a shared dependency is
 * counted once per caller and a retry is a fresh roll of the whole subtree.
 * That is exactly this model with every failure transient.
 */
export function napkinAvailability(topology: Topology, inputs: Inputs): number {
  const nodes = new Map([...inputs.nodes].map(([id, node]) => [id, { ...node, transient: 1 }]));
  return modelAvailability(topology, { ...inputs, nodes }).availability;
}

interface OutageVariable {
  classId: number;
  size: number;
  /** P(exactly j instances of the class are down), j = 0..min(size, MAX_DEPTH). */
  pmf: number[];
}

export function evaluate(model: CompiledModel, options: ModelOptions = {}): AvailabilityResult {
  const tolerance = options.tolerance ?? 1e-9;
  const maxStates = options.maxStates ?? 1_000_000;
  const { nodes } = model;

  // Down instances per class in the current state.
  const down = new Int32Array(model.classCount);
  // Per node: one attempt's (success, full-fidelity success) probabilities for
  // an instance that isn't down, valid while stamp === epoch.
  const memoS = new Float64Array(nodes.length);
  const memoF = new Float64Array(nodes.length);
  const stamp = new Int32Array(nodes.length);
  let epoch = 0;

  // Result registers for call(), to avoid allocating per call.
  let callS = 0;
  let callF = 0;

  const attempt = (index: number): void => {
    if (stamp[index] === epoch) return;
    const node = nodes[index]!;
    let s: number;
    let f: number;
    if (node.type === 'service') {
      s = 1 - node.transientFail;
      f = s;
      for (const edge of node.edges) {
        call(edge);
        if (edge.dependency === 'hard') s *= callS;
        f *= callF;
      }
    } else {
      const memberS: number[] = [];
      const memberF: number[] = [];
      for (const edge of node.edges) {
        call(edge);
        memberS.push(callS);
        memberF.push(callF);
      }
      if (node.type === 'any') {
        // Failover in declaration order: the first member that succeeds answers.
        let allFailed = 1;
        f = 0;
        for (let m = 0; m < memberS.length; m++) {
          f += allFailed * memberF[m]!;
          allFailed *= 1 - memberS[m]!;
        }
        s = 1 - allFailed;
      } else {
        s = atLeast(memberS, node.require);
        f = atLeast(memberF, node.require);
      }
    }
    memoS[index] = s;
    memoF[index] = f;
    stamp[index] = epoch;
  };

  /** Sets callS/callF for one call over `edge`, retries and fan-out included. */
  const call = (edge: CompiledEdge): void => {
    const target = nodes[edge.target]!;
    attempt(edge.target);
    // Attempts are independent given the outage state; stop at the first success.
    const s = memoS[edge.target]!;
    const f = memoF[edge.target]!;
    const perInstanceS = 1 - (1 - s) ** (edge.retries + 1);
    const perInstanceF = s > 0 ? (f * perInstanceS) / s : 0;

    let downCalled = 0;
    for (let c = 0; c < edge.classesCovered; c++) downCalled += down[target.classOffset + c]!;
    if (edge.fanout === 1) {
      callS = downCalled > 0 ? 0 : perInstanceS;
      callF = downCalled > 0 ? 0 : perInstanceF;
    } else {
      // Instances that aren't down are identical and independent given the state.
      callS = binomialAtLeast(edge.fanout - downCalled, perInstanceS, edge.fanoutRequire);
      // Partial results are successes but not full fidelity.
      callF = downCalled > 0 ? 0 : perInstanceF ** edge.fanout;
    }
  };

  const entryCall: CompiledEdge = { target: model.entry, dependency: 'hard', fanout: 1, fanoutRequire: 1, retries: 0, classesCovered: 1 };

  const variables = outageVariables(nodes);
  const totalOutages = convolve(variables.map((v) => v.pmf));
  const statesAtTotal = convolve(variables.map((v) => new Array<number>(Math.min(v.size, MAX_DEPTH) + 1).fill(1)));

  // Deepest total number of simultaneous outages to enumerate.
  let depth = 0;
  let covered = totalOutages[0]!;
  let planned = 1;
  while (1 - covered > tolerance && depth + 1 < totalOutages.length) {
    const next = statesAtTotal[depth + 1]!;
    if (planned + next > maxStates) break;
    planned += next;
    depth++;
    covered += totalOutages[depth]!;
  }

  let availability = 0;
  let fullFidelity = 0;
  let statesEvaluated = 0;
  const visit = (v: number, budget: number, weight: number): void => {
    if (v === variables.length) {
      epoch++;
      call(entryCall);
      availability += weight * callS;
      fullFidelity += weight * callF;
      statesEvaluated++;
      return;
    }
    const variable = variables[v]!;
    const most = Math.min(budget, variable.pmf.length - 1);
    for (let j = 0; j <= most; j++) {
      down[variable.classId] = j;
      visit(v + 1, budget - j, weight * variable.pmf[j]!);
    }
    down[variable.classId] = 0;
  };
  visit(0, depth, 1);

  return { availability, fullFidelity, truncation: Math.max(0, 1 - covered), statesEvaluated };
}

function outageVariables(nodes: CompiledNode[]): OutageVariable[] {
  const variables: OutageVariable[] = [];
  for (const node of nodes) {
    if (node.outage <= 0) continue;
    node.classSizes.forEach((size, c) => {
      variables.push({ classId: node.classOffset + c, size, pmf: binomialPmf(size, node.outage, MAX_DEPTH) });
    });
  }
  return variables;
}

/** Convolution of non-negative sequences, truncated to MAX_DEPTH + 1 terms. */
function convolve(sequences: number[][]): number[] {
  let result = [1];
  for (const sequence of sequences) {
    const next = new Array<number>(Math.min(result.length + sequence.length - 1, MAX_DEPTH + 1)).fill(0);
    for (let i = 0; i < result.length; i++) {
      for (let j = 0; j < sequence.length && i + j < next.length; j++) next[i + j]! += result[i]! * sequence[j]!;
    }
    result = next;
  }
  return result;
}
