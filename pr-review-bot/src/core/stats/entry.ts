import type { RoundExit } from "../exit.js";
import type { PrRecord } from "../record.js";
import { isoWeek } from "./week.js";
import type { PendingEntry } from "./types.js";

const FIVE_MINUTES_MS = 5 * 60_000;

/** Coarsening to 5 minutes keeps an exact timestamp from re-identifying a round. */
function roundTo5Min(ms: number): number {
  return Math.round(ms / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
}

/** Clock skew between GitHub and the bot can make a span negative; report 0. */
function span(from: number, to: number): number {
  return roundTo5Min(Math.max(0, to - from));
}

/**
 * Turns a finished round into an anonymous pending entry. Takes the record only
 * to read its timing and counters; the result copies none of its identity.
 *
 * Null for a round that predates schema 7 (`roundStartedAt` null): its start is
 * unknown, so any duration would be invented.
 */
export function buildEntry(
  record: PrRecord,
  exit: RoundExit,
  id: number,
  recordedAt: number,
): PendingEntry | null {
  if (record.roundStartedAt === null) return null;
  // doneAt comes from a GitHub timestamp, which can be null or parse to NaN.
  const doneAt =
    exit.doneAt !== null && Number.isFinite(exit.doneAt)
      ? exit.doneAt
      : recordedAt;
  // A reaction claim is timestamped when a tick sees it, which can be after
  // the review landed. Capping it at the done time keeps wait-to-claim within
  // the total and claim-to-done at zero rather than negative.
  const claimedAt =
    record.roundFirstClaimedAt === null ? null : Math.min(record.roundFirstClaimedAt, doneAt);
  return {
    id,
    // The week the bot recorded the resolution, not the week GitHub says it
    // happened: a late-found review must land in a week not yet folded.
    week: isoWeek(recordedAt),
    outcome: exit.outcome,
    waitToClaimMs:
      claimedAt === null ? null : span(record.roundStartedAt, claimedAt),
    claimToDoneMs: claimedAt === null ? null : span(claimedAt, doneAt),
    totalMs: span(record.roundStartedAt, doneAt),
    claimed: claimedAt !== null,
    claimsDropped: record.roundClaimsDropped,
    reRequests: record.roundReRequests,
  };
}
