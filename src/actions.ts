/**
 * What would help most: concrete changes, generated from where requests are
 * lost, tried against the model and ranked by what the promise measures.
 *
 * Actions are plain data (an ActionSpec) so the worker can rank them and the
 * UI can apply the one someone picks.
 */
import { type Analysis, analyze } from './analysis';
import { type Doc, displayName, fromParsed, makeRedundant, toDot, toYaml, updateCall, updateNode } from './doc';
import { compile } from './model/compile';
import { combineRuns } from './model/latency';
import { type LatencySimulation, simulateLatency } from './model/sampler';
import { type Evaluation, type Measure, evaluateObjectives } from './model/slo';

export type ActionSpec =
  | { type: 'reliable'; node: string }
  | { type: 'fallback'; node: string }
  | { type: 'optional'; call: number; timeoutMs?: number }
  | { type: 'retry'; call: number }
  | { type: 'timeout'; call: number; ms: number }
  | { type: 'partial'; call: number; require: number };

export interface RankedAction {
  spec: ActionSpec;
  /** Change in the promise metric (or availability, with no promise). */
  gain: { value: number; low: number; high: number };
  /** The metric after the change. */
  after: number;
  keepsPromise: boolean;
  /** Share of all requests that get a partial answer, before and after (only when it grows). */
  partialBefore?: number;
  partialAfter?: number;
  /** The gain's interval excludes zero. */
  clear: boolean;
  p99Before?: number;
  p99After?: number;
}

export function actionKey(spec: ActionSpec): string {
  return 'node' in spec ? `${spec.type}:${spec.node}` : `${spec.type}:${spec.call}`;
}

export function applyAction(doc: Doc, spec: ActionSpec): Doc {
  switch (spec.type) {
    case 'reliable': {
      const node = doc.nodes.find((n) => n.id === spec.node)!;
      return updateNode(doc, spec.node, { availability: tenTimes(node.availability) });
    }
    case 'fallback': {
      const result = makeRedundant(doc, spec.node);
      return typeof result === 'string' ? doc : result.doc;
    }
    case 'optional':
      return updateCall(doc, spec.call, { dependency: 'soft', ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}) });
    case 'retry':
      return updateCall(doc, spec.call, { retries: 2 });
    case 'timeout':
      return updateCall(doc, spec.call, { timeoutMs: spec.ms });
    case 'partial':
      return updateCall(doc, spec.call, { fanoutRequire: spec.require });
  }
}

/** 99.9% -> 99.99%: ten times fewer failures, without float noise. */
export function tenTimes(availability: number): number {
  return Number((1 - (1 - availability) / 10).toFixed(8));
}

const roundUp = (ms: number, step: number) => Math.ceil(ms / step) * step;

/**
 * Candidate changes aimed at what is actually losing requests: the services
 * whose failures cost the most, and the calls whose timeouts do.
 */
