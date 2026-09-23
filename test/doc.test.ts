import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Doc, addCall, addService, docProblems, fromParsed, removeNode, renameNode, setNodeType, toDot, toYaml, updateCall } from '../src/doc';
import { modelAvailability } from '../src/model/availability';
import { parseInputs } from '../src/model/inputs';
import { parseTopology } from '../src/model/topology';

function parse(dot: string, yaml: string): Doc {
  const t = parseTopology(dot);
  expect(t.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const i = parseInputs(yaml, t.value!);
  expect(i.diagnostics).toEqual([]);
  return fromParsed(t.value!, i.value!);
}
const roundTrip = (doc: Doc) => parse(toDot(doc), toYaml(doc));

describe('doc round trip', () => {
  const files = readdirSync('scenarios').filter((f) => f.endsWith('.yaml'));
  it.each(files)('%s survives DOT and YAML generation unchanged', (file) => {
    const yaml = readFileSync(`scenarios/${file}`, 'utf8');
    const doc = parse(readFileSync(`scenarios/${/^topology: (.+)$/m.exec(yaml)![1]}`, 'utf8'), yaml);
    expect(roundTrip(doc)).toEqual(doc);
  });

  it('keeps groups, labels, isolated nodes, odd ids and every call attribute', () => {
    const doc = parse(
      `digraph g {
        entry=a;
        a -> q [stage=1, retries=2, timeout_ms=50];
        a -> s [dependency=soft, fanout=5, fanout_require=3];
        q -> x; q -> y; q -> z;
        q [type=quorum, require=2];
        x [kind=infra, label="the x"];
        "odd-id";
      }`,
      'defaults: { availability: 99.9%, transient: 0.25, latency: { p50_ms: 3, p99_ms: 9 } }\nobjectives: { availability: 99%, latency: { p50_ms: 5, p999_ms: 90 }, succeed_within: { ms: 40, target: 98.5% } }',
    );
    expect(roundTrip(doc)).toEqual(doc);
    expect(toDot(doc)).toContain('"odd-id";');
  });
});

describe('doc edits', () => {
  const base = parse('digraph g { entry=a; a -> b; b -> c; }', 'defaults: { availability: 99.9%, transient: 0.5 }');

  it('renames a service everywhere it is referenced', () => {
    const doc = renameNode(base, 'a', 'web') as Doc;
    expect(doc.entry).toBe('web');
    expect(doc.calls[0]).toMatchObject({ from: 'web', to: 'b' });
    expect(renameNode(base, 'a', 'b')).toBe("There's already a service called b.");
    expect(renameNode(base, 'a', '1st')).toMatch(/letters, digits and underscores/);
  });

  it('refuses calls that would make a cycle or duplicate one', () => {
    expect(addCall(base, 'c', 'a')).toBe('a already depends on c, so this call would make a cycle.');
    expect(addCall(base, 'a', 'b')).toBe('a already calls b.');
    expect(addCall(base, 'a', 'a')).toBe("A service can't call itself.");
    expect((addCall(base, 'a', 'c') as Doc).calls).toHaveLength(3);
  });

  it('adds a service called by the selected one, with latency when others have it', () => {
    const { doc, id } = addService(base, 'b');
    expect(id).toBe('service');
    expect(doc.calls.at(-1)).toMatchObject({ from: 'b', to: 'service' });
    expect(doc.nodes.at(-1)!.latency).toBeUndefined();
    const timed = parse('digraph g { entry=a; a; }', 'nodes: { a: { availability: 1, transient: 0, latency: { p50_ms: 1, p99_ms: 2 } } }');
    expect(addService(timed).doc.nodes.at(-1)!.latency).toEqual({ p50Ms: 20, p99Ms: 100 });
    expect(addService(addService(base).doc).id).toBe('service_2');
  });

  it('turns a service into a group whose calls become plain members', () => {
    const withAttrs = updateCall(base, 0, { dependency: 'soft', fanout: 3, stage: 2, retries: 1 });
    const doc = setNodeType(withAttrs, 'a', 'quorum');
    expect(doc.nodes[0]).toMatchObject({ type: 'quorum', require: 1 });
    expect(doc.calls[0]).toMatchObject({ dependency: 'hard', fanout: 1, fanoutRequire: 1, stage: 0, retries: 1 });
    // And the result is still a valid model.
    expect(() => roundTrip(doc)).not.toThrow();
  });

  it('keeps fan-out requirements consistent', () => {
    const all = updateCall(base, 0, { fanout: 10 });
    expect(all.calls[0]).toMatchObject({ fanout: 10, fanoutRequire: 10 });
    const partial = updateCall(updateCall(all, 0, { fanoutRequire: 8 }), 0, { fanout: 5 });
    expect(partial.calls[0]).toMatchObject({ fanout: 5, fanoutRequire: 5 });
    const cleared = updateCall(updateCall(base, 0, { timeoutMs: 100 }), 0, { timeoutMs: undefined });
    expect('timeoutMs' in cleared.calls[0]!).toBe(false);
  });

  it('removes a service with its calls, but not the entry', () => {
    expect((removeNode(base, 'b') as Doc).calls).toEqual([]);
    expect(removeNode(base, 'a')).toMatch(/Requests arrive here/);
  });

  it('models the same availability after a round trip', () => {
    const t = parseTopology(toDot(base)).value!;
    expect(modelAvailability(t, parseInputs(toYaml(base), t).value!).availability).toBeCloseTo(0.999 ** 3, 12);
  });
});

describe('docProblems', () => {
  it('explains group and reachability problems in the editor\'s terms', () => {
    const doc = parse('digraph g { entry=a; a -> b; c; }', 'defaults: { availability: 99.9%, transient: 0.5 }');
    expect(docProblems(setNodeType(doc, 'b', 'any'))).toEqual([
      { node: 'b', blocking: true, message: 'b is an either-of group but calls nothing. Give it services to choose between, or make it a service again.' },
      { blocking: false, message: "c isn't called from where requests arrive, so it doesn't count yet." },
    ]);
  });
});
