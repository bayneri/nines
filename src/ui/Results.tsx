import { type ReactNode, useEffect, useState } from 'react';
import { type ActionSpec, type PathStep, describeAction } from '../actions';
import type { Analysis } from '../analysis';
import type { ActionsState, PathState } from './App';
import { type Doc, withLatencyObjective } from '../doc';
import type { Objectives } from '../model/inputs';
import type { Evaluation, Measure, ObjectiveResult, Verdict } from '../model/slo';
import { parseMs, parsePercent } from './controls';
import { decimalsFor, decimalsForInterval, inputPercent, ms, ninesDelta, percent, scientific } from './format';
import type { Selection } from './Graph';
import { Icon } from './icons';
import { useRememberedOpen } from './remember';
import { failureMode } from './words';
import { nodeName, share } from './words';

interface Props {
  doc: Doc;
  analysis: Analysis;
  evaluation: Evaluation;
  /** The lesson as loaded, to compare against once edited. */
  baseline?: Evaluation;
  /** Targets removed earlier in the session, restored when added back. */
  lastTargets: LastTargets;
  actions?: ActionsState;
  onApply: (spec: ActionSpec) => void;
  path?: PathState;
  onFindPath: (allowPartial: boolean) => void;
  onApplyPath: (steps: PathStep[]) => void;
  onObjectives: (objectives: Objectives) => void;
  onHighlight: (target: Selection) => void;
  onSelect: (target: Selection) => void;
}

const pName = (p: number) => `p${+(p * 100).toFixed(1)}`;
export const digitsFor = (m: Measure) => (m.kind === 'sampled' ? decimalsForInterval(m.low, m.high) : decimalsFor(m.value));
const find = <K extends ObjectiveResult['kind']>(objectives: ObjectiveResult[], kind: K) =>
  objectives.find((o): o is Extract<ObjectiveResult, { kind: K }> => o.kind === kind);
const VERDICT: Record<Verdict, string> = { met: 'Kept', missed: 'Broken', unclear: "Can't tell yet" };

export function Results({ doc, analysis, evaluation: e, baseline, lastTargets, actions, onApply, path, onFindPath, onApplyPath, onObjectives, onHighlight, onSelect }: Props) {
  const objectives = doc.objectives;
  const within = find(e.objectives, 'succeed_within');
  const was = (pick: (ev: Evaluation) => Measure | undefined) => {
    const before = baseline && pick(baseline);
    const now = pick(e);
    if (!before || !now) return undefined;
    const digits = Math.min(digitsFor(before), digitsFor(now));
    return percent(before.value, digits) === percent(now.value, digits) ? undefined : percent(before.value, digits);
  };

  return (
    <div className="results">
      {objectives.succeedWithin && within ? (
        <Lead
          target={objectives.succeedWithin.target}
          limit={objectives.succeedWithin.ms}
          result={within}
          napkin={analysis.napkin}
          was={was((ev) => find(ev.objectives, 'succeed_within')?.measure)}
          onChange={(succeedWithin) => onObjectives({ ...objectives, succeedWithin })}
        />
      ) : (
        <section className="lead">
          <p className="eyebrow">No promise yet</p>
          <button className="primary" onClick={() => onObjectives({ ...objectives, succeedWithin: { ms: 500, target: 0.999 } })}>
            Promise 99.9% of requests succeed within 500 ms
          </button>
        </section>
      )}

      <Breakdown doc={doc} analysis={analysis} evaluation={e} lastTargets={lastTargets} was={was} onObjectives={onObjectives} />
      <SeparateVsCombined objectives={e.objectives} />
      {find(e.objectives, 'succeed_within')?.verdict === 'missed' && actions?.done && <Path doc={doc} path={path} onFind={onFindPath} onApply={onApplyPath} />}
      <Actions doc={doc} evaluation={e} actions={actions} onApply={onApply} onHighlight={onHighlight} />
      <LossesDisclosure>
        <Losses doc={doc} analysis={analysis} evaluation={e} onHighlight={onHighlight} onSelect={onSelect} />
      </LossesDisclosure>

      {e.fullIgnoringTime.value < e.ignoringTime.value - 1e-12 && (
        <p className="aside">
          <strong>Partial answers.</strong> {within?.fullFidelity ? percent(within.fullFidelity.value, digitsFor(within.fullFidelity)) : percent(e.fullIgnoringTime.value)} of requests
          get a complete answer{within?.fullFidelity ? ` within ${within.ms} ms` : ''}. The rest succeed without an optional call, or with part of a fan-out.
        </p>
      )}

      <HowCalculated analysis={analysis} evaluation={e} />
    </div>
  );
}

