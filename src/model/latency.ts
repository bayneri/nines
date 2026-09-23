/** Helpers for simulated latency results, and napkin latency math for contrast. */
import type { Inputs } from './inputs';
import type { LatencySimulation } from './sampler';
import type { Topology } from './topology';

/** A sampled proportion with its 95% Wilson score interval. */
export interface Estimate {
  value: number;
  low: number;
  high: number;
}

/** Merges independent simulation runs (different seeds, same model). */
export function combineRuns(runs: LatencySimulation[]): LatencySimulation {
  const merge = (key: 'successLatencies' | 'fullSuccessLatencies') => {
    const merged = new Float64Array(runs.reduce((n, r) => n + r[key].length, 0));
    let offset = 0;
    for (const run of runs) {
      merged.set(run[key], offset);
      offset += run[key].length;
    }
    return merged.sort();
  };
  const sum = (key: 'trials' | 'eventualSuccesses' | 'eventualFullSuccesses' | 'unattributedLoss') => runs.reduce((n, r) => n + r[key], 0);
  const timeoutBlame = new Float64Array(runs[0]?.timeoutBlame.length ?? 0);
  for (const run of runs) run.timeoutBlame.forEach((v, i) => (timeoutBlame[i]! += v));
  return {
    trials: sum('trials'),
    successLatencies: merge('successLatencies'),
    fullSuccessLatencies: merge('fullSuccessLatencies'),
    eventualSuccesses: sum('eventualSuccesses'),
    eventualFullSuccesses: sum('eventualFullSuccesses'),
    timeoutBlame,
    unattributedLoss: sum('unattributedLoss'),
  };
}

/** Number of values <= ms in an ascending array. */
export function countAtMost(sorted: Float64Array, ms: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Nearest-rank percentile of an ascending array; q in (0, 1]. */
export function percentileOf(sorted: Float64Array, q: number): number | undefined {
  if (sorted.length === 0) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
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
