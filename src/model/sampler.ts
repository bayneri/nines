/**
 * Monte Carlo request simulator, following the model's semantics literally.
 *
 * Without timing it estimates eventual success and shares no evaluation logic
 * with the exact engine, so agreement between the two is evidence both are
 * right. With timing it also samples latency and enforces timeouts:
 *
 * - A service attempt takes its own latency, then runs its calls stage by
 *   stage: calls in a stage run in parallel and the stage lasts as long as
 *   its slowest call. A hard failure ends the attempt after that stage.
 * - A failed attempt (outage or transient) costs the node's own latency.
 * - An attempt slower than the edge's `timeout_ms` fails and costs the
 *   timeout. Retries run one after another.
 * - Fan-out instances run in parallel; the caller waits for all of them.
 * - `type=any` fails over in order, so failed members' time adds up.
 *   `type=quorum` calls members in parallel and answers when the
 *   `require`-th success arrives.
 */
import { type CompiledEdge, type CompiledModel, type CompiledNode, compile } from './compile';
import type { Inputs } from './inputs';
import { seededRandom } from './probability';
import type { Topology } from './topology';

export interface SampledAvailability {
  availability: number;
  fullFidelity: number;
  trials: number;
}

export interface LatencySimulation {
  trials: number;
  /** Requests that succeeded with timeouts enforced, at any latency. */
  succeeded: number;
  /** Requests that succeeded within the target (all successes when no target). */
  withinTarget: number;
  /** Requests that succeeded in full fidelity within the target. */
  fullWithinTarget: number;
  /** Latency of each successful request, sorted ascending. */
  successLatencies: Float64Array;
}

interface Outcome {
  ok: boolean;
  full: boolean;
  ms: number;
}

export function sampleAvailability(topology: Topology, inputs: Inputs, trials: number, seed = 1): SampledAvailability {
  const run = simulate(compile(topology, inputs), trials, seed, false);
  return { availability: run.succeeded / trials, fullFidelity: run.fullWithinTarget / trials, trials };
}

/** Requires latency inputs on every reachable service node. */
export function simulateLatency(model: CompiledModel, trials: number, seed: number, targetMs = Infinity): LatencySimulation {
  return simulate(model, trials, seed, true, targetMs);
}

function simulate(model: CompiledModel, trials: number, seed: number, timing: boolean, targetMs = Infinity): LatencySimulation {
  const random = seededRandom(seed);
  // Outage state per instance, sampled lazily once per request (trial).
  const sampledIn = new Int32Array(model.instanceCount).fill(-1);
  const isDown = new Uint8Array(model.instanceCount);
  let trial = 0;

  const inOutage = (node: CompiledNode, instance: number): boolean => {
    const id = node.offset + instance;
    if (sampledIn[id] !== trial) {
      sampledIn[id] = trial;
      isDown[id] = random() < node.outage ? 1 : 0;
    }
    return isDown[id] === 1;
  };

  const ownLatency = (node: CompiledNode): number => {
    if (!timing) return 0;
    const { mu, sigma } = node.latency!;
    // Box-Muller; 1 - random() is in (0, 1], so the log is finite.
    const z = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    return Math.exp(mu + sigma * z);
  };

  const attempt = (node: CompiledNode, instance: number): Outcome => {
    if (node.type === 'service') {
      let ms = ownLatency(node);
      if (inOutage(node, instance) || random() < node.transientFail) return { ok: false, full: false, ms };
      let full = true;
      for (const stage of node.stages) {
        let stageMs = 0;
        let hardFailed = false;
        for (const edge of stage) {
          const result = call(edge);
          if (result.ms > stageMs) stageMs = result.ms;
          if (!result.ok && edge.dependency === 'hard') hardFailed = true;
          full &&= result.full;
        }
        ms += stageMs;
        if (hardFailed) return { ok: false, full: false, ms };
      }
      return { ok: true, full, ms };
    }
    if (node.type === 'any') {
      let ms = 0;
      for (const edge of node.edges) {
        const result = call(edge);
        ms += result.ms;
        if (result.ok) return { ok: true, full: result.full, ms };
      }
      return { ok: false, full: false, ms };
    }
    const results = node.edges.map(call);
    const successTimes = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
    const ok = successTimes.length >= node.require;
    const full = results.filter((r) => r.full).length >= node.require;
    const ms = ok ? successTimes[node.require - 1]! : Math.max(0, ...results.map((r) => r.ms));
    return { ok, full, ms };
  };

  const callInstance = (edge: CompiledEdge, instance: number): Outcome => {
    const target = model.nodes[edge.target]!;
    let ms = 0;
    for (let i = 0; i <= edge.retries; i++) {
      const result = attempt(target, instance);
      if (timing && result.ms > edge.timeoutMs) {
        ms += edge.timeoutMs;
        continue;
      }
      ms += result.ms;
      if (result.ok) return { ok: true, full: result.full, ms };
    }
    return { ok: false, full: false, ms };
  };

  const call = (edge: CompiledEdge): Outcome => {
    if (edge.fanout === 1) return callInstance(edge, 0);
    let ok = 0;
    let allFull = true;
    let ms = 0;
    for (let i = 0; i < edge.fanout; i++) {
      const result = callInstance(edge, i);
      if (result.ok) ok++;
      allFull &&= result.full;
      if (result.ms > ms) ms = result.ms;
    }
    return { ok: ok >= edge.fanoutRequire, full: allFull, ms };
  };

  const entry = model.nodes[model.entry]!;
  let succeeded = 0;
  let withinTarget = 0;
  let fullWithinTarget = 0;
  const latencies: number[] = [];
  for (trial = 0; trial < trials; trial++) {
    const result = attempt(entry, 0);
    if (!result.ok) continue;
    succeeded++;
    latencies.push(result.ms);
    if (result.ms <= targetMs) {
      withinTarget++;
      if (result.full) fullWithinTarget++;
    }
  }
  return { trials, succeeded, withinTarget, fullWithinTarget, successLatencies: Float64Array.from(latencies).sort() };
}
