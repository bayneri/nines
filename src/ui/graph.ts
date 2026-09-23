/**
 * Builds the DOT that is rendered, from the parsed topology rather than the
 * user's source: semantics become visible labels (×100, ↻3, 300 ms) and CSS
 * classes, so the picture follows the model and the theme.
 */
import type { Inputs } from '../model/inputs';
import type { Topology, TopologyEdge } from '../model/topology';
import { inputPercent } from './format';

const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function renderDot(topology: Topology, inputs?: Inputs): string {
  const lines = [
    'digraph G {',
    '  graph [rankdir=TB, nodesep=0.35, ranksep=0.45, bgcolor=transparent, pad=0.1];',
    '  node [shape=box, style="rounded,filled", fontname="Helvetica", fontsize=11, margin="0.14,0.06", penwidth=1.2];',
    '  edge [fontname="Helvetica", fontsize=10, arrowsize=0.7, penwidth=1.2];',
  ];

  for (const node of topology.nodes.values()) {
    const classes = [node.type === 'service' ? 'service' : 'group'];
    if (node.kind === 'infra') classes.push('infra');
    if (node.id === topology.entry) classes.push('entry');
    let detail: string;
    if (node.type === 'any') detail = `any of ${topology.out.get(node.id)!.length}`;
    else if (node.type === 'quorum') detail = `${node.require} of ${topology.out.get(node.id)!.length}`;
    else {
      const own = inputs?.nodes.get(node.id);
      detail = own ? inputPercent(own.availability) : '';
    }
    const label = detail ? `${node.id}\\n${detail}` : node.id;
    const shape = node.type === 'service' ? '' : ', shape=box, style="rounded,filled,dashed"';
    lines.push(`  ${quote(node.id)} [label="${label.replace(/"/g, '\\"')}", class="${classes.join(' ')}", id=${quote(`node-${node.id}`)}${shape}];`);
  }

  const multiStage = new Set(
    [...topology.out].filter(([, edges]) => new Set(edges.map((e) => e.stage)).size > 1).map(([id]) => id),
  );
  for (const edge of topology.edges) {
    const label = edgeLabel(edge, multiStage.has(edge.from));
    const classes: string[] = [edge.dependency];
    if (topology.nodes.get(edge.from)!.type !== 'service') classes.push('member');
    const style = edge.dependency === 'soft' ? ', style=dashed' : '';
    lines.push(`  ${quote(edge.from)} -> ${quote(edge.to)} [label=${quote(label)}, class="${classes.join(' ')}"${style}];`);
  }
  lines.push('}');
  return lines.join('\n');
}

function edgeLabel(edge: TopologyEdge, showStage: boolean): string {
  const parts: string[] = [];
  if (showStage) parts.push(`stage ${edge.stage}`);
  if (edge.dependency === 'soft') parts.push('soft');
  if (edge.fanout > 1) parts.push(edge.fanoutRequire < edge.fanout ? `≥${edge.fanoutRequire} of ×${edge.fanout}` : `×${edge.fanout}`);
  if (edge.retries > 0) parts.push(`↻${edge.retries}`);
  if (edge.timeoutMs !== undefined) parts.push(`${edge.timeoutMs} ms`);
  return parts.length > 0 ? ` ${parts.join(' · ')} ` : '';
}
