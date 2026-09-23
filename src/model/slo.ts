/**
 * Evaluates the objectives against a funnel of outcomes, where each step can
 * only lose requests:
 *
 *   1. succeed ignoring time: failures alone, exact from enumeration. Timeouts
 *      can only turn successes into failures, so this is an upper bound.
 *   2. succeed with timeouts enforced: the real availability. Equal to step 1
 *      when no timeout is configured; otherwise simulated.
 *   3. succeed within L ms: simulated.
 *
 * The availability objective is judged at step 2, the combined
 * `succeed_within` objective at step 3, and a latency objective on the
 * successful requests only (step 3 as a share of step 2).
 */
import type { AvailabilityResult } from './availability';
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
  | { kind: 'succeed_within'; ms: number; target: number; measure?: Measure; fullFidelity?: Measure; verdict: Verdict; reason?: string };

export type LatencyState =
  | { status: 'missing'; nodes: string[] }
  | { status: 'pending' }
  | { status: 'sampled'; trials: number; done: boolean; percentiles?: { p50: number; p90: number; p99: number } };

export interface Evaluation {
  /** Step 1: succeed ignoring time. */
  ignoringTime: Measure;
  fullIgnoringTime: Measure;
  /** Some reachable call has a timeout, so step 2 needs the simulation. */
  hasTimeouts: boolean;
  /** Step 2: succeed with timeouts enforced. Undefined until it can be known. */
  withTimeouts?: Measure;
  latency: LatencyState;
  objectives: ObjectiveResult[];
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
  const hasTimeouts = model.nodes.some((n) => n.edges.some((e) => Number.isFinite(e.timeoutMs)));

  const ignoringTime = enumerated(availability.availability, availability);
  const fullIgnoringTime = enumerated(availability.fullFidelity, availability);
  const run = missing.length === 0 ? simulation?.run : undefined;

  // Timeouts can only lose requests, so a sampled figure is capped by step 1.
  const capped = (successes: number, trials: number, cap: Measure): Measure => {
    const e = wilson(successes, trials);
    return { value: Math.min(e.value, cap.high), low: Math.min(e.low, cap.high), high: Math.min(e.high, cap.high), kind: 'sampled' };
  };

  let withTimeouts: Measure | undefined;
  if (!hasTimeouts) withTimeouts = ignoringTime;
  else if (run) withTimeouts = capped(run.successLatencies.length, run.trials, ignoringTime);

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
      const measure = capped(countAtMost(run.successLatencies, ms), run.trials, withTimeouts ?? ignoringTime);
      const fullFidelity = capped(countAtMost(run.fullSuccessLatencies, ms), run.trials, fullIgnoringTime);
      objectives.push({ kind: 'succeed_within', ms, target, measure, fullFidelity, verdict: verdict(measure, target) });
    }
  }

  return { ignoringTime, fullIgnoringTime, hasTimeouts, withTimeouts, latency, objectives };
}

function enumerated(value: number, result: AvailabilityResult): Measure {
  return { value, low: value, high: Math.min(1, value + result.truncation), kind: result.exhaustive ? 'exact' : 'bounded' };
}

function verdict(measure: Measure, target: number): Verdict {
  if (measure.low >= target) return 'met';
  if (measure.high < target) return 'missed';
  return 'unclear';
}