// ---- The promise and its number ---------------------------------------------

function Lead({ target, limit, result, napkin, was, onChange }: {
  target: number;
  limit: number;
  result: Extract<ObjectiveResult, { kind: 'succeed_within' }>;
  napkin?: number;
  was?: string;
  onChange: (value: { target: number; ms: number }) => void;
}) {
  const m = result.measure;
  return (
    <section className={`lead ${result.verdict}`} aria-label="Your promise">
      <p className="eyebrow">You promise</p>
      <p className="sentence">
        <InlineNumber label="Share of requests" value={inputPercent(target).replace('%', '')} suffix="%" parse={(t) => parsePercent(t)} onCommit={(v) => onChange({ target: v, ms: limit })} /> of requests
        succeed within <InlineNumber label="Time limit" value={String(limit)} suffix="ms" parse={(t) => parseMs(t, false)} onCommit={(v) => onChange({ target, ms: v })} />
      </p>
      <div className="lead-value">
        <span className="big">{m ? percent(m.value, digitsFor(m)) : '…'}</span>
        <span className={`verdict ${result.verdict}`}>{VERDICT[result.verdict]}</span>
      </div>
      <p className="lead-sub">
        {m ? (
          <>
            of requests do{m.kind === 'sampled' && <span className="faint"> (±{((m.high - m.low) * 50).toFixed(digitsFor(m))})</span>}.
            {napkin !== undefined && <> Napkin math, which ignores time, says {percent(napkin)} succeed.</>}
            {was && <span className="was"> Was {was}.</span>}
          </>
        ) : (
          result.reason ?? 'Simulating…'
        )}
      </p>
    </section>
  );
}

/** A number you edit in place, inside a sentence. */
function InlineNumber({ label, value, suffix, parse, onCommit }: { label: string; value: string; suffix: string; parse: (t: string) => number | string | undefined; onCommit: (v: number) => void }) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string>();
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const v = parse(text.trim());
    if (typeof v !== 'number') {
      setError(typeof v === 'string' ? v : 'Enter a number.');
      return;
    }
    setError(undefined);
    if (text !== value) onCommit(v);
  };
  return (
    <span className="inline-number">
      <input
        aria-label={label}
        aria-invalid={error ? true : undefined}
        title={error}
        value={text}
        size={Math.max(1, text.length)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(value);
            setError(undefined);
          }
        }}
      />
      {suffix === '%' ? '%' : `\u00a0${suffix}`}
    </span>
  );
}

function NapkinVerdict({ napkin, modeled }: { napkin: number; modeled: number }) {
  const delta = ninesDelta(napkin, modeled);
  if (Math.abs(delta) < 0.05) return <>and agrees.</>;
  return <span className={delta > 0 ? 'bad-text' : 'warn-text'}>{delta > 0 ? 'too optimistic' : 'too pessimistic'} by {Math.abs(delta).toFixed(1)} nines.</span>;
}

// ---- How the number comes about ---------------------------------------------

export interface LastTargets {
  availability?: number;
  latency?: { percentile: number; ms: number };
}

