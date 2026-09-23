/**
 * Success within the latency target, estimated by simulating requests with
 * timeouts enforced. Unlike eventual success (availability.ts), a request
 * only counts if it succeeds and answers within `objective.latencyMs`.
 */
import { compile } from './compile';
import type { Inputs } from './inputs';
import { type LatencySimulation, simulateLatency } from './sampler';
import type { Topology } from './topology';

/** A sampled proportion with its 95% Wilson score interval. */
export interface Estimate {
  value: number;
  low: number;
  high: number;
}

export type LatencyAnalysis =
  | {
      status: 'modeled';
      trials: number;
      targetMs?: number;
      /** Succeeded with timeouts enforced, at any latency. */
      succeeded: Estimate;
      /** Succeeded within the target; equals `succeeded` when there is no target. */
      withinTarget: Estimate;
      fullWithinTarget: Estimate;
      /** Latency percentiles of successful requests. */
      percentiles: { p50: number; p90: number; p99: number } | undefined;
    }
  | { status: 'missing'; nodes: string[] };

export interface LatencyOptions {
  trials?: number;
  seed?: number;
}

export function modelLatency(topology: Topology, inputs: Inputs, options: LatencyOptions = {}): LatencyAnalysis {
  const trials = options.trials ?? 100_000;
  const model = compile(topology, inputs);
  const missing = model.nodes.filter((n) => n.type === 'service' && !n.latency).map((n) => n.id);
  if (missing.length > 0) return { status: 'missing', nodes: missing };

  const targetMs = inputs.objective.latencyMs;
  return summarizeLatency([simulateLatency(model, trials, options.seed ?? 1, targetMs ?? Infinity)], targetMs);
}

/** Combines independent simulation runs (different seeds, same model and target). */
export function summarizeLatency(runs: LatencySimulation[], targetMs: number | undefined): LatencyAnalysis {
  const sum = (key: 'trials' | 'succeeded' | 'withinTarget' | 'fullWithinTarget') => runs.reduce((total, r) => total + r[key], 0);
  const trials = sum('trials');
  const latencies = new Float64Array(sum('succeeded'));
  let offset = 0;
  for (const run of runs) {
    latencies.set(run.successLatencies, offset);
    offset += run.successLatencies.length;
  }
  latencies.sort();
  const percentile = (q: number) => latencies[Math.min(latencies.length - 1, Math.ceil(q * latencies.length) - 1)]!;
  return {
    status: 'modeled',
    trials,
    targetMs,
    succeeded: wilson(sum('succeeded'), trials),
    withinTarget: wilson(sum('withinTarget'), trials),
    fullWithinTarget: wilson(sum('fullWithinTarget'), trials),
    percentiles: latencies.length > 0 ? { p50: percentile(0.5), p90: percentile(0.9), p99: percentile(0.99) } : undefined,
  };
}

/**
 * Napkin p99: add up p99s along the critical path, as if percentiles added
 * and a fan-out's slowest instance were a typical one. Ignores retries,
 * timeouts and failover. Undefined when latency inputs are missing.
 */
export function napkinLatencyP99(topology: Topology, inputs: Inputs): number | undefined {
  const memo = new Map<string, number | undefined>();
  const p99 = (id: string): number | undefined => {
    if (memo.has(id)) return memo.get(id);
    const node = topology.nodes.get(id)!;
    const calls = topology.out.get(id)!;
    let result: number | undefined;
    if (node.type === 'service') {
      const own = inputs.nodes.get(id)?.latency?.p99Ms;
      const stages = new Map<number, number | undefined>();
      for (const edge of calls) {
        const call = p99(edge.to);
        const current = stages.has(edge.stage) ? stages.get(edge.stage) : 0;
        stages.set(edge.stage, call === undefined || current === undefined ? undefined : Math.max(current, call));
      }
      result = [...stages.values()].reduce<number | undefined>((sum, s) => (sum === undefined || s === undefined ? undefined : sum + s), own);
    } else {
      // Napkin failover: the first member answers. Quorum: the require-th fastest.
      const members = calls.map((e) => p99(e.to));
      if (!members.includes(undefined)) {
        const sorted = (members as number[]).sort((a, b) => a - b);
        result = node.type === 'any' ? p99(calls[0]!.to) : sorted[node.require! - 1];
      }
    }
    memo.set(id, result);
    return result;
  };
  return p99(topology.entry);
}

export function wilson(successes: number, trials: number, z = 1.959963984540054): Estimate {
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  return { value: p, low: Math.max(0, center - half), high: Math.min(1, center + half) };
}
