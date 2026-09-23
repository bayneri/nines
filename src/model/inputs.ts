/**
 * Reliability inputs: what you measure or assume. A YAML file keyed by the
 * topology's node ids, so one topology can be evaluated with many input sets.
 *
 * `availability` is the node's own success rate, excluding its dependencies.
 * `transient` is the fraction of its unavailability that is independent per
 * attempt (retries can recover it); the rest is an outage that lasts for the
 * whole request, retries included.
 */
import { LineCounter, isMap, parseDocument } from 'yaml';
import { type Diagnostic, type ParseResult, hasErrors, suggest } from './diagnostics';
import { type Topology, isGroup } from './topology';

export interface LatencyInput {
  p50Ms: number;
  p99Ms: number;
}

export interface NodeInputs {
  availability: number;
  transient: number;
  latency?: LatencyInput;
}

export interface Objective {
  /** Target fraction of requests that succeed (and, with latencyMs, succeed in time). */
  availability?: number;
  /** A request counts as good only if it succeeds within this many milliseconds. */
  latencyMs?: number;
}

export interface Inputs {
  /** The topology file this input set was written for, if stated. */
  topology?: string;
  objective: Objective;
  /** Resolved inputs for every service node in the topology. */
  nodes: Map<string, NodeInputs>;
  /** Service nodes with no entry under `nodes`, fully resolved from `defaults`. */
  defaulted: string[];
}

const TOP_KEYS = ['topology', 'objective', 'defaults', 'nodes'] as const;
const OBJECTIVE_KEYS = ['availability', 'latency_ms'] as const;
const NODE_KEYS = ['availability', 'transient', 'latency'] as const;
const LATENCY_KEYS = ['p50_ms', 'p99_ms'] as const;

type Path = (string | number)[];
type PartialInputs = { availability?: number; transient?: number; latency?: LatencyInput };

