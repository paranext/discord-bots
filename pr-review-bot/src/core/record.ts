import type { TeamName, UrgencyKey } from "../../config/config.js";
import { prSlug, type ParsedPr } from "./urls.js";

/** How the current claim was made. Decides whether removing a reaction may
 *  release it: a menu claim is released from the menu. */
export type ClaimSource = "menu" | "reaction";

export interface Resolution {
  resolvedAt: number;
  resolvedBy: string;
}

export interface PrRecord {
  // identity, from the url
  owner: string;
  repo: string;
  number: number;

  // the request message
  channelId: string;
  messageId: string | null;

  team: TeamName | null;
  urgency: UrgencyKey | null;
  prdThreadId: string | null;
  note: string | null;

  requesterId: string | null;
  requesterName: string | null;

  /** Sort key. Never changes, so re-requesting is not penalised. */
  firstRequestedAt: number;
  /** Freshness. For a scanned record this is the scanned message's timestamp. */
  lastRequestedAt: number;
  requestCount: number;

  claimedBy: string | null;
  claimedByName: string | null;
  claimedAt: number | null;
  /** Survives a stale auto-clear; renders `previously claimed`. Cleared by a new claim. */
  lastClaimedByName: string | null;
  claimClearedAt: number | null;

  /** Null whenever `claimedBy` is null — every path that clears the claim
   *  clears this too. Read it only to decide HOW a claim was made; read
   *  `claimedBy` to decide WHETHER there is one. */
  claimSource: ClaimSource | null;

  /** When refresh-loop step 8 last polled this record's message. The sort key
   *  for oldest-unchecked-first. */
  reactionCheckedAt: number | null;

  /**
   * Reactor ids observed at that poll — the diff's left-hand side.
   *
   * **`null` means UNPRIMED**, and is not the same as `[]`. The diff's whole
   * licence to read a reaction as present-tense intent is that an absence was
   * actually observed in between; across a gap where nothing was observed —
   * a record that left the polling set, or a fresh deploy — that licence does
   * not exist. A null-valued record's next poll writes the observed set and
   * acts on nothing. `[]` means "observed, nobody was reacting", which is a
   * usable left-hand side.
   */
  lastReactors: string[] | null;

  /** Set on NOT_FOUND / 401 for this record's repo. Cleared by the first successful sync. */
  syncPausedSince: number | null;

  resolvedAt: number | null;
  resolvedBy: string | null;
  /** Prior resolutions, appended on reopen, so "why is it back" stays answerable. */
  resolutionHistory: Resolution[];

  title: string;
  /** GitHub login of the PR's author. A self-review is not a review. */
  prAuthorLogin: string | null;
  isDraft: boolean;

  source: "command" | "scanned";
  lastSyncedAt: number | null;
}

export interface RequestFields {
  team: TeamName;
  urgency: UrgencyKey;
  prdThreadId: string | null;
  note: string | null;
  requesterId: string;
  requesterName: string;
  channelId: string;
  messageId: string | null;
}

export interface NewScannedInput {
  pr: ParsedPr;
  channelId: string;
  messageId: string;
  /** The scanned MESSAGE's timestamp — not the scan time. See Task 14. */
  messageTimestamp: number;
  title: string;
  prAuthorLogin: string | null;
  isDraft: boolean;
}

export function recordId(r: Pick<PrRecord, "owner" | "repo" | "number">): string {
  return prSlug(r);
}

export function isOpen(r: PrRecord): boolean {
  return r.resolvedAt === null;
}

export function resolveRecord(r: PrRecord, at: number, by: string): PrRecord {
  return {
    ...r,
    resolvedAt: at,
    resolvedBy: by,
    // A resolved row must not sit in Being reviewed.
    claimedBy: null,
    claimedByName: null,
    claimedAt: null,
    claimSource: null,
    // A resolved record leaves the polling set, so the next observation after
    // a reopen must prime rather than diff against a months-old snapshot.
    lastReactors: null,
  };
}

export function reopenRecord(r: PrRecord, _at: number): PrRecord {
  if (r.resolvedAt === null) return r;
  return {
    ...r,
    resolvedAt: null,
    resolvedBy: null,
    resolutionHistory: [
      ...r.resolutionHistory,
      { resolvedAt: r.resolvedAt, resolvedBy: r.resolvedBy ?? "unknown" },
    ],
  };
}

export function markRequested(r: PrRecord, at: number, fields: RequestFields): PrRecord {
  const reopened = reopenRecord(r, at);
  return {
    ...reopened,
    ...fields,
    source: "command",
    lastRequestedAt: at,
    requestCount: reopened.requestCount + 1,
    // A claim from the previous round must not hide the new request.
    claimedBy: null,
    claimedByName: null,
    claimedAt: null,
    claimSource: null,
    // `fields.messageId` always points at a NEWLY POSTED message — the
    // stored observation describes the previous one. Left alone, a reactor
    // who reacted to the old message and re-reacts to the bump would already
    // be in this stale set and read as unchanged: no release, no claim,
    // silently and permanently, until they toggle the reaction. The new
    // message must be primed from scratch, like any other record that just
    // (re)entered the polling set.
    lastReactors: null,
  };
}

export function newScannedRecord(input: NewScannedInput): PrRecord {
  return {
    owner: input.pr.owner,
    repo: input.pr.repo,
    number: input.pr.number,
    channelId: input.channelId,
    messageId: input.messageId,
    team: null,
    urgency: null,
    prdThreadId: null,
    note: null,
    requesterId: null,
    requesterName: null,
    firstRequestedAt: input.messageTimestamp,
    lastRequestedAt: input.messageTimestamp,
    requestCount: 1,
    claimedBy: null,
    claimedByName: null,
    claimedAt: null,
    lastClaimedByName: null,
    claimClearedAt: null,
    claimSource: null,
    reactionCheckedAt: null,
    lastReactors: null,
    syncPausedSince: null,
    resolvedAt: null,
    resolvedBy: null,
    resolutionHistory: [],
    title: input.title,
    prAuthorLogin: input.prAuthorLogin,
    isDraft: input.isDraft,
    source: "scanned",
    lastSyncedAt: null,
  };
}
