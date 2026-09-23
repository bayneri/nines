import type { Doc } from '../doc';
import { stepOf } from './words';

/** Explains only the notation the current graph uses. */
export function Legend({ doc, lossesShown, onToggleLosses }: { doc: Doc; lossesShown: boolean; onToggleLosses: (on: boolean) => void }) {
  const hasSteps = doc.calls.some((_, i) => stepOf(doc, i) !== undefined);
  const hasOptional = doc.calls.some((c) => c.dependency === 'soft');
  const hasCopies = doc.calls.some((c) => c.fanout > 1);
  const hasGroups = doc.nodes.some((n) => n.type !== 'service');
  return (
    <div className="legend" role="group" aria-label="Legend">
      {hasSteps && (
        <p>
          <span className="step">1</span>
          <span className="step">2</span> Call order (same number: at once)
        </p>
      )}
      {hasOptional && (
        <p>
          <span className="swatch dashed" aria-hidden="true" /> Optional
        </p>
      )}
      {hasCopies && (
        <p>
          <span className="mini-stack" aria-hidden="true" /> Copies called at once
        </p>
      )}
      {hasGroups && (
        <p>
          <span className="mini-pill" aria-hidden="true" /> Fallback takes over
        </p>
      )}
      <label>
        <input type="checkbox" checked={lossesShown} onChange={(e) => onToggleLosses(e.target.checked)} />
        <span className="swatch loss" aria-hidden="true" /> Where requests are lost
      </label>
    </div>
  );
}
