/**
 * Evaluates the objectives against a funnel of outcomes, where each step can
 * only lose requests:
 *
 *   1. succeed ignoring time: failures alone, exact from enumeration. Timeouts
 *      can only turn successes into failures, so this is an upper bound.
 *   2. succeed with timeouts enforced: the real availability. Equal to step 1
 *      when no hard call has a timeout; otherwise step 1 minus the simulated
 *      loss to timeouts.
 *   3. succeed within L ms: simulated.
 *
 * The availability objective is judged at step 2, the combined
 * `succeed_within` objective at step 3, and a latency objective on the
 * successful requests only (step 3 as a share of step 2).
 */
import type { AvailabilityResult } from './availability';
import { type TimeoutLoss, timeoutLosses } from './attribution';
import { compile } from './compile';
import type { Inputs } from './inputs';
import { countAtMost, percentileOf, wilson } from './latency';
import type { LatencySimulation } from './sampler';
import type { Topology } from './topology';

/**
 * A probability with the range it is known to lie in: `exact` (range within
 * enumeration tolerance), `bounded` (enumeration stopped early) or `sampled`
 * (95% interval).
 */
export interface Measure {
  value: number;
  low: number;
  high: number;
  kind: 'exact' | 'bounded' | 'sampled';
}

export type Verdict = 'met' | 'missed' | 'unclear';

export type ObjectiveResult =
  | { kind: 'availability'; target: number; measure?: Measure; verdict: Verdict; reason?: string }
  | { kind: 'latency'; percentile: number; ms: number; measure?: Measure; observedMs?: number; verdict: Verdict; reason?: string }
  | {
      kind: 'succeed_within';
      ms: number;
      target: number;
      measure?: Measure;
      fullFidelity?: Measure;
      /** Of the requests that succeed, the share that answer within `ms`. */
      fastShare?: Measure;
      verdict: Verdict;
      reason?: string;
    };

export type LatencyState =
  | { status: 'missing'; nodes: string[] }
  | { status: 'pending' }
  | { status: 'sampled'; trials: number; done: boolean; percentiles?: { p50: number; p90: number; p99: number } };

export interface Evaluation {
  /** Step 1: succeed ignoring time. */
  ignoringTime: Measure;
  fullIgnoringTime: Measure;
  /** Some reachable hard call has a timeout, so step 2 needs the simulation. */
  hasTimeouts: boolean;
  /** Step 2: succeed with timeouts enforced. Undefined until it can be known. */
  withTimeouts?: Measure;
  latency: LatencyState;
  objectives: ObjectiveResult[];
  /** Requests lost to each call's timeouts, largest first; empty until simulated. */
  timeoutLosses: TimeoutLoss[];
}

export interface SimulationInput {
  run: LatencySimulation;
  done: boolean;
}

