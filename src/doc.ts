/**
 * The editable model behind the UI. The graph editor changes a Doc; DOT and
 * YAML are generated from it for the engine and the code view, and parsed
 * back into it when someone edits the code directly.
 */
import type { Inputs, LatencyInput, LatencyObjective, Objectives } from './model/inputs';
import type { DependencyKind, NodeType, Topology } from './model/topology';

export interface DocNode {
  id: string;
  type: NodeType;
  /** Quorum only. */
  require?: number;
  infra: boolean;
  label?: string;
  /** Services only (groups have no failures of their own). */
  availability: number;
  transient: number;
  latency?: LatencyInput;
}

export interface DocCall {
  from: string;
  to: string;
  dependency: DependencyKind;
  fanout: number;
  fanoutRequire: number;
  retries: number;
  stage: number;
  timeoutMs?: number;
}

export interface Doc {
  name: string;
  entry: string;
  nodes: DocNode[];
  /** In declaration order, which is failover order for a group's members. */
  calls: DocCall[];
  objectives: Objectives;
}

export function fromParsed(topology: Topology, inputs: Inputs): Doc {
  return {
    name: topology.name,
    entry: topology.entry,
    nodes: [...topology.nodes.values()].map((n) => {
      const own = inputs.nodes.get(n.id);
      const node: DocNode = { id: n.id, type: n.type, infra: n.kind === 'infra', availability: own?.availability ?? 1, transient: own?.transient ?? 0.5 };
      if (n.type === 'quorum') node.require = n.require;
      if (n.label !== undefined) node.label = n.label;
      if (own?.latency) node.latency = { ...own.latency };
      return node;
    }),
    calls: topology.edges.map(({ from, to, dependency, fanout, fanoutRequire, retries, stage, timeoutMs }) => {
      const call: DocCall = { from, to, dependency, fanout, fanoutRequire, retries, stage };
      if (timeoutMs !== undefined) call.timeoutMs = timeoutMs;
      return call;
    }),
    objectives: { ...inputs.objectives, latency: inputs.objectives.latency.map((l) => ({ ...l })) },
  };
}

