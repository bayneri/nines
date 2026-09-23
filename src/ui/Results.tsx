import { type ReactNode, useEffect, useState } from 'react';
import type { Analysis } from '../analysis';
import { type Doc, withLatencyObjective } from '../doc';
import type { Objectives } from '../model/inputs';
import type { Evaluation, Measure, ObjectiveResult, Verdict } from '../model/slo';
import { parseMs, parsePercent } from './controls';
import { decimalsFor, decimalsForInterval, inputPercent, ms, ninesDelta, percent, scientific } from './format';
import type { Selection } from './Graph';
import { Icon } from './icons';
import { failureMode } from './words';
import { nodeName, share } from './words';

interface Props {
  doc: Doc;
  analysis: Analysis;
  evaluation: Evaluation;
  /** The lesson as loaded, to compare against once edited. */
  baseline?: Evaluation;
  advanced: boolean;
  onObjectives: (objectives: Objectives) => void;
  onHighlight: (target: Selection) => void;
  onSelect: (target: Selection) => void;
}

const pName = (p: number) => `p${+(p * 100).toFixed(1)}`;
export const digitsFor = (m: Measure) => (m.kind === 'sampled' ? decimalsForInterval(m.low, m.high) : decimalsFor(m.value));
const find = <K extends ObjectiveResult['kind']>(objectives: ObjectiveResult[], kind: K) =>
  objectives.find((o): o is Extract<ObjectiveResult, { kind: K }> => o.kind === kind);
const VERDICT: Record<Verdict, string> = { met: 'Kept', missed: 'Broken', unclear: "Can't tell yet" };

export function Results({ doc, analysis, evaluation: e, baseline, advanced, onObjectives, onHighlight, onSelect }: Props) {
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

      <Breakdown doc={doc} analysis={analysis} evaluation={e} advanced={advanced} was={was} onObjectives={onObjectives} />
      <SeparateVsCombined objectives={e.objectives} />
      <Losses doc={doc} analysis={analysis} evaluation={e} onHighlight={onHighlight} onSelect={onSelect} />

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
            {napkin !== undefined && <> Napkin math says {percent(napkin)}, <NapkinVerdict napkin={napkin} modeled={m.value} /></>}
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

function Breakdown({ doc, analysis, evaluation: e, advanced, was, onObjectives }: {
  doc: Doc;
  analysis: Analysis;
  evaluation: Evaluation;
  advanced: boolean;
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
          {analysis.napkin !== undefined && `Napkin math: ${percent(analysis.napkin)}.`}
          {was((ev) => ev.withTimeouts) && <span className="was"> Was {was((ev) => ev.withTimeouts)}.</span>}
        </span>
        {availability && (
          <TargetChip verdict={availability.verdict} text={`target ${inputPercent(availability.target)}`} onRemove={advanced ? () => onObjectives({ ...objectives, availability: undefined }) : undefined} />
        )}
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
          {latencies.map((l, i) => (
            <TargetChip
              key={i}
              verdict={l.verdict}
              text={`target ${pName(l.percentile)} ≤ ${l.ms} ms`}
              onRemove={advanced ? () => onObjectives(withLatencyObjective(objectives, i, undefined)) : undefined}
            />
          ))}
        </div>
      )}
      {advanced && (
        <div className="row-actions start">
          {objectives.availability === undefined && (
            <button className="text-button" onClick={() => onObjectives({ ...objectives, availability: objectives.succeedWithin?.target ?? 0.999 })}>
              <Icon name="plus" size={13} /> Separate availability target
            </button>
          )}
          {!objectives.latency.some((l) => l.percentile === 0.99) && (
            <button className="text-button" onClick={() => onObjectives(withLatencyObjective(objectives, objectives.latency.length, { percentile: 0.99, ms: objectives.succeedWithin?.ms ?? 500 }))}>
              <Icon name="plus" size={13} /> Separate p99 target
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function TargetChip({ verdict, text, onRemove }: { verdict: Verdict; text: string; onRemove?: () => void }) {
  return (
    <span className={`target-chip ${verdict}`}>
      <Icon name={verdict === 'met' ? 'check' : verdict === 'missed' ? 'cross' : 'question'} size={12} />
      {text}
      {onRemove && (
        <button className="chip-remove" onClick={onRemove} aria-label={`Remove ${text}`}>
          <Icon name="close" size={11} />
        </button>
      )}
    </span>
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
    <section className="losses" aria-labelledby="losses-title">
      <h3 id="losses-title">Where requests are lost</h3>
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
