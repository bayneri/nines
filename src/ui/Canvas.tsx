import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Doc } from '../doc';
import { renderDot } from './graph';

export type Selection = { kind: 'node'; id: string } | { kind: 'call'; index: number } | undefined;

interface Props {
  doc: Doc;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  /** When set, clicking a service picks it instead of selecting it. */
  onPick?: (id: string) => void;
  toolbar: ReactNode;
  banner?: ReactNode;
  inspector?: ReactNode;
}

// Graphviz is ~1.4 MB of WebAssembly; load it after the rest of the app.
const viz = import('@viz-js/viz').then((m) => m.instance());
const SVG_NS = 'http://www.w3.org/2000/svg';
const INSPECTOR_WIDTH = 272;
const GAP = 14;
/** Matches .canvas-frame's min-height in styles.css. */
const FRAME_MIN_HEIGHT = 460;

/** The dependency graph, drawn by Graphviz and made clickable. */
export function Canvas({ doc, selection, onSelect, onPick, toolbar, banner, inspector }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const drawing = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<SVGSVGElement>();
  const [anchor, setAnchor] = useState<{ left: number; top: number; below: boolean }>();
  const [minHeight, setMinHeight] = useState<number>();

  useEffect(() => {
    let cancelled = false;
    viz.then((v) => {
      if (cancelled || !drawing.current) return;
      const element = v.renderSVGElement(renderDot(doc));
      element.removeAttribute('width');
      element.removeAttribute('height');
      element.setAttribute('role', 'group');
      element.setAttribute('aria-label', 'Dependency graph. Select a service or a call to edit it.');
      decorate(element, doc);
      drawing.current.replaceChildren(element);
      setSvg(element);
    });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  const selectedElement = useCallback((): Element | null => {
    if (!svg || !selection) return null;
    if (selection.kind === 'node') return svg.querySelector(`[data-node="${CSS.escape(selection.id)}"]`);
    return svg.querySelector(`[data-call="${selection.index}"]`);
  }, [svg, selection]);

  // Highlight the selection and place the inspector beside it.
  useLayoutEffect(() => {
    if (!svg) return;
    svg.querySelectorAll('.selected').forEach((e) => e.classList.remove('selected'));
    const element = selectedElement();
    element?.classList.add('selected');
    const place = () => {
      if (!element || !frame.current) return setAnchor(undefined);
      const box = frame.current.getBoundingClientRect();
      const target = element.getBoundingClientRect();
      const top = Math.max(GAP, target.top - box.top - 8);
      if (target.right - box.left + GAP + INSPECTOR_WIDTH <= box.width) return setAnchor({ left: target.right - box.left + GAP, top, below: false });
      if (target.left - box.left - GAP - INSPECTOR_WIDTH >= 0) return setAnchor({ left: target.left - box.left - GAP - INSPECTOR_WIDTH, top, below: false });
      setAnchor({ left: 0, top: 0, below: true });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [svg, selectedElement]);

  // Keep the inspector inside the canvas: slide it up, and grow the canvas
  // when the inspector is taller than the drawing.
  useLayoutEffect(() => {
    const element = popover.current;
    if (!element || !anchor || anchor.below) return setMinHeight(undefined);
    const fit = () => {
      const height = element.offsetHeight;
      // The frame's natural height: its CSS minimum or the drawing plus padding.
      const available = Math.max(FRAME_MIN_HEIGHT, (drawing.current?.offsetHeight ?? 0) + 2 * 16);
      const top = Math.max(GAP, Math.min(anchor.top, available - height - GAP));
      element.style.top = `${top}px`;
      setMinHeight(top + height + GAP > available ? top + height + GAP : undefined);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchor]);

  const activate = (target: EventTarget | null) => {
    const element = (target as Element | null)?.closest('[data-node], [data-call]');
    if (!element) return onSelect(undefined);
    const node = element.getAttribute('data-node');
    if (node !== null) return onPick ? onPick(node) : onSelect({ kind: 'node', id: node });
    if (!onPick) onSelect({ kind: 'call', index: Number(element.getAttribute('data-call')) });
  };

  return (
    <section className={`canvas${onPick ? ' picking' : ''}`} aria-label="System">
      <div className="canvas-toolbar">{toolbar}</div>
      {banner}
      <div ref={frame} className="canvas-frame" style={minHeight ? { minHeight } : undefined}>
        <div
          ref={drawing}
          className="drawing"
          onClick={(e) => activate(e.target)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              activate(e.target);
            }
          }}
        />
        {inspector && anchor && !anchor.below && (
          <div ref={popover} className="inspector-anchor" style={{ left: anchor.left, top: anchor.top, width: INSPECTOR_WIDTH }}>
            {inspector}
          </div>
        )}
      </div>
      {inspector && anchor?.below && <div className="inspector-below">{inspector}</div>}
    </section>
  );
}

/** Tags nodes and calls with what they represent, and makes them focusable. */
function decorate(svg: SVGSVGElement, doc: Doc) {
  doc.nodes.forEach((node, i) => {
    const g = svg.getElementById(`n${i}`);
    if (!g) return;
    g.setAttribute('data-node', node.id);
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', `${node.id}${node.id === doc.entry ? ', where requests arrive' : ''}`);
    g.querySelector('title')?.remove();
  });
  doc.calls.forEach((call, i) => {
    const g = svg.getElementById(`e${i}`);
    if (!g) return;
    g.setAttribute('data-call', String(i));
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', `${call.from} calls ${call.to}`);
    g.querySelector('title')?.remove();
    // Edges are thin; a wide transparent copy makes them easy to click.
    const path = g.querySelector('path');
    if (path) {
      const hit = document.createElementNS(SVG_NS, 'path');
      hit.setAttribute('d', path.getAttribute('d') ?? '');
      hit.setAttribute('class', 'hit');
      g.insertBefore(hit, g.firstChild);
    }
  });
  svg.querySelectorAll('title').forEach((t) => t.remove());
}
