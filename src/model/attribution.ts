/**
 * Where requests are lost.
 *
 * Failures (exact): for each service, how much availability ignoring time
 * would recover if it never failed, if only its outages went away, or if
 * only its flaky failures did. These are what-ifs, not a split of the total:
 * with redundancy, two services can each recover little alone and a lot
 * together, so they need not add up.
 *
 * Timeouts (simulated): requests that succeed ignoring time but are lost to
 * timeouts, blamed on the calls whose own timeouts cost them. These do add
 * up to the total loss to timeouts.
 */
import { type AvailabilityResult, modelAvailability } from './availability';
import { compile, failureModel } from './compile';
import type { Inputs, NodeInputs } from './inputs';
import { wilson } from './latency';
import type { LatencySimulation } from './sampler';
import type { Measure } from './slo';
import type { Topology } from './topology';

export interface FailureLever {
  id: string;
  /** Availability gained if the service never failed. */
  ifPerfect: number;
  /** Gained if its outages went away but its flaky failures stayed. */
  ifNoOutages: number;
  /** Gained if its flaky failures went away but its outages stayed. */
  ifNoFlaky: number;
}

export interface TimeoutLoss {
  /** Index into topology.edges. */
  edge: number;
  from: string;
  to: string;
  /** Share of all requests lost to this call's timeouts. */
  share: Measure;
}

/** Exact what-ifs for every reachable service, largest first. */
export function failureLevers(topology: Topology, inputs: Inputs, base: AvailabilityResult): FailureLever[] {
  const reachable = compile(topology, inputs).nodes.filter((n) => n.type === 'service').map((n) => n.id);
  const gain = (id: string, replacement: NodeInputs) => {
    const nodes = new Map(inputs.nodes);
    nodes.set(id, { ...inputs.nodes.get(id)!, ...replacement });
    return Math.max(0, modelAvailability(topology, { ...inputs, nodes }).availability - base.availability);
  };
  return reachable
    .map((id) => {
      const own = inputs.nodes.get(id)!;
      const { outage, transientFail } = failureModel(own.availability, own.transient);
      return {
        id,
        ifPerfect: gain(id, { availability: 1, transient: 0 }),
        // Without outages, only the per-attempt flaky failures remain, and vice versa.
        ifNoOutages: gain(id, { availability: 1 - transientFail, transient: 1 }),
        ifNoFlaky: gain(id, { availability: 1 - outage, transient: 0 }),
      };
    })
    .filter((lever) => lever.ifPerfect > 1e-12)
    .sort((a, b) => b.ifPerfect - a.ifPerfect);
}

/** Simulated blame for timeout losses, largest first. */
export function timeoutLosses(topology: Topology, run: LatencySimulation): TimeoutLoss[] {
  const losses: TimeoutLoss[] = [];
  run.timeoutBlame.forEach((blame, edge) => {
    if (blame <= 0) return;
    const { from, to } = topology.edges[edge]!;
    // Blame can be fractional; the interval is for the rounded count.
    const e = wilson(Math.round(blame), run.trials);
    losses.push({ edge, from, to, share: { value: blame / run.trials, low: e.low, high: e.high, kind: 'sampled' } });
  });
  return losses.sort((a, b) => b.share.value - a.share.value);
}
