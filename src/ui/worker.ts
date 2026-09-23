/**
 * Runs the analysis off the main thread. The exact result is posted first;
 * the latency simulation follows in chunks, each posting a refined
 * evaluation, and stops early when a newer request arrives.
 */
import { type PathProgress, type RankedAction, docFromAnalysis, findPath, rankActions } from '../actions';
import { type Analysis, analyze } from '../analysis';
import { compile } from '../model/compile';
import { combineRuns } from '../model/latency';
import { type LatencySimulation, simulateLatency } from '../model/sampler';
import { type Evaluation, evaluateObjectives } from '../model/slo';

export interface WorkerRequest {
  id: number;
  dot: string;
  yaml: string;
  /** Find a path to the promise instead of the usual analysis. */
  task?: 'path';
  allowPartial?: boolean;
}

export type WorkerResponse =
  | { id: number; kind: 'analysis'; analysis: Analysis }
  | { id: number; kind: 'evaluation'; evaluation: Evaluation }
  | { id: number; kind: 'actions'; actions: RankedAction[]; tried: number; total: number; done: boolean }
  | { id: number; kind: 'path'; progress: PathProgress };

const CHUNK_TRIALS = 20_000;
const CHUNKS = 5;

let latest = 0;
const post = (message: WorkerResponse) => self.postMessage(message);

self.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const { id, dot, yaml } = event.data;
  latest = id;
  if (event.data.task === 'path') return findPathTask(event.data);
  const analysis = analyze(dot, yaml);
  post({ id, kind: 'analysis', analysis });
  const { topology, inputs, availability, evaluation } = analysis;
  if (!topology || !inputs || !availability || evaluation?.latency.status !== 'pending') return;

  const model = compile(topology, inputs);
  const runs: LatencySimulation[] = [];
  let final: Evaluation | undefined;
  for (let chunk = 1; chunk <= CHUNKS; chunk++) {
    // Yield so a newer request can supersede this one between chunks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (latest !== id) return;
    runs.push(simulateLatency(model, CHUNK_TRIALS, chunk));
    const simulation = { run: combineRuns(runs), done: chunk === CHUNKS };
    final = evaluateObjectives(topology, inputs, availability, simulation);
    post({ id, kind: 'evaluation', evaluation: final });
  }

  // Then try the changes most likely to help, one at a time.
  const doc = docFromAnalysis(analysis);
  if (!doc || !final) return;
  let last: { tried: number; total: number; ranked: RankedAction[] } = { tried: 0, total: 0, ranked: [] };
  for (const progress of rankActions(doc, { analysis, evaluation: final })) {
    last = progress;
    post({ id, kind: 'actions', actions: progress.ranked, tried: progress.tried, total: progress.total, done: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (latest !== id) return;
  }
  post({ id, kind: 'actions', actions: last.ranked, tried: last.tried, total: last.total, done: true });
});

async function findPathTask({ id, dot, yaml, allowPartial }: WorkerRequest) {
  const analysis = analyze(dot, yaml);
  const doc = docFromAnalysis(analysis);
  if (!doc || !analysis.topology || !analysis.inputs || !analysis.availability) return;
  const model = compile(analysis.topology, analysis.inputs);
  const run = combineRuns([1, 2].map((seed) => simulateLatency(model, CHUNK_TRIALS, seed)));
  const evaluation = evaluateObjectives(analysis.topology, analysis.inputs, analysis.availability, { run, done: true });
  for (const progress of findPath(doc, { analysis, evaluation }, { allowPartial })) {
    post({ id, kind: 'path', progress });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (latest !== id) return;
  }
}
