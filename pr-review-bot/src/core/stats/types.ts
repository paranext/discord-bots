import { emptyHistogram } from "./histogram.js";

/** How a review round ended. */
export type RoundOutcome = "reviewed" | "merged-unreviewed" | "closed-unreviewed" | "cleared";

/**
 * One finished round, waiting for its week to be folded. Deliberately holds NO
 * identifying field: no Discord id, name, GitHub login, repo, PR number, title,
 * note, urgency or message id. That is what makes the stats anonymous.
 */
export interface PendingEntry {
  id: number;
  /** ISO week (UTC) in which the bot recorded the resolution, `YYYY-Www`. */
  week: string;
  outcome: RoundOutcome;
  /** Rounded to 5 minutes. Null when the round was never claimed. */
  waitToClaimMs: number | null;
  /** Rounded to 5 minutes. Null when the round was never claimed. */
  claimToDoneMs: number | null;
  totalMs: number;
  claimed: boolean;
  claimsDropped: number;
  reRequests: number;
}

export interface WeekTotals {
  outcomes: Record<RoundOutcome, number>;
  claimsDropped: number;
  roundsWithDrop: number;
  reRequests: number;
  histograms: { waitToClaim: number[]; claimToDone: number[]; total: number[] };
}

export interface StatsState {
  nextEntryId: number;
  pending: PendingEntry[];
  weeks: Record<string, WeekTotals>;
  /** Latest week folded; outputs never read past it. */
  foldedThrough: string | null;
  /**
   * First week collection covers in full: the week after the first fold ran.
   * Weeks before it hold no totals because nothing was collected, not because
   * nothing happened, so outputs must not read them as zeros. Null until the
   * first fold sets it.
   */
  sinceWeek: string | null;
}

export function emptyStats(): StatsState {
  return { nextEntryId: 1, pending: [], weeks: {}, foldedThrough: null, sinceWeek: null };
}

export function emptyWeek(): WeekTotals {
  return {
    outcomes: { reviewed: 0, "merged-unreviewed": 0, "closed-unreviewed": 0, cleared: 0 },
    claimsDropped: 0,
    roundsWithDrop: 0,
    reRequests: 0,
    histograms: { waitToClaim: emptyHistogram(), claimToDone: emptyHistogram(), total: emptyHistogram() },
  };
}
