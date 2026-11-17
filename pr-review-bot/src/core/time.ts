/**
 * A Discord relative timestamp. Long form by necessity: Discord renders
 * `<t:…:R>` as "3 days ago" and offers no compact variant, so the compact `3d`
 * form is only reachable by computing ages — which would make the digest body a
 * function of wall-clock time and defeat the write-skip.
 */
export function relTs(epochMs: number): string {
  return `<t:${Math.floor(epochMs / 1000)}:R>`;
}

/** A never-synced store counts as stale, so a fresh deploy admits it has no data. */
export function isStale(lastSync: number | null, now: number, thresholdMs: number): boolean {
  if (lastSync === null) return true;
  return now - lastSync >= thresholdMs;
}
