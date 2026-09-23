/**
 * Monte Carlo reference: simulates requests one by one, literally following
 * the model's semantics. It shares no evaluation logic with the exact engine,
 * so agreement between the two is evidence both are right.
 */
import { type CompiledEdge, type CompiledNode, compile } from './compile';
import type { Inputs } from './inputs';
import { seededRandom } from './probability';
import type { Topology } from './topology';

export interface SampledAvailability {
  availability: number;
  fullFidelity: number;
  trials: number;
}

interface Outcome {
  ok: boolean;
  full: boolean;
}

const FAILED: Outcome = { ok: false, full: false };

export function sampleAvailability(topology: Topology, inputs: Inputs, trials: number, seed = 1): SampledAvailability {
  const model = compile(topology, inputs);
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

  const attempt = (node: CompiledNode, instance: number): Outcome => {
    if (node.type === 'service') {
      if (inOutage(node, instance) || random() < node.transientFail) return FAILED;
      let full = true;
      for (const edge of node.edges) {
        const result = call(edge);
        if (!result.ok && edge.dependency === 'hard') return FAILED;
        full &&= result.full;
      }
      return { ok: true, full };
    }
    if (node.type === 'any') {
      for (const edge of node.edges) {
        const result = call(edge);
        if (result.ok) return result;
      }
      return FAILED;
    }
    let ok = 0;
    let full = 0;
    for (const edge of node.edges) {
      const result = call(edge);
      if (result.ok) ok++;
      if (result.full) full++;
    }
    return { ok: ok >= node.require, full: full >= node.require };
  };

  const callInstance = (edge: CompiledEdge, instance: number): Outcome => {
    const target = model.nodes[edge.target]!;
    for (let i = 0; i <= edge.retries; i++) {
      const result = attempt(target, instance);
      if (result.ok) return result;
    }
    return FAILED;
  };

  const call = (edge: CompiledEdge): Outcome => {
    if (edge.fanout === 1) return callInstance(edge, 0);
    let ok = 0;
    let allFull = true;
    for (let i = 0; i < edge.fanout; i++) {
      const result = callInstance(edge, i);
      if (result.ok) ok++;
      allFull &&= result.full;
    }
    return { ok: ok >= edge.fanoutRequire, full: allFull };
  };

  const entry = model.nodes[model.entry]!;
  let ok = 0;
  let full = 0;
  for (trial = 0; trial < trials; trial++) {
    const result = attempt(entry, 0);
    if (result.ok) ok++;
    if (result.full) full++;
  }
  return { availability: ok / trials, fullFidelity: full / trials, trials };
}
