import { describe, expect, it } from 'vitest';
import { type ActionSpec, PARTIAL_TYPES, type PathProgress, type RankedAction, actionKey, applyAction, applyPath, candidateActions, describeAction, findPath, rankActions, tenTimes } from '../src/actions';
import { analyze } from '../src/analysis';
import { type Doc, toDot, toYaml } from '../src/doc';
import { compile } from '../src/model/compile';
import { combineRuns } from '../src/model/latency';
import { simulateLatency } from '../src/model/sampler';
import { evaluateObjectives } from '../src/model/slo';
import { SCENARIOS } from '../src/scenarios';

const lesson = (id: string) => SCENARIOS.find((s) => s.id === id)!.doc;

function baseline(doc: Doc) {
  const analysis = analyze(toDot(doc), toYaml(doc));
  const run = combineRuns([1, 2].map((seed) => simulateLatency(compile(analysis.topology!, analysis.inputs!), 10_000, seed)));
  return { analysis, evaluation: evaluateObjectives(analysis.topology!, analysis.inputs!, analysis.availability!, { run, done: true }) };
}

function rank(doc: Doc, trials = 20_000): RankedAction[] {
  let last: RankedAction[] = [];
  for (const progress of rankActions(doc, baseline(doc), { trials })) last = progress.ranked;
  return last;
}

const titles = (doc: Doc, specs: ActionSpec[]) => specs.map((s) => describeAction(doc, s).title);

describe('candidateActions', () => {
  it('aims at what loses requests, and skips changes that make no sense', () => {
    const doc = lesson('product_page');
    const { analysis, evaluation } = baseline(doc);
    const found = titles(doc, candidateActions(doc, analysis, evaluation));
    expect(found).toContain('Let Product page carry on without Inventory');
    expect(found).toContain('Make Inventory 10× more reliable');
    expect(found).toContain('Add a fallback for Inventory');
    // Shared infrastructure isn't offered as optional.
    expect(found.some((t) => t.includes('without Auth'))).toBe(false);
  });

  it('offers partial answers, not skipping every copy, for a fan-out that times out', () => {
    const doc = lesson('search');
    const { analysis, evaluation } = baseline(doc);
    const found = titles(doc, candidateActions(doc, analysis, evaluation));
    expect(found).toContain('Answer with 95 of 100 Shard copies');
    expect(found).toContain('Wait longer for Shard');
    expect(found.some((t) => t.includes('without Shard'))).toBe(false);
  });
});

describe('applyAction', () => {
  it('makes each change it describes', () => {
    const doc = lesson('product_page');
    const inventoryCall = doc.calls.findIndex((c) => c.to === 'inventory');
    expect(tenTimes(0.999)).toBe(0.9999);
    expect(applyAction(doc, { type: 'reliable', node: 'inventory' }).nodes.find((n) => n.id === 'inventory')!.availability).toBe(0.9999);
    expect(applyAction(doc, { type: 'optional', call: inventoryCall, timeoutMs: 230 }).calls[inventoryCall]).toMatchObject({ dependency: 'soft', timeoutMs: 230 });
    expect(applyAction(doc, { type: 'retry', call: inventoryCall }).calls[inventoryCall]!.retries).toBe(2);
    expect(applyAction(doc, { type: 'fallback', node: 'inventory' }).nodes.some((n) => n.id === 'inventory_fallback')).toBe(true);
    expect(actionKey({ type: 'partial', call: 3, require: 95 })).toBe('partial:3');
  });
});

describe('rankActions', () => {
  it('puts the lesson’s answer first: optional beats a nine', () => {
    const doc = lesson('product_page');
    const ranked = rank(doc);
    const order = titles(doc, ranked.map((r) => r.spec));
    expect(order[0]).toBe('Let Product page carry on without Inventory');
    expect(order.indexOf('Add a fallback for Inventory')).toBeLessThan(order.indexOf('Make Inventory 10× more reliable'));
    expect(ranked[0]!.clear).toBe(true);
    // Its trade-off: more answers are partial.
    expect(ranked[0]!.partialAfter).toBeGreaterThan(ranked[0]!.partialBefore!);
  });

  it('ranks partial answers first for the fan-out, with the trade-off it costs', () => {
    const doc = lesson('search');
    // Gains here are ~16%, so a small sample is plenty (and search is costly to simulate).
    const [top] = rank(doc, 4_000);
    expect(describeAction(doc, top!.spec).title).toBe('Answer with 95 of 100 Shard copies');
    expect(top!.after).toBeGreaterThan(0.99);
    expect(top!.partialAfter).toBeGreaterThan(0.1);
  });

  it('says when a single change keeps the promise', () => {
    const base = lesson('product_page');
    const doc: Doc = { ...base, objectives: { ...base.objectives, succeedWithin: { ms: 300, target: 0.998 } } };
    const ranked = rank(doc);
    const keeps = ranked.filter((r) => r.keepsPromise).map((r) => describeAction(doc, r.spec).title);
    expect(keeps).toContain('Let Product page carry on without Inventory');
    expect(keeps).not.toContain('Make Inventory 10× more reliable');
  });

  it('is ordered: clear gains first, largest first', () => {
    const ranked = rank(lesson('checkout'));
    for (let i = 1; i < ranked.length; i++) {
      const [a, b] = [ranked[i - 1]!, ranked[i]!];
      expect(Number(a.clear) > Number(b.clear) || (a.clear === b.clear && a.gain.value >= b.gain.value)).toBe(true);
    }
  });
});

describe('findPath', () => {
  const run = (doc: Doc, options: Parameters<typeof findPath>[2] = {}) => {
    let last: PathProgress | undefined;
    for (const p of findPath(doc, baseline(doc), { trials: 10_000, ...options })) last = p;
    return last!;
  };

  it('finds that checkout’s promise is about time: one change, to payments’ latency', () => {
    const path = run(lesson('checkout'));
    expect(path.outcome).toBe('reached');
    expect(path.steps.map((s) => s.title)).toEqual(['Make Payments twice as fast']);
    expect(path.steps[0]!.after).toBeGreaterThanOrEqual(0.999);
  });

  it('keeps answers complete unless partial answers are allowed', () => {
    const doc = lesson('product_page_promise');
    const complete = run(doc, { maxSteps: 3 });
    expect(complete.steps.every((s) => !PARTIAL_TYPES.includes(s.spec.type))).toBe(true);
    const partial = run(doc, { maxSteps: 1, allowPartial: true });
    expect(partial.steps[0]!.title).toBe('Let Product page carry on without Inventory');
  });

  it('climbs, never repeats a change, and stops at the step limit when it falls short', () => {
    const path = run(lesson('product_page_promise'), { maxSteps: 3 });
    expect(path.outcome).toBe('limit');
    const afters = path.steps.map((s) => s.after);
    expect(afters.every((v, i) => v > (i === 0 ? path.start : afters[i - 1]!))).toBe(true);
    expect(new Set(path.steps.map((s) => s.title)).size).toBe(path.steps.length);
  });

  it('has nothing to do when the promise is already kept', () => {
    expect(run(lesson('product_page')).outcome).toBe('nothing-to-do');
  });

  it('applies a path step by step', () => {
    const doc = lesson('product_page_promise');
    const path = run(doc, { maxSteps: 2 });
    const applied = applyPath(doc, path.steps);
    expect(applied).toEqual(path.steps.reduce((d, s) => applyAction(d, s.spec), doc));
    expect(applied).not.toEqual(doc);
  });
});
