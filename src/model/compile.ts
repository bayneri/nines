/**
 * Compiles a topology plus inputs into the flat form both availability
 * engines share: integer node indices, per-node instance counts and the
 * failure parameters derived from `availability` and `transient`.
 *
 * Instance rules: a plain edge calls instance 0 of its target; `fanout=N`
 * calls instances 0..N-1. So a node has as many instances as the largest
 * fanout into it, and the same instance index is the same instance no matter
 * who calls it.
 *
 * Every edge calls a prefix of its target's instances, so the fanout values
 * into a node cut its instances into classes: [0, b1), [b1, b2), ... Instances
 * in one class have the same callers, outage probability and dependencies, so
 * they are interchangeable: only how many of them are down matters.
 */
import type { Inputs } from './inputs';
import type { DependencyKind, NodeType, Topology } from './topology';

export interface CompiledEdge {
  /** Index of this call in `topology.edges`. */
  index: number;
  target: number;
  dependency: DependencyKind;
  fanout: number;
  fanoutRequire: number;
  retries: number;
  /** The call covers the target's first `classesCovered` instance classes. */
  classesCovered: number;
  stage: number;
  /** Infinity when the caller waits for as long as the call takes. */
  timeoutMs: number;
}

/** Lognormal latency fitted to p50 and p99: ln(latency) ~ Normal(mu, sigma). */
export interface LatencyModel {
  mu: number;
  sigma: number;
}

export interface CompiledNode {
  id: string;
  type: NodeType;
  /** Members that must succeed (groups only). */
  require: number;
  instances: number;
  /** First instance's global id; instance i is `offset + i`. */
  offset: number;
  /** Sizes of the node's instance classes, in instance order. */
  classSizes: number[];
  /** First class's global id; class c is `classOffset + c`. */
  classOffset: number;
  /** P(an instance is in an outage for the whole request). */
  outage: number;
  /** P(one attempt fails transiently), given the instance isn't in an outage. */
  transientFail: number;
  /** The node's own latency per attempt, excluding its calls. Services only. */
  latency?: LatencyModel;
  edges: CompiledEdge[];
  /** Service calls grouped by stage, in stage order. */
  stages: CompiledEdge[][];
}

export interface CompiledModel {
  nodes: CompiledNode[];
  entry: number;
  /** Total instances across all nodes. */
  instanceCount: number;
  classCount: number;
  /** Number of calls in the topology (reachable or not), for per-call results. */
  edgeCount: number;
}

/**
 * Splits a node's unavailability into an outage part and a per-attempt part
 * such that a single attempt still succeeds with probability `availability`:
 *   outage + (1 - outage) * transientFail = 1 - availability
 */
export function failureModel(availability: number, transient: number): { outage: number; transientFail: number } {
  const unavailability = 1 - availability;
  const outage = unavailability * (1 - transient);
  const transientFail = outage >= 1 ? 0 : (unavailability * transient) / (1 - outage);
  return { outage, transientFail };
}

/** z-score of the 99th percentile of the standard normal. */
const Z99 = 2.3263478740408408;

export function latencyModel(p50Ms: number, p99Ms: number): LatencyModel {
  return { mu: Math.log(p50Ms), sigma: Math.log(p99Ms / p50Ms) / Z99 };
}

export function compile(topology: Topology, inputs: Inputs): CompiledModel {
  // Reachable nodes only, in declaration order.
  const reachable = new Set([topology.entry]);
  const stack = [topology.entry];
  while (stack.length > 0) {
    for (const edge of topology.out.get(stack.pop()!)!) {
      if (!reachable.has(edge.to)) {
        reachable.add(edge.to);
        stack.push(edge.to);
      }
    }
  }
  const ids = [...topology.nodes.keys()].filter((id) => reachable.has(id));
  const index = new Map(ids.map((id, i) => [id, i]));
  const edgeIndex = new Map(topology.edges.map((e, i) => [e, i]));

  // Class boundaries per node: the distinct fanout values of edges into it.
  const boundaries = new Map(ids.map((id) => [id, new Set<number>()]));
  for (const id of ids) {
    for (const edge of topology.out.get(id)!) boundaries.get(edge.to)!.add(edge.fanout);
  }
  const sortedBoundaries = new Map(ids.map((id) => [id, [...boundaries.get(id)!].sort((a, b) => a - b)]));
  // The entry has no caller; it has one instance.
  if (sortedBoundaries.get(topology.entry)!.length === 0) sortedBoundaries.set(topology.entry, [1]);

  let offset = 0;
  let classOffset = 0;
  const nodes = ids.map((id): CompiledNode => {
    const node = topology.nodes.get(id)!;
    const own = inputs.nodes.get(id);
    const failure = node.type === 'service' ? failureModel(own!.availability, own!.transient) : { outage: 0, transientFail: 0 };
    const bounds = sortedBoundaries.get(id)!;
    const compiled: CompiledNode = {
      id,
      type: node.type,
      require: node.require ?? 0,
      instances: bounds[bounds.length - 1]!,
      offset,
      classSizes: bounds.map((b, c) => b - (c === 0 ? 0 : bounds[c - 1]!)),
      classOffset,
      ...failure,
      edges: topology.out.get(id)!.map((edge) => ({
        index: edgeIndex.get(edge)!,
        target: index.get(edge.to)!,
        dependency: edge.dependency,
        fanout: edge.fanout,
        fanoutRequire: edge.fanoutRequire,
        retries: edge.retries,
        classesCovered: sortedBoundaries.get(edge.to)!.indexOf(edge.fanout) + 1,
        stage: edge.stage,
        timeoutMs: edge.timeoutMs ?? Infinity,
      })),
      stages: [],
    };
    if (own?.latency) compiled.latency = latencyModel(own.latency.p50Ms, own.latency.p99Ms);
    const stageNumbers = [...new Set(compiled.edges.map((e) => e.stage))].sort((a, b) => a - b);
    compiled.stages = stageNumbers.map((n) => compiled.edges.filter((e) => e.stage === n));
    offset += compiled.instances;
    classOffset += bounds.length;
    return compiled;
  });

  return { nodes, entry: index.get(topology.entry)!, instanceCount: offset, classCount: classOffset, edgeCount: topology.edges.length };
}
