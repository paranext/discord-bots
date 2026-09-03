import { describe, expect, it } from "vitest";
import { applyClaim, applyUnclaim, clearStaleClaim } from "../../src/core/claims.js";
import { newScannedRecord, resolveRecord, type PrRecord } from "../../src/core/record.js";

const T0 = 1_756_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STALE = 2 * DAY;

function record(overrides: Partial<PrRecord> = {}): PrRecord {
  const base = newScannedRecord({
    pr: { owner: "paranext", repo: "paranext-core", number: 2695 },
    channelId: "chan",
    messageId: "msg",
    messageTimestamp: T0,
    title: "PT-4363",
    prAuthorLogin: "jolie",
    isDraft: false,
  });
  return { ...base, ...overrides };
}

describe("applyClaim", () => {
  it("records the claimer and the time", () => {
    const outcome = applyClaim(record(), "u1", "Katherine", T0 + HOUR, "menu");
    expect(outcome.kind).toBe("claimed");
    if (outcome.kind !== "claimed") throw new Error("unreachable");
    expect(outcome.record.claimedBy).toBe("u1");
    expect(outcome.record.claimedByName).toBe("Katherine");
    expect(outcome.record.claimedAt).toBe(T0 + HOUR);
  });

  it("clears previously-claimed markers, so a re-claimed row stops rendering them", () => {
    const previously = record({ lastClaimedByName: "Ira", claimClearedAt: T0 });
    const outcome = applyClaim(previously, "u1", "Katherine", T0 + HOUR, "menu");
    if (outcome.kind !== "claimed") throw new Error("unreachable");
    expect(outcome.record.lastClaimedByName).toBeNull();
    expect(outcome.record.claimClearedAt).toBeNull();
  });

  it("reports the holder when someone else already claimed it — first write wins", () => {
    const held = record({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0 });
    expect(applyClaim(held, "u2", "Ira", T0 + HOUR, "menu")).toEqual({
      kind: "already-claimed",
      byName: "Katherine",
    });
  });

  it("is idempotent when the same person claims twice, without moving claimedAt", () => {
    const held = record({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0 });
    const outcome = applyClaim(held, "u1", "Katherine", T0 + HOUR, "menu");
    if (outcome.kind !== "claimed") throw new Error("unreachable");
    expect(outcome.record.claimedAt).toBe(T0);
  });

  it("falls back to 'someone' when the existing claimer's display name is unknown", () => {
    const held = record({ claimedBy: "u1", claimedByName: null, claimedAt: T0 });
    expect(applyClaim(held, "u2", "Ira", T0 + HOUR, "menu")).toEqual({ kind: "already-claimed", byName: "someone" });
  });

  it("refuses to claim a resolved record", () => {
    const resolved = resolveRecord(record(), T0, "merged");
    expect(applyClaim(resolved, "u1", "Katherine", T0 + HOUR, "menu")).toEqual({ kind: "not-open" });
  });
});

describe("applyUnclaim", () => {
  it("releases a claim you hold", () => {
    const held = record({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0 });
    const outcome = applyUnclaim(held, "u1");
    expect(outcome.kind).toBe("released");
    if (outcome.kind !== "released") throw new Error("unreachable");
    expect(outcome.record.claimedBy).toBeNull();
    expect(outcome.record.claimedAt).toBeNull();
  });

  it("leaves a claim you do not hold alone and names the holder", () => {
    const held = record({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0 });
    expect(applyUnclaim(held, "u2")).toEqual({ kind: "already-claimed", byName: "Katherine" });
  });

  it("is a no-op when the record is already unclaimed", () => {
    const open = record();
    expect(applyUnclaim(open, "u1")).toEqual({ kind: "released", record: open });
  });

  it("falls back to 'someone' when the existing claimer's display name is unknown", () => {
    const held = record({ claimedBy: "u1", claimedByName: null, claimedAt: T0 });
    expect(applyUnclaim(held, "u2")).toEqual({ kind: "already-claimed", byName: "someone" });
  });

  it("does not set previously-claimed markers on a deliberate unclaim", () => {
    // `previously claimed` exists to explain an AUTO-clear. A voluntary release
    // is not a lapse and must not be labelled as one.
    const held = record({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0 });
    const outcome = applyUnclaim(held, "u1");
    if (outcome.kind !== "released") throw new Error("unreachable");
    expect(outcome.record.lastClaimedByName).toBeNull();
  });
});

describe("clearStaleClaim", () => {
  it("clears a claim older than the threshold and records who held it", () => {
    const held = record({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0 });
    const r = clearStaleClaim(held, T0 + STALE, STALE);
    expect(r.claimedBy).toBeNull();
    expect(r.claimedAt).toBeNull();
    expect(r.lastClaimedByName).toBe("Katherine");
    expect(r.claimClearedAt).toBe(T0 + STALE);
  });

  it("leaves a fresh claim untouched", () => {
    const held = record({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0 });
    expect(clearStaleClaim(held, T0 + HOUR, STALE)).toEqual(held);
  });

  it("is a no-op on an unclaimed record", () => {
    const open = record();
    expect(clearStaleClaim(open, T0 + STALE, STALE)).toEqual(open);
  });
});

describe("claimSource", () => {
  it("records how the claim was made", () => {
    const menu = applyClaim(record(), "u1", "Katherine", T0, "menu");
    if (menu.kind !== "claimed") throw new Error("unreachable");
    expect(menu.record.claimSource).toBe("menu");

    const reaction = applyClaim(record(), "u1", "Katherine", T0, "reaction");
    if (reaction.kind !== "claimed") throw new Error("unreachable");
    expect(reaction.record.claimSource).toBe("reaction");
  });

  it("unprimes the reaction state on a MENU claim, so a stale reaction cannot inherit the row", () => {
    // The record leaves the polling set the moment it is menu-claimed. Anything
    // that happens to its reactions while it is unpolled is unobserved, so the
    // first poll after it comes back must prime rather than diff.
    const observed = record({ lastReactors: ["u9"] });
    const outcome = applyClaim(observed, "u1", "Katherine", T0, "menu");
    if (outcome.kind !== "claimed") throw new Error("unreachable");
    expect(outcome.record.lastReactors).toBeNull();
  });

  it("keeps the reaction state on a REACTION claim — the same sync just observed it", () => {
    const observed = record({ lastReactors: ["u1"] });
    const outcome = applyClaim(observed, "u1", "Katherine", T0, "reaction");
    if (outcome.kind !== "claimed") throw new Error("unreachable");
    expect(outcome.record.lastReactors).toEqual(["u1"]);
  });

  it("is cleared by every path that clears the claim", () => {
    const held = record({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0, claimSource: "reaction" });

    const unclaimed = applyUnclaim(held, "u1");
    if (unclaimed.kind !== "released") throw new Error("unreachable");
    expect(unclaimed.record.claimSource).toBeNull();

    expect(clearStaleClaim(held, T0 + STALE, STALE).claimSource).toBeNull();
    expect(resolveRecord(held, T0 + HOUR, "github").claimSource).toBeNull();
  });
});
