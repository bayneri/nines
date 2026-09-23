import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failureModel } from '../src/model/compile';
import { modelAvailability, napkinAvailability } from '../src/model/availability';
import { type Inputs, parseInputs } from '../src/model/inputs';
import { seededRandom } from '../src/model/probability';
import { sampleAvailability } from '../src/model/sampler';
import { type Topology, parseTopology } from '../src/model/topology';

/** Builds a topology and inputs from DOT plus `id: [availability, transient]` pairs. */
function model(dot: string, nodes: Record<string, [number, number]>): { topology: Topology; inputs: Inputs } {
  const topology = parseTopology(dot);
  expect(topology.diagnostics).toEqual([]);
  const yaml = 'nodes:\n' + Object.entries(nodes).map(([id, [a, t]]) => `  ${id}: { availability: ${a}, transient: ${t} }`).join('\n');
  const inputs = parseInputs(yaml, topology.value!);
  expect(inputs.diagnostics).toEqual([]);
  return { topology: topology.value!, inputs: inputs.value! };
}

const exact = (m: ReturnType<typeof model>) => modelAvailability(m.topology, m.inputs);
const napkin = (m: ReturnType<typeof model>) => napkinAvailability(m.topology, m.inputs);
const PRECISION = 12;

describe('failureModel', () => {
  it.each([0, 0.3, 1])('keeps single-attempt availability at a (transient=%s)', (t) => {
    const { outage, transientFail } = failureModel(0.99, t);
    expect(outage + (1 - outage) * transientFail).toBeCloseTo(0.01, 15);
  });
});

