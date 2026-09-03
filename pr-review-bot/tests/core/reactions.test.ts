import { describe, expect, it } from "vitest";
import { selectReactionTargets, syncReactions } from "../../src/core/reactions.js";
import { newScannedRecord, recordId, type PrRecord } from "../../src/core/record.js";

const T0 = 1_756_000_000_000;
const HOUR = 3_600_000;

function record(number: number, overrides: Partial<PrRecord> = {}): PrRecord {
  const base = newScannedRecord({
    pr: { owner: "paranext", repo: "paranext-core", number },
    channelId: "chan",
    messageId: `msg-${number}`,
    messageTimestamp: T0,
    title: `PT-${number}`,
    prAuthorLogin: "jolie",
    isDraft: false,
  });
  return { ...base, ...overrides };
}

describe("selectReactionTargets", () => {
  it("polls never-checked records before checked ones", () => {
    const checked = record(1, { reactionCheckedAt: T0 });
    const never = record(2);
    expect(selectReactionTargets([checked, never])).toEqual([recordId(never), recordId(checked)]);
  });

  it("orders checked records oldest-first, tie-breaking on firstRequestedAt", () => {
    const older = record(1, { reactionCheckedAt: T0 });
    const newer = record(2, { reactionCheckedAt: T0 + HOUR });
    const tie = record(3, { reactionCheckedAt: T0, firstRequestedAt: T0 - HOUR });
    expect(selectReactionTargets([newer, older, tie])).toEqual([
      recordId(tie), recordId(older), recordId(newer),
    ]);
  });

  it("skips records that share a messageId — a single reaction cannot say which PR was meant", () => {
    const a = record(1, { messageId: "shared" });
    const b = record(2, { messageId: "shared" });
    const alone = record(3);
    expect(selectReactionTargets([a, b, alone])).toEqual([recordId(alone)]);
  });

  it("skips resolved records and records with no message", () => {
    const resolved = record(1, { resolvedAt: T0 });
    const noMessage = record(2, { messageId: null });
    const emptyMessage = record(3, { messageId: "" });
    expect(selectReactionTargets([resolved, noMessage, emptyMessage])).toEqual([]);
  });

  it("polls a reaction-claimed record so its release can be detected, but not a menu-claimed one", () => {
    const byReaction = record(1, { claimedBy: "u1", claimSource: "reaction" });
    const byMenu = record(2, { claimedBy: "u1", claimSource: "menu" });
    expect(selectReactionTargets([byReaction, byMenu])).toEqual([recordId(byReaction)]);
  });
});

