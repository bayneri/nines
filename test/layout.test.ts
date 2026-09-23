import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../src/scenarios';
import { elbow, layoutDoc } from '../src/ui/layout';

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('layoutDoc', () => {
  it.each(SCENARIOS.map((s) => [s.id, s] as const))('%s: nodes are inside the canvas, apart, and edges join them', (_, scenario) => {
    const layout = layoutDoc(scenario.doc);
    const boxes = [...layout.nodes.values()];
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(layout.width);
      expect(box.y + box.height).toBeLessThanOrEqual(layout.height);
    }
    boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => expect(overlaps(a, b), `${a.id} overlaps ${b.id}`).toBe(false)));

    layout.edges.forEach((edge) => {
      const call = scenario.doc.calls[edge.index]!;
      const from = layout.nodes.get(call.from)!;
      const to = layout.nodes.get(call.to)!;
      const numbers = edge.path.match(/-?\d+(\.\d+)?/g)!.map(Number);
      // Starts at the caller's bottom centre and ends at the callee's top centre.
      expect(numbers.slice(0, 2)).toEqual([Math.round((from.x + from.width / 2) * 10) / 10, Math.round((from.y + from.height) * 10) / 10]);
      expect(numbers.slice(-2)).toEqual([Math.round((to.x + to.width / 2) * 10) / 10, Math.round(to.y * 10) / 10]);
    });
  });
});

describe('elbow', () => {
  it('draws a straight line when there is no turn', () => {
    expect(elbow([[10, 0], [10, 20], [10, 40]])).toBe('M10 0 L10 40');
  });

  it('rounds each turn', () => {
    expect(elbow([[0, 0], [0, 30], [50, 30], [50, 60]])).toBe('M0 0 L0 20 Q0 30 10 30 L40 30 Q50 30 50 40 L50 60');
  });
});
