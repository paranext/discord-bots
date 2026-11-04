import { describe, expect, it } from "vitest";
import {
  isOpen,
  markRequested,
  newCommandRecord,
  recordId,
  reopenRecord,
  resolveRecord,
  type PrRecord,
} from "../../src/core/record.js";

const T0 = 1_756_000_000_000;
const HOUR = 3_600_000;

function commanded(overrides: Partial<PrRecord> = {}): PrRecord {
  return {
    owner: "paranext",
    repo: "paranext-core",
    number: 2695,
    channelId: "chan",
    messageId: "msg",
    team: "Simple",
    urgency: "thisWeek",
    note: null,
    requesterId: "user-1",
    requesterName: "Jolie",
    firstRequestedAt: T0,
    lastRequestedAt: T0,
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
    title: "PT-9003 Internet Settings UI Enhancements",
    prAuthorLogin: "jolie",
    isDraft: false,
    lastSyncedAt: T0,
    roundStartedAt: T0,
    roundFirstClaimedAt: null,
    roundClaimsDropped: 0,
    roundReRequests: 0,
    roundPendingEntryId: null,
    ...overrides,
  };
}

describe("recordId", () => {
  it("is owner/repo/number, lowercased", () => {
    expect(recordId(commanded({ owner: "Paranext" }))).toBe("paranext/paranext-core/2695");
  });
});

describe("resolve and reopen", () => {
  it("resolving sets both fields and closes the record", () => {
    const r = resolveRecord(commanded(), T0 + HOUR, "review by Katherine");
    expect(r.resolvedAt).toBe(T0 + HOUR);
    expect(r.resolvedBy).toBe("review by Katherine");
    expect(isOpen(r)).toBe(false);
  });

  it("resolving clears any claim, so a resolved row cannot sit in Being reviewed", () => {
    const claimed = commanded({ claimedBy: "u2", claimedByName: "Ira", claimedAt: T0 });
    const r = resolveRecord(claimed, T0 + HOUR, "review by Katherine");
    expect(r.claimedBy).toBeNull();
    expect(r.claimedAt).toBeNull();
  });

  it("reopening clears both fields and appends the prior resolution to history", () => {
    const resolved = resolveRecord(commanded(), T0 + HOUR, "review by Katherine");
    const reopened = reopenRecord(resolved, T0 + 2 * HOUR);
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.resolvedBy).toBeNull();
    expect(isOpen(reopened)).toBe(true);
    expect(reopened.resolutionHistory).toEqual([
      { resolvedAt: T0 + HOUR, resolvedBy: "review by Katherine" },
    ]);
  });

  it("reopening never touches firstRequestedAt", () => {
    const resolved = resolveRecord(commanded(), T0 + HOUR, "manual by Jolie");
    expect(reopenRecord(resolved, T0 + 2 * HOUR).firstRequestedAt).toBe(T0);
  });

  it("reopening an already-open record is a no-op that appends nothing", () => {
    const open = commanded();
    expect(reopenRecord(open, T0 + HOUR)).toEqual(open);
  });

  it("labels an unlabeled resolution 'unknown' in history rather than losing the entry", () => {
    const resolved = { ...resolveRecord(commanded(), T0 + HOUR, "review by Katherine"), resolvedBy: null };
    const reopened = reopenRecord(resolved, T0 + 2 * HOUR);
    expect(reopened.resolutionHistory).toEqual([{ resolvedAt: T0 + HOUR, resolvedBy: "unknown" }]);
  });

  it("accumulates history across two resolve/reopen rounds", () => {
    let r = resolveRecord(commanded(), T0 + HOUR, "review by Katherine");
    r = reopenRecord(r, T0 + 2 * HOUR);
    r = resolveRecord(r, T0 + 3 * HOUR, "review by Ira");
    r = reopenRecord(r, T0 + 4 * HOUR);
    expect(r.resolutionHistory).toHaveLength(2);
    expect(r.resolutionHistory[1]?.resolvedBy).toBe("review by Ira");
  });
});

