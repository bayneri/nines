import { describe, expect, it } from 'vitest';
import { compile, latencyModel } from '../src/model/compile';
import { modelAvailability } from '../src/model/availability';
import { type Inputs, parseInputs } from '../src/model/inputs';
import { modelLatency, napkinLatencyP99, wilson } from '../src/model/latency';
import { simulateLatency } from '../src/model/sampler';
import { type Topology, parseTopology } from '../src/model/topology';
import { randomModel } from './support/random-model';

type Spec = { a?: number; t?: number; ms: number | [number, number] };

/** Builds a model; `ms` is a constant latency or [p50, p99]. */
function model(dot: string, nodes: Record<string, Spec>, targetMs?: number): { topology: Topology; inputs: Inputs } {
  const topology = parseTopology(dot);
  expect(topology.diagnostics).toEqual([]);
  const lines = Object.entries(nodes).map(([id, { a = 1, t = 0.5, ms }]) => {
    const [p50, p99] = typeof ms === 'number' ? [ms, ms] : ms;
    return `  ${id}: { availability: ${a}, transient: ${t}, latency: { p50_ms: ${p50}, p99_ms: ${p99} } }`;
  });
  const objective = targetMs === undefined ? '' : `objective: { latency_ms: ${targetMs} }\n`;
  const inputs = parseInputs(`${objective}nodes:\n${lines.join('\n')}`, topology.value!);
  expect(inputs.diagnostics).toEqual([]);
  return { topology: topology.value!, inputs: inputs.value! };
}

const TRIALS = 50_000;
const run = (m: ReturnType<typeof model>, targetMs = Infinity) => simulateLatency(compile(m.topology, m.inputs), TRIALS, 7, targetMs);
const fraction = (count: number) => count / TRIALS;
/** Asserts a sampled proportion is within 4.5 standard errors of `p`. */
const expectProportion = (count: number, p: number) =>
  expect(Math.abs(fraction(count) - p)).toBeLessThanOrEqual(4.5 * Math.sqrt((p * (1 - p)) / TRIALS) + 1e-12);

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, error < 1.5e-7). */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(x) / Math.SQRT2));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}
const lognormalCdf = (ms: number, p50: number, p99: number) => {
  const { mu, sigma } = latencyModel(p50, p99);
  return normalCdf((Math.log(ms) - mu) / sigma);
};

describe('simulated latency', () => {
  it('samples a node at its stated p50 and p99', () => {
    const r = run(model('digraph g { entry=a; a; }', { a: { ms: [20, 200] } }));
    const at = (q: number) => r.successLatencies[Math.ceil(q * r.successLatencies.length) - 1]!;
    expect(at(0.5)).toBeGreaterThan(20 * 0.97);
    expect(at(0.5)).toBeLessThan(20 * 1.03);
    expect(at(0.99)).toBeGreaterThan(200 * 0.9);
    expect(at(0.99)).toBeLessThan(200 * 1.1);
  });

  it('runs a stage in parallel and stages in sequence', () => {
    const r = run(model('digraph g { entry=a; a -> b [stage=0]; a -> c [stage=0]; a -> d [stage=1]; }', {
      a: { ms: 5 }, b: { ms: 10 }, c: { ms: 20 }, d: { ms: 7 },
    }));
    expect(r.succeeded).toBe(TRIALS);
    expect(r.successLatencies[0]).toBeCloseTo(5 + 20 + 7, 9);
    expect(r.successLatencies[TRIALS - 1]).toBeCloseTo(5 + 20 + 7, 9);
  });

  it('stops after the stage where a hard dependency failed', () => {
    const r = run(model('digraph g { entry=a; a -> b [stage=0]; a -> c [stage=1]; }', {
      a: { ms: 5 }, b: { a: 0.5, t: 1, ms: 10 }, c: { ms: 1000 },
    }), 100);
    // Successes take 1015 ms, so none is within 100 ms; failures never wait for c.
    expectProportion(r.succeeded, 0.5);
    expect(r.withinTarget).toBe(0);
  });

  it('fails a hard dependency that exceeds its timeout', () => {
    const r = run(model('digraph g { entry=a; a -> b [timeout_ms=50]; }', { a: { ms: 1 }, b: { ms: 100 } }));
    expect(r.succeeded).toBe(0);
  });

  it('degrades on a soft timeout and charges the timeout', () => {
    const r = run(model('digraph g { entry=a; a -> b [dependency=soft, timeout_ms=50]; }', { a: { ms: 1 }, b: { ms: 100 } }), 60);
    expect(r.succeeded).toBe(TRIALS);
    expect(r.withinTarget).toBe(TRIALS);
    expect(r.fullWithinTarget).toBe(0);
    expect(r.successLatencies[0]).toBeCloseTo(51, 9);
  });

  it('waits in full for a soft dependency without a timeout', () => {
    const r = run(model('digraph g { entry=a; a -> b [dependency=soft]; }', { a: { ms: 1 }, b: { ms: 100 } }), 60);
    expect(r.succeeded).toBe(TRIALS);
    expect(r.withinTarget).toBe(0);
  });

  it('adds the time of failed attempts before a retry succeeds', () => {
    const r = run(model('digraph g { entry=a; a -> b [retries=2]; }', { a: { ms: 1 }, b: { a: 0.9, t: 1, ms: 10 } }), 15);
    const at = (ms: number) => r.successLatencies.filter((x) => Math.abs(x - ms) < 1e-9).length;
    expectProportion(at(11), 0.9);
    expectProportion(at(21), 0.09);
    expectProportion(at(31), 0.009);
    expectProportion(r.succeeded, 1 - 0.001);
    // Eventual success is 99.9%, but only first-attempt successes are within 15 ms.
    expectProportion(r.withinTarget, 0.9);
  });

  it('retries an attempt that timed out', () => {
    const p = lognormalCdf(60, 40, 200);
    const r = run(model('digraph g { entry=a; a -> b [timeout_ms=60, retries=1]; }', { a: { ms: 1 }, b: { ms: [40, 200] } }));
    expectProportion(r.succeeded, 1 - (1 - p) ** 2);
  });

  it('waits for the slowest fan-out instance', () => {
    const r = run(model('digraph g { entry=a; a -> s [fanout=10]; }', { a: { ms: 0.001 }, s: { ms: [20, 180] } }), 60);
    expectProportion(r.withinTarget, lognormalCdf(60 - 0.001, 20, 180) ** 10);
  });

  it('adds failed members\' time during failover', () => {
    const r = run(model('digraph g { entry=a; a -> g; g [type=any]; g -> x; g -> y; }', {
      a: { ms: 1 }, x: { a: 0.5, t: 0, ms: 10 }, y: { ms: 20 },
    }), 15);
    expectProportion(r.withinTarget, 0.5);
    expect(r.successLatencies[TRIALS - 1]).toBeCloseTo(1 + 10 + 20, 9);
  });

  it('answers a quorum when the require-th success arrives', () => {
    const r = run(model('digraph g { entry=a; a -> q; q [type=quorum, require=2]; q -> x; q -> y; q -> z; }', {
      a: { ms: 1 }, x: { ms: 10 }, y: { ms: 20 }, z: { ms: 30 },
    }));
    expect(r.successLatencies[0]).toBeCloseTo(21, 9);
    expect(r.successLatencies[TRIALS - 1]).toBeCloseTo(21, 9);
  });

  it.each(Array.from({ length: 10 }, (_, i) => i + 1))('without timeouts, success matches exact eventual success (random graph %i)', (seed) => {
    const { dot, yaml } = randomModel(seed, { latency: true });
    const topology = parseTopology(dot).value!;
    const inputs = parseInputs(yaml, topology).value!;
    const exact = modelAvailability(topology, inputs).availability;
    const r = simulateLatency(compile(topology, inputs), TRIALS, seed, Infinity);
    expectProportion(r.succeeded, exact);
  });
});