function Breakdown({ doc, analysis, evaluation: e, lastTargets, was, onObjectives }: {
  doc: Doc;
  analysis: Analysis;
  evaluation: Evaluation;
  lastTargets: LastTargets;
  was: (pick: (ev: Evaluation) => Measure | undefined) => string | undefined;
  onObjectives: (o: Objectives) => void;
}) {
  const objectives = doc.objectives;
  const within = find(e.objectives, 'succeed_within');
  const limit = objectives.succeedWithin?.ms;
  const availability = find(e.objectives, 'availability');
  const latencies = e.objectives.filter((o): o is Extract<ObjectiveResult, { kind: 'latency' }> => o.kind === 'latency');
  const p99 = e.latency.status === 'sampled' ? e.latency.percentiles?.p99 : undefined;
  const succeed = e.withTimeouts;

  return (
    <section className="breakdown" aria-label="Breakdown">
      <div className="factor">
        <span className="factor-label">Succeed at all</span>
        <span className="factor-value">{succeed ? percent(succeed.value, digitsFor(succeed)) : '…'}</span>
        <span className="factor-note">
          {e.hasTimeouts && succeed ? `${percent(e.ignoringTime.value)} if nothing timed out. ` : ''}
          {analysis.napkin !== undefined && (
            <>
              Napkin math: {percent(analysis.napkin)}, <NapkinVerdict napkin={analysis.napkin} modeled={e.ignoringTime.value} />
            </>
          )}
          {was((ev) => ev.withTimeouts) && <span className="was"> Was {was((ev) => ev.withTimeouts)}.</span>}
        </span>
        <span className="targets">
          {objectives.availability !== undefined ? (
            <Target
              verdict={availability?.verdict}
              label="Availability target"
              prefix="target ≥"
              value={inputPercent(objectives.availability).replace('%', '')}
              suffix="%"
              parse={parsePercent}
              onChange={(v) => onObjectives({ ...objectives, availability: v })}
              onRemove={() => {
                lastTargets.availability = objectives.availability;
                onObjectives({ ...objectives, availability: undefined });
              }}
            />
          ) : (
            <AddTarget onAdd={() => onObjectives({ ...objectives, availability: lastTargets.availability ?? objectives.succeedWithin?.target ?? 0.999 })} />
          )}
        </span>
      </div>
      {limit !== undefined && (
        <div className="factor">
          <span className="factor-label">…and answer within {limit} ms</span>
          <span className="factor-value">{within?.fastShare ? percent(within.fastShare.value, digitsFor(within.fastShare)) : '…'}</span>
          <span className="factor-note">
            of the requests that succeed.
            {p99 !== undefined && ` Their p99 is ${ms(p99)}`}
            {p99 !== undefined && analysis.napkinP99 !== undefined && `; adding up p99s would say ${ms(analysis.napkinP99)}`}
            {p99 !== undefined && '.'}
          </span>
          <span className="targets">
            {objectives.latency.map((l, i) => (
              <Target
                key={`${l.percentile}`}
                verdict={latencies.find((o) => o.percentile === l.percentile)?.verdict}
                label={`${pName(l.percentile)} target`}
                prefix={`target ${pName(l.percentile)} ≤`}
                value={String(l.ms)}
                suffix="ms"
                parse={(t) => parseMs(t, false)}
                onChange={(v) => onObjectives(withLatencyObjective(objectives, i, { ...l, ms: v }))}
                onRemove={() => {
                  lastTargets.latency = l;
                  onObjectives(withLatencyObjective(objectives, i, undefined));
                }}
              />
            ))}
            {objectives.latency.length === 0 && (
              <AddTarget onAdd={() => onObjectives(withLatencyObjective(objectives, 0, lastTargets.latency ?? { percentile: 0.99, ms: limit }))} />
            )}
          </span>
        </div>
      )}
    </section>
  );
}

/** A separate target on its row: edit the number in place, or remove it. */
function Target({ verdict, label, prefix, value, suffix, parse, onChange, onRemove }: {
  verdict?: Verdict;
  label: string;
  prefix: string;
  value: string;
  suffix: string;
  parse: (t: string) => number | string | undefined;
  onChange: (v: number) => void;
  onRemove: () => void;
}) {
  return (
    <span className={`target-chip ${verdict ?? 'unclear'}`}>
      {verdict && <Icon name={verdict === 'met' ? 'check' : verdict === 'missed' ? 'cross' : 'question'} size={12} />}
      {prefix} <InlineNumber label={label} value={value} suffix={suffix} parse={parse} onCommit={onChange} />
      <button className="chip-remove" onClick={onRemove} aria-label={`Remove the ${label.toLowerCase()}`} title="Remove this target">
        <Icon name="close" size={11} />
      </button>
    </span>
  );
}

function AddTarget({ onAdd }: { onAdd: () => void }) {
  return (
    <button className="target-add" onClick={onAdd} title="Also hold this part to a target of its own">
      <Icon name="plus" size={12} /> Add a target
    </button>
  );
}

