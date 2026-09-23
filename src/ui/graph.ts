/**
 * Builds the DOT that is drawn, from the doc rather than any source text.
 * Semantics become labels (×100, ↻3, 300 ms) and CSS classes; nodes and
 * calls get element ids (n0, e0) so clicks map back to the doc.
 */
import type { Doc, DocCall, DocNode } from '../doc';
import { inputPercent } from './format';

/** Escapes text for inside a double-quoted DOT string. */
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export const nodeElementId = (index: number) => `n${index}`;
export const callElementId = (index: number) => `e${index}`;

/** How a service fails, in words: outages last, flaky failures pass on retry. */
export function failureMix(transient: number): string {
  if (transient >= 0.8) return 'flaky';
  if (transient <= 0.2) return 'outages';
  return 'mixed';
}

export function renderDot(doc: Doc): string {
  const lines = [
    'digraph G {',
    '  graph [rankdir=TB, nodesep=0.45, ranksep=0.5, bgcolor=transparent, pad=0.2];',
    '  node [shape=box, style="rounded,filled", fontname="Helvetica", fontsize=11, margin="0.16,0.07", penwidth=1.2];',
    '  edge [fontname="Helvetica", fontsize=10, arrowsize=0.7, penwidth=1.2];',
    '  "__requests" [shape=plaintext, style="", label="requests", class="ingress", fontsize=10];',
    `  "__requests" -> "${esc(doc.entry)}" [class="ingress", arrowsize=0.6];`,
  ];
  const members = (id: string) => doc.calls.filter((c) => c.from === id).length;

  doc.nodes.forEach((node, i) => {
    const classes = [node.type === 'service' ? 'service' : 'group'];
    if (node.infra) classes.push('infra');
    if (node.id === doc.entry) classes.push('entry');
    const style = node.type === 'service' ? '' : ', style="rounded,filled,dashed"';
    const label = `${esc(node.id)}\\n${esc(nodeDetail(node, members(node.id)))}`;
    lines.push(`  "${esc(node.id)}" [label="${label}", id="${nodeElementId(i)}", class="${classes.join(' ')}"${style}];`);
  });

  const multiStage = new Set(
    doc.nodes.filter((n) => new Set(doc.calls.filter((c) => c.from === n.id).map((c) => c.stage)).size > 1).map((n) => n.id),
  );
  const groups = new Set(doc.nodes.filter((n) => n.type !== 'service').map((n) => n.id));
  doc.calls.forEach((call, i) => {
    const classes: string[] = [call.dependency];
    if (groups.has(call.from)) classes.push('member');
    const style = call.dependency === 'soft' ? ', style=dashed' : '';
    const label = esc(callLabel(call, multiStage.has(call.from)));
    lines.push(`  "${esc(call.from)}" -> "${esc(call.to)}" [label="${label}", id="${callElementId(i)}", class="${classes.join(' ')}"${style}];`);
  });
  lines.push('}');
  return lines.join('\n');
}

function nodeDetail(node: DocNode, members: number): string {
  if (node.type === 'any') return `either of ${members}`;
  if (node.type === 'quorum') return `${node.require ?? '?'} of ${members}`;
  return `${inputPercent(node.availability)} · ${failureMix(node.transient)}`;
}

export function callLabel(call: DocCall, showStage: boolean): string {
  const parts: string[] = [];
  if (showStage) parts.push(`step ${call.stage + 1}`);
  if (call.dependency === 'soft') parts.push('soft');
  if (call.fanout > 1) parts.push(call.fanoutRequire < call.fanout ? `${call.fanoutRequire} of ×${call.fanout}` : `×${call.fanout}`);
  if (call.retries > 0) parts.push(`↻${call.retries}`);
  if (call.timeoutMs !== undefined) parts.push(`${call.timeoutMs} ms`);
  return parts.length > 0 ? ` ${parts.join(' · ')} ` : '';
}
