import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { decimalsFor, decimalsForInterval, inputPercent, percent } from '../src/ui/format';
import { renderDot } from '../src/ui/graph';
import { fromParsed } from '../src/doc';
import { parseInputs } from '../src/model/inputs';
import { parseTopology } from '../src/model/topology';

describe('format', () => {
  it('shows two significant figures of the failure rate', () => {
    expect(percent(0.99939)).toBe('99.939%');
    expect(percent(0.8344)).toBe('83.44%');
    expect(percent(0.9999)).toBe('99.990%');
    expect(decimalsFor(0.9999)).toBe(3);
  });

  it('shows an estimate only as precisely as its interval allows', () => {
    // ±0.0015 percentage points: three decimals keep the ends apart.
    const digits = decimalsForInterval(0.999385, 0.999415);
    expect(digits).toBe(3);
    expect(percent(0.999385, digits)).not.toBe(percent(0.999415, digits));
    // ±0.2 points: one decimal is all the sample supports.
    expect(decimalsForInterval(0.832, 0.836)).toBe(1);
  });

  it('shows inputs as people write them', () => {
    expect(inputPercent(0.9995)).toBe('99.95%');
    expect(inputPercent(0.999)).toBe('99.9%');
  });
});

describe('analyze', () => {
  it('points out soft dependencies without a timeout', () => {
    const a = analyze('digraph g { entry=a; a -> b [dependency=soft]; a -> c [dependency=soft, timeout_ms=10]; }', 'defaults: { availability: 0.99, transient: 0.5 }');
    expect(a.notes).toContain('a -> b is soft but has no timeout_ms, so a still waits for it in full.');
    expect(a.notes.join()).not.toContain('a -> c');
    expect(a.availability?.exhaustive).toBe(true);
  });

  it('keeps the topology when only the inputs are invalid', () => {
    const a = analyze('digraph g { entry=a; a -> b; }', 'nodes: { zz: {} }');
    expect(a.topology).toBeDefined();
    expect(a.availability).toBeUndefined();
    expect(a.diagnostics.some((d) => d.source === 'inputs' && d.severity === 'error')).toBe(true);
  });
});

describe('renderDot', () => {
  it('labels call semantics, ids every element, and marks groups, infra and the entry', () => {
    const topology = parseTopology(`digraph g {
      entry=a;
      a -> g [stage=0];
      a -> s [stage=1, fanout=10, fanout_require=8, retries=2, timeout_ms=300, dependency=soft];
      g [type=quorum, require=2]; g -> x; g -> y; g -> z;
      x [kind=infra];
    }`).value!;
    const doc = fromParsed(topology, parseInputs('defaults: { availability: 0.9995, transient: 0.9 }', topology).value!);
    const dot = renderDot(doc);
    expect(dot).toContain('label=" step 2 · soft · 8 of ×10 · ↻2 · 300 ms ", id="e1"');
    expect(dot).toContain('label="g\\n2 of 3", id="n1"');
    expect(dot).toContain('label="s\\n99.95% · flaky", id="n2"');
    expect(dot).toMatch(/"x" \[.*class="service infra"/);
    expect(dot).toMatch(/"a" \[.*class="service entry"/);
    expect(dot).toContain('"__requests" -> "a"');
  });
});
