/** Plain-language descriptions shared by the graph and the pane. */
import { type Doc, type DocNode, displayName } from '../doc';

export function failureMode(transient: number): string {
  if (transient >= 0.8) return 'Flaky';
  if (transient <= 0.2) return 'Outages';
  return 'Mixed failures';
}

export function groupText(doc: Doc, node: DocNode): string {
  if (node.label) return node.label;
  const members = doc.calls.filter((c) => c.from === node.id).length;
  if (node.type === 'any') return members === 2 ? 'Either succeeds' : `Any of ${members} succeeds`;
  return `${node.require ?? 1} of ${members} must answer`;
}

/** The call's step, when its caller runs calls in more than one step. */
export function stepOf(doc: Doc, index: number): number | undefined {
  const call = doc.calls[index]!;
  const caller = doc.nodes.find((n) => n.id === call.from)!;
  const steps = new Set(doc.calls.filter((c) => c.from === call.from).map((c) => c.stage));
  return caller.type === 'service' && steps.size > 1 ? [...steps].sort((a, b) => a - b).indexOf(call.stage) + 1 : undefined;
}

/** What a call does differently from a plain "wait for it" call, in words (steps aside). */
export function callText(doc: Doc, index: number): string {
  const call = doc.calls[index]!;
  const caller = doc.nodes.find((n) => n.id === call.from)!;
  const siblings = doc.calls.filter((c) => c.from === call.from);
  const parts: string[] = [];
  if (caller.type === 'any' && siblings.indexOf(call) > 0) parts.push('Fallback');
  if (call.dependency === 'soft') parts.push('Optional');
  if (call.fanout > 1) parts.push(call.fanoutRequire < call.fanout ? `${call.fanoutRequire} of ${call.fanout} needed` : `×${call.fanout}`);
  if (call.retries > 0) parts.push(call.retries === 1 ? '1 retry' : `${call.retries} retries`);
  if (call.timeoutMs !== undefined) parts.push(`${call.timeoutMs} ms timeout`);
  return parts.join(' · ');
}

/** A call's name: "Caller → Callee", or just the callee for a group's option. */
export function callName(doc: Doc, index: number): string {
  const call = doc.calls[index]!;
  const caller = doc.nodes.find((n) => n.id === call.from)!;
  const callee = displayName(doc.nodes.find((n) => n.id === call.to)!);
  return caller.type === 'service' ? `${displayName(caller)} → ${callee}` : callee;
}

/** A share of requests with two significant figures: 15.4%, 1.0%, 0.050%, 0.0099%. */
export function share(value: number): string {
  const percent = value * 100;
  if (percent <= 0) return '0%';
  // Decide decimals on the value rounded to two significant figures, so
  // 0.0099999 formats like 0.010 rather than 0.0100.
  const rounded = Number(percent.toPrecision(2));
  const decimals = Math.min(6, Math.max(1, 1 - Math.floor(Math.log10(rounded))));
  return `${percent.toFixed(decimals)}%`;
}

export function nodeName(doc: Doc, id: string): string {
  const node = doc.nodes.find((n) => n.id === id);
  return node ? displayName(node) : id;
}

/** Largest fan-out into a node: how many instances of it exist. */
export function instancesOf(doc: Doc, id: string): number {
  return Math.max(1, ...doc.calls.filter((c) => c.to === id).map((c) => c.fanout));
}

/** A shared dependency: called by more than one caller. */
export function isShared(doc: Doc, id: string): boolean {
  return new Set(doc.calls.filter((c) => c.to === id).map((c) => c.from)).size > 1;
}