/** Calls out the case the combined promise exists for. */
function SeparateVsCombined({ objectives }: { objectives: ObjectiveResult[] }) {
  const availability = find(objectives, 'availability');
  const latency = objectives.filter((o) => o.kind === 'latency');
  const combined = find(objectives, 'succeed_within');
  if (!availability || latency.length === 0 || !combined) return null;
  if (availability.verdict !== 'met' || latency.some((o) => o.verdict !== 'met') || combined.verdict !== 'missed') return null;
  return (
    <p className="insight">
      Both separate targets are met, yet the promise is broken. Availability counts slow successes as good, and a latency target only looks at requests that succeeded, so
      together they still let a request be failed or slow.
    </p>
  );
}

// ---- What would help most ---------------------------------------------------

const SHOWN = 4;

function Actions({ doc, evaluation: e, actions, onApply, onHighlight }: { doc: Doc; evaluation: Evaluation; actions?: ActionsState; onApply: (spec: ActionSpec) => void; onHighlight: (t: Selection) => void }) {
  const within = find(e.objectives, 'succeed_within');
  const promise = doc.objectives.succeedWithin;
  const measuring = promise ? `succeed within ${promise.ms} ms` : 'succeed';
  const clear = actions?.list.filter((a) => a.clear) ?? [];
  const unclear = (actions?.list.length ?? 0) - clear.length;
  const broken = within?.verdict === 'missed';
  return (
    <section className="actions-list" aria-labelledby="actions-title" aria-busy={!actions?.done}>
      <h3 id="actions-title">What would help most</h3>
      {!actions || (actions.list.length === 0 && !actions.done) ? (
        <p className="section-intro">Trying changes aimed at where requests are lost…</p>
      ) : (
        <>
          <p className="section-intro">
            Each change tried on its own, ranked by how many more requests {measuring}.
            {!actions.done && ` Tried ${actions.tried} of ${actions.total}…`}
          </p>
          {clear.length === 0 && actions.done && <p className="aside">None of the changes tried made a clear difference.</p>}
          <ol>
            {clear.slice(0, SHOWN).map((action) => {
              const { title, detail, target } = describeAction(doc, action.spec);
              const tradeoffs: string[] = [];
              if (action.partialAfter !== undefined && action.partialBefore !== undefined) tradeoffs.push(`${share(action.partialAfter - action.partialBefore)} more answers would be partial`);
              if (action.p99After !== undefined && action.p99Before !== undefined && action.p99After > action.p99Before * 1.1) tradeoffs.push(`p99 rises from ${ms(action.p99Before)} to ${ms(action.p99After)}`);
              return (
                <li key={JSON.stringify(action.spec)} onMouseEnter={() => onHighlight(target)} onMouseLeave={() => onHighlight(undefined)}>
                  <span className="gain" title={`${percent(action.after, decimalsFor(action.after))} would ${measuring}`}>
                    +{share(action.gain.value)}
                    <span className="gain-after">→ {percent(action.after, Math.min(3, decimalsFor(action.after)))}</span>
                  </span>
                  <span className="action-body">
                    <span className="action-title">{title}</span>
                    <span className="action-detail">{detail}</span>
                    {action.keepsPromise && <span className="keeps">Keeps the promise</span>}
                    {tradeoffs.length > 0 && <span className="tradeoff">Trade-off: {tradeoffs.join('; ')}.</span>}
                  </span>
                  <button className="apply" onClick={() => onApply(action.spec)} onFocus={() => onHighlight(target)} onBlur={() => onHighlight(undefined)}>
                    Apply
                  </button>
                </li>
              );
            })}
          </ol>
          {actions.done && broken && clear.length > 0 && !clear.some((a) => a.keepsPromise) && (
            <p className="aside">No single change keeps the promise. Find a path above, or apply one and the list is worked out again for what’s left.</p>
          )}
          {actions.done && unclear > 0 && <p className="fine">{unclear === 1 ? 'One other change' : `${unclear} other changes`} made no clear difference.</p>}
        </>
      )}
    </section>
  );
}

// ---- A path to the promise --------------------------------------------------

