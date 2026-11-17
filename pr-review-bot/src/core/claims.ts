import { isOpen, type ClaimSource, type PrRecord } from "./record.js";

export type ClaimOutcome =
  | { kind: "claimed"; record: PrRecord }
  | { kind: "released"; record: PrRecord }
  | { kind: "already-claimed"; byName: string }
  | { kind: "not-open" };

/**
 * A release sooner than this after the claim is a mis-click, not a dropped
 * review, so it does not count toward `roundClaimsDropped`.
 */
export const MISTAKEN_RELEASE_MS = 5 * 60_000;

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
  source: ClaimSource,
): ClaimOutcome {
  if (!isOpen(r)) return { kind: "not-open" };

  if (r.claimedBy !== null && r.claimedBy !== userId) {
    return { kind: "already-claimed", byName: r.claimedByName ?? "someone" };
  }
  // Returns the record UNCHANGED, so an idempotent re-claim cannot repair a
  // wrong `claimSource`. Nothing may depend on it doing so.
  if (r.claimedBy === userId) return { kind: "claimed", record: r };

  return {
    kind: "claimed",
    record: {
      ...r,
      claimedBy: userId,
      claimedByName: displayName,
      claimedAt: at,
      claimSource: source,
      // Only the first claim of a round is kept: a later claim after a release
      // must not move the "wait to claim" endpoint.
      roundFirstClaimedAt: r.roundFirstClaimedAt ?? at,
      // A menu claim removes the record from the reaction polling set, so the
      // observation sequence breaks here and the next poll after it returns
      // must prime. A reaction claim was itself produced by an observation, so
      // the set the same sync just wrote stays valid.
      lastReactors: source === "menu" ? null : r.lastReactors,
      // A new claim resets the auto-clear markers.
      lastClaimedByName: null,
      claimClearedAt: null,
    },
  };
}

export function applyUnclaim(r: PrRecord, userId: string, at: number): ClaimOutcome {
  if (r.claimedBy === null) return { kind: "released", record: r };
  if (r.claimedBy !== userId) {
    return { kind: "already-claimed", byName: r.claimedByName ?? "someone" };
  }
  // `at` is required by the type, but an old-build worker can still send an
  // `unclaim` without it during a deploy. Treat that as "don't count a drop"
  // rather than letting NaN reach the record; the release itself still happens.
  const heldMs = r.claimedAt !== null && Number.isFinite(at) ? at - r.claimedAt : null;
  const dropped = heldMs !== null && heldMs >= MISTAKEN_RELEASE_MS;
  const mistaken = heldMs !== null && heldMs < MISTAKEN_RELEASE_MS;
  // A mis-click is treated as if the claim never happened, so if it was the
  // round's first claim its time must go too: left in place, the round would
  // report a wait-to-claim ending at a claim nobody meant. A mis-click after an
  // earlier real claim leaves that earlier time alone.
  const forgetFirstClaim = mistaken && r.roundFirstClaimedAt === r.claimedAt;
  return {
    kind: "released",
    record: {
      ...r,
      claimedBy: null,
      claimedByName: null,
      claimedAt: null,
      claimSource: null,
      roundClaimsDropped: r.roundClaimsDropped + (dropped ? 1 : 0),
      roundFirstClaimedAt: forgetFirstClaim ? null : r.roundFirstClaimedAt,
    },
  };
}

/**
 * Auto-clearing returns the PR to the open list where someone else can pick it
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
    claimSource: null,
    lastClaimedByName: r.claimedByName,
    claimClearedAt: now,
    // A stale auto-clear always counts as a drop, however the claim got stale.
    roundClaimsDropped: r.roundClaimsDropped + 1,
  };
}
