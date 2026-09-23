import { type ReactNode, useState } from 'react';
import type { Analysis } from '../analysis';
import { percentileKey, withLatencyObjective } from '../doc';
import type { Doc } from '../doc';
import type { Objectives } from '../model/inputs';
import type { Evaluation, Measure, ObjectiveResult, Verdict } from '../model/slo';
import { Field, parseMs, parsePercent } from './controls';
import { decimalsFor, decimalsForInterval, inputPercent, ms, ninesDelta, percent, scientific } from './format';
import type { Selection } from './Graph';
import { Icon } from './icons';
import { callName, nodeName, share } from './words';

interface Props {
  doc: Doc;
  analysis: Analysis;
  evaluation: Evaluation;
  /** The lesson as loaded, to compare against once edited. */
  baseline?: Evaluation;
  onObjectives: (objectives: Objectives) => void;
  onHighlight: (target: Selection) => void;
  onSelect: (target: Selection) => void;
}

const PERCENTILES = [0.5, 0.9, 0.95, 0.99, 0.999];
const pName = (p: number) => `p${+(p * 100).toFixed(1)}`;
export const digitsFor = (m: Measure) => (m.kind === 'sampled' ? decimalsForInterval(m.low, m.high) : decimalsFor(m.value));
const find = <K extends ObjectiveResult['kind']>(objectives: ObjectiveResult[], kind: K) =>
  objectives.find((o): o is Extract<ObjectiveResult, { kind: K }> => o.kind === kind);

type Editing = { kind: 'availability' } | { kind: 'latency'; index: number } | { kind: 'succeed_within' } | undefined;

export function Results({ doc, analysis, evaluation: e, baseline, onObjectives, onHighlight, onSelect }: Props) {
  const [editing, setEditing] = useState<Editing>();
  const objectives = doc.objectives;
  const availability = find(e.objectives, 'availability');
  const latencies = e.objectives.filter((o): o is Extract<ObjectiveResult, { kind: 'latency' }> => o.kind === 'latency');
  const within = find(e.objectives, 'succeed_within');

  // Availability as customers see it: with timeouts, once known.
  const available = e.withTimeouts;
  const availabilityDetail = e.hasTimeouts
    ? available
      ? `${percent(e.ignoringTime.value)} ignoring timeouts`
      : e.latency.status === 'missing'
        ? 'needs latency on every service'
        : 'simulating timeouts…'
    : undefined;

  const was = (pick: (ev: Evaluation) => Measure | undefined) => {
    const before = baseline && pick(baseline);
    const now = pick(e);
    if (!before || !now) return undefined;
    const digits = Math.min(digitsFor(before), digitsFor(now));
    return percent(before.value, digits) === percent(now.value, digits) ? undefined : percent(before.value, digits);
  };

  const p99 = e.latency.status === 'sampled' ? e.latency.percentiles?.p99 : undefined;
  const latencyRows = latencies.length > 0 ? latencies : [undefined];

  return (
    <div className="results">
      <Headline objectives={e.objectives} doc={doc} />

      <Metric
        title="Availability"
        verdict={availability?.verdict}
        model={available ? <MeasureValue measure={available} /> : <span className="muted">{e.latency.status === 'missing' ? 'needs latency' : '…'}</span>}
        napkin={analysis.napkin !== undefined ? <>{percent(analysis.napkin)}<NapkinNote napkin={analysis.napkin} modeled={e.ignoringTime.value} /></> : '—'}
        promise={
          <PromiseCell
            verdict={availability?.verdict}
            onEdit={() => {
              if (objectives.availability === undefined) onObjectives({ ...objectives, availability: 0.999 });
              setEditing({ kind: 'availability' });
            }}
          >
            {objectives.availability !== undefined ? `≥ ${inputPercent(objectives.availability)}` : undefined}
          </PromiseCell>
        }
        note={[availabilityDetail, was((ev) => ev.withTimeouts) && `was ${was((ev) => ev.withTimeouts)}`].filter(Boolean).join(' · ')}
      />
      {latencyRows.map((o, index) => {
        const percentile = o?.percentile ?? 0.99;
        const observed = o ? o.observedMs : p99;
        return (
          <Metric
            key={index}
            title={`Latency ${pName(percentile)}`}
            verdict={o?.verdict}
            model={observed !== undefined ? <span className="value">{ms(observed)}</span> : <span className="muted">{e.latency.status === 'missing' ? 'not modeled' : '…'}</span>}
            napkin={percentile === 0.99 && analysis.napkinP99 !== undefined ? ms(analysis.napkinP99) : '—'}
            promise={
              <PromiseCell
                verdict={o?.verdict}
                onEdit={() => {
                  if (!o) onObjectives(withLatencyObjective(objectives, objectives.latency.length, { percentile: 0.99, ms: 500 }));
                  setEditing({ kind: 'latency', index: o ? index : objectives.latency.length });
                }}
              >
                {o ? `≤ ${o.ms} ms` : undefined}
              </PromiseCell>
            }
            note={e.latency.status === 'sampled' ? 'Of requests that succeeded. Napkin adds up p99s along the slowest path.' : undefined}
          />
        );
      })}
      {within && (
        <Metric
          title={`Succeed within ${within.ms} ms`}
          verdict={within.verdict}
          model={within.measure ? <MeasureValue measure={within.measure} /> : <span className="muted">…</span>}
          napkin="—"
          promise={
            <PromiseCell verdict={within.verdict} onEdit={() => setEditing({ kind: 'succeed_within' })}>
              ≥ {inputPercent(within.target)}
            </PromiseCell>
          }
          note={[within.reason, was((ev) => find(ev.objectives, 'succeed_within')?.measure) && `was ${was((ev) => find(ev.objectives, 'succeed_within')?.measure)}`].filter(Boolean).join(' · ')}
        />
      )}

      {editing && <PromiseEditor editing={editing} objectives={objectives} onObjectives={onObjectives} onDone={() => setEditing(undefined)} />}
      {!editing && !within && (
        <button
          className="text-button"
          onClick={() => {
            onObjectives({ ...objectives, succeedWithin: { ms: objectives.latency[0]?.ms ?? 500, target: objectives.availability ?? 0.999 } });
            setEditing({ kind: 'succeed_within' });
          }}
        >
          <Icon name="plus" size={14} /> Promise success within a time
        </button>
      )}
      <SeparateVsCombined objectives={e.objectives} />

      <Losses doc={doc} analysis={analysis} evaluation={e} onHighlight={onHighlight} onSelect={onSelect} />

      {e.fullIgnoringTime.value < e.ignoringTime.value - 1e-12 && (
        <p className="aside">
          <strong>Degraded answers.</strong> {percent(e.fullIgnoringTime.value)} of requests get every call answered in full
          {within?.fullFidelity && `, ${percent(within.fullFidelity.value, digitsFor(within.fullFidelity))} within ${within.ms} ms`}. The rest succeed without an optional
          call or with part of a fan-out.
        </p>
      )}

      <HowCalculated analysis={analysis} evaluation={e} />
    </div>
  );
}

