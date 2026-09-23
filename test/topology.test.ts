import { describe, expect, it } from 'vitest';
import { parseTopology } from '../src/model/topology';

const ok = (source: string) => {
  const result = parseTopology(source);
  expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return result.value!;
};
const errors = (source: string) =>
  parseTopology(source).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
const warnings = (source: string) =>
  parseTopology(source).diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message);

describe('parseTopology', () => {
  it('applies edge defaults', () => {
    const t = ok('digraph g { graph [entry=a]; a -> b; }');
    expect(t.name).toBe('g');
    expect(t.entry).toBe('a');
    expect(t.edges).toEqual([
      { from: 'a', to: 'b', dependency: 'hard', fanout: 1, fanoutRequire: 1, retries: 0, stage: 0, line: 1 },
    ]);
    expect(t.nodes.get('b')).toMatchObject({ id: 'b', type: 'service' });
  });

  it('accepts a top-level entry attribute', () => {
    expect(ok('digraph g { entry=a; a -> b; }').entry).toBe('a');
  });

  it('parses every edge attribute', () => {
    const t = ok(`digraph g {
      entry=a;
      a -> b [dependency=soft, fanout=10, fanout_require=8, retries=2, stage=1, timeout_ms=250];
      a -> c [fanout=5, fanout_require=all];
    }`);
    expect(t.edges[0]).toMatchObject({ dependency: 'soft', fanout: 10, fanoutRequire: 8, retries: 2, stage: 1, timeoutMs: 250 });
    expect(t.edges[1]).toMatchObject({ fanout: 5, fanoutRequire: 5 });
  });

  it('expands edge chains and groups, keeping declaration order', () => {
    const t = ok('digraph g { entry=a; a -> b -> c [retries=1]; a -> {d e}; }');
    expect(t.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['a->b', 'b->c', 'a->d', 'a->e']);
    expect(t.edges.slice(0, 2).every((e) => e.retries === 1)).toBe(true);
    expect(t.out.get('a')!.map((e) => e.to)).toEqual(['b', 'd', 'e']);
    expect(t.out.get('c')).toEqual([]);
  });

  it('resolves group nodes', () => {
    const t = ok(`digraph g {
      entry=a;
      a -> db; a -> q;
      db [type=any]; db -> db1; db -> db2;
      q [type=quorum, require=2]; q -> q1; q -> q2; q -> q3;
      q1 [kind=infra, label="Q one"];
    }`);
    expect(t.nodes.get('db')).toMatchObject({ type: 'any', require: 1 });
    expect(t.nodes.get('q')).toMatchObject({ type: 'quorum', require: 2 });
    expect(t.nodes.get('q1')).toMatchObject({ kind: 'infra', label: 'Q one' });
  });

  it('merges repeated node statements', () => {
    const t = ok('digraph g { entry=a; a -> g; g [type=quorum]; g [require=1]; g -> x; }');
    expect(t.nodes.get('g')).toMatchObject({ type: 'quorum', require: 1 });
  });

  describe('rejects', () => {
    it.each([
      ['syntax errors, with location', 'digraph g {\n a -> ;\n}', 'Syntax error'],
      ['undirected graphs', 'graph g { entry=a; a -- b; }', 'Use `digraph`'],
      ['a missing entry', 'digraph g { a -> b; }', 'Set the entry point'],
      ['an unknown entry', 'digraph g { entry=aa; a -> b; }', 'Did you mean "a"?'],
      ['unknown attributes, with a suggestion', 'digraph g { entry=a; a -> b [dependancy=soft]; }', 'Did you mean "dependency"?'],
      ['bad enum values', 'digraph g { entry=a; a -> b [dependency=optional]; }', 'must be one of hard | soft'],
      ['non-integer counts', 'digraph g { entry=a; a -> b [retries=1.5]; }', 'must be an integer ≥ 0'],
      ['zero fanout', 'digraph g { entry=a; a -> b [fanout=0]; }', 'must be an integer ≥ 1'],
      ['fanout_require above fanout', 'digraph g { entry=a; a -> b [fanout=3, fanout_require=4]; }', 'more than fanout=3'],
      ['default attribute statements', 'digraph g { entry=a; edge [dependency=soft]; a -> b; }', "Default `edge [...]` statements aren't supported"],
      ['subgraphs', 'digraph g { entry=a; subgraph cluster_x { a -> b; } }', "Subgraphs aren't supported"],
      ['ports', 'digraph g { entry=a; a:p -> b; }', "Ports (`node:port`) aren't supported"],
      ['duplicate edges', 'digraph g { entry=a; a -> b; a -> b [retries=1]; }', 'Duplicate edge a -> b'],
      ['unknown node kinds', 'digraph g { entry=a; a -> b; b [kind=database]; }', 'must be one of infra'],
      ['cycles, naming the path', 'digraph g { entry=a; a -> b -> c -> b; }', 'Dependency cycle: b -> c -> b'],
      ['require on a service', 'digraph g { entry=a; a -> b; b [require=2]; }', 'only applies to type=any or type=quorum'],
      ['type=any with require > 1', 'digraph g { entry=a; a -> g; g [type=any, require=2]; g -> x; g -> y; }', 'use type=quorum'],
      ['quorum without require', 'digraph g { entry=a; a -> g; g [type=quorum]; g -> x; }', 'needs "require"'],
      ['quorum requiring more than its members', 'digraph g { entry=a; a -> g; g [type=quorum, require=3]; g -> x; g -> y; }', 'requires 3 members but has only 2'],
      ['empty groups', 'digraph g { entry=a; a -> g; g [type=any]; }', 'has no members'],
      ['dependency attributes on member edges', 'digraph g { entry=a; a -> g; g [type=any]; g -> x [dependency=soft]; }', 'its edges are members, not dependencies'],
      ['fanout to a group', 'digraph g { entry=a; a -> g [fanout=3]; g [type=any]; g -> x; }', 'is a group'],
    ])('%s', (_, source, message) => {
      expect(errors(source).join('\n')).toContain(message);
    });

    it('reports the source line of the problem', () => {
      const [d] = parseTopology('digraph g {\n  entry=a;\n  a -> b [fanout=zero];\n}').diagnostics;
      expect(d).toMatchObject({ severity: 'error', line: 3 });
    });

    it('reports conflicting values of a repeated attribute', () => {
      expect(errors('digraph g { entry=a; a -> b; b [label=x]; b [label=y]; }').join()).toContain('Conflicting values for "label"');
    });
  });

  it('warns about unreachable nodes and single-member groups', () => {
    const w = warnings('digraph g { entry=a; a -> g; g [type=any]; g -> x; orphan -> y; }');
    expect(w).toEqual([
      'Group "g" has a single member, so it adds no redundancy.',
      'Not reachable from entry "a", so not modeled: orphan, y.',
    ]);
  });

  it('allows retries and timeouts on member edges', () => {
    const t = ok('digraph g { entry=a; a -> g; g [type=any]; g -> x [retries=2, timeout_ms=100]; g -> y; }');
    expect(t.out.get('g')![0]).toMatchObject({ retries: 2, timeoutMs: 100 });
  });
});
