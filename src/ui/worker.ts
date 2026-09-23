/**
 * Runs the analysis off the main thread. The exact availability result is
 * posted first; the latency simulation follows in chunks, each posting a
 * refined estimate, and stops early when a newer request arrives.
 */
import { type Analysis, analyze } from '../analysis';
import { compile } from '../model/compile';
import { type LatencyAnalysis, summarizeLatency } from '../model/latency';
import { type LatencySimulation, simulateLatency } from '../model/sampler';

export interface WorkerRequest {
  id: number;
  dot: string;
  yaml: string;
}

export type WorkerResponse =
  | { id: number; kind: 'analysis'; analysis: Analysis }
  | { id: number; kind: 'latency'; latency: LatencyAnalysis; done: boolean };

const CHUNK_TRIALS = 20_000;
const CHUNKS = 5;

let latest = 0;
const post = (message: WorkerResponse) => self.postMessage(message);

self.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const { id, dot, yaml } = event.data;
  latest = id;
  const analysis = analyze(dot, yaml);
  post({ id, kind: 'analysis', analysis });
  if (!analysis.topology || !analysis.inputs) return;

  const model = compile(analysis.topology, analysis.inputs);
  const missing = model.nodes.filter((n) => n.type === 'service' && !n.latency).map((n) => n.id);
  if (missing.length > 0) {
    post({ id, kind: 'latency', latency: { status: 'missing', nodes: missing }, done: true });
    return;
  }

  const targetMs = analysis.inputs.objective.latencyMs;
  const runs: LatencySimulation[] = [];
  for (let chunk = 1; chunk <= CHUNKS; chunk++) {
    // Yield so a newer request can supersede this one between chunks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (latest !== id) return;
    runs.push(simulateLatency(model, CHUNK_TRIALS, chunk, targetMs ?? Infinity));
    post({ id, kind: 'latency', latency: summarizeLatency(runs, targetMs), done: chunk === CHUNKS });
  }
});