function Headline({ objectives, doc }: { objectives: ObjectiveResult[]; doc: Doc }) {
  if (objectives.length === 0) {
    return (
      <header className="headline">
        <p className="eyebrow">No promise yet</p>
        <p className="sentence">Set a target in the table below to check this system against it.</p>
      </header>
    );
  }
  const { availability, latency, succeedWithin } = doc.objectives;
  const parts: string[] = [];
  if (succeedWithin) parts.push(`${inputPercent(succeedWithin.target)} of requests succeed within ${succeedWithin.ms} ms`);
  else if (availability !== undefined) parts.push(`${inputPercent(availability)} of requests succeed`);
  if (!succeedWithin) for (const l of latency) parts.push(`${pName(l.percentile)} stays under ${l.ms} ms`);
  const missed = objectives.filter((o) => o.verdict === 'missed').length;
  const unclear = objectives.filter((o) => o.verdict === 'unclear').length;
  const verdict: Verdict = missed > 0 ? 'missed' : unclear > 0 ? 'unclear' : 'met';
  return (
    <header className={`headline ${verdict}`}>
      <p className="eyebrow">You promise</p>
      <p className="sentence">{joinWords(parts)}.</p>
      <p className="verdict-line">
        <span className={`verdict ${verdict}`}>{verdict === 'met' ? 'Kept' : verdict === 'missed' ? 'Broken' : "Can't tell yet"}</span>
        <span className="muted">
          {missed > 0 ? `${missed} of ${objectives.length} ${objectives.length === 1 ? 'target' : 'targets'} missed` : unclear > 0 ? 'still simulating, or too close to call' : `all ${objectives.length} ${objectives.length === 1 ? 'target' : 'targets'} met`}
        </span>
      </p>
    </header>
  );
}