function Path({ doc, path, onFind, onApply }: { doc: Doc; path?: PathState; onFind: (allowPartial: boolean) => void; onApply: (steps: PathStep[]) => void }) {
  const promise = doc.objectives.succeedWithin!;
  const allowPartial = path?.allowPartial ?? false;
  const p = path?.progress;
  const toggle = (
    <label className="check small">
      <input type="checkbox" checked={allowPartial} onChange={(e) => onFind(e.target.checked)} />
      Allow partial answers (optional calls, some fan-out copies missing)
    </label>
  );

  if (!path) {
    return (
      <section className="path idle" aria-label="Path to the promise">
        <div>
          <h3>What would it take?</h3>
          <p className="section-intro">Apply the change that helps most, re-rank, repeat, until the promise is kept.</p>
        </div>
        <button className="primary" onClick={() => onFind(false)}>
          Find a path to the promise
        </button>
      </section>
    );
  }

  const pct = (v: number) => percent(v, Math.min(3, decimalsFor(v)));
  const done = p?.outcome !== undefined;
  let headline: string;
  if (!done) headline = p?.searching ? `Step ${p.searching.step}: trying ${p.searching.total ? `${p.searching.tried} of ${p.searching.total}` : 'the best'} changes…` : 'Working out where it stands…';
  else if (p!.outcome === 'reached') headline = p!.steps.length === 1 ? 'Kept with one change' : `Kept with ${p!.steps.length} changes`;
  else headline = `Not kept after ${p!.steps.length} ${p!.steps.length === 1 ? 'change' : 'changes'}`;

  // What remains when the path falls short: failures, or time.
  let remaining: string | undefined;
  if (done && p!.outcome !== 'reached' && p!.succeedAtAll !== undefined && p!.fastShare !== undefined) {
    remaining =
      p!.succeedAtAll >= promise.target
        ? `What’s left is time: ${share(1 - p!.fastShare)} of successful requests take longer than ${promise.ms} ms.`
        : `What’s left is failures: ${share(1 - p!.succeedAtAll)} of requests fail.`;
    if (p!.outcome === 'stuck') remaining += ' None of the remaining changes tried makes a clear difference.';
  }
  const tradeoffs: string[] = [];
  if (done && p!.partialAfter !== undefined && p!.partialBefore !== undefined && p!.partialAfter > p!.partialBefore + 0.0005) {
    tradeoffs.push(`${share(p!.partialAfter - p!.partialBefore)} more answers would be partial`);
  }
  if (done && p!.p99After !== undefined && p!.p99Before !== undefined && p!.p99After > p!.p99Before * 1.1) tradeoffs.push(`p99 rises from ${ms(p!.p99Before)} to ${ms(p!.p99After)}`);

  return (
    <section className={`path ${done ? p!.outcome : 'running'}`} aria-label="Path to the promise" aria-busy={!done}>
      <h3>{headline}</h3>
      {p && (
        <ol className="path-steps">
          <li className="start">
            <span>Today</span>
            <span className="value">{pct(p.start)}</span>
          </li>
          {p.steps.map((step, i) => (
            <li key={i}>
              <span>{step.title}</span>
              <span className="value">{pct(step.after)}</span>
            </li>
          ))}
          <li className="goal">
            <span>The promise</span>
            <span className="value">{pct(promise.target)}</span>
          </li>
        </ol>
      )}
      {done && p!.narrow && <p className="fine">It clears the promise by less than the simulation’s margin of error.</p>}
      {remaining && <p className="aside">{remaining}</p>}
      {tradeoffs.length > 0 && <p className="tradeoff">Trade-off: {tradeoffs.join('; ')}.</p>}
      {toggle}
      {done && p!.steps.length > 0 && (
        <div className="row-actions start">
          <button className="primary" onClick={() => onApply(p!.steps)}>
            Apply {p!.steps.length === 1 ? 'this change' : `all ${p!.steps.length} changes`}
          </button>
        </div>
      )}
    </section>
  );
}

// ---- Where requests are lost ------------------------------------------------

interface LossRow {
  key: string;
  target: Selection;
  label: string;
  detail: string;
  value: number;
}

