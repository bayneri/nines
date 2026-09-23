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
 *
 * Each request is followed in two coupled worlds: with timeouts enforced, and
 * ignoring time. Both see the same outages and the same attempts; they only
 * part ways when a slow attempt that would have succeeded times out. So a
 * request that succeeds with timeouts also succeeds ignoring time, and the
 * difference between the two counts estimates what timeouts cost, which is
 * far less noisy than estimating success with timeouts on its own.
 *
 * The same coupling says which calls' timeouts cost each lost request.
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
  /** Latency of each request that succeeded (timeouts enforced), sorted ascending. */
  successLatencies: Float64Array;
  /** Latency of each request that succeeded in full fidelity, sorted ascending. */
  fullSuccessLatencies: Float64Array;
  /** Requests that succeeded in the coupled world that ignores time. */
  eventualSuccesses: number;
  eventualFullSuccesses: number;
  /**
   * Requests lost to timeouts, blamed per call (indexed like topology.edges).
   * A lost request is split evenly between the hard calls that failed only
   * because their own timeout cut off an attempt that was going to succeed.
   * Sums to the timeout loss, less `unattributedLoss`.
   */
  timeoutBlame: Float64Array;
  unattributedLoss: number;
}

/** A call's outcome with timeouts enforced (ok, full, ms) and ignoring time (ok0, full0). */
interface Outcome {
  ok: boolean;
  full: boolean;
  ms: number;
  ok0: boolean;
  full0: boolean;
}

export function sampleAvailability(topology: Topology, inputs: Inputs, trials: number, seed = 1): SampledAvailability {
  const run = simulate(compile(topology, inputs), trials, seed, false);
  return { availability: run.eventualSuccesses / trials, fullFidelity: run.eventualFullSuccesses / trials, trials };
}

/** Requires latency inputs on every reachable service node. */
export function simulateLatency(model: CompiledModel, trials: number, seed: number): LatencySimulation {
  return simulate(model, trials, seed, true);
}

function simulate(model: CompiledModel, trials: number, seed: number, timing: boolean): LatencySimulation {
  const random = seededRandom(seed);
  // Outage state per instance, sampled lazily once per request (trial).
  const sampledIn = new Int32Array(model.instanceCount).fill(-1);
  const isDown = new Uint8Array(model.instanceCount);
  let trial = 0;
  // Calls lost to their own timeout in the current trial.
  const lostCalls: number[] = [];
  const lostIn = new Int32Array(model.edgeCount).fill(-1);

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

  const failed = (ms: number): Outcome => ({ ok: false, full: false, ms, ok0: false, full0: false });

  const attempt = (node: CompiledNode, instance: number): Outcome => {
    if (node.type === 'service') {
      let ms = ownLatency(node);
      if (inOutage(node, instance) || random() < node.transientFail) return failed(ms);
      let alive = true;
      let alive0 = true;
      let full = true;
      let full0 = true;
      for (const stage of node.stages) {
        if (!alive && !alive0) break;
        // The timed world stops after the stage where a hard call failed, so it
        // only waits for stages it was still running; the untimed world goes on.
        const timedRunning = alive;
        let stageMs = 0;
        for (const edge of stage) {
          const r = call(edge);
          if (r.ms > stageMs) stageMs = r.ms;
          if (edge.dependency === 'hard') {
            if (!r.ok) alive = false;
            if (!r.ok0) alive0 = false;
          }
          full &&= r.full;
          full0 &&= r.full0;
        }
        if (timedRunning) ms += stageMs;
      }
      return { ok: alive, full: alive && full, ms, ok0: alive0, full0: alive0 && full0 };
    }
    if (node.type === 'any') {
      let ms = 0;
      let result: Outcome | undefined;
      let result0: Outcome | undefined;
      for (const edge of node.edges) {
        if (result && result0) break;
        const r = call(edge);
        if (!result) {
          ms += r.ms;
          if (r.ok) result = r;
        }
        if (!result0 && r.ok0) result0 = r;
      }
      return { ok: !!result, full: !!result?.full, ms, ok0: !!result0, full0: !!result0?.full0 };
    }
    const results = node.edges.map(call);
    const count = (pick: (r: Outcome) => boolean) => results.filter(pick).length;
    const successTimes = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
    const ok = successTimes.length >= node.require;
    const ms = ok ? successTimes[node.require - 1]! : Math.max(0, ...results.map((r) => r.ms));
    return {
      ok,
      full: count((r) => r.full) >= node.require,
      ms,
      ok0: count((r) => r.ok0) >= node.require,
      full0: count((r) => r.full0) >= node.require,
    };
  };

  const callInstance = (edge: CompiledEdge, instance: number): Outcome => {
    const target = model.nodes[edge.target]!;
    let ms = 0;
    let result: Outcome | undefined;
    let result0: Outcome | undefined;
    let cutOff = false;
    for (let i = 0; i <= edge.retries && !(result && result0); i++) {
      const r = attempt(target, instance);
      if (!result) {
        if (timing && r.ms > edge.timeoutMs) {
          ms += edge.timeoutMs;
          // This attempt was going to succeed; the timeout cost it.
          if (r.ok) cutOff = true;
        } else {
          ms += r.ms;
          if (r.ok) result = r;
        }
      }
      if (!result0 && r.ok0) result0 = r;
    }
    // Lost to its own timeout (deeper losses are blamed on the deeper call).
    if (!result && result0 && cutOff && edge.dependency === 'hard' && lostIn[edge.index] !== trial) {
      lostIn[edge.index] = trial;
      lostCalls.push(edge.index);
    }
    return { ok: !!result, full: !!result?.full, ms, ok0: !!result0, full0: !!result0?.full0 };
  };

  const call = (edge: CompiledEdge): Outcome => {
    if (edge.fanout === 1) return callInstance(edge, 0);
    let ok = 0;
    let ok0 = 0;
    let full = true;
    let full0 = true;
    let ms = 0;
    for (let i = 0; i < edge.fanout; i++) {
      const r = callInstance(edge, i);
      if (r.ok) ok++;
      if (r.ok0) ok0++;
      full &&= r.full;
      full0 &&= r.full0;
      if (r.ms > ms) ms = r.ms;
    }
    return { ok: ok >= edge.fanoutRequire, full, ms, ok0: ok0 >= edge.fanoutRequire, full0 };
  };

  const entry = model.nodes[model.entry]!;
  const latencies: number[] = [];
  const fullLatencies: number[] = [];
  let eventualSuccesses = 0;
  let eventualFullSuccesses = 0;
  const timeoutBlame = new Float64Array(model.edgeCount);
  let unattributedLoss = 0;
  for (trial = 0; trial < trials; trial++) {
    lostCalls.length = 0;
    const r = attempt(entry, 0);
    if (r.ok0 && !r.ok) {
      if (lostCalls.length === 0) unattributedLoss++;
      for (const edge of lostCalls) timeoutBlame[edge]! += 1 / lostCalls.length;
    }
    if (r.ok0) eventualSuccesses++;
    if (r.full0) eventualFullSuccesses++;
    if (!r.ok) continue;
    latencies.push(r.ms);
    if (r.full) fullLatencies.push(r.ms);
  }
  return {
    trials,
    successLatencies: Float64Array.from(latencies).sort(),
    fullSuccessLatencies: Float64Array.from(fullLatencies).sort(),
    eventualSuccesses,
    eventualFullSuccesses,
    timeoutBlame,
    unattributedLoss,
  };
}
