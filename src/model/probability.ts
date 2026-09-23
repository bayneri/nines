/** Distribution of the number of successes among independent trials (Poisson binomial). */
export function successCountDistribution(probabilities: readonly number[]): Float64Array {
  const dist = new Float64Array(probabilities.length + 1);
  dist[0] = 1;
  probabilities.forEach((p, n) => {
    for (let k = n + 1; k >= 1; k--) dist[k] = dist[k]! * (1 - p) + dist[k - 1]! * p;
    dist[0] = dist[0]! * (1 - p);
  });
  return dist;
}

/** P(at least `k` of the independent trials succeed). */
export function atLeast(probabilities: readonly number[], k: number): number {
  if (k <= 0) return 1;
  if (k === probabilities.length) return probabilities.reduce((acc, p) => acc * p, 1);
  const dist = successCountDistribution(probabilities);
  let total = 0;
  for (let j = k; j < dist.length; j++) total += dist[j]!;
  return Math.min(1, total);
}

/**
 * P(Binomial(n, p) >= k). Sums whichever tail is shorter, in log space, so
 * large n doesn't underflow.
 */
export function binomialAtLeast(n: number, p: number, k: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p >= 1) return 1;
  if (p <= 0) return 0;
  if (k === n) return p ** n;
  // Upper tail as "at most n-k failures" when that's the shorter sum;
  // otherwise 1 - "at most k-1 successes".
  const failuresTail = n - k <= k - 1;
  const [q, terms] = failuresTail ? [1 - p, n - k] : [p, k - 1];
  const tail = binomialAtMost(n, q, terms);
  return failuresTail ? tail : Math.max(0, 1 - tail);
}

/** P(Binomial(n, q) <= m). */
function binomialAtMost(n: number, q: number, m: number): number {
  const logRatio = Math.log(q) - Math.log1p(-q);
  let logTerm = n * Math.log1p(-q);
  let maxLog = logTerm;
  const logs = [logTerm];
  for (let j = 1; j <= m; j++) {
    logTerm += Math.log((n - j + 1) / j) + logRatio;
    logs.push(logTerm);
    if (logTerm > maxLog) maxLog = logTerm;
  }
  let sum = 0;
  for (const l of logs) sum += Math.exp(l - maxLog);
  return Math.min(1, Math.exp(maxLog) * sum);
}

/** P(Binomial(n, p) = j) for j = 0..min(n, maxJ). */
export function binomialPmf(n: number, p: number, maxJ: number): number[] {
  const upTo = Math.min(n, maxJ);
  const logRatio = Math.log(p) - Math.log1p(-p);
  let logTerm = n * Math.log1p(-p);
  const pmf = [Math.exp(logTerm)];
  for (let j = 1; j <= upTo; j++) {
    logTerm += Math.log((n - j + 1) / j) + logRatio;
    pmf.push(Math.exp(logTerm));
  }
  return pmf;
}

/** Deterministic PRNG (mulberry32) so sampled results are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
