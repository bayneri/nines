/**
 * Topology: what you build. Parsed from a Graphviz DOT digraph whose edges
 * point from caller to callee, with custom node/edge attributes.
 *
 * Semantics (shared with the simulator):
 * - A node id is one instance. Every edge into it refers to the same state.
 * - `fanout=N` calls N independent instances of the target; the target's own
 *   downstream dependencies stay shared.
 * - Group nodes (`type=any|quorum`) are logical: their outgoing edges are
 *   alternatives (tried in declaration order), not dependencies.
 * - `stage` orders a caller's calls: same stage runs in parallel, stages run
 *   in sequence. `timeout_ms` is how long the caller waits for one attempt.
 */
import { parse } from 'ts-graphviz/ast';
import { type Diagnostic, type ParseResult, hasErrors, suggest } from './diagnostics';

export type NodeType = 'service' | 'any' | 'quorum';
export type DependencyKind = 'hard' | 'soft';
export const NODE_ICONS = ['web', 'service', 'database', 'queue', 'infra'] as const;
export type NodeIcon = (typeof NODE_ICONS)[number];

export interface TopologyNode {
  id: string;
  type: NodeType;
  /** Members that must succeed; only for group nodes (any => 1). */
  require?: number;
  kind?: 'infra';
  /** Display only: how the node is drawn. */
  icon?: NodeIcon;
  label?: string;
  line?: number;
}

export interface TopologyEdge {
  from: string;
  to: string;
  dependency: DependencyKind;
  fanout: number;
  /** Instances out of `fanout` that must succeed. */
  fanoutRequire: number;
  retries: number;
  stage: number;
  /** Undefined means the caller waits for as long as the call takes. */
  timeoutMs?: number;
  line?: number;
}

export interface Topology {
  name: string;
  entry: string;
  /** In declaration order. */
  nodes: Map<string, TopologyNode>;
  edges: TopologyEdge[];
  /** Outgoing edges per node, in declaration order. */
  out: Map<string, TopologyEdge[]>;
}

export function isGroup(node: TopologyNode): boolean {
  return node.type !== 'service';
}

const GRAPH_ATTRS = ['entry', 'label'] as const;
const NODE_ATTRS = ['type', 'require', 'kind', 'icon', 'label'] as const;
const EDGE_ATTRS = ['dependency', 'fanout', 'fanout_require', 'retries', 'stage', 'timeout_ms', 'label'] as const;
/** Edge attributes that only make sense on a service's dependency, not a group's member. */
const DEPENDENCY_ONLY_EDGE_ATTRS = ['dependency', 'fanout', 'fanout_require', 'stage'] as const;

type Loc = { start: { line: number; column: number } } | null | undefined;
interface RawAttr {
  value: string;
  loc: Loc;
}
type RawAttrs = Map<string, RawAttr>;
interface AttrNode {
  type: string;
  key: { value: string };
  value: { value: string };
  location?: Loc;
}

