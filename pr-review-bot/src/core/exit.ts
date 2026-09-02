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
}

export type ExitVerdict = { resolve: false } | { resolve: true; resolvedBy: string };

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
  if (snapshot.merged) return { resolve: true, resolvedBy: "merged" };
  if (snapshot.state === "CLOSED") return { resolve: true, resolvedBy: "closed" };

  const author = record.prAuthorLogin ?? snapshot.authorLogin;
  const qualifying = snapshot.reviews
    .filter((r) => countsAsReview(r, author, record.lastRequestedAt))
    .sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0));

  const first = qualifying[0];
  if (first === undefined) return { resolve: false };
  return { resolve: true, resolvedBy: `review by ${first.authorLogin ?? "someone"}` };
}

/** Folds a GitHub snapshot into a record: refresh cached fields, then apply the exit rule. */
export function applySnapshot(record: PrRecord, snapshot: PrSnapshot, now: number): PrRecord {
  const refreshed: PrRecord = {
    ...record,
    title: snapshot.title,
    isDraft: snapshot.isDraft,
    prAuthorLogin: snapshot.authorLogin ?? record.prAuthorLogin,
    syncPausedSince: null,
    lastSyncedAt: now,
  };

  if (!isOpen(refreshed)) return refreshed;

  const verdict = exitVerdict(refreshed, snapshot);
  return verdict.resolve ? resolveRecord(refreshed, now, verdict.resolvedBy) : refreshed;
}