export function candidateActions(doc: Doc, analysis: Analysis, evaluation: Evaluation): ActionSpec[] {
  const specs: ActionSpec[] = [];
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const levers = (analysis.levers ?? []).filter((l) => l.ifPerfect >= 1e-5).slice(0, 4);

  for (const lever of levers) {
    const node = byId.get(lever.id);
    if (!node || node.type !== 'service') continue;
    if (node.availability < 0.99999) specs.push({ type: 'reliable', node: node.id });
    const callers = doc.calls.map((c, i) => ({ c, i })).filter(({ c }) => c.to === node.id);
    const inGroup = callers.some(({ c }) => byId.get(c.from)!.type !== 'service');
    if (!inGroup) specs.push({ type: 'fallback', node: node.id });
    for (const { c, i } of callers) {
      if (byId.get(c.from)!.type !== 'service') continue;
      // Carrying on without every copy of a fan-out isn't an answer; "partial" covers that.
      // Shared infrastructure (auth, a control plane) is rarely something a caller can skip.
      if (c.dependency === 'hard' && node.id !== doc.entry && c.fanout === 1 && !node.infra) {
        const timeoutMs = c.timeoutMs ?? (node.latency ? roundUp(node.latency.p99Ms * 1.5, 10) : undefined);
        specs.push({ type: 'optional', call: i, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
      }
      if (c.dependency === 'hard' && c.retries === 0 && node.transient >= 0.5) specs.push({ type: 'retry', call: i });
    }
  }

  for (const loss of evaluation.timeoutLosses.filter((l) => l.share.value >= 1e-4).slice(0, 2)) {
    const call = doc.calls[loss.edge]!;
    const callee = byId.get(call.to)!;
    if (call.timeoutMs !== undefined) {
      const ms = roundUp(Math.max(call.timeoutMs * 2, (callee.latency?.p99Ms ?? 0) * 2), 50);
      specs.push({ type: 'timeout', call: loss.edge, ms });
    }
    if (call.fanout > 1 && call.fanoutRequire === call.fanout) {
      specs.push({ type: 'partial', call: loss.edge, require: Math.min(call.fanout - 1, Math.floor(call.fanout * 0.95)) });
    }
  }

  const seen = new Set<string>();
  return specs.filter((s) => (seen.has(actionKey(s)) ? false : (seen.add(actionKey(s)), true)));
}

/** What the ranking measures: success within the promised time, else availability. */
function metric(e: Evaluation): Measure | undefined {
  return e.objectives.find((o) => o.kind === 'succeed_within')?.measure ?? e.withTimeouts;
}

interface Tried {
  doc: Doc;
  analysis: Analysis;
  evaluation: Evaluation;
  run?: LatencySimulation;
}

function evaluateDoc(doc: Doc, seeds: number[], trials: number): Tried | undefined {
  const analysis = analyze(toDot(doc), toYaml(doc));
  if (!analysis.topology || !analysis.inputs || !analysis.availability) return undefined;
  if (analysis.diagnostics.some((d) => d.severity === 'error')) return undefined;
  const model = compile(analysis.topology, analysis.inputs);
  if (model.nodes.some((n) => n.type === 'service' && !n.latency)) {
    return { doc, analysis, evaluation: evaluateObjectives(analysis.topology, analysis.inputs, analysis.availability) };
  }
  const run = combineRuns(seeds.map((seed) => simulateLatency(model, trials, seed)));
  return { doc, analysis, run, evaluation: evaluateObjectives(analysis.topology, analysis.inputs, analysis.availability, { run, done: true }) };
}

export interface RankOptions {
  /** Simulated requests per seed for each candidate; by default sized to `budgetMs`. */
  trials?: number;
  /** Roughly how long to spend simulating each candidate. */
  budgetMs?: number;
  /** Seeds shared with the baseline run: the same random requests for every candidate. */
  seeds?: number[];
  /** Candidates simulated at most. */
  limit?: number;
}

/**
 * Ranks candidate actions, yielding the ranking so far after each one is
 * tried, so a caller can show progress and stop early.
 */
export interface RankProgress {
  ranked: RankedAction[];
  tried: number;
  total: number;
}

export function* rankActions(doc: Doc, baseline: { analysis: Analysis; evaluation: Evaluation }, options: RankOptions = {}): Generator<RankProgress> {
  const seeds = options.seeds ?? [1, 2];
  const candidates = candidateActions(doc, baseline.analysis, baseline.evaluation);
  if (candidates.length === 0) return;

  // Simulation cost varies a hundredfold between graphs: size the sample to a
  // time budget, so cheap graphs get tight intervals and costly ones stay quick.
  let trials = options.trials;
  if (trials === undefined) {
    const probe = 4_000;
    const start = performance.now();
    evaluateDoc(doc, [seeds[0]!], probe);
    const perRequest = Math.max(1e-4, (performance.now() - start) / probe);
    trials = Math.round(Math.min(150_000, Math.max(10_000, (options.budgetMs ?? 300) / perRequest / seeds.length)));
  }

  const base = evaluateDoc(doc, seeds, trials);
  const baseMetric = base && metric(base.evaluation);
  if (!base || !baseMetric) return;
  const target = doc.objectives.succeedWithin?.target ?? doc.objectives.availability;
  const limit = doc.objectives.succeedWithin?.ms ?? Infinity;
  const within = (e: Evaluation) => e.objectives.find((o) => o.kind === 'succeed_within');

  // Screen with the exact model: time-free gains first, timing changes always tried.
  const screened = candidates
    .map((spec) => {
      const next = applyAction(doc, spec);
      const exact = analyze(toDot(next), toYaml(next)).availability?.availability ?? 0;
      const timing = spec.type === 'timeout' || spec.type === 'partial';
      return { spec, prior: timing ? Infinity : exact - base.evaluation.ignoringTime.value };
    })
    .sort((a, b) => b.prior - a.prior)
    .slice(0, options.limit ?? 8);

  const ranked: RankedAction[] = [];
  let tried = 0;
  for (const { spec } of screened) {
    tried++;
    const candidate = evaluateDoc(applyAction(doc, spec), seeds, trials);
    const after = candidate && metric(candidate.evaluation);
    if (!candidate || !after) continue;
    const n = trials * seeds.length;
    // The gain is the difference of the figures the pane shows before and after
    // applying; the request-by-request comparison supplies its uncertainty.
    const gain = after.value - baseMetric.value;
    const se = pairedGain(base, candidate, limit)?.se ?? Math.sqrt(variance(after, n) + variance(baseMetric, n));
    // Partial answers: succeeded in time, but without an optional call or some copies.
    const partial = (e: Evaluation) => {
      const w = within(e);
      return w?.measure && w.fullFidelity ? Math.max(0, w.measure.value - w.fullFidelity.value) : undefined;
    };
    const partialBefore = partial(base.evaluation);
    const partialAfter = partial(candidate.evaluation);
    const p99 = (e: Evaluation) => (e.latency.status === 'sampled' ? e.latency.percentiles?.p99 : undefined);
    const low = gain - 1.96 * se;
    ranked.push({
      spec,
      gain: { value: gain, low, high: gain + 1.96 * se },
      after: after.value,
      keepsPromise: target !== undefined && baseMetric.value < target && after.value >= target,
      ...(partialBefore !== undefined && partialAfter !== undefined && partialAfter > partialBefore + 1.96 * se ? { partialBefore, partialAfter } : {}),
      p99Before: p99(base.evaluation),
      p99After: p99(candidate.evaluation),
      clear: low > 0,
    });
    // Clear gains first, then by size.
    ranked.sort((a, b) => Number(b.clear) - Number(a.clear) || b.gain.value - a.gain.value);
    yield { ranked: [...ranked], tried, total: screened.length };
  }
}

/**
 * The gain measured request by request: the simulator reseeds per request, so
 * request i in both runs saw the same draws until the change made them
 * differ. The spread of per-request differences is far smaller than the
 * spread of either run, so small gains become distinguishable from noise.
 */
function pairedGain(base: Tried, tried: Tried, limit: number): { gain: number; se: number } | undefined {
  const a = base.run?.requestLatencies;
  const b = tried.run?.requestLatencies;
  if (!a || !b || a.length !== b.length || a.length === 0) return undefined;
  const good = (ms: number) => !Number.isNaN(ms) && ms <= limit;
  let sum = 0;
  let sumSquares = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Number(good(b[i]!)) - Number(good(a[i]!));
    sum += d;
    sumSquares += d * d;
  }
  const n = a.length;
  const mean = sum / n;
  // Floor the variance at one discordant request, so zero observed changes isn't certainty.
  const variance = Math.max(sumSquares / n - mean * mean, 1 / n) / n;
  return { gain: mean, se: Math.sqrt(variance) };
}

const variance = (m: Measure, n: number) => (m.kind === 'sampled' ? (m.value * (1 - m.value)) / n : ((m.high - m.low) / 2) ** 2);

/** Words for an action, for the pane. */
export function describeAction(doc: Doc, spec: ActionSpec): { title: string; detail: string; target: { kind: 'node'; id: string } | { kind: 'call'; index: number } } {
  const name = (id: string) => displayName(doc.nodes.find((n) => n.id === id)!);
  switch (spec.type) {
    case 'reliable': {
      const node = doc.nodes.find((n) => n.id === spec.node)!;
      const pct = (a: number) => `${parseFloat((a * 100).toFixed(4))}%`;
      return { title: `Make ${name(spec.node)} 10× more reliable`, detail: `From ${pct(node.availability)} to ${pct(tenTimes(node.availability))}. The classic “add a nine”.`, target: { kind: 'node', id: spec.node } };
    }
    case 'fallback':
      return { title: `Add a fallback for ${name(spec.node)}`, detail: 'A second copy takes over when it fails. It shares the same dependencies.', target: { kind: 'node', id: spec.node } };
    case 'optional': {
      const call = doc.calls[spec.call]!;
      const timeout = spec.timeoutMs !== undefined && call.timeoutMs === undefined ? ` Waits at most ${spec.timeoutMs} ms for it.` : '';
      return { title: `Let ${name(call.from)} carry on without ${name(call.to)}`, detail: `Answers without it count as partial.${timeout}`, target: { kind: 'call', index: spec.call } };
    }
    case 'retry': {
      const call = doc.calls[spec.call]!;
      return { title: `Retry calls to ${name(call.to)}`, detail: 'Up to 2 retries. Its failures are mostly flaky, which a retry recovers.', target: { kind: 'call', index: spec.call } };
    }
    case 'timeout': {
      const call = doc.calls[spec.call]!;
      return { title: `Wait longer for ${name(call.to)}`, detail: `Raise the timeout from ${call.timeoutMs} ms to ${spec.ms} ms.`, target: { kind: 'call', index: spec.call } };
    }
    case 'partial': {
      const call = doc.calls[spec.call]!;
      return { title: `Answer with ${spec.require} of ${call.fanout} ${name(call.to)} copies`, detail: 'Skips the slowest few; those answers are partial.', target: { kind: 'call', index: spec.call } };
    }
  }
}

/** Rebuilds a Doc from analysis results (the worker only has text). */
export function docFromAnalysis(analysis: Analysis): Doc | undefined {
  return analysis.topology && analysis.inputs ? fromParsed(analysis.topology, analysis.inputs) : undefined;
}

