import type { Analysis } from '../analysis';
import type { Evaluation, Measure, ObjectiveResult, Verdict } from '../model/slo';
import { decimalsFor, downtimePer30Days, formatNines, inputPercent, ms, ninesDelta, percent, scientific } from './format';

interface Props {
  analysis: Analysis;
  evaluation: Evaluation;
}

export function Results({ analysis, evaluation }: Props) {
  const { napkin, napkinP99, inputs } = analysis;
  const e = evaluation;
  const within = e.objectives.find((o): o is Extract<ObjectiveResult, { kind: 'succeed_within' }> => o.kind === 'succeed_within');

  return (
    <section className="results" aria-label="Results">
      <h2 className="section-title">Where requests go</h2>
      <ol className="funnel">
        <li>
          <span className="step">Succeed, ignoring time</span>
          <Value measure={e.ignoringTime} />
          <span className="fine">
            Failures alone, with every caller waiting as long as it takes. {e.ignoringTime.kind === 'bounded' ? boundedNote(e.ignoringTime) : 'An upper bound on everything below.'}
            {napkin !== undefined && (
              <>
                {' '}
                Napkin math says {percent(napkin)}: <NapkinVerdict napkin={napkin} modeled={e.ignoringTime.value} />.
              </>
            )}
          </span>
        </li>
        <li>
          <span className="step">Succeed with timeouts enforced</span>
          {!e.hasTimeouts ? (
            <span className="same">same: no timeouts configured</span>
          ) : e.withTimeouts ? (
            <Value measure={e.withTimeouts} />
          ) : (
            <span className="same">{e.latency.status === 'missing' ? 'needs latency inputs' : 'simulating…'}</span>
          )}
          <span className="fine">Availability as customers see it: a timed-out call is an error, unless it was a soft dependency.</span>
        </li>
        {within?.measure && (
          <li>
            <span className="step">Succeed within {within.ms} ms</span>
            <Value measure={within.measure} />
            <span className="fine">Succeeded and answered in time.</span>
          </li>
        )}
      </ol>

      {e.objectives.length > 0 && (
        <>
          <h2 className="section-title">Promises</h2>
          <ul className="objectives">
            {e.objectives.map((o, i) => (
              <Objective key={i} objective={o} />
            ))}
          </ul>
          <SeparateVsCombined objectives={e.objectives} />
        </>
      )}

      <dl className="facts">
        {e.fullIgnoringTime.value < e.ignoringTime.value - 1e-12 && (
          <>
            <dt>Full fidelity</dt>
            <dd>
              {percent(e.fullIgnoringTime.value)} of requests get every call answered in full
              {within?.fullFidelity && `, ${percent(within.fullFidelity.value, decimalsFor(within.fullFidelity.value))} within ${within.ms} ms`}. The rest are degraded:
              a soft dependency failed or a fan-out answered partially.
            </dd>
          </>
        )}
        {e.latency.status === 'sampled' && e.latency.percentiles && (
          <>
            <dt>Latency</dt>
            <dd>
              Successful requests: p50 {ms(e.latency.percentiles.p50)}, p99 {ms(e.latency.percentiles.p99)}.
              {napkinP99 !== undefined && ` Napkin p99, adding p99s along the path: ${ms(napkinP99)}.`} From {e.latency.trials.toLocaleString()} simulated requests
              {e.latency.done ? '.' : ', refining…'}
            </dd>
          </>
        )}
        {e.latency.status === 'missing' && (
          <>
            <dt>Latency</dt>
            <dd>Not modeled: add latency to {e.latency.nodes.join(', ')}.</dd>
          </>
        )}
      </dl>

      {analysis.notes.length > 0 && (
        <ul className="notes">
          {analysis.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {inputs && inputs.objectives.availability === undefined && inputs.objectives.latency.length === 0 && !inputs.objectives.succeedWithin && (
        <p className="fine">No objectives set. Add `objectives:` to the inputs to check a promise.</p>
      )}
    </section>
  );
}

function Value({ measure }: { measure: Measure }) {
  const digits = decimalsFor(measure.value);
  return (
    <span className="measure">
      <span className="value">
        {measure.kind === 'bounded' ? '≥ ' : ''}
        {percent(measure.value, digits)}
      </span>
      <span className={`tag ${measure.kind}`}>{measure.kind === 'exact' ? 'exact' : 'estimate'}</span>
      <span className="range">
        {measure.kind === 'sampled'
          ? `95% CI ${percent(measure.low, digits)} – ${percent(measure.high, digits)}`
          : `${formatNines(measure.value)} · ≈ ${downtimePer30Days(measure.value)} failed per 30 days`}
      </span>
    </span>
  );
}

function boundedNote(m: Measure): string {
  return `Enumeration stopped early: the true value lies between ${percent(m.low)} and ${percent(m.high)} (bound ${scientific(m.high - m.low)}).`;
}

function NapkinVerdict({ napkin, modeled }: { napkin: number; modeled: number }) {
  const delta = ninesDelta(napkin, modeled);
  if (Math.abs(delta) < 0.05) return <>it matches</>;
  return (
    <span className={delta > 0 ? 'bad-text' : 'warn-text'}>
      {delta > 0 ? 'optimistic' : 'pessimistic'} by {Math.abs(delta).toFixed(1)} nines
    </span>
  );
}

const VERDICT_LABEL: Record<Verdict, string> = { met: 'met', missed: 'missed', unclear: "can't tell" };

function Objective({ objective: o }: { objective: ObjectiveResult }) {
  let statement: string;
  let detail: string | undefined;
  if (o.kind === 'availability') {
    statement = `${inputPercent(o.target)} of requests succeed`;
    detail = o.measure && `${percent(o.measure.value)} do`;
  } else if (o.kind === 'latency') {
    const p = `p${+(o.percentile * 100).toFixed(1)}`;
    statement = `${p} of successful requests ≤ ${o.ms} ms`;
    detail = o.observedMs !== undefined ? `${p} is ${ms(o.observedMs)}` : undefined;
  } else {
    statement = `${inputPercent(o.target)} of requests succeed within ${o.ms} ms`;
    detail = o.measure && `${percent(o.measure.value, decimalsFor(o.measure.value))} do`;
  }
  return (
    <li className={`objective ${o.verdict}`}>
      <span className="verdict">{VERDICT_LABEL[o.verdict]}</span>
      <span className="statement">{statement}</span>
      <span className="fine">{[detail, o.reason].filter(Boolean).join(' · ')}</span>
    </li>
  );
}

/** Calls out the case the combined objective exists for. */
function SeparateVsCombined({ objectives }: { objectives: ObjectiveResult[] }) {
  const availability = objectives.find((o) => o.kind === 'availability');
  const latency = objectives.filter((o) => o.kind === 'latency');
  const combined = objectives.find((o) => o.kind === 'succeed_within');
  if (!availability || latency.length === 0 || !combined) return null;
  if (availability.verdict !== 'met' || latency.some((o) => o.verdict !== 'met') || combined.verdict !== 'missed') return null;
  return (
    <p className="insight">
      Both separate objectives are met, yet the combined promise is missed. Availability counts slow successes as good, and a latency percentile only
      looks at successful requests, so together they still allow a request to be either failed or slow.
    </p>
  );
}
