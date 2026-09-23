/**
 * Lays out a Doc for drawing: dagre places the nodes in ranks, and each call
 * is routed as a rounded elbow from the bottom of its caller to the top of
 * its callee. Calls leaving one caller share a horizontal run, and calls
 * into one callee meet above it, which draws redundancy and shared
 * dependencies as the braces they are.
 */
import dagre from '@dagrejs/dagre';
import { type Doc, displayName } from '../doc';

export const CARD = { width: 184, height: 70 };
export const PILL = { width: 176, height: 50 };
const INGRESS = { width: 90, height: 18 };
/** Room for a two-line call label (what it does, and what it loses) above each callee. */
const RANK_GAP = 100;
const NODE_GAP = 52;
const MARGIN = 24;
const RADIUS = 10;

export interface NodeBox {
  id: string;
  /** Top-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EdgeRoute {
  /** Index into doc.calls. */
  index: number;
  path: string;
  /** Where the call's label sits, centred on the line. */
  label: { x: number; y: number };
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: Map<string, NodeBox>;
  edges: EdgeRoute[];
  /** The short "requests" lead-in above the entry. */
  ingress: { path: string; label: { x: number; y: number } };
}

export function layoutDoc(doc: Doc): GraphLayout {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: NODE_GAP, ranksep: RANK_GAP, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  g.setNode('\0requests', { ...INGRESS });
  for (const node of doc.nodes) g.setNode(node.id, node.type === 'service' ? { width: cardWidth(doc, node.id), height: CARD.height } : { ...PILL });
  g.setEdge('\0requests', doc.entry);
  for (const call of doc.calls) g.setEdge(call.from, call.to);
  dagre.layout(g);

  // dagre can put long edges' bends at negative coordinates; find the real bounds.
  const xs: number[] = [];
  const ys: number[] = [];
  for (const id of g.nodes()) {
    const n = g.node(id);
    xs.push(n.x - n.width / 2, n.x + n.width / 2);
    ys.push(n.y - n.height / 2, n.y + n.height / 2);
  }
  for (const e of g.edges()) for (const p of g.edge(e).points ?? []) xs.push(p.x);
  const dx = MARGIN - Math.min(...xs);
  const dy = MARGIN - Math.min(...ys);

  const nodes = new Map<string, NodeBox>();
  for (const node of doc.nodes) {
    const n = g.node(node.id);
    nodes.set(node.id, { id: node.id, x: n.x - n.width / 2 + dx, y: n.y - n.height / 2 + dy, width: n.width, height: n.height });
  }
  keepCallOrder(doc, nodes);

  const incoming = new Map<string, number>();
  for (const call of doc.calls) incoming.set(call.to, (incoming.get(call.to) ?? 0) + 1);

  const edges = doc.calls.map((call, index): EdgeRoute => {
    const from = nodes.get(call.from)!;
    const to = nodes.get(call.to)!;
    const sx = from.x + from.width / 2;
    const sy = from.y + from.height;
    const tx = to.x + to.width / 2;
    const ty = to.y;
    // A long edge runs down the channel dagre found for it, clear of other nodes.
    const bends = (g.edge({ v: call.from, w: call.to }).points ?? []).slice(1, -1);
    const channel = bends.length > 1 ? bends[Math.floor(bends.length / 2)]!.x + dx : tx;
    const yA = sy + RANK_GAP / 2;
    const yB = ty - RANK_GAP / 2;
    const path = elbow([
      [sx, sy],
      [sx, yA],
      [channel, yA],
      [channel, Math.max(yA, yB)],
      [tx, Math.max(yA, yB)],
      [tx, ty],
    ]);
    // A label sits on the part of the line that is the call's own: just above
    // its callee, or, when several calls meet at one callee, below its caller.
    const outgoing = doc.calls.filter((c) => c.from === call.from).length;
    const label =
      (incoming.get(call.to) ?? 0) > 1 && outgoing === 1
        ? { x: sx, y: (sy + yA) / 2 }
        : (incoming.get(call.to) ?? 0) > 1
          ? { x: (sx + channel) / 2, y: yA }
          : { x: tx, y: (Math.max(yA, yB) + ty) / 2 };
    return { index, path, label };
  });

  const entry = nodes.get(doc.entry)!;
  const ex = entry.x + entry.width / 2;
  const ingress = { path: `M${ex} ${entry.y - 30} V${entry.y}`, label: { x: ex, y: entry.y - 38 } };

  return {
    width: Math.max(...xs) + dx + MARGIN,
    height: Math.max(...ys) + dy + MARGIN,
    nodes,
    edges,
    ingress,
  };
}

