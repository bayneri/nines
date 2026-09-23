import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ActionSpec, type RankedAction, applyAction } from '../actions';
import type { Analysis } from '../analysis';
import { type Doc, addCall, addService, blankDoc, docProblems, makeRedundant, setObjectives, toDot, toYaml } from '../doc';
import type { Evaluation } from '../model/slo';
import { SCENARIOS } from '../scenarios';
import { CodeView } from './CodeView';
import { Graph, type LossOverlay, type Selection } from './Graph';
import { Icon } from './icons';
import { CallInspector, NodeInspector } from './Inspector';
import { Legend } from './Legend';
import { Lessons } from './Lessons';
import { Results } from './Results';
import type { WorkerRequest, WorkerResponse } from './worker';
import { nodeName, share } from './words';

type Mode = 'learn' | 'model';
export interface ActionsState {
  list: RankedAction[];
  tried: number;
  total: number;
  done: boolean;
  /** The model (as DOT + YAML) these actions were ranked for. */
  key: string;
}

const DEBOUNCE_MS = 150;
/** Edits with the same coalesce key this close together are one undo step. */
const COALESCE_MS = 800;
/** Losses below this share of requests aren't drawn on the graph. */
const DRAW_THRESHOLD = 0.0001;
/** Simulated losses backed by fewer lost requests than this are noise. */
const MIN_LOST_REQUESTS = 5;

interface History {
  docs: Doc[];
  index: number;
  lastKey?: string;
  lastAt?: number;
}
const start = (doc: Doc): History => ({ docs: [doc], index: 0 });

