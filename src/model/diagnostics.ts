export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  source: 'topology' | 'inputs';
  message: string;
  line?: number;
  column?: number;
}

export interface ParseResult<T> {
  /** Present only when there are no error-severity diagnostics. */
  value?: T;
  diagnostics: Diagnostic[];
}

export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

/** Suggests the closest known name for a likely typo (edit distance ≤ 2). */
export function suggest(name: string, known: readonly string[]): string {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of known) {
    const d = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best ? ` Did you mean "${best}"?` : '';
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = curr;
  }
  return prev[b.length]!;
}
