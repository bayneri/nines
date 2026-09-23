import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Analysis } from '../analysis';
import { type Doc, addCall, addService, docProblems, setObjectives, toDot, toYaml } from '../doc';
import type { Evaluation } from '../model/slo';
import { SCENARIOS } from '../scenarios';
import { Canvas, type Selection } from './Canvas';
import { CodeView } from './CodeView';
import { CallInspector, NodeInspector } from './Inspector';
import { Panel } from './Panel';
import type { WorkerRequest, WorkerResponse } from './worker';

const DEBOUNCE_MS = 150;
/** Edits with the same coalesce key this close together are one undo step. */
const COALESCE_MS = 800;

interface History {
  docs: Doc[];
  index: number;
  lastKey?: string;
  lastAt?: number;
}

export function App() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0]!.id);
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const [history, setHistory] = useState<History>({ docs: [scenario.doc], index: 0 });
  const doc = history.docs[history.index]!;

  const [selection, setSelection] = useState<Selection>();
  const [picking, setPicking] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [tried, setTried] = useState(false);
  const [view, setView] = useState<'results' | 'code'>('results');

  const [analysis, setAnalysis] = useState<Analysis>();
  const [evaluation, setEvaluation] = useState<Evaluation>();
  const [baselines, setBaselines] = useState<Record<string, Evaluation>>({});

  // ---- Editing -------------------------------------------------------------

  const edit = useCallback((result: Doc | string, coalesce?: string) => {
    if (typeof result === 'string') return setMessage(result);
    setMessage(undefined);
    setHistory((h) => {
      const now = Date.now();
      const merge = coalesce !== undefined && h.lastKey === coalesce && now - (h.lastAt ?? 0) < COALESCE_MS;
      const base = merge ? h.index - 1 : h.index;
      const docs = [...h.docs.slice(0, base + 1), result];
      return { docs, index: docs.length - 1, lastKey: coalesce, lastAt: now };
    });
  }, []);

  const undo = () => setHistory((h) => ({ ...h, index: Math.max(0, h.index - 1), lastKey: undefined }));
  const redo = () => setHistory((h) => ({ ...h, index: Math.min(h.docs.length - 1, h.index + 1), lastKey: undefined }));

  const loadScenario = (id: string) => {
    const next = SCENARIOS.find((s) => s.id === id)!;
    setScenarioId(id);
    setHistory({ docs: [next.doc], index: 0 });
    setSelection(undefined);
    setPicking(undefined);
    setMessage(undefined);
    setTried(false);
  };

  // Keep the selection pointing at something that exists.
  useEffect(() => {
    if (selection?.kind === 'node' && !doc.nodes.some((n) => n.id === selection.id)) setSelection(undefined);
    if (selection?.kind === 'call' && !doc.calls[selection.index]) setSelection(undefined);
  }, [doc, selection]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (e.key === 'Escape') {
        setPicking(undefined);
        if (!typing) setSelection(undefined);
      }
      if (typing || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const addDependency = (caller?: string) => {
    const { doc: next, id } = addService(doc, caller);
    edit(next);
    setSelection({ kind: 'node', id });
  };

  // ---- Analysis ------------------------------------------------------------

  const dot = useMemo(() => toDot(doc), [doc]);
  const yaml = useMemo(() => toYaml(doc), [doc]);
  const scenarioSource = useMemo(() => ({ dot: toDot(scenario.doc), yaml: toYaml(scenario.doc) }), [scenario]);
  const edited = dot !== scenarioSource.dot || yaml !== scenarioSource.yaml;

  const worker = useRef<Worker>(undefined);
  const requests = useRef<{ id: number; baselineOf?: string }>({ id: 0 });

  useEffect(() => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.id !== requests.current.id) return;
      const next = message.kind === 'analysis' ? message.analysis.evaluation : message.evaluation;
      if (message.kind === 'analysis') setAnalysis(message.analysis);
      setEvaluation(next);
      const baselineOf = requests.current.baselineOf;
      if (baselineOf && next && next.latency.status !== 'pending') setBaselines((b) => ({ ...b, [baselineOf]: next }));
    });
    worker.current = w;
    return () => w.terminate();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      requests.current = { id: requests.current.id + 1, baselineOf: edited ? undefined : scenarioId };
      const request: WorkerRequest = { id: requests.current.id, dot, yaml };
      worker.current?.postMessage(request);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [dot, yaml, edited, scenarioId]);

  // Structural problems in the editor's terms; parser errors only as a fallback.
  const structural = useMemo(() => docProblems(doc), [doc]);
  const blocking = structural.filter((p) => p.blocking).map((p) => p.message);
  const parserErrors = analysis?.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message) ?? [];
  const problems = blocking.length > 0 ? blocking : parserErrors;
  const notices = structural.filter((p) => !p.blocking).map((p) => p.message);

  // ---- Layout --------------------------------------------------------------

  const selectedNode = selection?.kind === 'node' ? doc.nodes.find((n) => n.id === selection.id) : undefined;
  const inspector =
    selection?.kind === 'node' ? (
      <NodeInspector
        doc={doc}
        id={selection.id}
        onEdit={edit}
        onRenamed={(id) => setSelection({ kind: 'node', id })}
        onClose={() => setSelection(undefined)}
        onAddDependency={() => addDependency(selection.id)}
        onCallAnother={() => setPicking(selection.id)}
      />
    ) : selection?.kind === 'call' ? (
      <CallInspector doc={doc} index={selection.index} onEdit={edit} onClose={() => setSelection(undefined)} />
    ) : undefined;

  const toolbar = (
    <>
      <button onClick={() => addDependency(selectedNode?.id)}>+ Service</button>
      <span className="toolbar-hint">
        {picking
          ? `Click the service ${picking} should call. Esc to cancel.`
          : selection
            ? ''
            : 'Click a service or a call to edit it.'}
      </span>
      <span className="spacer" />
      <button onClick={undo} disabled={history.index === 0} aria-label="Undo">
        Undo
      </button>
      <button onClick={redo} disabled={history.index === history.docs.length - 1} aria-label="Redo">
        Redo
      </button>
    </>
  );

  const banner = (message || problems.length > 0 || notices.length > 0) && (
    <div className={`canvas-banner${message || problems.length > 0 ? '' : ' info'}`} role="status">
      <span>{message ?? (problems.length > 0 ? problems.join(' ') : notices.join(' '))}</span>
      {message && (
        <button className="link" onClick={() => setMessage(undefined)}>
          Dismiss
        </button>
      )}
    </div>
  );

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">nines</span>
        <label className="scenario-picker">
          <span className="sr-only">Scenario</span>
          <select value={scenarioId} onChange={(e) => loadScenario(e.target.value)}>
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <div className="view-switch" role="tablist" aria-label="Side panel">
          <button role="tab" aria-selected={view === 'results'} onClick={() => setView('results')}>
            Results
          </button>
          <button role="tab" aria-selected={view === 'code'} onClick={() => setView('code')}>
            Code
          </button>
        </div>
      </header>

      <section className="story" aria-label="Scenario">
        <p>{tried && edited ? scenario.tryIt.result : scenario.lesson}</p>
        <div className="story-actions">
          {!(tried && edited) && (
            <button
              className="primary"
              onClick={() => {
                edit(scenario.tryIt.apply(doc));
                setTried(true);
              }}
            >
              Try: {scenario.tryIt.label.charAt(0).toLowerCase() + scenario.tryIt.label.slice(1)}
            </button>
          )}
          {edited && <button onClick={() => loadScenario(scenarioId)}>Reset</button>}
        </div>
      </section>

      <main className="workspace">
        <Canvas
          doc={doc}
          selection={selection}
          onSelect={(s) => {
            setSelection(s);
            setMessage(undefined);
          }}
          onPick={
            picking
              ? (target) => {
                  const result = addCall(doc, picking, target);
                  edit(result);
                  setPicking(undefined);
                  if (typeof result !== 'string') setSelection({ kind: 'call', index: result.calls.length - 1 });
                }
              : undefined
          }
          toolbar={toolbar}
          banner={banner}
          inspector={picking ? undefined : inspector}
        />
        <aside className="side" aria-label={view === 'results' ? 'Results' : 'Code'}>
          {view === 'code' ? (
            <CodeView
              doc={doc}
              onApply={(next) => {
                edit(next);
                setSelection(undefined);
              }}
            />
          ) : analysis && evaluation ? (
            <Panel
              analysis={analysis}
              evaluation={evaluation}
              baseline={edited ? baselines[scenarioId] : undefined}
              objectives={doc.objectives}
              onObjectives={(objectives) => edit(setObjectives(doc, objectives))}
            />
          ) : (
            <p className="empty">{analysis ? 'Fix the problem shown on the graph to see results.' : 'Analyzing…'}</p>
          )}
        </aside>
      </main>

      <footer className="footer">
        Availability ignoring time is exact: every combination of outages is enumerated until what's left is below 10⁻⁹. Anything involving time is simulated, so it
        comes with a 95% interval. Everything runs in your browser.
      </footer>
    </div>
  );
}
