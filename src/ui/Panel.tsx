import { useState } from 'react';
import type { Analysis } from '../analysis';
import { percentileKey, withLatencyObjective } from '../doc';
import type { Objectives } from '../model/inputs';
import type { Evaluation, Measure, ObjectiveResult, Verdict } from '../model/slo';
import { Field, parseMs, parsePercent } from './controls';
import { decimalsFor, decimalsForInterval, formatNines, inputPercent, ms, ninesDelta, percent, scientific } from './format';

interface Props {
  analysis: Analysis;
  evaluation: Evaluation;
  /** The scenario as loaded, to compare against once edited. */
  baseline?: Evaluation;
  objectives: Objectives;
  onObjectives: (objectives: Objectives) => void;
}

const PERCENTILES = [0.5, 0.9, 0.95, 0.99, 0.999];
const pName = (p: number) => `p${+(p * 100).toFixed(1)}`;

export function Panel({ analysis, evaluation: e, baseline, objectives, onObjectives }: Props) {
  const within = findKind(e.objectives, 'succeed_within');
  const was = (pick: (ev: Evaluation) => Measure | undefined) => {
    const before = baseline && pick(baseline);
    const now = pick(e);
    if (!before || !now) return undefined;
    const digits = Math.min(digitsFor(before), digitsFor(now));
    return percent(before.value, digits) === percent(now.value, digits) ? undefined : percent(before.value, digits);
  };

  return (
    <div className="panel">
      <section aria-labelledby="promises-title">
        <h2 id="promises-title">Promises</h2>
        <Promises evaluation={e} baseline={baseline} objectives={objectives} onObjectives={onObjectives} />
        <SeparateVsCombined objectives={e.objectives} />
      </section>

      <section aria-labelledby="funnel-title">
        <h2 id="funnel-title">Where requests go</h2>
        <ol className="funnel">
          <Step
            title="Succeed, ignoring time"
            measure={e.ignoringTime}
            was={was((ev) => ev.ignoringTime)}
            note={
              <>
                {e.ignoringTime.kind === 'bounded' ? boundedNote(e.ignoringTime) : 'Failures alone. Nothing below can beat it.'}
                {analysis.napkin !== undefined && (
                  <>
                    {' '}
                    Napkin math says {percent(analysis.napkin)}, <NapkinVerdict napkin={analysis.napkin} modeled={e.ignoringTime.value} />.
                  </>
                )}
              </>
            }
          />
          {e.hasTimeouts ? (
            <Step
              title="Succeed with timeouts"
              measure={e.withTimeouts}
              was={was((ev) => ev.withTimeouts)}
              pending={e.latency.status === 'missing' ? 'Needs latency on every service.' : 'Simulating…'}
              note="What customers see as availability: a hard call that times out is an error."
            />
          ) : (
            <li className="step same">
              <span className="step-title">Succeed with timeouts</span>
              <span className="step-note">Same: no hard call has a timeout.</span>
            </li>
          )}
          {within && (
            <Step title={`Succeed within ${within.ms} ms`} measure={within.measure} was={was((ev) => findKind(ev.objectives, 'succeed_within')?.measure)} note="Succeeded, and in time." />
          )}
        </ol>
      </section>

      <Details analysis={analysis} evaluation={e} />
    </div>
  );
}

function findKind<K extends ObjectiveResult['kind']>(objectives: ObjectiveResult[], kind: K) {
  return objectives.find((o): o is Extract<ObjectiveResult, { kind: K }> => o.kind === kind);
}

function Step({ title, measure, was, note, pending }: { title: string; measure?: Measure; was?: string; note: React.ReactNode; pending?: string }) {
  return (
    <li className="step">
      <span className="step-title">{title}</span>
      {measure ? <Value measure={measure} was={was} /> : <span className="pending">{pending}</span>}
      <span className="step-note">{note}</span>
    </li>
  );
}

/** Display decimals: from the interval for estimates, from the value for exact figures. */
export function digitsFor(measure: Measure): number {
  return measure.kind === 'sampled' ? decimalsForInterval(measure.low, measure.high) : decimalsFor(measure.value);
}

function Value({ measure, was }: { measure: Measure; was?: string }) {
  const digits = digitsFor(measure);
  const range =
    measure.kind === 'sampled'
      ? `95% CI ${percent(measure.low, digits)}–${percent(measure.high, digits)}`
      : measure.kind === 'bounded'
        ? `at least; bound ${scientific(measure.high - measure.low)}`
        : formatNines(measure.value);
  return (
    <span className="value-line">
      <span className="value">
        {measure.kind === 'bounded' ? '≥ ' : ''}
        {percent(measure.value, digits)}
      </span>
      <span className={`tag ${measure.kind === 'exact' ? 'exact' : 'estimate'}`}>{measure.kind === 'exact' ? 'exact' : 'estimate'}</span>
      <span className="range">{range}</span>
      {was && <span className="was">was {was}</span>}
    </span>
  );
}

function boundedNote(m: Measure): string {
  return `Enumeration stopped early: the true value is between ${percent(m.low)} and ${percent(m.high)}.`;
}