describe('modelAvailability, closed form', () => {
  it.each([0, 0.5, 1])('series chain multiplies, whatever the failure mix (transient=%s)', (t) => {
    const m = model('digraph g { entry=a; a -> b -> c; }', { a: [0.999, t], b: [0.99, t], c: [0.95, t] });
    const result = exact(m);
    expect(result.availability).toBeCloseTo(0.999 * 0.99 * 0.95, PRECISION);
    expect(result.fullFidelity).toBeCloseTo(result.availability, PRECISION);
    expect(result.truncation).toBeLessThanOrEqual(1e-9);
  });

  it('independent redundancy multiplies failure rates', () => {
    const m = model('digraph g { entry=a; a -> g; g [type=any]; g -> x; g -> y; }', { a: [0.9999, 0], x: [0.99, 0], y: [0.98, 0.5] });
    expect(exact(m).availability).toBeCloseTo(0.9999 * (1 - 0.01 * 0.02), PRECISION);
  });

  it('a shared outage-prone dependency caps redundancy; napkin math misses it', () => {
    const m = model(
      'digraph g { entry=fe; fe -> app; app [type=any]; app -> us; app -> eu; us -> cp; eu -> cp; }',
      { fe: [0.9999, 0.5], us: [0.999, 0.2], eu: [0.999, 0.2], cp: [0.9995, 0] },
    );
    // cp fails only by outage: it is either down for both regions or never fails.
    expect(exact(m).availability).toBeCloseTo(0.9999 * 0.9995 * (1 - 0.001 * 0.001), PRECISION);
    // Napkin: each region path independently includes cp.
    expect(napkin(m)).toBeCloseTo(0.9999 * (1 - (1 - 0.999 * 0.9995) ** 2), PRECISION);
  });

  it('a shared dependency with purely transient failures is as good as independent', () => {
    const m = model('digraph g { entry=a; a -> b; a -> c; b -> s; c -> s; }', { a: [1, 1], b: [1, 1], c: [1, 1], s: [0.99, 1] });
    expect(exact(m).availability).toBeCloseTo(0.99 ** 2, PRECISION);
  });

  it('fan-out raises availability to the power of N', () => {
    const m = model('digraph g { entry=a; a -> s [fanout=100]; }', { a: [1, 0.5], s: [0.9999, 0.5] });
    expect(exact(m).availability).toBeCloseTo(0.9999 ** 100, PRECISION);
  });

  it('partial fan-out is binomial and costs full fidelity', () => {
    const m = model('digraph g { entry=a; a -> s [fanout=10, fanout_require=9]; }', { a: [1, 0.5], s: [0.95, 0.5] });
    const result = exact(m);
    expect(result.availability).toBeCloseTo(0.95 ** 10 + 10 * 0.95 ** 9 * 0.05, PRECISION);
    expect(result.fullFidelity).toBeCloseTo(0.95 ** 10, PRECISION);
  });

  it('quorum 2 of 3 is 3a² - 2a³', () => {
    const m = model('digraph g { entry=a; a -> q; q [type=quorum, require=2]; q -> x; q -> y; q -> z; }', {
      a: [1, 0.5], x: [0.99, 0.5], y: [0.99, 0.5], z: [0.99, 0.5],
    });
    expect(exact(m).availability).toBeCloseTo(3 * 0.99 ** 2 - 2 * 0.99 ** 3, PRECISION);
  });

  it('quorum is full fidelity only if enough members answer in full', () => {
    const m = model('digraph g { entry=a; a -> q; q [type=quorum, require=2]; q -> x; q -> y; q -> z; x -> s [dependency=soft]; y -> s [dependency=soft]; z -> s [dependency=soft]; }', {
      a: [1, 0.5], x: [0.99, 0.5], y: [0.99, 0.5], z: [0.99, 0.5], s: [0.9, 1],
    });
    const full = 0.99 * 0.9;
    expect(exact(m).availability).toBeCloseTo(3 * 0.99 ** 2 - 2 * 0.99 ** 3, PRECISION);
    expect(exact(m).fullFidelity).toBeCloseTo(3 * full ** 2 - 2 * full ** 3, PRECISION);
  });

  describe('retries', () => {
    const retried = (t: number) => model('digraph g { entry=a; a -> b [retries=2]; }', { a: [1, 0.5], b: [0.99, t] });

    it('recover transient failures completely', () => {
      expect(exact(retried(1)).availability).toBeCloseTo(1 - 0.01 ** 3, PRECISION);
    });

    it('do nothing for outages', () => {
      expect(exact(retried(0)).availability).toBeCloseTo(0.99, PRECISION);
    });

    it('recover only the transient share of a mixed failure', () => {
      const { outage, transientFail } = failureModel(0.99, 0.6);
      expect(exact(retried(0.6)).availability).toBeCloseTo((1 - outage) * (1 - transientFail ** 3), PRECISION);
    });

    it('re-run the callee subtree but cannot outlast a downstream outage', () => {
      const m = model('digraph g { entry=c; c -> p [retries=3]; p -> l; }', { c: [0.9999, 0.5], p: [0.999, 0.9], l: [0.9995, 0] });
      const p = failureModel(0.999, 0.9);
      expect(exact(m).availability).toBeCloseTo(0.9999 * 0.9995 * (1 - p.outage) * (1 - p.transientFail ** 4), PRECISION);
      // Napkin re-rolls the whole subtree, ledger included.
      expect(napkin(m)).toBeCloseTo(0.9999 * (1 - (1 - 0.999 * 0.9995) ** 4), PRECISION);
    });
  });

  it('soft dependencies cost full fidelity, not availability', () => {
    const m = model('digraph g { entry=a; a -> h; a -> s [dependency=soft]; }', { a: [0.999, 0.5], h: [0.99, 0.5], s: [0.9, 0.5] });
    const result = exact(m);
    expect(result.availability).toBeCloseTo(0.999 * 0.99, PRECISION);
    expect(result.fullFidelity).toBeCloseTo(0.999 * 0.99 * 0.9, PRECISION);
  });

  it('a degraded soft dependency still answers, so failover does not happen', () => {
    // Member x succeeds degraded (its soft dep failed); the group uses it and doesn't fail over to y.
    const m = model('digraph g { entry=a; a -> g; g [type=any]; g -> x; g -> y; x -> s [dependency=soft]; }', {
      a: [1, 0.5], x: [0.9, 0.5], y: [0.8, 0.5], s: [0.5, 0.5],
    });
    const result = exact(m);
    expect(result.availability).toBeCloseTo(1 - 0.1 * 0.2, PRECISION);
    expect(result.fullFidelity).toBeCloseTo(0.9 * 0.5 + 0.1 * 0.8, PRECISION);
  });

  it('napkin math counts a shared dependency once per caller', () => {
    const m = model('digraph g { entry=a; a -> b; a -> c; b -> s; c -> s; }', { a: [0.999, 0.5], b: [0.999, 0.5], c: [0.999, 0.5], s: [0.99, 0] });
    expect(napkin(m)).toBeCloseTo(0.999 ** 3 * 0.99 ** 2, PRECISION);
    expect(exact(m).availability).toBeCloseTo(0.999 ** 3 * 0.99, PRECISION);
  });
});

