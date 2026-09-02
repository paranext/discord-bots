import { isOpen, type PrRecord } from "./record.js";

export type ClaimOutcome =
  | { kind: "claimed"; record: PrRecord }
  | { kind: "released"; record: PrRecord }
  | { kind: "already-claimed"; byName: string }
  | { kind: "not-open" };

/**
 * First-write-wins. A reaction never supersedes an existing claim, and this is
 * deliberately not "earliest timestamp wins": the reactions endpoint carries no
 * per-reaction timestamp, so a reaction can only be stamped at detection time.
 */
export function applyClaim(
  r: PrRecord,
  userId: string,
  displayName: string,
  at: number,
): ClaimOutcome {
  if (!isOpen(r)) return { kind: "not-open" };

  if (r.claimedBy !== null && r.claimedBy !== userId) {
    return { kind: "already-claimed", byName: r.claimedByName ?? "someone" };
  }
  if (r.claimedBy === userId) return { kind: "claimed", record: r };

  return {
    kind: "claimed",
    record: {
      ...r,
      claimedBy: userId,
      claimedByName: displayName,
      claimedAt: at,
      // A new claim resets the auto-clear markers.
      lastClaimedByName: null,
      claimClearedAt: null,
    },
  };
}

export function applyUnclaim(r: PrRecord, userId: string): ClaimOutcome {
  if (r.claimedBy === null) return { kind: "released", record: r };
  if (r.claimedBy !== userId) {
    return { kind: "already-claimed", byName: r.claimedByName ?? "someone" };
  }
  return {
    kind: "released",
    record: { ...r, claimedBy: null, claimedByName: null, claimedAt: null },
  };
}

/**
 * Auto-clearing returns the PR to its team section where someone else can pick it
 * up. It deliberately does NOT display a warning beside the claimer's name: a ⚠️
 * in a permanently pinned message is a public lateness board, and the predictable
 * adaptation is that people stop claiming.
 */
export function clearStaleClaim(r: PrRecord, now: number, thresholdMs: number): PrRecord {
  if (r.claimedAt === null) return r;
  if (now - r.claimedAt < thresholdMs) return r;
  return {
    ...r,
    claimedBy: null,
    claimedAt: null,
    claimedByName: null,
    lastClaimedByName: r.claimedByName,
    claimClearedAt: now,
  };
}
