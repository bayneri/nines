import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { modelAvailability } from '../src/model/availability';
import { compile } from '../src/model/compile';
import { parseInputs } from '../src/model/inputs';
import { simulateLatency } from '../src/model/sampler';
import { type ObjectiveResult, evaluateObjectives } from '../src/model/slo';
import { parseTopology } from '../src/model/topology';
import { toDot, toYaml } from '../src/doc';
import { wilson } from '../src/model/latency';
import { SCENARIOS } from '../src/scenarios';
import { randomModel } from './support/random-model';

function evaluate(dot: string, yaml: string, options: { simulate?: boolean } = { simulate: true }) {
  const topology = parseTopology(dot);
  expect(topology.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const inputs = parseInputs(yaml, topology.value!);
  expect(inputs.diagnostics).toEqual([]);
  const t = topology.value!;
  const i = inputs.value!;
  const availability = modelAvailability(t, i);
  const model = compile(t, i);
  // Like the worker: simulate only when every service has latency inputs.
  const canSimulate = model.nodes.every((n) => n.type !== 'service' || n.latency);
  const simulation = options.simulate && canSimulate ? { run: simulateLatency(model, 50_000, 3), done: true } : undefined;
  return evaluateObjectives(t, i, availability, simulation);
}
const find = <K extends ObjectiveResult['kind']>(objectives: ObjectiveResult[], kind: K) =>
  objectives.find((o) => o.kind === kind) as Extract<ObjectiveResult, { kind: K }>;

// b fails transiently 5% of the time, and each failed attempt costs 10 ms.
const RETRIES = 'digraph g { entry=a; a -> b [retries=3]; }';
const RETRY_NODES = `
  a: { availability: 1, transient: 0.5, latency: { p50_ms: 1, p99_ms: 1 } }
  b: { availability: 95%, transient: 1, latency: { p50_ms: 10, p99_ms: 10 } }`;

describe('evaluateObjectives', () => {
  it('meets availability and p99 separately while missing the combined promise', () => {
    const e = evaluate(RETRIES, `
objectives:
  availability: 99.99%
  latency: { p99_ms: 25 }
  succeed_within: { ms: 25, target: 99.9% }
nodes:${RETRY_NODES}`);
    // 1 - 0.05^4 of requests succeed; 99.75% of all requests within 2 attempts (21 ms).
    expect(e.ignoringTime.value).toBeCloseTo(1 - 0.05 ** 4, 12);
    expect(find(e.objectives, 'availability').verdict).toBe('met');
    expect(find(e.objectives, 'latency').verdict).toBe('met');
    expect(find(e.objectives, 'latency').observedMs).toBeCloseTo(21, 9);
    const combined = find(e.objectives, 'succeed_within');
    expect(combined.verdict).toBe('missed');
    expect(combined.measure!.value).toBeCloseTo(0.9975, 2);
  });

  it('judges a latency objective on successful requests only', () => {
    const e = evaluate('digraph g { entry=a; a -> b; }', `
objectives: { latency: { p99_ms: 20 } }
nodes:
  a: { availability: 1, transient: 0.5, latency: { p50_ms: 1, p99_ms: 1 } }
  b: { availability: 50%, transient: 1, latency: { p50_ms: 10, p99_ms: 10 } }`);
    // Half the requests fail, but every successful one takes 11 ms.
    expect(find(e.objectives, 'latency').verdict).toBe('met');
  });

  it('uses the exact figure for availability when no timeout can fire', () => {
    const e = evaluate(RETRIES, `objectives: { availability: 99.9% }\nnodes:${RETRY_NODES}`, { simulate: false });
    expect(e.hasTimeouts).toBe(false);
    expect(e.withTimeouts).toEqual(e.ignoringTime);
    expect(find(e.objectives, 'availability')).toMatchObject({ verdict: 'met', measure: { kind: 'exact' } });
  });

  it('judges availability after timeouts, which can only lose requests', () => {
    const dot = readFileSync('scenarios/search.dot', 'utf8');
    const yaml = readFileSync('scenarios/search.yaml', 'utf8');
    const e = evaluate(dot, yaml);
    expect(e.hasTimeouts).toBe(true);
    expect(e.ignoringTime.value).toBeGreaterThan(0.98);
    expect(e.withTimeouts!.kind).toBe('sampled');
    expect(e.withTimeouts!.value).toBeLessThan(0.86);
    expect(e.withTimeouts!.high).toBeLessThanOrEqual(e.ignoringTime.high);
  });

  it('caps a sampled figure at the exact ceiling', () => {
    // The timeout never fires, so the simulation estimates the ceiling itself, with noise.
    const e = evaluate('digraph g { entry=a; a -> b [timeout_ms=1000]; }', `
nodes:
  a: { availability: 1, transient: 0.5, latency: { p50_ms: 1, p99_ms: 1 } }
  b: { availability: 99.9%, transient: 0.5, latency: { p50_ms: 10, p99_ms: 10 } }`);
    expect(e.withTimeouts!.value).toBeLessThanOrEqual(e.ignoringTime.high);
    expect(e.withTimeouts!.high).toBeLessThanOrEqual(e.ignoringTime.high);
  });

  it('says why an objective cannot be judged, and still rules out an impossible one', () => {
    const dot = 'digraph g { entry=a; a -> b [timeout_ms=100]; }';
    const nodes = '\nnodes:\n  a: { availability: 1, transient: 0.5 }\n  b: { availability: 99%, transient: 0.5 }';
    const unclear = evaluate(dot, `objectives: { availability: 98%, latency: { p99_ms: 50 } }${nodes}`);
    expect(find(unclear.objectives, 'availability')).toMatchObject({ verdict: 'unclear', reason: 'timeouts are configured; add latency to a, b to model it' });
    expect(find(unclear.objectives, 'latency')).toMatchObject({ verdict: 'unclear', reason: 'add latency to a, b to model it' });
    expect(unclear.latency).toEqual({ status: 'missing', nodes: ['a', 'b'] });

    const missed = evaluate(dot, `objectives: { availability: 99.9% }${nodes}`);
    expect(find(missed.objectives, 'availability')).toMatchObject({ verdict: 'missed', reason: 'even ignoring timeouts' });
  });
});

describe('soft timeouts', () => {
  it('keep availability exact, because they only degrade the answer', () => {
    const e = evaluate('digraph g { entry=a; a -> b [dependency=soft, timeout_ms=5]; }', `
nodes:
  a: { availability: 99.9%, transient: 0.5, latency: { p50_ms: 1, p99_ms: 1 } }
  b: { availability: 99%, transient: 0.5, latency: { p50_ms: 10, p99_ms: 10 } }`);
    expect(e.hasTimeouts).toBe(false);
    expect(e.withTimeouts).toEqual(e.ignoringTime);
    expect(e.ignoringTime.value).toBeCloseTo(0.999, 12);
  });
});

describe('coupled timed and untimed simulation', () => {
  const run = (dot: string, yaml: string, trials: number, seed: number) => {
    const t = parseTopology(dot).value!;
    const i = parseInputs(yaml, t).value!;
    return { t, i, sim: simulateLatency(compile(t, i), trials, seed) };
  };

  it.each(Array.from({ length: 12 }, (_, k) => k + 1))('ignoring time, matches the exact engine even as timeouts fire (random graph %i)', (seed) => {
    const { dot, yaml } = randomModel(seed, { latency: true, timeouts: true });
    const { t, i, sim } = run(dot, yaml, 40_000, seed);
    const exact = modelAvailability(t, i).availability;
    const sigma = Math.sqrt((exact * (1 - exact)) / sim.trials);
    expect(Math.abs(sim.eventualSuccesses / sim.trials - exact), dot).toBeLessThan(4.5 * sigma + 1e-9);
    // Timeouts can only lose requests.
    expect(sim.successLatencies.length).toBeLessThanOrEqual(sim.eventualSuccesses);
  });

  it('narrows the interval when timeouts rarely cost anything', () => {
    const scenario = SCENARIOS.find((s) => s.id === 'multi_region')!;
    const e = evaluate(toDot(scenario.doc), toYaml(scenario.doc));
    const coupled = e.withTimeouts!;
    const direct = wilson(Math.round(coupled.value * 50_000), 50_000);
    expect(coupled.high - coupled.low).toBeLessThan((direct.high - direct.low) / 3);
    expect(coupled.high).toBeLessThanOrEqual(e.ignoringTime.high);
  });

  it('still reports large losses in full', () => {
    const e = evaluate(readFileSync('scenarios/search.dot', 'utf8'), readFileSync('scenarios/search.yaml', 'utf8'));
    expect(e.withTimeouts!.value).toBeGreaterThan(0.82);
    expect(e.withTimeouts!.value).toBeLessThan(0.85);
  });
});
