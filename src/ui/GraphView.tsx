import { useEffect, useRef, useState } from 'react';

// Graphviz is ~1.4 MB of WebAssembly; load it after the rest of the app.
const viz = import('@viz-js/viz').then((m) => m.instance());

/** Renders DOT to SVG with Graphviz (WebAssembly), styled by CSS classes. */
export function GraphView({ dot, stale }: { dot: string | undefined; stale: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!dot) return;
    let cancelled = false;
    viz
      .then((v) => {
        if (cancelled || !container.current) return;
        const svg = v.renderSVGElement(dot);
        svg.removeAttribute('width');
        svg.removeAttribute('height');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', 'Service dependency graph');
        container.current.replaceChildren(svg);
        setError(undefined);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [dot]);

  return (
    <div className={`graph${stale ? ' stale' : ''}`}>
      <div ref={container} className="graph-canvas" />
      {!dot && <p className="graph-empty">Fix the topology errors to see the graph.</p>}
      {stale && dot && <p className="graph-note">Showing the last valid topology.</p>}
      {error && <p className="graph-note">Couldn't render the graph: {error}</p>}
    </div>
  );
}
