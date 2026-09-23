import { describe, expect, it } from 'vitest';
import { parseInputs } from '../src/model/inputs';
import { parseTopology } from '../src/model/topology';

const topology = parseTopology(`digraph shop {
  entry=web;
  web -> api;
  api -> db;
  db [type=any];
  db -> db_a;
  db -> db_b;
}`).value!;

const parse = (yaml: string) => parseInputs(yaml, topology);
const errors = (yaml: string) =>
  parse(yaml).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

describe('parseInputs', () => {
  it('resolves every service node, merging defaults field by field', () => {
    const { value, diagnostics } = parse(`
topology: shop.dot
objectives:
  availability: 99.9%
  latency: { p50_ms: 80, p99_ms: 300 }
  succeed_within: { ms: 300, target: 99.5% }
defaults: { availability: 0.999, transient: 0.5, latency: { p50_ms: 10, p99_ms: 50 } }
nodes:
  web:  { availability: 99.99% }
  api:  { transient: 0, latency: { p50_ms: 20, p99_ms: 200 } }
  db_a: { availability: "99.95 %" }
`);
    expect(diagnostics).toEqual([]);
    expect(value!.topology).toBe('shop.dot');
    expect(value!.objectives).toEqual({
      availability: 0.999,
      latency: [{ percentile: 0.5, ms: 80 }, { percentile: 0.99, ms: 300 }],
      succeedWithin: { ms: 300, target: 0.995 },
    });
    expect(value!.nodes.get('web')!.availability).toBeCloseTo(0.9999, 12);
    expect(value!.nodes.get('web')!.transient).toBe(0.5);
    expect(value!.nodes.get('api')).toEqual({ availability: 0.999, transient: 0, latency: { p50Ms: 20, p99Ms: 200 } });
    expect(value!.nodes.get('db_a')!.availability).toBeCloseTo(0.9995, 12);
    expect(value!.defaulted).toEqual(['db_b']);
    expect(value!.nodes.has('db')).toBe(false);
  });

  it('treats an empty node entry as "use defaults"', () => {
    const { value } = parse('defaults: { availability: 0.99, transient: 0 }\nnodes:\n  web:\n');
    expect(value!.nodes.get('web')).toEqual({ availability: 0.99, transient: 0 });
    expect(value!.defaulted).toEqual(['api', 'db_a', 'db_b']);
  });

  describe('rejects', () => {
    it.each([
      ['YAML syntax errors', 'nodes: { web: [', 'YAML syntax error'],
      ['a non-mapping document', '- web', 'must be a YAML mapping'],
      ['percent written as a bare number', 'defaults: { availability: 99.9, transient: 0 }', 'write it as a fraction (0.999) or a percentage string ("99.9%")'],
      ['availability of zero', 'defaults: { availability: 0, transient: 0 }', 'must be in (0, 1]'],
      ['transient out of range', 'defaults: { availability: 0.9, transient: 1.5 }', 'must be a number in [0, 1]'],
      ['unknown keys, with a suggestion', 'defaults: { availabilty: 0.9, transient: 0 }', 'Did you mean "availability"?'],
      ['unknown top-level keys', 'defualts: {}', 'Did you mean "defaults"?'],
      ['unknown nodes, with a suggestion', 'defaults: { availability: 0.9, transient: 0 }\nnodes: { dba: {} }', 'Did you mean "db"?'],
      ['inputs for group nodes', 'defaults: { availability: 0.9, transient: 0 }\nnodes: { db: { availability: 0.9 } }', 'its availability comes from its members'],
      ['half-specified latency', 'defaults: { availability: 0.9, transient: 0, latency: { p50_ms: 5 } }', 'needs both p50_ms and p99_ms'],
      ['p99 below p50', 'defaults: { availability: 0.9, transient: 0, latency: { p50_ms: 50, p99_ms: 5 } }', 'is below its p50_ms'],
      ['non-mapping nodes', 'nodes: [web]', '`nodes` must be a mapping'],
      ['unknown latency percentiles', 'objectives: { latency: { p98_ms: 300 } }', 'Allowed: p50_ms, p90_ms, p95_ms, p99_ms, p999_ms'],
      ['half-specified succeed_within', 'objectives: { succeed_within: { ms: 300 } }', 'needs both `ms` and `target`'],
      ['the old single objective key', 'objective: { availability: 99.9% }', 'Did you mean "objectives"?'],
    ])('%s', (_, yaml, message) => {
      expect(errors(yaml).join('\n')).toContain(message);
    });

    it('names each service node that has no value and no default', () => {
      expect(errors('nodes:\n  web: { availability: 0.9 }\n')).toEqual([
        'No transient for node "web"; set it under `nodes.web` or `defaults`.',
        'No availability or transient for node "api"; set it under `nodes.api` or `defaults`.',
        'No availability or transient for node "db_a"; set it under `nodes.db_a` or `defaults`.',
        'No availability or transient for node "db_b"; set it under `nodes.db_b` or `defaults`.',
      ]);
    });

    it('reports an invalid value once, not again as missing', () => {
      expect(errors('defaults: { availability: 150%, transient: 0 }')).toEqual([
        'availability of `defaults` must be in (0, 1] or a percentage like "99.9%", got "150%".',
      ]);
    });

    it('reports the source line of the problem', () => {
      const [d] = parse('defaults: { availability: 0.9, transient: 0 }\nnodes:\n  api:\n    transient: -1\n').diagnostics;
      expect(d).toMatchObject({ severity: 'error', line: 4 });
    });
  });
});