/** Wide enough for the name, the icon and a fan-out badge, within limits. */
function cardWidth(doc: Doc, id: string): number {
  const node = doc.nodes.find((n) => n.id === id)!;
  const badge = doc.calls.some((c) => c.to === id && c.fanout > 1) ? 40 : 0;
  return Math.round(Math.min(280, Math.max(CARD.width, 64 + displayName(node).length * 8.4 + badge)));
}

/**
 * dagre orders nodes to reduce crossings, which can put a fallback left of
 * the first choice, or step 3 left of step 1. Callees that sit side by side
 * only for one caller swap into call order (step, then declaration), so
 * failover and steps read left to right. Their widths can differ, so they
 * are repacked into the same span rather than swapped slot for slot.
 */
function keepCallOrder(doc: Doc, nodes: Map<string, NodeBox>) {
  for (const caller of doc.nodes) {
    const calls = doc.calls.filter((c) => c.from === caller.id);
    const ordered = [...calls].sort((a, b) => a.stage - b.stage || calls.indexOf(a) - calls.indexOf(b)).map((c) => c.to);
    const exclusive = ordered.filter((id) => doc.calls.every((c) => c.to !== id || c.from === caller.id));
    const row = exclusive.filter((id) => nodes.get(id)!.y === nodes.get(exclusive[0]!)!.y);
    if (row.length < 2) continue;
    const boxes = row.map((id) => nodes.get(id)!);
    const left = Math.min(...boxes.map((b) => b.x));
    const right = Math.max(...boxes.map((b) => b.x + b.width));
    const gap = (right - left - boxes.reduce((sum, b) => sum + b.width, 0)) / (boxes.length - 1);
    let x = left;
    for (const box of boxes) {
      box.x = x;
      x += box.width + gap;
    }
  }
}

/** An orthogonal polyline with rounded corners, skipping zero-length legs. */
export function elbow(points: [number, number][]): string {
  const pts = points.filter((p, i) => i === 0 || Math.abs(p[0] - points[i - 1]![0]) > 0.5 || Math.abs(p[1] - points[i - 1]![1]) > 0.5);
  // Drop middle points on a straight line.
  const corners = pts.filter((p, i) => {
    if (i === 0 || i === pts.length - 1) return true;
    const [a, b] = [pts[i - 1]!, pts[i + 1]!];
    return !((Math.abs(a[0] - p[0]) < 0.5 && Math.abs(p[0] - b[0]) < 0.5) || (Math.abs(a[1] - p[1]) < 0.5 && Math.abs(p[1] - b[1]) < 0.5));
  });
  let d = `M${fmt(corners[0]![0])} ${fmt(corners[0]![1])}`;
  for (let i = 1; i < corners.length; i++) {
    const p = corners[i]!;
    const next = corners[i + 1];
    if (!next) {
      d += ` L${fmt(p[0])} ${fmt(p[1])}`;
      break;
    }
    const prev = corners[i - 1]!;
    const r = Math.min(RADIUS, dist(prev, p) / 2, dist(p, next) / 2);
    const inPoint = toward(p, prev, r);
    const outPoint = toward(p, next, r);
    d += ` L${fmt(inPoint[0])} ${fmt(inPoint[1])} Q${fmt(p[0])} ${fmt(p[1])} ${fmt(outPoint[0])} ${fmt(outPoint[1])}`;
  }
  return d;
}

const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const toward = (from: [number, number], to: [number, number], r: number): [number, number] => {
  const d = dist(from, to) || 1;
  return [from[0] + ((to[0] - from[0]) / d) * r, from[1] + ((to[1] - from[1]) / d) * r];
};
const fmt = (n: number) => Math.round(n * 10) / 10;