const PLAIN_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const dotId = (id: string) => (PLAIN_ID.test(id) ? id : `"${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);

export function toDot(doc: Doc): string {
  const lines = [`digraph ${dotId(doc.name)} {`, `    graph [entry=${dotId(doc.entry)}];`, ''];
  for (const c of doc.calls) {
    const attrs: string[] = [];
    if (c.dependency !== 'hard') attrs.push(`dependency=${c.dependency}`);
    if (c.stage !== 0) attrs.push(`stage=${c.stage}`);
    if (c.fanout !== 1) attrs.push(`fanout=${c.fanout}`);
    if (c.fanoutRequire !== c.fanout) attrs.push(`fanout_require=${c.fanoutRequire}`);
    if (c.retries !== 0) attrs.push(`retries=${c.retries}`);
    if (c.timeoutMs !== undefined) attrs.push(`timeout_ms=${c.timeoutMs}`);
    lines.push(`    ${dotId(c.from)} -> ${dotId(c.to)}${attrs.length ? ` [${attrs.join(', ')}]` : ''};`);
  }

  const inCalls = new Set(doc.calls.flatMap((c) => [c.from, c.to]));
  const declarations: string[] = [];
  for (const n of doc.nodes) {
    const attrs: string[] = [];
    if (n.type !== 'service') attrs.push(`type=${n.type}`);
    if (n.type === 'quorum' && n.require !== undefined) attrs.push(`require=${n.require}`);
    if (n.infra) attrs.push('kind=infra');
    if (n.label !== undefined) attrs.push(`label=${JSON.stringify(n.label)}`);
    if (attrs.length > 0) declarations.push(`    ${dotId(n.id)} [${attrs.join(', ')}];`);
    else if (!inCalls.has(n.id)) declarations.push(`    ${dotId(n.id)};`);
  }
  if (declarations.length > 0) lines.push('', ...declarations);
  lines.push('}');
  return lines.join('\n') + '\n';
}

const PERCENTILE_KEY: Record<string, string> = { '0.5': 'p50_ms', '0.9': 'p90_ms', '0.95': 'p95_ms', '0.99': 'p99_ms', '0.999': 'p999_ms' };

export function percentileKey(percentile: number): string {
  return PERCENTILE_KEY[String(percentile)]!;
}

/** 0.9995 -> "99.95%": exact decimal, no float noise. */
export function yamlPercent(p: number): string {
  return `${parseFloat((p * 100).toFixed(6))}%`;
}

export function toYaml(doc: Doc): string {
  const lines = [`topology: ${doc.name}.dot`];
  const { availability, latency, succeedWithin } = doc.objectives;
  if (availability !== undefined || latency.length > 0 || succeedWithin) {
    lines.push('objectives:');
    if (availability !== undefined) lines.push(`  availability: ${yamlPercent(availability)}`);
    if (latency.length > 0) {
      const sorted = [...latency].sort((a, b) => a.percentile - b.percentile);
      lines.push(`  latency: { ${sorted.map((l) => `${percentileKey(l.percentile)}: ${l.ms}`).join(', ')} }`);
    }
    if (succeedWithin) lines.push(`  succeed_within: { ms: ${succeedWithin.ms}, target: ${yamlPercent(succeedWithin.target)} }`);
  }
  const services = doc.nodes.filter((n) => n.type === 'service');
  lines.push('nodes:');
  const width = Math.max(0, ...services.map((n) => yamlKey(n.id).length));
  for (const n of services) {
    const fields = [`availability: ${yamlPercent(n.availability)}`, `transient: ${parseFloat(n.transient.toFixed(4))}`];
    if (n.latency) fields.push(`latency: { p50_ms: ${n.latency.p50Ms}, p99_ms: ${n.latency.p99Ms} }`);
    lines.push(`  ${(yamlKey(n.id) + ':').padEnd(width + 1)} { ${fields.join(', ')} }`);
  }
  if (services.length === 0) lines[lines.length - 1] = 'nodes: {}';
  return lines.join('\n') + '\n';
}

const yamlKey = (id: string) => (PLAIN_ID.test(id) ? id : JSON.stringify(id));

// ---------------------------------------------------------------------------
// Edits. Each returns a new Doc, or a string explaining why it can't be done.

export type EditResult = Doc | string;

const replaceNode = (doc: Doc, id: string, patch: Partial<DocNode>): Doc => ({
  ...doc,
  nodes: doc.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
});

export function updateNode(doc: Doc, id: string, patch: Partial<Omit<DocNode, 'id' | 'type'>>): Doc {
  return replaceNode(doc, id, patch);
}

export function renameNode(doc: Doc, from: string, to: string): EditResult {
  const name = to.trim();
  if (name === from) return doc;
  if (!PLAIN_ID.test(name)) return 'Use letters, digits and underscores, starting with a letter.';
  if (doc.nodes.some((n) => n.id === name)) return `There's already a service called ${name}.`;
  const rename = (id: string) => (id === from ? name : id);
  return {
    ...doc,
    entry: rename(doc.entry),
    nodes: doc.nodes.map((n) => (n.id === from ? { ...n, id: name } : n)),
    calls: doc.calls.map((c) => ({ ...c, from: rename(c.from), to: rename(c.to) })),
  };
}

/**
 * A group's calls are its members, which take only retries and timeouts, so
 * switching to a group resets the attributes that only a dependency has.
 */
export function setNodeType(doc: Doc, id: string, type: NodeType): Doc {
  const members = doc.calls.filter((c) => c.from === id).length;
  const node: Partial<DocNode> = { type, require: type === 'quorum' ? Math.max(1, Math.min(members, Math.ceil((members + 1) / 2))) : undefined };
  const next = replaceNode(doc, id, node);
  if (type === 'service') return next;
  return {
    ...next,
    calls: next.calls.map((c) => (c.from === id ? { ...c, dependency: 'hard', fanout: 1, fanoutRequire: 1, stage: 0 } : c)),
  };
}

export function uniqueId(doc: Doc, base: string): string {
  const taken = new Set(doc.nodes.map((n) => n.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

/** Adds a service; when `caller` is given, also a call to it. */
export function addService(doc: Doc, caller?: string): { doc: Doc; id: string } {
  const id = uniqueId(doc, 'service');
  const services = doc.nodes.filter((n) => n.type === 'service');
  const node: DocNode = { id, type: 'service', infra: false, availability: 0.999, transient: 0.5 };
  // Keep latency modeled if every other service has it.
  if (services.length > 0 && services.every((n) => n.latency)) node.latency = { p50Ms: 20, p99Ms: 100 };
  let next: Doc = { ...doc, nodes: [...doc.nodes, node] };
  if (caller) {
    const added = addCall(next, caller, id);
    if (typeof added !== 'string') next = added;
  }
  return { doc: next, id };
}

export function addCall(doc: Doc, from: string, to: string): EditResult {
  if (from === to) return "A service can't call itself.";
  if (doc.calls.some((c) => c.from === from && c.to === to)) return `${from} already calls ${to}.`;
  if (reaches(doc, to, from)) return `${to} already depends on ${from}, so this call would make a cycle.`;
  const call: DocCall = { from, to, dependency: 'hard', fanout: 1, fanoutRequire: 1, retries: 0, stage: 0 };
  return { ...doc, calls: [...doc.calls, call] };
}

export function updateCall(doc: Doc, index: number, patch: Partial<Omit<DocCall, 'from' | 'to'>>): Doc {
  return {
    ...doc,
    calls: doc.calls.map((c, i) => {
      if (i !== index) return c;
      const next = { ...c, ...patch };
      if ('timeoutMs' in patch && patch.timeoutMs === undefined) delete next.timeoutMs;
      // Keep the requirement valid when fan-out shrinks, and "all" when it was all.
      if (patch.fanout !== undefined) next.fanoutRequire = c.fanoutRequire === c.fanout ? next.fanout : Math.min(next.fanoutRequire, next.fanout);
      return next;
    }),
  };
}

export function removeCall(doc: Doc, index: number): Doc {
  return { ...doc, calls: doc.calls.filter((_, i) => i !== index) };
}

export function removeNode(doc: Doc, id: string): EditResult {
  if (id === doc.entry) return 'Requests arrive here. Make another service the entry point first.';
  return { ...doc, nodes: doc.nodes.filter((n) => n.id !== id), calls: doc.calls.filter((c) => c.from !== id && c.to !== id) };
}

export function setObjectives(doc: Doc, objectives: Objectives): Doc {
  return { ...doc, objectives };
}

export function withLatencyObjective(objectives: Objectives, index: number, value: LatencyObjective | undefined): Objectives {
  const latency = [...objectives.latency];
  if (value === undefined) latency.splice(index, 1);
  else if (index >= latency.length) latency.push(value);
  else latency[index] = value;
  return { ...objectives, latency };
}

function reaches(doc: Doc, from: string, to: string): boolean {
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === to) return true;
    for (const c of doc.calls) {
      if (c.from === id && !seen.has(c.to)) {
        seen.add(c.to);
        stack.push(c.to);
      }
    }
  }
  return false;
}

/**
 * Structural problems in the editor's own terms. The parser reports the same
 * things in DOT terms; the canvas shows these instead. `blocking` problems
 * stop evaluation; the rest are worth knowing.
 */
export function docProblems(doc: Doc): { message: string; node?: string; blocking: boolean }[] {
  const problems: { message: string; node?: string; blocking: boolean }[] = [];
  for (const node of doc.nodes) {
    if (node.type === 'service') continue;
    const members = doc.calls.filter((c) => c.from === node.id).length;
    const kind = node.type === 'any' ? 'an either-of group' : 'a quorum';
    if (members === 0) {
      problems.push({ node: node.id, blocking: true, message: `${node.id} is ${kind} but calls nothing. Give it services to choose between, or make it a service again.` });
    } else if (node.type === 'quorum' && (node.require ?? 1) > members) {
      problems.push({ node: node.id, blocking: true, message: `${node.id} needs ${node.require} answers but only calls ${members} services.` });
    }
  }
  const reachable = new Set([doc.entry]);
  const stack = [doc.entry];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const c of doc.calls) {
      if (c.from === id && !reachable.has(c.to)) {
        reachable.add(c.to);
        stack.push(c.to);
      }
    }
  }
  const unreachable = doc.nodes.filter((n) => !reachable.has(n.id)).map((n) => n.id);
  if (unreachable.length > 0) {
    const list = unreachable.join(', ');
    problems.push({ blocking: false, message: `${list} ${unreachable.length === 1 ? "isn't" : "aren't"} called from where requests arrive, so ${unreachable.length === 1 ? "it doesn't" : "they don't"} count yet.` });
  }
  return problems;
}
