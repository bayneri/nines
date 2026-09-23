import type { Analysis } from '../analysis';
import type { LatencyAnalysis } from '../model/latency';
import { decimalsFor, downtimePer30Days, formatNines, inputPercent, ms, ninesDelta, percent, scientific } from './format';

interface Props {
  analysis: Analysis;
  latency?: { value: LatencyAnalysis; done: boolean };
}

export function Results({ analysis, latency }: Props) {
  const { availability, napkin, inputs } = analysis;
  if (!availability || napkin === undefined || !inputs) {
    return <section className="results empty">Fix the errors in the editor to see results.</section>;
  }
  const a = availability.availability;
  const objective = inputs.objective;
  const hasFidelityGap = availability.fullFidelity < a - 1e-12;

  return (
    <section className="results" aria-label="Results">
      <div className="cards">
        <article className="card primary">
          <h3>
            Eventual success
            <span className={`tag ${availability.exhaustive ? 'exact' : 'estimate'}`}>{availability.exhaustive ? 'exact' : 'estimate'}</span>
          </h3>
          <p className="value">
            {availability.exhaustive ? '' : '≥ '}
            {percent(a)}
          </p>
          <p className="sub">
            {formatNines(a)} · ≈ {downtimePer30Days(a)} of failed requests per 30 days
          </p>
          <p className="fine">
            {availability.exhaustive
              ? `Modeled availability: requests that succeed if every caller waits as long as it takes (timeouts ignored). ${availability.truncation > 0 ? `Exact to within ${scientific(availability.truncation)}.` : 'Every outage state enumerated.'}`
              : `Enumeration stopped after ${availability.statesEvaluated.toLocaleString()} outage states. The true value lies between ${percent(a)} and ${percent(Math.min(1, a + availability.truncation))} (bound ${scientific(availability.truncation)}).`}
          </p>
        </article>

        <article className="card">
          <h3>Napkin math</h3>
          <p className="value muted">{percent(napkin)}</p>
          <p className="sub">
            <NapkinVerdict napkin={napkin} modeled={a} />
          </p>
          <p className="fine">Multiplies availabilities as if every failure were independent: shared dependencies counted once per caller, retries treated as fresh rolls.</p>
        </article>

        <LatencyCard latency={latency} targetMs={objective.latencyMs} napkinP99={analysis.napkinP99} />
      </div>

      {hasFidelityGap || (latency?.value.status === 'modeled' && latency.value.fullWithinTarget.value < latency.value.withinTarget.value) ? (
        <div className="row">
          <span className="label">Full-fidelity success</span>
          <span>
            eventual <strong>{percent(availability.fullFidelity)}</strong>
            {latency?.value.status === 'modeled' && objective.latencyMs !== undefined && (
              <>
                {' '}· within {objective.latencyMs} ms <strong>{percent(latency.value.fullWithinTarget.value, decimalsFor(latency.value.fullWithinTarget.value))}</strong>
              </>
            )}
          </span>
          <span className="fine">Every call answered in full, soft dependencies and all fan-out instances included. The gap to eventual success is what degrading instead of failing costs the customer.</span>
        </div>
      ) : null}

      {objective.availability !== undefined && <ObjectiveRow target={objective.availability} eventual={a} truncation={availability.truncation} latency={latency?.value} targetMs={objective.latencyMs} />}

      {analysis.notes.length > 0 && (
        <ul className="notes">
          {analysis.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NapkinVerdict({ napkin, modeled }: { napkin: number; modeled: number }) {
  const delta = ninesDelta(napkin, modeled);
  if (Math.abs(delta) < 0.05) return <>matches the model</>;
  return (
    <span className={delta > 0 ? 'bad-text' : 'warn-text'}>
      {delta > 0 ? 'optimistic' : 'pessimistic'} by {Math.abs(delta).toFixed(1)} nines
    </span>
  );
}

function LatencyCard({ latency, targetMs, napkinP99 }: { latency?: Props['latency']; targetMs?: number; napkinP99?: number }) {
  const title = targetMs === undefined ? 'Latency' : `Success within ${targetMs} ms`;
  if (!latency) {
    return (
      <article className="card">
        <h3>{title}</h3>
        <p className="value muted">…</p>
        <p className="sub">simulating requests</p>
      </article>
    );
  }
  const l = latency.value;
  if (l.status === 'missing') {
    return (
      <article className="card">
        <h3>{title}</h3>
        <p className="sub">Latency not modeled: add a latency to {l.nodes.join(', ')}.</p>
      </article>
    );
  }
  const within = l.withinTarget;
  const digits = decimalsFor(within.value);
  return (
    <article className="card">
      <h3>
        {title}
        <span className="tag estimate">estimate</span>
      </h3>
      {targetMs !== undefined ? (
        <>
          <p className="value">{percent(within.value, digits)}</p>
          <p className="sub">
            95% CI {percent(within.low, digits)} – {percent(within.high, digits)}
          </p>
        </>
      ) : (
        <p className="sub">Set objective.latency_ms to measure success within a target.</p>
      )}
      <p className="fine">
        {l.percentiles && (
          <>
            Successful requests: p50 {ms(l.percentiles.p50)}, p99 {ms(l.percentiles.p99)}.{' '}
          </>
        )}
        {napkinP99 !== undefined && <>Napkin p99 (adding p99s along the path): {ms(napkinP99)}. </>}
        {l.trials.toLocaleString()} simulated requests{latency.done ? '' : ', refining…'}; timeouts enforced.
      </p>
    </article>
  );
}

function ObjectiveRow({ target, eventual, truncation, latency, targetMs }: { target: number; eventual: number; truncation: number; latency?: LatencyAnalysis; targetMs?: number }) {
  const short = ninesDelta(target, eventual);
  let inTime: string | undefined;
  if (latency?.status === 'modeled' && targetMs !== undefined) {
    const w = latency.withinTarget;
    inTime = w.high < target ? `missed within ${targetMs} ms` : w.low >= target ? `met within ${targetMs} ms` : `within ${targetMs} ms: too close to call at this sample size`;
  }
  return (
    <div className="row">
      <span className="label">Objective {inputPercent(target)}</span>
      {eventual >= target ? (
        <span className="good-text">met by eventual success</span>
      ) : eventual + truncation >= target ? (
        <span className="warn-text">eventual success: can't tell within the enumeration bound</span>
      ) : (
        <span className="bad-text">eventual success is {short.toFixed(1)} nines short</span>
      )}
      {inTime && <span className={inTime.startsWith('met') ? 'good-text' : inTime.startsWith('missed') ? 'bad-text' : 'warn-text'}>{inTime}</span>}
    </div>
  );
}