export function App() {
  const [mode, setMode] = useState<Mode>('learn');
  const [lessonId, setLessonId] = useState(SCENARIOS[0]!.id);
  const lesson = SCENARIOS.find((s) => s.id === lessonId)!;
  const [histories, setHistories] = useState<Record<Mode, History>>({ learn: start(lesson.doc), model: start(blankDoc()) });
  const history = histories[mode];
  const doc = history.docs[history.index]!;
  const setHistory = useCallback((update: (h: History) => History) => setHistories((all) => ({ ...all, [mode]: update(all[mode]) })), [mode]);

  const [selection, setSelection] = useState<Selection>();
  const [highlight, setHighlight] = useState<Selection>();
  const [picking, setPicking] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [tried, setTried] = useState(false);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [showLosses, setShowLosses] = useState(true);
  const [showCode, setShowCode] = useState(false);
  const [advanced, setAdvanced] = useState(() => {
    try {
      return localStorage.getItem('nines.advanced') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('nines.advanced', advanced ? '1' : '0');
    } catch {
      // Storage can be unavailable; the switch then just doesn't persist.
    }
  }, [advanced]);

  const [analysis, setAnalysis] = useState<Analysis>();
  const [evaluation, setEvaluation] = useState<Evaluation>();
  const [baselines, setBaselines] = useState<Record<string, Evaluation>>({});
  const [actions, setActions] = useState<ActionsState>();

  // ---- Editing -------------------------------------------------------------

  const edit = useCallback(
    (result: Doc | string, coalesce?: string) => {
      if (typeof result === 'string') return setMessage(result);
      setMessage(undefined);
      setHistory((h) => {
        const now = Date.now();
        const merge = coalesce !== undefined && h.lastKey === coalesce && now - (h.lastAt ?? 0) < COALESCE_MS;
        const base = merge ? h.index - 1 : h.index;
        const docs = [...h.docs.slice(0, base + 1), result];
        return { docs, index: docs.length - 1, lastKey: coalesce, lastAt: now };
      });
    },
    [setHistory],
  );
  const undo = useCallback(() => setHistory((h) => ({ ...h, index: Math.max(0, h.index - 1), lastKey: undefined })), [setHistory]);
  const redo = useCallback(() => setHistory((h) => ({ ...h, index: Math.min(h.docs.length - 1, h.index + 1), lastKey: undefined })), [setHistory]);

  const clearTransient = () => {
    // Results belong to the doc they were computed for; a new doc starts fresh.
    setAnalysis(undefined);
    setEvaluation(undefined);
    setActions(undefined);
    setSelection(undefined);
    setHighlight(undefined);
    setPicking(undefined);
    setMessage(undefined);
  };
  const openLesson = (id: string) => {
    const next = SCENARIOS.find((s) => s.id === id)!;
    setLessonId(id);
    setHistories((all) => ({ ...all, learn: start(next.doc) }));
    setTried(false);
    clearTransient();
  };
  const loadModel = (next: Doc) => {
    setHistories((all) => ({ ...all, model: start(next) }));
    setMode('model');
    clearTransient();
  };
  const switchMode = (next: Mode) => {
    setMode(next);
    clearTransient();
  };

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
  }, [undo, redo]);

  const addDependency = (caller?: string) => {
    const { doc: next, id } = addService(doc, caller);
    edit(next);
    setSelection({ kind: 'node', id });
  };

  // ---- Analysis ------------------------------------------------------------

  const dot = useMemo(() => toDot(doc), [doc]);
  const yaml = useMemo(() => toYaml(doc), [doc]);
  const lessonSource = useMemo(() => ({ dot: toDot(lesson.doc), yaml: toYaml(lesson.doc) }), [lesson]);
  const lessonEdited = dot !== lessonSource.dot || yaml !== lessonSource.yaml;
  const baselineKey = mode === 'learn' && !lessonEdited ? lessonId : undefined;

  const worker = useRef<Worker>(undefined);
  const requests = useRef<{ id: number; baselineOf?: string; key: string }>({ id: 0, key: '' });

  useEffect(() => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.id !== requests.current.id) return;
      if (message.kind === 'actions') {
        setActions({ list: message.actions, tried: message.tried, total: message.total, done: message.done, key: requests.current.key });
        return;
      }
      const next = message.kind === 'analysis' ? message.analysis.evaluation : message.evaluation;
      if (message.kind === 'analysis') {
        setAnalysis(message.analysis);
        setActions(undefined);
      }
      setEvaluation(next);
      const baselineOf = requests.current.baselineOf;
      if (baselineOf && next && next.latency.status !== 'pending') setBaselines((b) => ({ ...b, [baselineOf]: next }));
    });
    worker.current = w;
    return () => w.terminate();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      requests.current = { id: requests.current.id + 1, baselineOf: baselineKey, key: dot + yaml };
      const request: WorkerRequest = { id: requests.current.id, dot, yaml };
      worker.current?.postMessage(request);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [dot, yaml, baselineKey]);

  const structural = useMemo(() => docProblems(doc), [doc]);
  const blocking = structural.filter((p) => p.blocking).map((p) => p.message);
  const parserErrors = analysis?.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message) ?? [];
  const problems = blocking.length > 0 ? blocking : parserErrors;
  const notices = structural.filter((p) => !p.blocking).map((p) => p.message);
  // Between an edit and the worker's reply, results describe the previous doc;
  // keep only the losses that still point at the same services and calls.
  const current = useMemo(() => {
    if (!analysis || !evaluation) return undefined;
    const ids = new Set(doc.nodes.map((n) => n.id));
    return {
      analysis: { ...analysis, levers: analysis.levers?.filter((l) => ids.has(l.id)) },
      evaluation: { ...evaluation, timeoutLosses: evaluation.timeoutLosses.filter((l) => doc.calls[l.edge]?.from === l.from && doc.calls[l.edge]?.to === l.to) },
    };
  }, [analysis, evaluation, doc]);
  const ready = current && problems.length === 0;

  // What to draw as lost: timeout losses on calls, failure levers on services.
  const losses = useMemo((): LossOverlay | undefined => {
    if (!showLosses || !ready) return undefined;
    const { analysis: a, evaluation: e } = current;
    const trials = e.latency.status === 'sampled' ? e.latency.trials : 0;
    const timeouts = e.timeoutLosses.filter((l) => l.share.value * trials >= MIN_LOST_REQUESTS);
    const max = Math.max(1e-12, ...timeouts.map((l) => l.share.value), ...(a.levers ?? []).map((l) => l.ifPerfect));
    const nodes = new Map((a.levers ?? []).filter((l) => l.ifPerfect >= DRAW_THRESHOLD).map((l) => [l.id, l.ifPerfect / max]));
    const calls = new Map(
      timeouts.filter((l) => l.share.value >= DRAW_THRESHOLD).map((l) => [l.edge, `timeouts lose ${share(l.share.value)}`]),
    );
    return { nodes, calls };
  }, [showLosses, ready, current]);

  // ---- Layout --------------------------------------------------------------

  const pane = showCode ? (
    <CodeView
      doc={doc}
      onApply={(next) => {
        edit(next);
        setSelection(undefined);
      }}
    />
  ) : selection?.kind === 'node' ? (
    <NodeInspector
      doc={doc}
      analysis={current?.analysis}
      evaluation={current?.evaluation}
      id={selection.id}
      onEdit={edit}
      onBack={() => setSelection(undefined)}
      onSelectCall={(index) => setSelection({ kind: 'call', index })}
      onRenamed={(id) => setSelection({ kind: 'node', id })}
      advanced={advanced}
      onAddDependency={() => addDependency(selection.id)}
      onCallAnother={() => setPicking(selection.id)}
      onMakeRedundant={() => {
        const result = makeRedundant(doc, selection.id);
        if (typeof result === 'string') return edit(result);
        edit(result.doc);
        setSelection({ kind: 'node', id: result.group });
      }}
    />
  ) : selection?.kind === 'call' ? (
    <CallInspector advanced={advanced} doc={doc} analysis={current?.analysis} evaluation={current?.evaluation} index={selection.index} onEdit={edit} onBack={() => setSelection(undefined)} />
  ) : ready ? (
    <Results
      doc={doc}
      analysis={current.analysis}
      evaluation={current.evaluation}
      baseline={mode === 'learn' && lessonEdited ? baselines[lessonId] : undefined}
      advanced={advanced}
      actions={actions?.key === dot + yaml ? actions : undefined}
      onApply={(spec: ActionSpec) => {
        edit(applyAction(doc, spec));
        setHighlight(undefined);
      }}
      onObjectives={(objectives) => edit(setObjectives(doc, objectives))}
      onHighlight={setHighlight}
      onSelect={setSelection}
    />
  ) : (
    <p className="pane-empty">{analysis ? 'Fix the problem shown on the graph to see results.' : 'Working it out…'}</p>
  );

  const banner = message ?? (problems.length > 0 ? problems.join(' ') : picking ? `Click the service ${nodeName(doc, picking)} should call. Esc to cancel.` : notices.join(' '));
  const bannerKind = message || problems.length > 0 ? 'problem' : picking ? 'prompt' : 'info';

  return (
    <div className={`app mode-${mode}`}>
      <header className="topbar">
        <span className="brand">nines</span>
        <div className="mode-switch" role="tablist" aria-label="Mode">
          <button role="tab" aria-selected={mode === 'learn'} onClick={() => switchMode('learn')}>
            <Icon name="book" size={15} /> Learn
          </button>
          <button role="tab" aria-selected={mode === 'model'} onClick={() => switchMode('model')}>
            <Icon name="grid" size={15} /> Model
          </button>
        </div>
        <span className="spacer" />
        <label className="switch" title="Show every setting, for power users">
          <input type="checkbox" role="switch" aria-label="Advanced" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} />
          <span className="switch-label">Advanced</span>
        </label>
        <button className="icon-button" onClick={undo} disabled={history.index === 0} aria-label="Undo" title="Undo (⌘Z)">
          <Icon name="undo" />
        </button>
        <button className="icon-button" onClick={redo} disabled={history.index === history.docs.length - 1} aria-label="Redo" title="Redo (⇧⌘Z)">
          <Icon name="redo" />
        </button>
        <button className={`icon-button${showCode ? ' on' : ''}`} onClick={() => setShowCode((v) => !v)} aria-pressed={showCode} aria-label="Show the model as code" title="Code">
          <Icon name="code" />
        </button>
      </header>

      <div className="workspace">
        {mode === 'learn' && (
          <Lessons
            lessons={SCENARIOS}
            current={lessonId}
            tried={tried}
            edited={lessonEdited}
            completed={completed}
            onOpen={openLesson}
            onTry={() => {
              edit(lesson.tryIt.apply(doc));
              setTried(true);
              setCompleted((c) => new Set(c).add(lessonId));
            }}
            onReset={() => openLesson(lessonId)}
            onBlank={() => loadModel(blankDoc())}
          />
        )}

        <main className="canvas" aria-label="System">
          <div className="canvas-tools">
            {mode === 'model' && (
              <label className="template">
                <span className="sr-only">Start from</span>
                <select value="" onChange={(e) => loadModel(e.target.value === 'blank' ? blankDoc() : SCENARIOS.find((s) => s.id === e.target.value)!.doc)}>
                  <option value="" disabled>
                    Start from…
                  </option>
                  <option value="blank">A blank system</option>
                  {SCENARIOS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button onClick={() => addDependency(selection?.kind === 'node' ? selection.id : undefined)}>
              <Icon name="plus" size={14} /> Service
            </button>
            <span className="spacer" />
            <Legend doc={doc} lossesShown={showLosses} onToggleLosses={setShowLosses} />
          </div>
          {banner && (
            <div className={`canvas-banner ${bannerKind}`} role="status">
              <span>{banner}</span>
              {message && (
                <button className="text-button" onClick={() => setMessage(undefined)}>
                  Dismiss
                </button>
              )}
            </div>
          )}
          <div className="canvas-scroll">
            <Graph
              doc={doc}
              selection={selection}
              highlight={highlight}
              losses={losses}
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
            />
          </div>
        </main>

        <aside className="pane" aria-label={showCode ? 'Code' : selection ? 'Inspector' : 'Results'}>
          {pane}
        </aside>
      </div>
    </div>
  );
}
