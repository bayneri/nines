import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { decimalsFor, decimalsForInterval, inputPercent, percent } from '../src/ui/format';
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

describe('share', () => {
  it('shows two significant figures without float noise', async () => {
    const { share } = await import('../src/ui/words');
    expect([share(0.154), share(0.01), share(0.0005), share(0.000099999), share(0)]).toEqual(['15.4%', '1.0%', '0.050%', '0.010%', '0%']);
  });
});

describe('failureMode', () => {
  it('agrees with the typical-value summaries', async () => {
    const { failureMode } = await import('../src/ui/words');
    const { TYPICAL } = await import('../src/doc');
    for (const t of Object.values(TYPICAL)) {
      const words = failureMode(t.transient).toLowerCase();
      expect(t.summary, `${t.transient} is "${words}"`).toContain(words === 'mixed failures' ? 'mixed failures' : words);
    }
  });
});
