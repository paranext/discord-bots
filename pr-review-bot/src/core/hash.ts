/**
 * FNV-1a over UTF-16 code units. Synchronous and dependency-free because the
 * renderer is pure: `crypto.subtle.digest` is async and would force the whole
 * render path to be awaited. Collision risk is irrelevant here — the only
 * consequence of a collision is one skipped digest edit, corrected next tick.
 */
export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