export function parseTopology(source: string): ParseResult<Topology> {
  const diagnostics: Diagnostic[] = [];
  const report = (severity: Diagnostic['severity'], message: string, loc?: Loc) =>
    diagnostics.push({ severity, source: 'topology', message, line: loc?.start.line, column: loc?.start.column });
  const error = (message: string, loc?: Loc) => report('error', message, loc);

  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source);
  } catch (e) {
    const cause = (e as { cause?: { location?: Loc } }).cause;
    error(`Syntax error: ${(e as Error).message}`, cause?.location);
    return { diagnostics };
  }

  const graph = ast.children.find((c) => c.type === 'Graph');
  if (!graph) {
    error('No graph found. Expected `digraph <name> { ... }`.');
    return { diagnostics };
  }
  if (!graph.directed) {
    error('Use `digraph`, not `graph`: edges point from caller to callee.', graph.location);
  }

  const collect = (target: RawAttrs, attrs: readonly AttrNode[], allowed: readonly string[], owner: string) => {
    for (const attr of attrs) {
      if (attr.type !== 'Attribute') continue;
      const key = attr.key.value;
      const value = attr.value.value;
      if (!allowed.includes(key)) {
        error(`Unknown attribute "${key}" on ${owner}.${suggest(key, allowed)} Allowed: ${allowed.join(', ')}.`, attr.location);
        continue;
      }
      const existing = target.get(key);
      if (existing && existing.value !== value) {
        error(`Conflicting values for "${key}" on ${owner}: "${existing.value}" and "${value}".`, attr.location);
        continue;
      }
      target.set(key, { value, loc: attr.location });
    }
  };

  const graphAttrs: RawAttrs = new Map();
  const nodeAttrs = new Map<string, RawAttrs>();
  const nodeLoc = new Map<string, Loc>();
  const declare = (id: string, loc: Loc) => {
    if (!nodeAttrs.has(id)) {
      nodeAttrs.set(id, new Map());
      nodeLoc.set(id, loc);
    }
    return nodeAttrs.get(id)!;
  };
  const rawEdges: { from: string; to: string; attrs: RawAttrs; loc: Loc }[] = [];

  for (const stmt of graph.children) {
    switch (stmt.type) {
      case 'Comment':
        break;
      case 'Attribute':
        collect(graphAttrs, [stmt as unknown as AttrNode], GRAPH_ATTRS, 'the graph');
        break;
      case 'AttributeList':
        if (stmt.kind === 'Graph') {
          collect(graphAttrs, stmt.children as unknown as AttrNode[], GRAPH_ATTRS, 'the graph');
        } else {
          const kind = stmt.kind.toLowerCase();
          error(`Default \`${kind} [...]\` statements aren't supported; set attributes on each ${kind} instead.`, stmt.location);
        }
        break;
      case 'Node': {
        const id = stmt.id.value;
        collect(declare(id, stmt.location), stmt.children as unknown as AttrNode[], NODE_ATTRS, `node "${id}"`);
        break;
      }
      case 'Edge': {
        // `a -> b -> c` and `a -> {b c}` expand to one edge per caller/callee pair.
        const hops: string[][] = [];
        for (const target of stmt.targets) {
          const refs = target.type === 'NodeRefGroup' ? target.children : [target];
          const ids: string[] = [];
          for (const ref of refs) {
            if (ref.port || ref.compass) error('Ports (`node:port`) aren\'t supported.', ref.location);
            declare(ref.id.value, ref.location);
            ids.push(ref.id.value);
          }
          hops.push(ids);
        }
        const attrs: RawAttrs = new Map();
        collect(attrs, stmt.children as unknown as AttrNode[], EDGE_ATTRS, 'edge');
        for (let i = 0; i + 1 < hops.length; i++) {
          for (const from of hops[i]!) {
            for (const to of hops[i + 1]!) rawEdges.push({ from, to, attrs, loc: stmt.location });
          }
        }
        break;
      }
      case 'Subgraph':
        error('Subgraphs aren\'t supported yet; declare nodes and edges at the top level.', stmt.location);
        break;
    }
  }

  // Attribute value helpers.
  const intAttr = (attrs: RawAttrs, key: string, owner: string, min: number): number | undefined => {
    const attr = attrs.get(key);
    if (!attr) return undefined;
    if (!/^\d+$/.test(attr.value) || Number(attr.value) < min) {
      error(`"${key}" on ${owner} must be an integer ≥ ${min}, got "${attr.value}".`, attr.loc);
      return undefined;
    }
    return Number(attr.value);
  };
  const enumAttr = <T extends string>(attrs: RawAttrs, key: string, owner: string, allowed: readonly T[]): T | undefined => {
    const attr = attrs.get(key);
    if (!attr) return undefined;
    if (!(allowed as readonly string[]).includes(attr.value)) {
      error(`"${key}" on ${owner} must be one of ${allowed.join(' | ')}, got "${attr.value}".${suggest(attr.value, allowed)}`, attr.loc);
      return undefined;
    }
    return attr.value as T;
  };

  // Nodes.
  const nodes = new Map<string, TopologyNode>();
  for (const [id, attrs] of nodeAttrs) {
    const owner = `node "${id}"`;
    const type = enumAttr(attrs, 'type', owner, ['service', 'any', 'quorum'] as const) ?? 'service';
    const require = intAttr(attrs, 'require', owner, 1);
    const node: TopologyNode = { id, type, line: nodeLoc.get(id)?.start.line };
    if (type === 'service' && attrs.has('require')) {
      error(`"require" on ${owner} only applies to type=any or type=quorum.`, attrs.get('require')!.loc);
    } else if (type === 'any') {
      if (require !== undefined && require !== 1) {
        error(`${owner} is type=any, which means require=1; use type=quorum for require=${require}.`, attrs.get('require')!.loc);
      }
      node.require = 1;
    } else if (type === 'quorum') {
      if (require === undefined && !attrs.has('require')) {
        error(`${owner} is type=quorum and needs "require" (how many members must succeed).`, nodeLoc.get(id));
      }
      node.require = require;
    }
    const icon = enumAttr(attrs, 'icon', owner, NODE_ICONS);
    if (icon) node.icon = icon;
    const kind = enumAttr(attrs, 'kind', owner, ['infra'] as const);
    if (kind) node.kind = kind;
    const label = attrs.get('label')?.value;
    if (label !== undefined) node.label = label;
    nodes.set(id, node);
  }

  // Edges.
  const edges: TopologyEdge[] = [];
  const out = new Map<string, TopologyEdge[]>([...nodes.keys()].map((id) => [id, []]));
  const seen = new Set<string>();
  for (const { from, to, attrs, loc } of rawEdges) {
    const owner = `edge ${from} -> ${to}`;
    const pair = `${from}\u0000${to}`;
    if (seen.has(pair)) {
      error(`Duplicate ${owner}; declare each dependency once.`, loc);
      continue;
    }
    seen.add(pair);

    const fromNode = nodes.get(from)!;
    const toNode = nodes.get(to)!;
    if (isGroup(fromNode)) {
      for (const key of DEPENDENCY_ONLY_EDGE_ATTRS) {
        if (attrs.has(key)) {
          error(`"${key}" doesn't apply to ${owner}: "${from}" is a group, so its edges are members, not dependencies.`, attrs.get(key)!.loc);
        }
      }
    }

    const fanout = intAttr(attrs, 'fanout', owner, 1) ?? 1;
    if (fanout > 1 && isGroup(toNode)) {
      error(`fanout on ${owner} isn't supported: "${to}" is a group, which has no instances of its own to fan out to.`, attrs.get('fanout')!.loc);
    }
    let fanoutRequire = fanout;
    const rawRequire = attrs.get('fanout_require');
    if (rawRequire && rawRequire.value !== 'all') {
      const n = intAttr(attrs, 'fanout_require', owner, 1);
      if (n !== undefined && n > fanout) {
        error(`"fanout_require" on ${owner} is ${n}, more than fanout=${fanout}.`, rawRequire.loc);
      } else if (n !== undefined) {
        fanoutRequire = n;
      }
    }

    const edge: TopologyEdge = {
      from,
      to,
      dependency: enumAttr(attrs, 'dependency', owner, ['hard', 'soft'] as const) ?? 'hard',
      fanout,
      fanoutRequire,
      retries: intAttr(attrs, 'retries', owner, 0) ?? 0,
      stage: intAttr(attrs, 'stage', owner, 0) ?? 0,
      line: loc?.start.line,
    };
    const timeoutMs = intAttr(attrs, 'timeout_ms', owner, 1);
    if (timeoutMs !== undefined) edge.timeoutMs = timeoutMs;
    edges.push(edge);
    out.get(from)!.push(edge);
  }

  // Group membership.
  for (const node of nodes.values()) {
    if (!isGroup(node)) continue;
    const members = out.get(node.id)!.length;
    const loc = nodeLoc.get(node.id);
    if (members === 0) {
      error(`Group "${node.id}" has no members; add edges ${node.id} -> <member>.`, loc);
    } else if (node.require !== undefined && node.require > members) {
      error(`Group "${node.id}" requires ${node.require} members but has only ${members}.`, loc);
    } else if (members === 1) {
      report('warning', `Group "${node.id}" has a single member, so it adds no redundancy.`, loc);
    }
  }

  // Entry point.
  const entryAttr = graphAttrs.get('entry');
  if (!entryAttr) {
    error('Set the entry point where requests arrive: `graph [entry=<node>];`.', graph.location);
  } else if (!nodes.has(entryAttr.value)) {
    error(`Entry "${entryAttr.value}" isn't a node in this graph.${suggest(entryAttr.value, [...nodes.keys()])}`, entryAttr.loc);
  }

  const cycle = findCycle(out);
  if (cycle) error(`Dependency cycle: ${cycle.join(' -> ')}. The topology must be acyclic.`);

  if (entryAttr && nodes.has(entryAttr.value)) {
    const reachable = reachableFrom(entryAttr.value, out);
    const unreachable = [...nodes.keys()].filter((id) => !reachable.has(id));
    if (unreachable.length > 0) {
      report('warning', `Not reachable from entry "${entryAttr.value}", so not modeled: ${unreachable.join(', ')}.`);
    }
  }

  if (hasErrors(diagnostics)) return { diagnostics };
  return {
    value: { name: graph.id?.value ?? 'topology', entry: entryAttr!.value, nodes, edges, out },
    diagnostics,
  };
}

function findCycle(out: Map<string, TopologyEdge[]>): string[] | undefined {
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'visiting') return [...path.slice(path.indexOf(id)), id];
    state.set(id, 'visiting');
    path.push(id);
    for (const edge of out.get(id) ?? []) {
      const cycle = visit(edge.to);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const id of out.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return undefined;
}

function reachableFrom(start: string, out: Map<string, TopologyEdge[]>): Set<string> {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length > 0) {
    for (const edge of out.get(stack.pop()!) ?? []) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        stack.push(edge.to);
      }
    }
  }
  return seen;
}