/** P(Binomial(n, p) >= k), summed term by term, independent of the engine's helper. */
function binomialTail(n: number, p: number, k: number): number {
  let total = 0;
  for (let j = k; j <= n; j++) {
    let choose = 1;
    for (let i = 1; i <= j; i++) choose = (choose * (n - j + i)) / i;
    total += choose * p ** j * (1 - p) ** (n - j);
  }
  return total;
}

/**
 * Where calls interact through shared state. Each closed form conditions on
 * the outage state by hand: a dependency is either down for the whole request
 * or up, in which case every attempt rolls its own transient coin.
 */
describe('modelAvailability, interactions', () => {
  it('partial fan-out cannot absorb an outage of a dependency all instances share', () => {
    const m = model('digraph g { entry=a; a -> s [fanout=10, fanout_require=8]; s -> idx; }', {
      a: [1, 0.5], s: [0.97, 1], idx: [0.995, 0.5],
    });
    const idx = failureModel(0.995, 0.5);
    const expected = (1 - idx.outage) * binomialTail(10, 0.97 * (1 - idx.transientFail), 8);
    expect(exact(m).availability).toBeCloseTo(expected, PRECISION);
    // Treating idx failures as independent per shard lets the 8-of-10 slack absorb them.
    expect(exact(m).availability).toBeLessThan(binomialTail(10, 0.97 * 0.995, 8) - 1e-3);
  });

  it('retries apply per fan-out instance, and each instance has its own outage', () => {
    const m = model('digraph g { entry=a; a -> s [fanout=5, retries=2]; }', { a: [1, 0.5], s: [0.98, 0.6] });
    const s = failureModel(0.98, 0.6);
    expect(exact(m).availability).toBeCloseTo(((1 - s.outage) * (1 - s.transientFail ** 3)) ** 5, PRECISION);
  });

  it('nested fan-out shares the leaf instances but not their transient coins', () => {
    const m = model('digraph g { entry=a; a -> b [fanout=3]; b -> c [fanout=2]; }', {
      a: [0.999, 0.5], b: [0.99, 0.5], c: [0.98, 0.5],
    });
    const c = failureModel(0.98, 0.5);
    // Both c instances must be up; then each of the 3 b instances rolls its own coins for its 2 calls.
    expect(exact(m).availability).toBeCloseTo(0.999 * (1 - c.outage) ** 2 * (0.99 * (1 - c.transientFail) ** 2) ** 3, PRECISION);
    expect(napkin(m)).toBeCloseTo(0.999 * (0.99 * 0.98 ** 2) ** 3, PRECISION);
  });

  it('nested retries multiply attempts but outages still hold across all of them', () => {
    const m = model('digraph g { entry=a; a -> b [retries=1]; b -> c [retries=2]; }', {
      a: [0.999, 0.5], b: [0.99, 0.7], c: [0.98, 0.6],
    });
    const b = failureModel(0.99, 0.7);
    const c = failureModel(0.98, 0.6);
    const bAttempt = (1 - b.transientFail) * (1 - c.transientFail ** 3);
    expect(exact(m).availability).toBeCloseTo(0.999 * (1 - b.outage) * (1 - c.outage) * (1 - (1 - bAttempt) ** 2), PRECISION);
  });

  it('failover with retried members cannot escape a dependency both members share', () => {
    const m = model('digraph g { entry=fe; fe -> g; g [type=any]; g -> x [retries=1]; g -> y [retries=1]; x -> s; y -> s; }', {
      fe: [0.9999, 0.5], x: [0.99, 1], y: [0.95, 1], s: [0.995, 0.4],
    });
    const s = failureModel(0.995, 0.4);
    const member = (a: number) => 1 - (1 - a * (1 - s.transientFail)) ** 2;
    expect(exact(m).availability).toBeCloseTo(0.9999 * (1 - s.outage) * (1 - (1 - member(0.99)) * (1 - member(0.95))), PRECISION);
  });

  it('a retry re-runs a whole fan-out, but a down instance fails every retry', () => {
    const m = model('digraph g { entry=a; a -> b [retries=2]; b -> s [fanout=4]; }', { a: [1, 0.5], b: [0.99, 1], s: [0.99, 0.5] });
    const s = failureModel(0.99, 0.5);
    const bAttempt = 0.99 * (1 - s.transientFail) ** 4;
    expect(exact(m).availability).toBeCloseTo((1 - s.outage) ** 4 * (1 - (1 - bAttempt) ** 3), PRECISION);
  });

  it('a plain call and a fan-out call to the same node share instance 0', () => {
    const m = model('digraph g { entry=a; a -> s; a -> t; t -> s [fanout=3]; }', { a: [1, 0.5], t: [1, 0.5], s: [0.99, 0.5] });
    const s = failureModel(0.99, 0.5);
    // Three instances must be up (not four); four calls each roll a transient coin.
    expect(exact(m).availability).toBeCloseTo((1 - s.outage) ** 3 * (1 - s.transientFail) ** 4, PRECISION);
  });
});

