/**
 * Runs the analysis off the main thread. The exact result is posted first;
 * the latency simulation follows in chunks, each posting a refined
 * evaluation, and stops early when a newer request arrives.
 */
import { type Analysis, analyze } from '../analysis';
import { compile } from '../model/compile';
import { combineRuns } from '../model/latency';
import { type LatencySimulation, simulateLatency } from '../model/sampler';
import { type Evaluation, evaluateObjectives } from '../model/slo';

export interface WorkerRequest {
  id: number;
  dot: string;
  yaml: string;
}

export type WorkerResponse =
  | { id: number; kind: 'analysis'; analysis: Analysis }
  | { id: number; kind: 'evaluation'; evaluation: Evaluation };

const CHUNK_TRIALS = 20_000;
const CHUNKS = 5;

let latest = 0;
const post = (message: WorkerResponse) => self.postMessage(message);

self.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const { id, dot, yaml } = event.data;
  latest = id;
  const analysis = analyze(dot, yaml);
  post({ id, kind: 'analysis', analysis });
  const { topology, inputs, availability, evaluation } = analysis;
  if (!topology || !inputs || !availability || evaluation?.latency.status !== 'pending') return;

  const model = compile(topology, inputs);
  const runs: LatencySimulation[] = [];
  for (let chunk = 1; chunk <= CHUNKS; chunk++) {
    // Yield so a newer request can supersede this one between chunks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (latest !== id) return;
    runs.push(simulateLatency(model, CHUNK_TRIALS, chunk));
    const simulation = { run: combineRuns(runs), done: chunk === CHUNKS };
    post({ id, kind: 'evaluation', evaluation: evaluateObjectives(topology, inputs, availability, simulation) });
  }
});
