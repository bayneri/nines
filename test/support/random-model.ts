import { seededRandom } from '../../src/model/probability';

/** A random valid topology with groups, soft deps, fan-out and retries, plus high failure rates. */
export function randomModel(seed: number, options: { latency?: boolean } = {}): { dot: string; yaml: string } {
  const random = seededRandom(seed);
  const pick = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
  const n = pick(4, 7);
  const groupType = new Map<number, 'any' | 'quorum'>();
  for (let i = 1; i <= n - 3; i++) if (random() < 0.25) groupType.set(i, random() < 0.6 ? 'any' : 'quorum');

  const edges = new Map<number, Set<number>>(Array.from({ length: n }, (_, i) => [i, new Set<number>()]));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) if (random() < 0.35) edges.get(i)!.add(j);
    while (groupType.has(i) && edges.get(i)!.size < 2) edges.get(i)!.add(pick(i + 1, n - 1));
  }
  for (let j = 1; j < n; j++) {
    if (![...edges.values()].some((targets) => targets.has(j))) edges.get(pick(0, j - 1))!.add(j);
  }

  const lines = ['digraph r {', '  entry=n0;'];
  for (const [i, type] of groupType) {
    lines.push(`  n${i} [type=${type}${type === 'quorum' ? `, require=${pick(1, edges.get(i)!.size)}` : ''}];`);
  }
  for (const [i, targets] of edges) {
    for (const j of targets) {
      const attrs = [`retries=${pick(0, groupType.has(i) ? 1 : 2)}`];
      if (!groupType.has(i)) {
        if (random() < 0.2) attrs.push('dependency=soft');
        if (!groupType.has(j) && random() < 0.25) {
          const fanout = pick(2, 3);
          attrs.push(`fanout=${fanout}`, `fanout_require=${pick(1, fanout)}`);
        }
      }
      lines.push(`  n${i} -> n${j} [${attrs.join(', ')}];`);
    }
  }
  lines.push('}');

  const nodes = Array.from({ length: n }, (_, i) => i).filter((i) => !groupType.has(i));
  const transient = () => [0, 1, random()][pick(0, 2)]!.toFixed(3);
  const defaults = options.latency ? 'defaults: { latency: { p50_ms: 10, p99_ms: 80 } }\n' : '';
  const yaml = defaults + 'nodes:\n' + nodes.map((i) => `  n${i}: { availability: ${(0.8 + 0.19 * random()).toFixed(3)}, transient: ${transient()} }`).join('\n');
  return { dot: lines.join('\n'), yaml };
}
