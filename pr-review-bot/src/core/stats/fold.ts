import { bucketIndex } from "./histogram.js";
import { isoWeek, shiftWeek } from "./week.js";
import { emptyWeek, type PendingEntry, type StatsState, type WeekTotals } from "./types.js";

/** Add one entry to a COPY of the week's totals; the input is never mutated. */
function addEntry(week: WeekTotals, entry: PendingEntry): WeekTotals {
  const histograms = {
    waitToClaim: [...week.histograms.waitToClaim],
    claimToDone: [...week.histograms.claimToDone],
    total: [...week.histograms.total],
  };
  // Histograms count reviewed rounds only: a merge, close or clear says nothing
  // about how long a review takes. The two claim-phase histograms also need a
  // claim, and a duration to bucket.
  if (entry.outcome === "reviewed") {
    histograms.total[bucketIndex(entry.totalMs)]! += 1;
    if (entry.claimed && entry.waitToClaimMs !== null) histograms.waitToClaim[bucketIndex(entry.waitToClaimMs)]! += 1;
    if (entry.claimed && entry.claimToDoneMs !== null) histograms.claimToDone[bucketIndex(entry.claimToDoneMs)]! += 1;
  }
  return {
    outcomes: { ...week.outcomes, [entry.outcome]: week.outcomes[entry.outcome] + 1 },
    claimsDropped: week.claimsDropped + entry.claimsDropped,
    roundsWithDrop: week.roundsWithDrop + (entry.claimsDropped > 0 ? 1 : 0),
    reRequests: week.reRequests + entry.reRequests,
    histograms,
  };
}

/**
 * Fold every pending entry from a closed week into that week's totals and
 * delete the entry. A week is closed once its end plus the reopen window has
 * passed: until then a reopen can still withdraw an entry, and folding it
 * would make that impossible. `foldedThrough` is the last such week, and never
 * moves backwards (a clock that steps back must not un-fold anything).
 *
 * The first run also fixes `sinceWeek`, the first week collection sees from
 * its start: the deploy week is only partly observed, so its totals would read
 * as a quiet week rather than a half-watched one. Entries from before
 * `sinceWeek` are dropped unfolded, and `foldedThrough` stays null until
 * `sinceWeek` itself closes, so no output ever starts on a partial week.
 *
 * Pure: returns new state, the ids it removed (folded or dropped) so the
 * caller can null the record links that pointed at them, and how many of those
 * were actually folded into a week (dropped early entries are not).
 */
export function foldStats(
  stats: StatsState,
  now: number,
  reopenWindowMs: number,
): { stats: StatsState; foldedIds: number[]; folded: number } {
  const sinceWeek = stats.sinceWeek ?? shiftWeek(isoWeek(now), 1);
  const candidate = shiftWeek(isoWeek(now - reopenWindowMs), -1);
  const latest = stats.foldedThrough !== null && stats.foldedThrough > candidate ? stats.foldedThrough : candidate;
  // Nothing before sinceWeek is ever folded, so there is no foldedThrough to
  // report until sinceWeek itself is closed.
  const foldedThrough = latest >= sinceWeek ? latest : stats.foldedThrough;

  const early = stats.pending.filter((e) => e.week < sinceWeek);
  const closing = stats.pending.filter((e) => e.week >= sinceWeek && foldedThrough !== null && e.week <= foldedThrough);
  if (
    early.length === 0 &&
    closing.length === 0 &&
    foldedThrough === stats.foldedThrough &&
    sinceWeek === stats.sinceWeek
  ) {
    return { stats, foldedIds: [], folded: 0 };
  }

  const weeks = { ...stats.weeks };
  for (const entry of closing) weeks[entry.week] = addEntry(weeks[entry.week] ?? emptyWeek(), entry);
  const removed = new Set([...early, ...closing].map((e) => e.id));
  return {
    stats: { ...stats, weeks, pending: stats.pending.filter((e) => !removed.has(e.id)), foldedThrough, sinceWeek },
    foldedIds: [...removed],
    folded: closing.length,
  };
}