const joinWords = (parts: string[]) => (parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);

const VERDICT_WORD: Record<Verdict, string> = { met: 'Met', missed: 'Missed', unclear: "Can't tell" };

function Metric({ title, verdict, model, napkin, promise, note }: { title: string; verdict?: Verdict; model: ReactNode; napkin: ReactNode; promise: ReactNode; note?: string }) {
  return (
    <section className={`metric ${verdict ?? ''}`} aria-label={title}>
      <header>
        <h3>{title}</h3>
        {verdict && <span className={`verdict ${verdict}`}>{VERDICT_WORD[verdict]}</span>}
      </header>
      <dl className="trio">
        <div className="model">
          <dt>Model</dt>
          <dd>{model}</dd>
        </div>
        <div className="napkin">
          <dt>Napkin</dt>
          <dd>{napkin}</dd>
        </div>
        <div className="promise">
          <dt>Promise</dt>
          <dd>{promise}</dd>
        </div>
      </dl>
      {note && <p className="metric-note">{note}</p>}
    </section>
  );
}

function MeasureValue({ measure }: { measure: Measure }) {
  const digits = digitsFor(measure);
  const title =
    measure.kind === 'sampled'
      ? `Estimate, 95% interval ${percent(measure.low, digits)}–${percent(measure.high, digits)}`
      : measure.kind === 'bounded'
        ? `At least; the enumeration stopped early (bound ${scientific(measure.high - measure.low)})`
        : 'Exact';
  return (
    <span className="value" title={title}>
      {measure.kind === 'bounded' && '≥ '}
      {percent(measure.value, digits)}
      {measure.kind === 'sampled' && <span className="interval"> ±{((measure.high - measure.low) * 50).toFixed(Math.max(0, digits))}</span>}
    </span>
  );
}

function NapkinNote({ napkin, modeled }: { napkin: number; modeled: number }) {
  const delta = ninesDelta(napkin, modeled);
  if (Math.abs(delta) < 0.05) return <span className="sub">matches, ignoring time</span>;
  return <span className={`sub ${delta > 0 ? 'bad-text' : 'warn-text'}`}>{delta > 0 ? 'optimistic' : 'pessimistic'} by {Math.abs(delta).toFixed(1)} nines</span>;
}

function PromiseCell({ verdict, children, onEdit }: { verdict?: Verdict; children?: ReactNode; onEdit: () => void }) {
  if (children === undefined) {
    return (
      <button className="text-button" onClick={onEdit}>
        <Icon name="plus" size={13} /> Set
      </button>
    );
  }
  return (
    <button className={`promise-value ${verdict ?? ''}`} onClick={onEdit} aria-label={`Edit the promise ${String(children)}`}>
      {children}
    </button>
  );
}