function Losses({ doc, analysis, evaluation, onHighlight, onSelect }: { doc: Doc; analysis: Analysis; evaluation: Evaluation; onHighlight: (t: Selection) => void; onSelect: (t: Selection) => void }) {
  const rows: LossRow[] = [];
  const trials = evaluation.latency.status === 'sampled' ? evaluation.latency.trials : 0;
  // A simulated loss backed by a handful of requests is noise.
  for (const loss of evaluation.timeoutLosses.filter((l) => l.share.value * trials >= 5)) {
    const call = doc.calls[loss.edge]!;
    rows.push({
      key: `t${loss.edge}`,
      target: { kind: 'call', index: loss.edge },
      label: `${nodeName(doc, loss.to)} answers too late`,
      detail: `cut off by the ${call.timeoutMs} ms timeout`,
      value: loss.share.value,
    });
  }
  for (const lever of analysis.levers ?? []) {
    const node = doc.nodes.find((n) => n.id === lever.id)!;
    const how =
      lever.ifNoFlaky < 0.1 * lever.ifNoOutages
        ? 'outages, which retries can’t fix'
        : lever.ifNoOutages < 0.1 * lever.ifNoFlaky
          ? 'flaky failures, which retries can fix'
          : `${failureMode(node.transient).toLowerCase()}`;
    rows.push({ key: `f${lever.id}`, target: { kind: 'node', id: lever.id }, label: `${nodeName(doc, lever.id)} fails`, detail: how, value: lever.ifPerfect });
  }
  const shown = rows.filter((r) => r.value >= 1e-5).sort((a, b) => b.value - a.value).slice(0, 5);
  if (shown.length === 0) return null;
  const max = shown[0]!.value;
  return (
    <section className="losses" aria-label="Where requests are lost">
      <p className="section-intro">Share of all requests lost to each cause. Point at one to find it on the graph.</p>
      <ol>
        {shown.map((row) => (
          <li key={row.key}>
            <button onMouseEnter={() => onHighlight(row.target)} onMouseLeave={() => onHighlight(undefined)} onFocus={() => onHighlight(row.target)} onBlur={() => onHighlight(undefined)} onClick={() => onSelect(row.target)}>
              <span className="loss-label">
                {row.label}
                <span className="sub">{row.detail}</span>
              </span>
              <span className="loss-value">{share(row.value)}</span>
              <span className="bar" style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }} />
            </button>
          </li>
        ))}
      </ol>
      <p className="fine">A failing service is credited with what you’d win back if it never failed. With redundancy these can overlap.</p>
    </section>
  );
}

/** "Where requests are lost", collapsed under the ranked actions and remembered open or closed. */
function LossesDisclosure({ children }: { children: ReactNode }) {
  const [open, setOpen] = useRememberedOpen('losses');
  return (
    <details className="how losses-disclosure" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <Icon name="chevron" size={14} /> Where requests are lost
      </summary>
      {children}
    </details>
  );
}

function HowCalculated({ analysis, evaluation: e }: { analysis: Analysis; evaluation: Evaluation }): ReactNode {
  const result = analysis.availability;
  return (
    <details className="how">
      <summary>
        <Icon name="chevron" size={14} /> How these numbers are calculated
      </summary>
      <p>
        <strong>Failures are counted exactly.</strong> An outage lasts a whole request, so the model goes through every combination of simultaneous outages
        {result ? ` (${result.statesEvaluated.toLocaleString()} here)` : ''} and works out exactly how likely a request is to succeed, retries and fallbacks included.{' '}
        {e.ignoringTime.kind === 'bounded'
          ? `It stopped early this time, so the true value lies between ${percent(e.ignoringTime.low)} and ${percent(e.ignoringTime.high)}.`
          : 'What it leaves out is under one in a billion.'}
      </p>
      <p>
        <strong>Time is simulated.</strong>{' '}
        {e.latency.status === 'sampled' ? `${e.latency.trials.toLocaleString()} requests are simulated` : 'Requests are simulated'}, with each service’s latency drawn from its
        p50 and p99. Each one runs twice, with and without timeouts, so the requests that timeouts cost are counted directly. These numbers carry a ± for their 95% interval.
      </p>
      <p>
        <strong>Napkin math</strong> multiplies availabilities as if every failure were independent: a shared dependency counts once per caller, and a retry re-rolls everything
        below it. It ignores time altogether.
      </p>
      {e.ignoringTime.kind === 'bounded' && <p>Enumeration bound: {scientific(e.ignoringTime.high - e.ignoringTime.low)}.</p>}
    </details>
  );
}
