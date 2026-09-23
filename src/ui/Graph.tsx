import { useEffect, useMemo, useRef, useState } from 'react';
import { type Doc, displayName, iconFor } from '../doc';
import { inputPercent } from './format';
import { Icon } from './icons';
import { layoutDoc } from './layout';
import { callText, failureMode, groupText, instancesOf, isShared, stepOf } from './words';

export type Selection = { kind: 'node'; id: string } | { kind: 'call'; index: number } | undefined;

/** What to draw as lost: per-node emphasis (0–1) and per-call loss labels. */
export interface LossOverlay {
  nodes: Map<string, number>;
  calls: Map<number, string>;
}

interface Props {
  doc: Doc;
  selection: Selection;
  /** Something to point at, e.g. a hovered row in the pane. */
  highlight?: Selection;
  losses?: LossOverlay;
  onSelect: (selection: Selection) => void;
  /** When set, clicking a service picks it instead of selecting it. */
  onPick?: (id: string) => void;
}

/** Small graphs are drawn up to this much larger than their natural size. */
const MAX_SCALE = 1.4;

/** The dependency graph: cards and rounded elbow calls, laid out by dagre. */
export function Graph({ doc, selection, highlight, losses, onSelect, onPick }: Props) {
  const layout = useMemo(() => layoutDoc(doc), [doc]);
  const frame = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState({ width: 0, height: 0 });
  const [hovered, setHovered] = useState<string>();

  // Fill the canvas: scale up small graphs, fit large ones to the width.
  useEffect(() => {
    const container = frame.current?.parentElement;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const style = getComputedStyle(container);
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      setSpace({ width: container.clientWidth - padX, height: container.clientHeight - padY });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const fitWidth = space.width > 0 ? space.width / layout.width : 1;
  const fitHeight = space.height > 0 ? space.height / layout.height : 1;
  let scale = Math.min(MAX_SCALE, fitWidth, fitHeight);
  // Rather than shrink a tall graph to illegibility, fit its width and scroll.
  if (scale < Math.min(1, fitWidth) * 0.75) scale = Math.min(1, fitWidth);
  const offsetX = Math.max(0, (space.width - layout.width * scale) / 2);
  const offsetY = Math.max(0, (space.height - layout.height * scale) / 2);

  // A shared dependency lights up with the calls into it while hovered or selected.
  const focusNode = selection?.kind === 'node' ? selection.id : hovered;
  const sharedFocus = focusNode && isShared(doc, focusNode) ? focusNode : undefined;
  const is = (s: Selection, kind: 'node' | 'call', key: string | number) =>
    s?.kind === kind && (s.kind === 'node' ? s.id === key : s.index === key);

  return (
    <div
      ref={frame}
      className={`graph${onPick ? ' picking' : ''}`}
      style={{ height: Math.max(space.height, layout.height * scale) }}
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as Element).classList.contains('graph-inner')) onSelect(undefined);
      }}
    >
      <div className="graph-inner" style={{ width: layout.width, height: layout.height, left: offsetX, top: offsetY, transform: `scale(${scale})` }}>
        <svg width={layout.width} height={layout.height} aria-hidden="true">
          <path className="ingress" d={layout.ingress.path} />
          {layout.edges.map((edge) => {
            const call = doc.calls[edge.index]!;
            const classes = [
              'edge',
              call.dependency,
              is(selection, 'call', edge.index) && 'selected',
              is(highlight, 'call', edge.index) && 'highlighted',
              losses?.calls.has(edge.index) && 'lost',
              sharedFocus === call.to && 'shared',
            ].filter(Boolean);
            return (
              <g key={edge.index} className={classes.join(' ')}>
                <path className="line" d={edge.path} />
                <path
                  className="hit"
                  d={edge.path}
                  onClick={() => !onPick && onSelect({ kind: 'call', index: edge.index })}
                />
              </g>
            );
          })}
        </svg>
        <span className="ingress-label" style={{ left: layout.ingress.label.x, top: layout.ingress.label.y }}>
          Requests
        </span>

        {layout.edges.map((edge) => {
          const text = callText(doc, edge.index);
          const step = stepOf(doc, edge.index);
          const loss = losses?.calls.get(edge.index);
          if (!text && !loss && step === undefined) return null;
          return (
            <button
              key={edge.index}
              className={`edge-label${is(selection, 'call', edge.index) ? ' selected' : ''}${loss ? ' lost' : ''}`}
              style={{ left: edge.label.x, top: edge.label.y }}
              onClick={() => !onPick && onSelect({ kind: 'call', index: edge.index })}
              aria-label={`${step !== undefined ? `Step ${step}: ` : ''}${text || 'plain call'}${loss ? `, ${loss}` : ''}`}
            >
              <span className="edge-text">
                {step !== undefined && (
                  <span className="step" title={`Step ${step}: runs after the calls in earlier steps`}>
                    {step}
                  </span>
                )}
                {text}
              </span>
              {loss && <span className="loss-text">{loss}</span>}
            </button>
          );
        })}

        {doc.nodes.map((node) => {
          const box = layout.nodes.get(node.id)!;
          const emphasis = losses?.nodes.get(node.id) ?? 0;
          const instances = instancesOf(doc, node.id);
          const classes = [
            node.type === 'service' ? 'card' : 'pill',
            node.id === doc.entry && 'entry',
            is(selection, 'node', node.id) && 'selected',
            is(highlight, 'node', node.id) && 'highlighted',
            sharedFocus === node.id && 'shared',
            emphasis >= 0.5 ? 'loss-strong' : emphasis >= 0.08 ? 'loss-mild' : '',
            instances > 1 && 'stacked',
          ].filter(Boolean);
          const activate = () => (onPick ? onPick(node.id) : onSelect({ kind: 'node', id: node.id }));
          return (
            <button
              key={node.id}
              className={classes.join(' ')}
              style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
              onClick={activate}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered((h) => (h === node.id ? undefined : h))}
              aria-pressed={is(selection, 'node', node.id)}
            >
              {node.type === 'service' ? (
                <>
                  <span className="card-title">
                    <Icon name={iconFor(doc, node)} size={18} />
                    <span className="name">{displayName(node)}</span>
                    {instances > 1 && <span className="instances">×{instances}</span>}
                  </span>
                  <span className="card-meta">
                    <span className="availability">{inputPercent(node.availability)}</span>
                    <span className="mode">{failureMode(node.transient)}</span>
                  </span>
                </>
              ) : (
                <span className="pill-text">{groupText(doc, node)}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