export function evaluateObjectives(
  topology: Topology,
  inputs: Inputs,
  availability: AvailabilityResult,
  simulation?: SimulationInput,
): Evaluation {
  const model = compile(topology, inputs);
  const missing = model.nodes.filter((n) => n.type === 'service' && !n.latency).map((n) => n.id);
  // A soft call that times out only degrades the answer, so only hard calls
  // (group members included) can turn a timeout into a failure.
  const hasTimeouts = model.nodes.some((n) => n.edges.some((e) => e.dependency === 'hard' && Number.isFinite(e.timeoutMs)));

  const ignoringTime = enumerated(availability.availability, availability);
  const fullIgnoringTime = enumerated(availability.fullFidelity, availability);
  const run = missing.length === 0 ? simulation?.run : undefined;

  // The simulation follows every request with and without timeouts, coupled,
  // so it measures what time costs: requests that succeed ignoring time but
  // not with it. Subtracting that loss from the exact figure is much less
  // noisy than sampling success directly, and can't exceed the exact ceiling.
  const lessLoss = (base: Measure, losses: number, trials: number): Measure => {
    const loss = wilson(Math.max(0, losses), trials);
    return { value: base.value - loss.value, low: Math.max(0, base.low - loss.high), high: base.high - loss.low, kind: 'sampled' };
  };

  let withTimeouts: Measure | undefined;
  if (!hasTimeouts) withTimeouts = ignoringTime;
  else if (run) withTimeouts = lessLoss(ignoringTime, run.eventualSuccesses - run.successLatencies.length, run.trials);

  const latency: LatencyState =
    missing.length > 0
      ? { status: 'missing', nodes: missing }
      : !run
        ? { status: 'pending' }
        : {
            status: 'sampled',
            trials: run.trials,
            done: simulation!.done,
            percentiles:
              run.successLatencies.length > 0
                ? {
                    p50: percentileOf(run.successLatencies, 0.5)!,
                    p90: percentileOf(run.successLatencies, 0.9)!,
                    p99: percentileOf(run.successLatencies, 0.99)!,
                  }
                : undefined,
          };
  const unavailable = missing.length > 0 ? `add latency to ${missing.join(', ')} to model it` : 'simulating';

  const objectives: ObjectiveResult[] = [];
  const { availability: availabilityTarget, latency: latencyTargets, succeedWithin } = inputs.objectives;

  if (availabilityTarget !== undefined) {
    if (withTimeouts) {
      objectives.push({ kind: 'availability', target: availabilityTarget, measure: withTimeouts, verdict: verdict(withTimeouts, availabilityTarget) });
    } else {
      // Unknown with timeouts, but it can't exceed the ceiling.
      const missed = ignoringTime.high < availabilityTarget;
      objectives.push({
        kind: 'availability',
        target: availabilityTarget,
        verdict: missed ? 'missed' : 'unclear',
        reason: missed ? 'even ignoring timeouts' : `timeouts are configured; ${unavailable}`,
      });
    }
  }

  for (const { percentile, ms } of latencyTargets) {
    if (!run || run.successLatencies.length === 0) {
      objectives.push({ kind: 'latency', percentile, ms, verdict: 'unclear', reason: run ? 'no request succeeded' : unavailable });
      continue;
    }
    // "pNN <= ms" holds exactly when at least NN% of successful requests take <= ms.
    const e = wilson(countAtMost(run.successLatencies, ms), run.successLatencies.length);
    const measure: Measure = { ...e, kind: 'sampled' };
    objectives.push({ kind: 'latency', percentile, ms, measure, observedMs: percentileOf(run.successLatencies, percentile), verdict: verdict(measure, percentile) });
  }

  if (succeedWithin) {
    const { ms, target } = succeedWithin;
    if (!run) {
      objectives.push({ kind: 'succeed_within', ms, target, verdict: 'unclear', reason: unavailable });
    } else {
      const measure = lessLoss(ignoringTime, run.eventualSuccesses - countAtMost(run.successLatencies, ms), run.trials);
      // Full fidelity isn't monotone across the coupled worlds (failover can pick
      // a degraded member in one and a complete one in the other), so it is
      // sampled directly.
      const fullFidelity: Measure = { ...wilson(countAtMost(run.fullSuccessLatencies, ms), run.trials), kind: 'sampled' };
      const fastShare: Measure | undefined =
        run.successLatencies.length > 0 ? { ...wilson(countAtMost(run.successLatencies, ms), run.successLatencies.length), kind: 'sampled' } : undefined;
      objectives.push({ kind: 'succeed_within', ms, target, measure, fullFidelity, fastShare, verdict: verdict(measure, target) });
    }
  }

  return { ignoringTime, fullIgnoringTime, hasTimeouts, withTimeouts, latency, objectives, timeoutLosses: run ? timeoutLosses(topology, run) : [] };
}

function enumerated(value: number, result: AvailabilityResult): Measure {
  return { value, low: value, high: Math.min(1, value + result.truncation), kind: result.exhaustive ? 'exact' : 'bounded' };
}

function verdict(measure: Measure, target: number): Verdict {
  if (measure.low >= target) return 'met';
  if (measure.high < target) return 'missed';
  return 'unclear';
}
