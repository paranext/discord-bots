import type { RoundOutcome } from "./stats/types.js";
import { isOpen, resolveRecord, type PrRecord } from "./record.js";

export interface ReviewEvent {
  /** Epoch ms. Null means PENDING — a reviewer with unsubmitted line comments. */
  submittedAt: number | null;
  state: string;
  authorLogin: string | null;
  /** True when GraphQL reported the author's __typename as Bot. */
  authorIsBot: boolean;
}

export interface PrSnapshot {
  slug: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  merged: boolean;
  isDraft: boolean;
  authorLogin: string | null;
  reviews: ReviewEvent[];
  /** Epoch ms GitHub recorded the merge; null while unmerged. */
  mergedAt: number | null;
  /** Epoch ms GitHub recorded the close (also set on merge); null while open. */
  closedAt: number | null;
}

/** How a round ended, for the anonymous stats. */
export interface RoundExit {
  outcome: RoundOutcome;
  /** Epoch ms GitHub says the round was done; null means "use the recording time". */
  doneAt: number | null;
}

export type ExitVerdict = { resolve: false } | { resolve: true; resolvedBy: string; exit: RoundExit };

function sameLogin(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

/**
 * Whether one review event means a human other than the author has looked
 * since `since`. Three filters, each closing a permanent-drop loop:
 *
 *  - null submittedAt is a PENDING review; nobody has looked yet.
 *  - a bot review (Copilot, CodeRabbit) would clear a row one minute after the
 *    request and re-clear every re-request within a tick.
 *  - the PR author's own line comments arrive as a real PullRequestReview and
 *    would do the same.
 */
export function countsAsReview(
  reviewEvent: ReviewEvent,
  prAuthorLogin: string | null,
  since: number,
): boolean {
  if (reviewEvent.submittedAt === null) return false;
  if (reviewEvent.submittedAt <= since) return false;
  if (reviewEvent.authorIsBot) return false;
  if (reviewEvent.authorLogin !== null && reviewEvent.authorLogin.toLowerCase().endsWith("[bot]")) return false;
  if (sameLogin(reviewEvent.authorLogin, prAuthorLogin)) return false;
  return true;
}

export function exitVerdict(record: PrRecord, snapshot: PrSnapshot): ExitVerdict {
  const author = record.prAuthorLogin ?? snapshot.authorLogin;
  const qualifying = snapshot.reviews
    .filter((r) => countsAsReview(r, author, record.lastRequestedAt))
    .sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0));
  const first = qualifying[0];

  // A merge or close that follows a real review is still a reviewed round: the
  // review, not the merge, is when the reviewer finished.
  if (snapshot.merged) {
    const exit: RoundExit =
      first === undefined
        ? { outcome: "merged-unreviewed", doneAt: snapshot.mergedAt }
        : { outcome: "reviewed", doneAt: first.submittedAt };
    return { resolve: true, resolvedBy: "merged", exit };
  }
  if (snapshot.state === "CLOSED") {
    const exit: RoundExit =
      first === undefined
        ? { outcome: "closed-unreviewed", doneAt: snapshot.closedAt }
        : { outcome: "reviewed", doneAt: first.submittedAt };
    return { resolve: true, resolvedBy: "closed", exit };
  }

  if (first === undefined) return { resolve: false };
  return {
    resolve: true,
    resolvedBy: `review by ${first.authorLogin ?? "someone"}`,
    exit: { outcome: "reviewed", doneAt: first.submittedAt },
  };
}

/**
 * Folds a GitHub snapshot into a record: refresh cached fields, then apply the
 * exit rule. `exit` is non-null only when this call resolved an open record, so
 * a caller recording stats counts each round exactly once.
 */
export function applySnapshotWithExit(
  record: PrRecord,
  snapshot: PrSnapshot,
  now: number,
): { record: PrRecord; exit: RoundExit | null } {
  const refreshed: PrRecord = {
    ...record,
    title: snapshot.title,
    isDraft: snapshot.isDraft,
    prAuthorLogin: snapshot.authorLogin ?? record.prAuthorLogin,
    syncPausedSince: null,
    lastSyncedAt: now,
  };

  if (!isOpen(refreshed)) return { record: refreshed, exit: null };

  const verdict = exitVerdict(refreshed, snapshot);
  if (!verdict.resolve) return { record: refreshed, exit: null };
  return { record: resolveRecord(refreshed, now, verdict.resolvedBy), exit: verdict.exit };
}
