/** Number of nines: 0.999 -> 3. */
export function nines(p: number): number {
  return p >= 1 ? Infinity : -Math.log10(1 - p);
}

/**
 * A percentage with enough decimals to show two significant figures of the
 * failure rate: 0.99939 -> "99.939%", 0.8344 -> "83.44%".
 */
export function percent(p: number, digits = decimalsFor(p)): string {
  return `${(p * 100).toFixed(digits)}%`;
}

export function decimalsFor(p: number): number {
  if (p >= 1) return 2;
  const failurePercent = (1 - p) * 100;
  // The epsilon keeps 1 - 0.9999 = 9.99999e-5 from counting as one more decimal.
  return Math.min(8, Math.max(2, Math.ceil(-Math.log10(failurePercent) - 1e-9) + 1));
}

/** A percentage as people write it in inputs: 0.9995 -> "99.95%", 0.999 -> "99.9%". */
export function inputPercent(p: number): string {
  return `${parseFloat((p * 100).toFixed(6))}%`;
}

export function formatNines(p: number): string {
  const n = nines(p);
  return n === Infinity ? '∞ nines' : `${n.toFixed(1)} nines`;
}

/** Failed requests expressed as equivalent full-outage time per 30 days. */
export function downtimePer30Days(p: number): string {
  const minutes = (1 - p) * 30 * 24 * 60;
  if (minutes < 1) return `${(minutes * 60).toFixed(0)} s`;
  if (minutes < 120) return `${minutes.toFixed(0)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

/** "0.3 nines" difference between two availabilities, signed as a - b. */
export function ninesDelta(a: number, b: number): number {
  return nines(a) - nines(b);
}

export function ms(value: number): string {
  return value >= 100 ? `${value.toFixed(0)} ms` : `${value.toFixed(1)} ms`;
}

export function scientific(value: number): string {
  return value.toExponential(1).replace('e-', '×10⁻').replace(/\d+$/, (d) => [...d].map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+c]).join(''));
}