describe('modelAvailability agrees with Monte Carlo on random graphs', () => {
  /** A random valid topology with groups, soft deps, fan-out and retries, plus high failure rates. */
  function randomModel(seed: number): { dot: string; yaml: string } {
    const random = seededRandom(seed);
    const pick = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
    const n = pick(4, 7);
    const groupType = new Map<number, 'any' | 'quorum'>();
    for (let i = 1; i <= n - 3; i++) if (random() < 0.25) groupType.set(i, random() < 0.6 ? 'any' : 'quorum');

    const edges = new Map<number, Set<number>>(Array.from({ length: n }, (_, i) => [i, new Set<number>()]));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) if (random() < 0.35) edges.get(i)!.add(j);
      while (groupType.has(i) && edges.get(i)!.size < 2) edges.get(i)!.add(pick(i + 1, n - 1));
    }
    for (let j = 1; j < n; j++) {
      if (![...edges.values()].some((targets) => targets.has(j))) edges.get(pick(0, j - 1))!.add(j);
    }

    const lines = ['digraph r {', '  entry=n0;'];
    for (const [i, type] of groupType) {
      lines.push(`  n${i} [type=${type}${type === 'quorum' ? `, require=${pick(1, edges.get(i)!.size)}` : ''}];`);
    }
    for (const [i, targets] of edges) {
      for (const j of targets) {
        const attrs = [`retries=${pick(0, groupType.has(i) ? 1 : 2)}`];
        if (!groupType.has(i)) {
          if (random() < 0.2) attrs.push('dependency=soft');
          if (!groupType.has(j) && random() < 0.25) {
            const fanout = pick(2, 3);
            attrs.push(`fanout=${fanout}`, `fanout_require=${pick(1, fanout)}`);
          }
        }
        lines.push(`  n${i} -> n${j} [${attrs.join(', ')}];`);
      }
    }
    lines.push('}');

    const nodes = Array.from({ length: n }, (_, i) => i).filter((i) => !groupType.has(i));
    const transient = () => [0, 1, random()][pick(0, 2)]!.toFixed(3);
    const yaml = 'nodes:\n' + nodes.map((i) => `  n${i}: { availability: ${(0.8 + 0.19 * random()).toFixed(3)}, transient: ${transient()} }`).join('\n');
    return { dot: lines.join('\n'), yaml };
  }

  const TRIALS = 60_000;
  it.each(Array.from({ length: 25 }, (_, i) => i + 1))('random graph, seed %i', (seed) => {
    const { dot, yaml } = randomModel(seed);
    const topology = parseTopology(dot);
    expect(topology.diagnostics.filter((d) => d.severity === 'error'), dot).toEqual([]);
    const inputs = parseInputs(yaml, topology.value!);
    expect(inputs.diagnostics, yaml).toEqual([]);

    const result = modelAvailability(topology.value!, inputs.value!);
    const sampled = sampleAvailability(topology.value!, inputs.value!, TRIALS, seed);
    for (const key of ['availability', 'fullFidelity'] as const) {
      const p = result[key];
      const sigma = Math.sqrt((p * (1 - p)) / TRIALS);
      expect(Math.abs(sampled[key] - p), `${key}: exact ${p}, sampled ${sampled[key]}\n${dot}\n${yaml}`).toBeLessThan(4.5 * sigma + result.truncation + 1e-9);
    }
  });
});