export function parseInputs(source: string, topology: Topology): ParseResult<Inputs> {
  const diagnostics: Diagnostic[] = [];
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, prettyErrors: false });

  const report = (severity: Diagnostic['severity'], message: string, offset?: number) => {
    const pos = offset === undefined ? undefined : lineCounter.linePos(offset);
    diagnostics.push({ severity, source: 'inputs', message, line: pos?.line, column: pos?.col });
  };
  const offsetOf = (path: Path): number | undefined => {
    const node = path.length === 0 ? doc.contents : doc.getIn(path, true);
    return (node as { range?: [number, number, number] } | undefined)?.range?.[0];
  };
  const error = (message: string, path: Path = []) => report('error', message, offsetOf(path));

  for (const e of doc.errors) report('error', `YAML syntax error: ${e.message}`, e.pos[0]);
  if (hasErrors(diagnostics)) return { diagnostics };
  if (!isMap(doc.contents)) {
    error('Inputs must be a YAML mapping with `nodes:` (and optionally `defaults:`, `objective:`).');
    return { diagnostics };
  }
  const root = doc.toJS() as Record<string, unknown>;

  const asMap = (value: unknown, path: Path, what: string): Record<string, unknown> | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
      error(`${what} must be a mapping.`, path);
      return undefined;
    }
    return value as Record<string, unknown>;
  };
  const checkKeys = (map: Record<string, unknown>, allowed: readonly string[], path: Path, what: string) => {
    for (const key of Object.keys(map)) {
      if (!allowed.includes(key)) {
        error(`Unknown key "${key}" in ${what}.${suggest(key, allowed)} Allowed: ${allowed.join(', ')}.`, [...path, key]);
      }
    }
  };

  const availability = (value: unknown, path: Path, what: string): number | undefined => {
    if (value === undefined) return undefined;
    let n: number | undefined;
    if (typeof value === 'number') {
      if (value > 1 && value <= 100) {
        error(`${what} is ${value}; write it as a fraction (${fromPercent(value)}) or a percentage string ("${value}%").`, path);
        return undefined;
      }
      n = value;
    } else if (typeof value === 'string' && /^\d+(\.\d+)?\s*%$/.test(value.trim())) {
      n = fromPercent(parseFloat(value));
    }
    if (n === undefined || !(n > 0 && n <= 1)) {
      error(`${what} must be in (0, 1] or a percentage like "99.9%", got ${JSON.stringify(value)}.`, path);
      return undefined;
    }
    return n;
  };
  const fraction = (value: unknown, path: Path, what: string): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || value < 0 || value > 1) {
      error(`${what} must be a number in [0, 1], got ${JSON.stringify(value)}.`, path);
      return undefined;
    }
    return value;
  };
  const positive = (value: unknown, path: Path, what: string): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !(value > 0)) {
      error(`${what} must be a positive number, got ${JSON.stringify(value)}.`, path);
      return undefined;
    }
    return value;
  };

  const nodeInputs = (value: unknown, path: Path, owner: string): PartialInputs | undefined => {
    const map = asMap(value, path, owner);
    if (!map) return value === null ? {} : undefined;
    checkKeys(map, NODE_KEYS, path, owner);
    const result: PartialInputs = {
      availability: availability(map.availability, [...path, 'availability'], `availability of ${owner}`),
      transient: fraction(map.transient, [...path, 'transient'], `transient of ${owner}`),
    };
    const latency = asMap(map.latency, [...path, 'latency'], `latency of ${owner}`);
    if (latency) {
      checkKeys(latency, LATENCY_KEYS, [...path, 'latency'], `latency of ${owner}`);
      const p50 = positive(latency.p50_ms, [...path, 'latency', 'p50_ms'], `p50_ms of ${owner}`);
      const p99 = positive(latency.p99_ms, [...path, 'latency', 'p99_ms'], `p99_ms of ${owner}`);
      if (latency.p50_ms === undefined || latency.p99_ms === undefined) {
        error(`latency of ${owner} needs both p50_ms and p99_ms.`, [...path, 'latency']);
      } else if (p50 !== undefined && p99 !== undefined) {
        if (p99 < p50) error(`p99_ms of ${owner} (${p99}) is below its p50_ms (${p50}).`, [...path, 'latency']);
        else result.latency = { p50Ms: p50, p99Ms: p99 };
      }
    }
    return result;
  };

  checkKeys(root, TOP_KEYS, [], 'inputs');

  let topologyRef: string | undefined;
  if (root.topology !== undefined) {
    if (typeof root.topology === 'string') topologyRef = root.topology;
    else error('`topology` must be a file name.', ['topology']);
  }

  const objective: Objective = {};
  const objectiveMap = asMap(root.objective, ['objective'], '`objective`');
  if (objectiveMap) {
    checkKeys(objectiveMap, OBJECTIVE_KEYS, ['objective'], '`objective`');
    const a = availability(objectiveMap.availability, ['objective', 'availability'], 'objective availability');
    if (a !== undefined) objective.availability = a;
    const l = positive(objectiveMap.latency_ms, ['objective', 'latency_ms'], 'objective latency_ms');
    if (l !== undefined) objective.latencyMs = l;
  }

  const defaults = root.defaults === undefined ? {} : nodeInputs(root.defaults, ['defaults'], '`defaults`') ?? {};

  const explicit = new Map<string, PartialInputs>();
  const nodesMap = asMap(root.nodes, ['nodes'], '`nodes`') ?? {};
  for (const [id, value] of Object.entries(nodesMap)) {
    const node = topology.nodes.get(id);
    if (!node) {
      error(`"${id}" isn't a node in topology "${topology.name}".${suggest(id, [...topology.nodes.keys()])}`, ['nodes', id]);
      continue;
    }
    if (isGroup(node)) {
      error(`"${id}" is a group (type=${node.type}); its availability comes from its members, so it takes no inputs.`, ['nodes', id]);
      continue;
    }
    const parsed = nodeInputs(value, ['nodes', id], `node "${id}"`);
    if (parsed) explicit.set(id, parsed);
  }

  const rawDefaults = root.defaults as Record<string, unknown> | null | undefined;
  const rawNode = (id: string) => nodesMap[id] as Record<string, unknown> | null | undefined;
  const nodes = new Map<string, NodeInputs>();
  const defaulted: string[] = [];
  for (const node of topology.nodes.values()) {
    if (isGroup(node)) continue;
    const own = explicit.get(node.id);
    if (!own) defaulted.push(node.id);
    const merged = { ...defaults, ...stripUndefined(own ?? {}) };
    if (merged.availability === undefined || merged.transient === undefined) {
      // Only report keys that were never written; invalid values were already reported.
      const written = (key: string) => rawNode(node.id)?.[key] !== undefined || rawDefaults?.[key] !== undefined;
      const missing = ['availability', 'transient'].filter((k) => !written(k));
      if (missing.length > 0) {
        error(`No ${missing.join(' or ')} for node "${node.id}"; set it under \`nodes.${node.id}\` or \`defaults\`.`, own ? ['nodes', node.id] : []);
      }
      continue;
    }
    const resolved: NodeInputs = { availability: merged.availability!, transient: merged.transient! };
    if (merged.latency) resolved.latency = merged.latency;
    nodes.set(node.id, resolved);
  }

  if (hasErrors(diagnostics)) return { diagnostics };
  return { value: { topology: topologyRef, objective, nodes, defaulted }, diagnostics };
}

function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/** 99.9 -> 0.999 exactly (as a double), where 99.9 / 100 gives 0.9990000000000001. */
function fromPercent(percent: number): number {
  return Number(`${percent}e-2`);
}