describe("markRequested", () => {
  const fields = {
    team: "Power" as const,
    urgency: "blocking" as const,
    note: "blocks the release cut",
    requesterId: "user-2",
    requesterName: "Ira",
    channelId: "chan",
    messageId: "msg-2",
  };

  it("updates lastRequestedAt and increments the count", () => {
    const r = markRequested(commanded(), T0 + HOUR, fields);
    expect(r.lastRequestedAt).toBe(T0 + HOUR);
    expect(r.requestCount).toBe(2);
  });

  it("counts a re-request on an open record without touching the other round fields", () => {
    const open = commanded({
      claimedBy: "u3", claimedByName: "Kat", claimedAt: T0,
      roundFirstClaimedAt: T0, roundClaimsDropped: 1, roundPendingEntryId: 7,
    });
    const r = markRequested(open, T0 + HOUR, fields);
    expect(r.roundReRequests).toBe(1);
    expect(r.roundStartedAt).toBe(T0);
    expect(r.roundFirstClaimedAt).toBe(T0);
    expect(r.roundClaimsDropped).toBe(1);
    expect(r.roundPendingEntryId).toBe(7);
    expect(r.claimedBy).toBeNull();
  });

  it("leaves a null roundStartedAt null on an open record", () => {
    const r = markRequested(commanded({ roundStartedAt: null }), T0 + HOUR, fields);
    expect(r.roundStartedAt).toBeNull();
  });

  it("starts a fresh round on a resolved record", () => {
    const resolved = resolveRecord(
      commanded({ roundFirstClaimedAt: T0, roundClaimsDropped: 2, roundReRequests: 3, roundPendingEntryId: 9 }),
      T0 + HOUR,
      "review by Katherine",
    );
    const r = markRequested(resolved, T0 + 2 * HOUR, fields);
    expect(r.roundStartedAt).toBe(T0 + 2 * HOUR);
    expect(r.roundFirstClaimedAt).toBeNull();
    expect(r.roundClaimsDropped).toBe(0);
    expect(r.roundReRequests).toBe(0);
    expect(r.roundPendingEntryId).toBeNull();
  });

  it("never changes firstRequestedAt, so re-requesting is not penalised in the sort", () => {
    expect(markRequested(commanded(), T0 + 8 * HOUR, fields).firstRequestedAt).toBe(T0);
  });

  it("clears any existing claim, so a stale claim cannot hide the new request", () => {
    const claimed = commanded({ claimedBy: "u3", claimedByName: "Kat", claimedAt: T0 });
    const r = markRequested(claimed, T0 + HOUR, fields);
    expect(r.claimedBy).toBeNull();
    expect(r.claimedAt).toBeNull();
  });

  it("nulls lastReactors, since the new message it points at was never observed (Finding 2)", () => {
    // /review-request on an already-tracked PR always posts a new message via
    // `fields.messageId`. Leaving the old observation in place would strand a
    // reactor who reacted to the FIRST message and re-reacts to the bump: they
    // would already be in this stale set and read as "unchanged", so no
    // release and no claim happen, silently and permanently.
    const primed = commanded({ lastReactors: ["u1"] });
    expect(markRequested(primed, T0 + HOUR, fields).lastReactors).toBeNull();
  });

  it("reopens a resolved record and preserves the prior resolution", () => {
    const resolved = resolveRecord(commanded(), T0 + HOUR, "review by Katherine");
    const r = markRequested(resolved, T0 + 2 * HOUR, fields);
    expect(isOpen(r)).toBe(true);
    expect(r.resolutionHistory).toHaveLength(1);
  });

});

describe("newCommandRecord", () => {
  const pr = { owner: "paranext", repo: "paranext-core", number: 2695 };
  const fields = {
    team: "Power" as const,
    urgency: "blocking" as const,
    note: "blocks the release cut",
    requesterId: "user-2",
    requesterName: "Ira",
    channelId: "chan",
    messageId: "msg-2",
  };

  it("starts a first request at count 1, with both request times at `at`", () => {
    const r = newCommandRecord({ pr, at: T0, fields: { ...fields, messageId: null }, title: "t", prAuthorLogin: "a", isDraft: false });
    expect(r.requestCount).toBe(1);
    expect(r.firstRequestedAt).toBe(T0);
    expect(r.lastRequestedAt).toBe(T0);
    expect(r.messageId).toBeNull();
    expect(r.team).toBe(fields.team);
    expect(r.claimedBy).toBeNull();
    expect(r.lastReactors).toBeNull();
    expect(r.resolvedAt).toBeNull();
  });
});