describe("syncReactions", () => {
  const A = { id: "u1", name: "Katherine" };
  const B = { id: "u2", name: "Ira" };

  it("primes without acting when lastReactors is null", () => {
    const outcome = syncReactions(record(1, { lastReactors: null }), [A], T0);
    expect(outcome.record.lastReactors).toEqual(["u1"]);
    expect(outcome.record.reactionCheckedAt).toBe(T0);
    expect(outcome.record.claimedBy).toBeNull();
    expect(outcome.claimed).toEqual([]);
  });

  it("does not act on the SECOND poll either, if nothing changed after priming", () => {
    const primed = record(1, { lastReactors: ["u1"] });
    expect(syncReactions(primed, [A], T0 + HOUR).record.claimedBy).toBeNull();
  });

  it("claims for a newly present reactor", () => {
    const outcome = syncReactions(record(1, { lastReactors: [] }), [A], T0);
    expect(outcome.record.claimedBy).toBe("u1");
    expect(outcome.record.claimSource).toBe("reaction");
    expect(outcome.claimed).toEqual(["u1"]);
  });

  it("reports the loser when two reactors arrive at once, and claims for the first", () => {
    const outcome = syncReactions(record(1, { lastReactors: [] }), [A, B], T0);
    expect(outcome.record.claimedBy).toBe("u1");
    expect(outcome.superseded).toEqual([{ userId: "u2", byName: "Katherine" }]);
  });

  it("releases when the holder's reaction is gone", () => {
    const held = record(1, {
      lastReactors: ["u1"], claimedBy: "u1", claimedByName: "Katherine",
      claimedAt: T0, claimSource: "reaction",
    });
    const outcome = syncReactions(held, [], T0 + HOUR);
    expect(outcome.record.claimedBy).toBeNull();
    expect(outcome.released).toEqual(["u1"]);
    // Handing a review back on purpose is not the 48-hour auto-clear and must
    // not render as `previously claimed`.
    expect(outcome.record.lastClaimedByName).toBeNull();
    expect(outcome.record.claimClearedAt).toBeNull();
  });

  it("does not release a MENU claim when a reaction disappears", () => {
    const held = record(1, {
      lastReactors: ["u1"], claimedBy: "u1", claimedByName: "Katherine",
      claimedAt: T0, claimSource: "menu",
    });
    expect(syncReactions(held, [], T0 + HOUR).record.claimedBy).toBe("u1");
  });

  it("does not release when the departing reactor is not the holder", () => {
    const held = record(1, {
      lastReactors: ["u1", "u2"], claimedBy: "u1", claimedByName: "Katherine",
      claimedAt: T0, claimSource: "reaction",
    });
    expect(syncReactions(held, [A], T0 + HOUR).record.claimedBy).toBe("u1");
  });

  it("promotes a still-standing reactor when the holder leaves", () => {
    // B reacted, was told it was already claimed, and is still standing on the
    // message. Without promotion B is stranded forever.
    const held = record(1, {
      lastReactors: ["u1", "u2"], claimedBy: "u1", claimedByName: "Katherine",
      claimedAt: T0, claimSource: "reaction",
    });
    const outcome = syncReactions(held, [B], T0 + HOUR);
    expect(outcome.released).toEqual(["u1"]);
    expect(outcome.record.claimedBy).toBe("u2");
    expect(outcome.claimed).toEqual(["u2"]);
  });

  it("applies releases BEFORE claims when one leaves and one arrives in the same poll", () => {
    // Claims-first would tell B "already claimed by Katherine" — false by the
    // time the DM lands — and then release to nobody.
    const held = record(1, {
      lastReactors: ["u1"], claimedBy: "u1", claimedByName: "Katherine",
      claimedAt: T0, claimSource: "reaction",
    });
    const outcome = syncReactions(held, [B], T0 + HOUR);
    expect(outcome.record.claimedBy).toBe("u2");
    expect(outcome.superseded).toEqual([]);
  });

  it("does not report a promoted reactor as superseded — they took no action now", () => {
    const held = record(1, {
      lastReactors: ["u1", "u2", "u3"], claimedBy: "u1", claimedByName: "Katherine",
      claimedAt: T0, claimSource: "reaction",
    });
    const C = { id: "u3", name: "Sam" };
    const outcome = syncReactions(held, [B, C], T0 + HOUR);
    expect(outcome.record.claimedBy).toBe("u2");
    expect(outcome.superseded).toEqual([]);
  });

  it("does not re-claim for a standing reaction after a 48-hour auto-clear", () => {
    // clearStaleClaims (step 5) already cleared the claim this tick. No release
    // happened inside the sync, so nothing promotes, and the unchanged reaction
    // stays unchanged.
    const cleared = record(1, {
      lastReactors: ["u1"], claimedBy: null, claimSource: null,
      lastClaimedByName: "Katherine", claimClearedAt: T0 + HOUR,
    });
    const outcome = syncReactions(cleared, [A], T0 + 2 * HOUR);
    expect(outcome.record.claimedBy).toBeNull();
    expect(outcome.claimed).toEqual([]);
  });

  it("stamps only the check time when the read failed, leaving the observed set alone", () => {
    // null reactors = "we did not see anything". Writing [] here would claim an
    // observation that never happened, and the next successful poll would then
    // read every standing reactor as newly present.
    const primed = record(1, { lastReactors: ["u1"] });
    const outcome = syncReactions(primed, null, T0 + HOUR);
    expect(outcome.record.reactionCheckedAt).toBe(T0 + HOUR);
    expect(outcome.record.lastReactors).toEqual(["u1"]);
    expect(outcome.claimed).toEqual([]);
  });

  it("leaves an unprimed record unprimed when the read failed", () => {
    expect(syncReactions(record(1, { lastReactors: null }), null, T0).record.lastReactors).toBeNull();
  });

  it("stamps the check time and the observed set on every poll, including an empty one", () => {
    const outcome = syncReactions(record(1, { lastReactors: ["u1"] }), [], T0 + HOUR);
    expect(outcome.record.reactionCheckedAt).toBe(T0 + HOUR);
    // The empty SET, not null: this is an observation, and it is what makes the
    // next arrival detectable.
    expect(outcome.record.lastReactors).toEqual([]);
  });
});