function NapkinVerdict({ napkin, modeled }: { napkin: number; modeled: number }) {
  const delta = ninesDelta(napkin, modeled);
  if (Math.abs(delta) < 0.05) return <>which matches</>;
  return (
    <span className={delta > 0 ? 'bad-text' : 'warn-text'}>
      {delta > 0 ? 'optimistic' : 'pessimistic'} by {Math.abs(delta).toFixed(1)} nines
    </span>
  );
}

// ---------------------------------------------------------------------------

type Editing = { kind: 'availability' } | { kind: 'latency'; index: number } | { kind: 'succeed_within' } | undefined;

const VERDICT_LABEL: Record<Verdict, string> = { met: 'Met', missed: 'Missed', unclear: "Can't tell" };

function Promises({ evaluation, baseline, objectives, onObjectives }: { evaluation: Evaluation; baseline?: Evaluation; objectives: Objectives; onObjectives: (o: Objectives) => void }) {
  const [editing, setEditing] = useState<Editing>();
  const results = evaluation.objectives;
  const latencyResults = results.filter((o) => o.kind === 'latency');
  const rows: { key: string; result: ObjectiveResult; edit: Editing; remove: () => void; before?: ObjectiveResult }[] = [];

  const availability = findKind(results, 'availability');
  if (availability) {
    rows.push({ key: 'a', result: availability, edit: { kind: 'availability' }, remove: () => onObjectives({ ...objectives, availability: undefined }), before: baseline && findKind(baseline.objectives, 'availability') });
  }
  latencyResults.forEach((result, index) => {
    rows.push({ key: `l${index}`, result, edit: { kind: 'latency', index }, remove: () => onObjectives(withLatencyObjective(objectives, index, undefined)), before: baseline?.objectives.filter((o) => o.kind === 'latency')[index] });
  });
  const within = findKind(results, 'succeed_within');
  if (within) {
    rows.push({ key: 'w', result: within, edit: { kind: 'succeed_within' }, remove: () => onObjectives({ ...objectives, succeedWithin: undefined }), before: baseline && findKind(baseline.objectives, 'succeed_within') });
  }

  const add = (kind: string) => {
    if (kind === 'availability') onObjectives({ ...objectives, availability: 0.999 });
    if (kind === 'latency') {
      const used = new Set(objectives.latency.map((l) => l.percentile));
      const percentile = [0.99, 0.9, 0.5, 0.95, 0.999].find((p) => !used.has(p));
      if (percentile !== undefined) {
        onObjectives(withLatencyObjective(objectives, objectives.latency.length, { percentile, ms: 500 }));
        setEditing({ kind: 'latency', index: objectives.latency.length });
        return;
      }
    }
    if (kind === 'succeed_within') onObjectives({ ...objectives, succeedWithin: { ms: objectives.latency[0]?.ms ?? 500, target: objectives.availability ?? 0.999 } });
    setEditing(kind === 'availability' ? { kind: 'availability' } : kind === 'succeed_within' ? { kind: 'succeed_within' } : undefined);
  };

  const same = (a: Editing, b: Editing) => JSON.stringify(a) === JSON.stringify(b);
  return (
    <>
      {rows.length === 0 && <p className="empty">No promises yet. Add one to check this system against it.</p>}
      <ul className="promises">
        {rows.map((row) =>
          same(editing, row.edit) ? (
            <li key={row.key} className="promise editing">
              <PromiseEditor editing={row.edit!} objectives={objectives} onObjectives={onObjectives} onDone={() => setEditing(undefined)} onRemove={() => { row.remove(); setEditing(undefined); }} />
            </li>
          ) : (
            <li key={row.key} className={`promise ${row.result.verdict}`}>
              <span className="verdict">{VERDICT_LABEL[row.result.verdict]}</span>
              <button className="statement" onClick={() => setEditing(row.edit)} aria-label={`Edit: ${statement(row.result)}`}>
                {statement(row.result)}
              </button>
              <span className="detail">
                {detail(row.result)}
                {row.before && row.before.verdict !== row.result.verdict && <span className="was"> · was {VERDICT_LABEL[row.before.verdict].toLowerCase()}</span>}
              </span>
            </li>
          ),
        )}
      </ul>
      <label className="add-promise">
        <span className="sr-only">Add a promise</span>
        <select value="" onChange={(ev) => add(ev.target.value)}>
          <option value="" disabled>
            + Add a promise
          </option>
          {objectives.availability === undefined && <option value="availability">A share of requests succeed</option>}
          {objectives.latency.length < PERCENTILES.length && <option value="latency">A latency percentile stays under a limit</option>}
          {!objectives.succeedWithin && <option value="succeed_within">A share of requests succeed within a time</option>}
        </select>
      </label>
    </>
  );
}

function statement(o: ObjectiveResult): string {
  if (o.kind === 'availability') return `${inputPercent(o.target)} of requests succeed`;
  if (o.kind === 'latency') return `${pName(o.percentile)} of successful requests ≤ ${o.ms} ms`;
  return `${inputPercent(o.target)} of requests succeed within ${o.ms} ms`;
}