describe('modelLatency', () => {
  it('names the nodes missing latency inputs', () => {
    const topology = parseTopology('digraph g { entry=a; a -> b; a -> c; }').value!;
    const inputs = parseInputs('defaults: { availability: 0.99, transient: 0.5 }\nnodes:\n  b: { latency: { p50_ms: 1, p99_ms: 2 } }', topology).value!;
    expect(modelLatency(topology, inputs)).toEqual({ status: 'missing', nodes: ['a', 'c'] });
  });

  it('separates eventual success from success within the target', () => {
    const m = model('digraph g { entry=a; a -> b [retries=2]; }', { a: { ms: 1 }, b: { a: 0.9, t: 1, ms: 10 } }, 15);
    const result = modelLatency(m.topology, m.inputs, { trials: TRIALS });
    const eventual = modelAvailability(m.topology, m.inputs).availability;
    expect(eventual).toBeCloseTo(0.999, 12);
    expect(result.status).toBe('modeled');
    if (result.status !== 'modeled') return;
    expect(result.withinTarget.low).toBeLessThan(0.9);
    expect(result.withinTarget.high).toBeGreaterThan(0.9);
    expect(result.percentiles!.p50).toBeCloseTo(11, 9);
  });
});

describe('napkinLatencyP99', () => {
  it('adds p99s along the critical path and ignores fan-out', () => {
    const m = model('digraph g { entry=a; a -> b [stage=0]; a -> c [stage=0]; a -> s [stage=1, fanout=100]; }', {
      a: { ms: [5, 20] }, b: { ms: [10, 50] }, c: { ms: [10, 80] }, s: { ms: [20, 180] },
    });
    expect(napkinLatencyP99(m.topology, m.inputs)).toBe(20 + 80 + 180);
  });

  it('is undefined without latency inputs', () => {
    const topology = parseTopology('digraph g { entry=a; a -> b; }').value!;
    const inputs = parseInputs('defaults: { availability: 0.99, transient: 0.5 }', topology).value!;
    expect(napkinLatencyP99(topology, inputs)).toBeUndefined();
  });
});

describe('wilson', () => {
  it('stays inside [0, 1] and brackets the estimate', () => {
    expect(wilson(100, 100)).toMatchObject({ value: 1, high: 1 });
    expect(wilson(100, 100).low).toBeGreaterThan(0.96);
    const e = wilson(999, 1000);
    expect(e.low).toBeLessThan(0.999);
    expect(e.high).toBeGreaterThan(0.999);
  });
});
