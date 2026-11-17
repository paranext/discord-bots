const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Bucket edges, fixed once shipped: persisted histograms are only meaningful
 * against the edges they were counted with. 12 edges give 13 buckets; the last
 * is open-ended.
 */
export const BUCKET_EDGES_MS: readonly number[] = [
  15 * MIN,
  30 * MIN,
  HOUR,
  2 * HOUR,
  4 * HOUR,
  8 * HOUR,
  DAY,
  2 * DAY,
  3 * DAY,
  5 * DAY,
  7 * DAY,
  14 * DAY,
];

/** Edges are lower-inclusive: exactly 15m lands in bucket 1. */
export function bucketIndex(ms: number): number {
  const i = BUCKET_EDGES_MS.findIndex((edge) => ms < edge);
  return i === -1 ? BUCKET_EDGES_MS.length : i;
}

export function emptyHistogram(): number[] {
  return new Array<number>(BUCKET_EDGES_MS.length + 1).fill(0);
}

export function addHistograms(a: number[], b: number[]): number[] {
  return a.map((n, i) => n + (b[i] ?? 0));
}

export function histogramCount(h: number[]): number {
  return h.reduce((sum, n) => sum + n, 0);
}

/**
 * Estimate the p-quantile (0..1) by walking buckets until the cumulative count
 * reaches p * n, then interpolating linearly inside that bucket. The open-ended
 * last bucket has no width, so it reports its lower edge. Null when empty.
 */
export function quantile(h: number[], p: number): number | null {
  const n = histogramCount(h);
  if (n === 0) return null;
  const target = p * n;
  let before = 0;
  for (let i = 0; i < h.length; i++) {
    const count = h[i] ?? 0;
    if (count > 0 && before + count >= target) {
      const lower = i === 0 ? 0 : (BUCKET_EDGES_MS[i - 1] as number);
      const upper = BUCKET_EDGES_MS[i];
      if (upper === undefined) return lower;
      return lower + ((target - before) / count) * (upper - lower);
    }
    before += count;
  }
  return BUCKET_EDGES_MS[BUCKET_EDGES_MS.length - 1] as number;
}