function detail(o: ObjectiveResult): string {
  if (o.reason) return o.reason;
  if (o.kind === 'latency') return o.observedMs === undefined ? '' : `${pName(o.percentile)} is ${ms(o.observedMs)}`;
  return o.measure ? `${percent(o.measure.value, digitsFor(o.measure))} do` : '';
}

function PromiseEditor({ editing, objectives, onObjectives, onDone, onRemove }: { editing: NonNullable<Editing>; objectives: Objectives; onObjectives: (o: Objectives) => void; onDone: () => void; onRemove: () => void }) {
  const target = (value: number, set: (v: number) => void) => (
    <Field
      label="Share"
      value={inputPercent(value).replace('%', '')}
      suffix="%"
      width={76}
      onCommit={(text) => {
        const v = parsePercent(text);
        if (typeof v === 'string') return v;
        set(v);
      }}
    />
  );
  const limit = (value: number, set: (v: number) => void) => (
    <Field
      label="Within"
      value={String(value)}
      suffix="ms"
      width={70}
      onCommit={(text) => {
        const v = parseMs(text, false);
        if (typeof v !== 'number') return v;
        set(v);
      }}
    />
  );

  let body: React.ReactNode;
  if (editing.kind === 'availability') {
    body = (
      <>
        <p className="editor-title">A share of requests succeed</p>
        {target(objectives.availability ?? 0.999, (v) => onObjectives({ ...objectives, availability: v }))}
      </>
    );
  } else if (editing.kind === 'succeed_within') {
    const sw = objectives.succeedWithin!;
    body = (
      <>
        <p className="editor-title">A share of requests succeed within a time</p>
        <div className="pair">
          {target(sw.target, (v) => onObjectives({ ...objectives, succeedWithin: { ...sw, target: v } }))}
          {limit(sw.ms, (v) => onObjectives({ ...objectives, succeedWithin: { ...sw, ms: v } }))}
        </div>
      </>
    );
  } else {
    const l = objectives.latency[editing.index]!;
    const used = new Set(objectives.latency.map((x, i) => (i === editing.index ? -1 : x.percentile)));
    body = (
      <>
        <p className="editor-title">A latency percentile of successful requests</p>
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
          {limit(l.ms, (v) => onObjectives(withLatencyObjective(objectives, editing.index, { ...l, ms: v })))}
        </div>
      </>
    );
  }
  return (
    <div className="promise-editor">
      {body}
      <div className="actions">
        <button className="danger" onClick={onRemove}>
          Remove
        </button>
        <button onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

/** Calls out the case the combined promise exists for. */
function SeparateVsCombined({ objectives }: { objectives: ObjectiveResult[] }) {
  const availability = findKind(objectives, 'availability');
  const latency = objectives.filter((o) => o.kind === 'latency');
  const combined = findKind(objectives, 'succeed_within');
  if (!availability || latency.length === 0 || !combined) return null;
  if (availability.verdict !== 'met' || latency.some((o) => o.verdict !== 'met') || combined.verdict !== 'missed') return null;
  return (
    <p className="insight">
      Both separate promises hold, but the combined one doesn't. Availability counts a slow success as good, and a latency percentile only looks at requests
      that succeeded, so together they still let a request be failed or slow.
    </p>
  );
}

function Details({ analysis, evaluation: e }: { analysis: Analysis; evaluation: Evaluation }) {
  const within = findKind(e.objectives, 'succeed_within');
  const items: { term: string; text: string }[] = [];
  if (e.fullIgnoringTime.value < e.ignoringTime.value - 1e-12) {
    const inTime = within?.fullFidelity ? `, ${percent(within.fullFidelity.value, digitsFor(within.fullFidelity))} within ${within.ms} ms` : '';
    items.push({
      term: 'Full answers',
      text: `${percent(e.fullIgnoringTime.value)} of requests get every call answered${inTime}. The rest are degraded: a soft call failed or a fan-out answered partially.`,
    });
  }
  if (e.latency.status === 'sampled' && e.latency.percentiles) {
    const napkin = analysis.napkinP99 !== undefined ? ` Adding up p99s along the path would say ${ms(analysis.napkinP99)}.` : '';
    items.push({
      term: 'Latency',
      text: `Successful requests take ${ms(e.latency.percentiles.p50)} at p50 and ${ms(e.latency.percentiles.p99)} at p99.${napkin} Simulated from ${e.latency.trials.toLocaleString()} requests${e.latency.done ? '' : ', refining'}.`,
    });
  }
  if (e.latency.status === 'missing') items.push({ term: 'Latency', text: `Not modeled until every service has one: add it to ${e.latency.nodes.join(', ')}.` });
  for (const note of analysis.notes) items.push({ term: 'Note', text: note });
  if (items.length === 0) return null;
  return (
    <dl className="details">
      {items.map((item, i) => (
        <div key={i}>
          <dt>{item.term}</dt>
          <dd>{item.text}</dd>
        </div>
      ))}
    </dl>
  );
}
