import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { failureLevers, timeoutLosses } from '../src/model/attribution';
import { modelAvailability } from '../src/model/availability';
import { compile, failureModel } from '../src/model/compile';
import { parseInputs } from '../src/model/inputs';
import { simulateLatency } from '../src/model/sampler';
import { parseTopology } from '../src/model/topology';

function load(dot: string, yaml: string) {
  const topology = parseTopology(dot).value!;
  const inputs = parseInputs(yaml, topology).value!;
  return { topology, inputs, base: modelAvailability(topology, inputs) };
}
const PRECISION = 12;

describe('failureLevers', () => {
  it('in a chain, a perfect service recovers exactly its own failures', () => {
    const { topology, inputs, base } = load('digraph g { entry=a; a -> b -> c; }', 'nodes: { a: { availability: 0.999, transient: 0.5 }, b: { availability: 0.99, transient: 0.5 }, c: { availability: 0.95, transient: 0.5 } }');
    const levers = failureLevers(topology, inputs, base);
    expect(levers.map((l) => l.id)).toEqual(['c', 'b', 'a']);
    expect(levers[0]!.ifPerfect).toBeCloseTo(0.999 * 0.99 * (1 - 0.95), PRECISION);
  });

  it('shows that redundancy makes each region a weak lever and the shared dependency a strong one', () => {
    const { topology, inputs, base } = load(readFileSync('scenarios/multi_region.dot', 'utf8'), readFileSync('scenarios/multi_region.yaml', 'utf8'));
    const levers = Object.fromEntries(failureLevers(topology, inputs, base).map((l) => [l.id, l]));
    expect(levers.control_plane!.ifPerfect).toBeGreaterThan(100 * levers.app_us_east!.ifPerfect);
    // control_plane fails only by outage: removing outages is the whole lever, removing flakiness is nothing.
    expect(levers.control_plane!.ifNoOutages).toBeCloseTo(levers.control_plane!.ifPerfect, PRECISION);
    expect(levers.control_plane!.ifNoFlaky).toBeCloseTo(0, PRECISION);
  });

  it('splits a lever by failure mode', () => {
    const { topology, inputs, base } = load('digraph g { entry=a; a -> b [retries=2]; }', 'nodes: { a: { availability: 1, transient: 0 }, b: { availability: 0.99, transient: 0.6 } }');
    const [b] = failureLevers(topology, inputs, base);
    const { outage, transientFail } = failureModel(0.99, 0.6);
    // With retries, flaky failures cost little; the outages are the lever.
    expect(b!.ifNoFlaky).toBeCloseTo((1 - outage) - base.availability, PRECISION);
    expect(b!.ifNoOutages).toBeCloseTo(1 - transientFail ** 3 - base.availability, PRECISION);
    expect(b!.ifNoOutages).toBeGreaterThan(50 * b!.ifNoFlaky);
  });
});

describe('timeoutLosses', () => {
  it('blames the shard timeouts for the search scenario, and adds up to the total loss', () => {
    const { topology, inputs } = load(readFileSync('scenarios/search.dot', 'utf8'), readFileSync('scenarios/search.yaml', 'utf8'));
    const run = simulateLatency(compile(topology, inputs), 40_000, 5);
    const losses = timeoutLosses(topology, run);
    expect(losses[0]).toMatchObject({ from: 'search_api', to: 'shard' });
    const total = run.eventualSuccesses - run.successLatencies.length;
    const blamed = losses.reduce((sum, l) => sum + l.share.value * run.trials, 0);
    expect(blamed + run.unattributedLoss).toBeCloseTo(total, 6);
    expect(run.unattributedLoss).toBe(0);
  });

  it('blames the deepest call whose own timeout cut off a success', () => {
    // b's call to c always times out; a's call to b has a generous timeout, so only b -> c is to blame.
    const { topology, inputs } = load(
      'digraph g { entry=a; a -> b [timeout_ms=10000]; b -> c [timeout_ms=5]; }',
      `nodes:
  a: { availability: 1, transient: 0, latency: { p50_ms: 1, p99_ms: 1 } }
  b: { availability: 1, transient: 0, latency: { p50_ms: 1, p99_ms: 1 } }
  c: { availability: 1, transient: 0, latency: { p50_ms: 10, p99_ms: 10 } }`,
    );
    const run = simulateLatency(compile(topology, inputs), 1_000, 1);
    expect(timeoutLosses(topology, run).map((l) => [l.from, l.to, l.share.value])).toEqual([['b', 'c', 1]]);
  });

  it('never blames a soft call, whose timeout only degrades the answer', () => {
    const { topology, inputs } = load(
      'digraph g { entry=a; a -> b [dependency=soft, timeout_ms=5]; }',
      `nodes:
  a: { availability: 1, transient: 0, latency: { p50_ms: 1, p99_ms: 1 } }
  b: { availability: 1, transient: 0, latency: { p50_ms: 10, p99_ms: 10 } }`,
    );
    const run = simulateLatency(compile(topology, inputs), 1_000, 1);
    expect(timeoutLosses(topology, run)).toEqual([]);
    expect(run.successLatencies.length).toBe(1_000);
  });
});