describe('truncation', () => {
  const m = model('digraph g { entry=a; a -> g; g [type=any]; g -> x; g -> y; x -> s [fanout=20]; y -> s [fanout=20]; }', {
    a: [0.999, 0], x: [0.99, 0], y: [0.99, 0], s: [0.999, 0.2],
  });

  it('bounds the error of a capped enumeration', () => {
    const full = modelAvailability(m.topology, m.inputs, { tolerance: 0 });
    // One state: nothing down.
    const capped = modelAvailability(m.topology, m.inputs, { maxStates: 1 });
    expect(full.truncation).toBeLessThan(1e-15);
    expect(capped.truncation).toBeGreaterThan(1e-6);
    expect(full.availability - capped.availability).toBeGreaterThanOrEqual(0);
    expect(full.availability - capped.availability).toBeLessThanOrEqual(capped.truncation);
  });

  it('stays within the default tolerance', () => {
    expect(modelAvailability(m.topology, m.inputs).truncation).toBeLessThanOrEqual(1e-9);
  });
});

describe('exact engine agrees with Monte Carlo', () => {
  const dir = join(import.meta.dirname, '..', 'scenarios');
  const scenarios = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  const TRIALS = 200_000;

  // Real inputs fail too rarely for sampling to resolve; inflate unavailability
  // so every mechanism (outages, retries, fan-out, soft deps) fires often.
  it.each(scenarios)('%s with 20× unavailability', (file) => {
    const source = readFileSync(join(dir, file), 'utf8');
    const topology = parseTopology(readFileSync(join(dir, /^topology: (.+)$/m.exec(source)![1]!), 'utf8')).value!;
    const inputs = parseInputs(source, topology).value!;
    const inflated: Inputs = {
      ...inputs,
      nodes: new Map([...inputs.nodes].map(([id, n]) => [id, { ...n, availability: 1 - Math.min(0.5, (1 - n.availability) * 20) }])),
    };

    const result = modelAvailability(topology, inflated);
    const sampled = sampleAvailability(topology, inflated, TRIALS, 42);
    for (const key of ['availability', 'fullFidelity'] as const) {
      const p = result[key];
      const sigma = Math.sqrt((p * (1 - p)) / TRIALS);
      expect(Math.abs(sampled[key] - p), `${key}: exact ${p}, sampled ${sampled[key]}`).toBeLessThan(4.5 * sigma + result.truncation);
    }
  });
});
