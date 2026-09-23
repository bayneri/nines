import { useEffect, useMemo, useRef, useState } from 'react';
import type { Analysis } from '../analysis';
import type { Evaluation } from '../model/slo';
import type { Topology } from '../model/topology';
import { SCENARIOS } from '../scenarios';
import { Editor, type FileTab } from './Editor';
import { GraphView } from './GraphView';
import { renderDot } from './graph';
import { Results } from './Results';
import type { WorkerRequest, WorkerResponse } from './worker';

const DEBOUNCE_MS = 250;

export function App() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0]!.id);
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const [dot, setDot] = useState(scenario.dot);
  const [yaml, setYaml] = useState(scenario.yaml);
  const [tab, setTab] = useState<FileTab>('dot');

  const [analysis, setAnalysis] = useState<Analysis>();
  const [evaluation, setEvaluation] = useState<Evaluation>();
  const [lastTopology, setLastTopology] = useState<{ topology: Topology; inputs?: Analysis['inputs'] }>();

  const worker = useRef<Worker>(undefined);
  const requestId = useRef(0);

  useEffect(() => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.id !== requestId.current) return;
      if (message.kind === 'analysis') {
        setAnalysis(message.analysis);
        setEvaluation(message.analysis.evaluation);
        if (message.analysis.topology) setLastTopology({ topology: message.analysis.topology, inputs: message.analysis.inputs });
      } else {
        setEvaluation(message.evaluation);
      }
    });
    worker.current = w;
    return () => w.terminate();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      const request: WorkerRequest = { id: ++requestId.current, dot, yaml };
      worker.current?.postMessage(request);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [dot, yaml]);

  const chooseScenario = (id: string) => {
    const next = SCENARIOS.find((s) => s.id === id)!;
    setScenarioId(id);
    setDot(next.dot);
    setYaml(next.yaml);
  };
  const edited = dot !== scenario.dot || yaml !== scenario.yaml;

  const graphDot = useMemo(() => (lastTopology ? renderDot(lastTopology.topology, lastTopology.inputs) : undefined), [lastTopology]);

  return (
    <div className="app">
      <header className="masthead">
        <h1>
          nines<span className="tagline">where napkin reliability math goes wrong</span>
        </h1>
        <nav className="scenarios" aria-label="Scenarios">
          {SCENARIOS.map((s) => (
            <button key={s.id} className="scenario" aria-pressed={s.id === scenarioId} onClick={() => chooseScenario(s.id)}>
              {s.title}
            </button>
          ))}
        </nav>
      </header>

      <section className="story">
        <p>{scenario.lesson}</p>
        <p className="try">
          <strong>Try:</strong> {scenario.tryThis}
          {edited && (
            <button className="reset" onClick={() => chooseScenario(scenario.id)}>
              Reset scenario
            </button>
          )}
        </p>
      </section>

      <main className="workspace">
        <Editor
          tab={tab}
          onTab={setTab}
          dot={dot}
          yaml={yaml}
          onChange={(t, v) => (t === 'dot' ? setDot(v) : setYaml(v))}
          diagnostics={analysis?.diagnostics ?? []}
        />
        <div className="output">
          <GraphView dot={graphDot} stale={analysis !== undefined && !analysis.topology} />
          {!analysis ? (
            <section className="results empty">Analyzing…</section>
          ) : evaluation ? (
            <Results analysis={analysis} evaluation={evaluation} />
          ) : (
            <section className="results empty">Fix the errors in the editor to see results.</section>
          )}
        </div>
      </main>

      <footer className="footer">
        Eventual success is exact: every combination of outages is enumerated until what's left is below 10⁻⁹. Success within the latency
        target is simulated, so it comes with a confidence interval. Everything runs in your browser.
      </footer>
    </div>
  );
}
