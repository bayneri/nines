import { useRef } from 'react';
import type { Diagnostic } from '../model/diagnostics';

export type FileTab = 'dot' | 'yaml';

interface Props {
  tab: FileTab;
  onTab: (tab: FileTab) => void;
  dot: string;
  yaml: string;
  onChange: (tab: FileTab, value: string) => void;
  diagnostics: Diagnostic[];
  readOnly?: boolean;
}

const FILES: { tab: FileTab; name: string; source: Diagnostic['source']; hint: string }[] = [
  { tab: 'dot', name: 'topology.dot', source: 'topology', hint: 'What you build: services, dependencies, redundancy, fan-out, retries, timeouts.' },
  { tab: 'yaml', name: 'inputs.yaml', source: 'inputs', hint: 'What you measure or assume: availability, failure mix, latency, objectives.' },
];

export function Editor({ tab, onTab, dot, yaml, onChange, diagnostics, readOnly }: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  const value = tab === 'dot' ? dot : yaml;
  const file = FILES.find((f) => f.tab === tab)!;
  const shown = diagnostics.filter((d) => d.source === file.source);
  const errorLines = new Set(shown.filter((d) => d.severity === 'error' && d.line).map((d) => d.line));
  const lineCount = value.split('\n').length;

  const jumpTo = (line: number) => {
    const el = textarea.current;
    if (!el) return;
    const lines = value.split('\n');
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    el.focus();
    el.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 18;
    el.scrollTop = Math.max(0, (line - 4) * lineHeight);
  };

  return (
    <section className={`editor${readOnly ? ' read-only' : ''}`} aria-label="Model source">
      <div className="tabs" role="tablist">
        {FILES.map((f) => {
          const errors = diagnostics.filter((d) => d.source === f.source && d.severity === 'error').length;
          return (
            <button key={f.tab} role="tab" aria-selected={tab === f.tab} className="tab" onClick={() => onTab(f.tab)}>
              {f.name}
              {errors > 0 && <span className="badge error" aria-label={`${errors} errors`}>{errors}</span>}
            </button>
          );
        })}
      </div>
      <p className="hint">{file.hint}</p>
      <div className="code">
        <pre ref={gutter} className="gutter" aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => (
            <span key={i} className={errorLines.has(i + 1) ? 'bad' : undefined}>
              {i + 1}
              {'\n'}
            </span>
          ))}
        </pre>
        <textarea
          ref={textarea}
          value={value}
          spellCheck={false}
          readOnly={readOnly}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={file.name}
          onChange={(e) => onChange(tab, e.target.value)}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
        />
      </div>
      {shown.length > 0 && (
        <ul className="diagnostics">
          {shown.map((d, i) => (
            <li key={i} className={d.severity}>
              {d.line ? (
                <button className="line" onClick={() => jumpTo(d.line!)}>
                  line {d.line}
                </button>
              ) : null}
              <span>{d.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