function PromiseEditor({ editing, objectives, onObjectives, onDone }: { editing: NonNullable<Editing>; objectives: Objectives; onObjectives: (o: Objectives) => void; onDone: () => void }) {
  const share = (value: number, set: (v: number) => void) => (
    <Field label="At least" value={inputPercent(value).replace('%', '')} suffix="% of requests" width={70} onCommit={(t) => { const v = parsePercent(t); if (typeof v === 'string') return v; set(v); }} />
  );
  const limit = (label: string, value: number, set: (v: number) => void) => (
    <Field label={label} value={String(value)} suffix="ms" width={64} onCommit={(t) => { const v = parseMs(t, false); if (typeof v !== 'number') return v; set(v); }} />
  );
  let title: string;
  let body: ReactNode;
  let remove: () => void;
  if (editing.kind === 'availability') {
    title = 'Availability promise';
    body = share(objectives.availability ?? 0.999, (v) => onObjectives({ ...objectives, availability: v }));
    remove = () => onObjectives({ ...objectives, availability: undefined });
  } else if (editing.kind === 'succeed_within') {
    const sw = objectives.succeedWithin!;
    title = 'Success within a time';
    body = (
      <div className="pair">
        {share(sw.target, (v) => onObjectives({ ...objectives, succeedWithin: { ...sw, target: v } }))}
        {limit('Within', sw.ms, (v) => onObjectives({ ...objectives, succeedWithin: { ...sw, ms: v } }))}
      </div>
    );
    remove = () => onObjectives({ ...objectives, succeedWithin: undefined });
  } else {
    const l = objectives.latency[editing.index] ?? { percentile: 0.99, ms: 500 };
    const used = new Set(objectives.latency.map((x, i) => (i === editing.index ? -1 : x.percentile)));
    title = 'Latency promise, for successful requests';
    body = (
      <div className="pair">
        <div className="field">
          <label htmlFor="percentile">Percentile</label>
          <select id="percentile" value={l.percentile} onChange={(ev) => onObjectives(withLatencyObjective(objectives, editing.index, { ...l, percentile: Number(ev.target.value) }))}>
            {PERCENTILES.filter((p) => !used.has(p)).map((p) => (
              <option key={p} value={p}>
                {pName(p)} ({percentileKey(p)})
              </option>
            ))}
          </select>
        </div>
        {limit('At most', l.ms, (v) => onObjectives(withLatencyObjective(objectives, editing.index, { ...l, ms: v })))}
      </div>
    );
    remove = () => onObjectives(withLatencyObjective(objectives, editing.index, undefined));
  }
  return (
    <div className="promise-editor">
      <p className="editor-title">{title}</p>
      {body}
      <div className="row-actions">
        <button className="text-button danger" onClick={() => { remove(); onDone(); }}>
          Remove
        </button>
        <button onClick={onDone}>Done</button>
      </div>
    </div>
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
      Both separate targets hold, but the combined promise doesn't. Availability counts a slow success as good, and a latency percentile only looks at requests that
      succeeded, so together they still let a request be failed or slow.
    </p>
  );
}

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
    rows.push({ key: `t${loss.edge}`, target: { kind: 'call', index: loss.edge }, label: `${callName(doc, loss.edge)} timeouts`, detail: 'requests its timeout cut off', value: loss.share.value });
  }
  for (const lever of analysis.levers ?? []) {
    const mostly = lever.ifNoFlaky < 0.1 * lever.ifNoOutages ? 'outages, which retries can’t fix' : lever.ifNoOutages < 0.1 * lever.ifNoFlaky ? 'flaky failures' : 'outages and flaky failures';
    rows.push({ key: `f${lever.id}`, target: { kind: 'node', id: lever.id }, label: `${nodeName(doc, lever.id)} failures`, detail: mostly, value: lever.ifPerfect });
  }
  const shown = rows.filter((r) => r.value >= 1e-5).sort((a, b) => b.value - a.value).slice(0, 6);
  if (shown.length === 0) return null;
  const max = shown[0]!.value;
  return (
    <section className="losses" aria-labelledby="losses-title">
      <h3 id="losses-title">Where requests are lost</h3>
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
      <p className="fine">Failures: what you'd get back if the service never failed. Timeouts: requests they cost. Hover to find them on the graph.</p>
    </section>
  );
}

function HowCalculated({ analysis, evaluation: e }: { analysis: Analysis; evaluation: Evaluation }) {
  const result = analysis.availability;
  return (
    <details className="how">
      <summary>
        <Icon name="chevron" size={14} /> How these numbers are calculated
      </summary>
      <p>
        <strong>Availability ignoring time is exact.</strong> Outages last a whole request, so the model enumerates every combination of simultaneous outages
        {result ? ` (${result.statesEvaluated.toLocaleString()} here)` : ''} and, for each, works out exactly how likely the request is to succeed, retries and failover
        included.{' '}
        {e.ignoringTime.kind === 'bounded'
          ? `It stopped early this time, so the true value lies between ${percent(e.ignoringTime.low)} and ${percent(e.ignoringTime.high)}.`
          : 'What it leaves out is below one in a billion.'}
      </p>
      <p>
        <strong>Anything involving time is simulated.</strong>{' '}
        {e.latency.status === 'sampled'
          ? `${e.latency.trials.toLocaleString()} requests are simulated with latencies drawn from each service's p50 and p99. `
          : 'Requests are simulated with latencies drawn from each service’s p50 and p99. '}
        Each one is followed twice, with and without timeouts, so the requests timeouts cost are counted directly and subtracted from the exact figure. Estimates show their
        95% interval.
      </p>
      <p>
        <strong>Napkin math</strong> multiplies availabilities as if every failure were independent: a shared dependency counts once per caller, and a retry re-rolls
        everything below it. Napkin p99 adds up p99s along the slowest path.
      </p>
      <p>
        <strong>Where requests are lost.</strong> A service's figure is a what-if from the exact model: the availability you'd gain if it never failed. With redundancy these
        don't add up. Timeout figures come from the simulation and do.
      </p>
    </details>
  );
}
