import { describe, expect, it } from "vitest";
import { config } from "../../config/config.js";
import { applyCommands, emptyState } from "../../src/store/apply.js";
import type { Command, StoreState } from "../../src/store/types.js";
import type { PrSnapshot } from "../../src/core/exit.js";
import { newScannedRecord, resolveRecord, type PrRecord } from "../../src/core/record.js";
import { recordId } from "../../src/core/record.js";
import type { RequestFields } from "../../src/core/record.js";

const T0 = 1_756_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ID = "paranext/paranext-core/2695";
const PR = { owner: "paranext", repo: "paranext-core", number: 2695 };
const FIELDS: RequestFields = {
  team: "Power",
  urgency: "soon",
  prdThreadId: null,
  note: "",
  requesterId: "u-1",
  requesterName: "Jolie",
  channelId: "chan",
  messageId: "msg-2",
};

function withRecord(overrides: Partial<PrRecord> = {}): StoreState {
  const base = newScannedRecord({
    pr: { owner: "paranext", repo: "paranext-core", number: 2695 },
    channelId: "chan",
    messageId: "msg",
    messageTimestamp: T0,
    title: "PT-4363",
    prAuthorLogin: "jolie",
    isDraft: false,
  });
  const record = { ...base, ...overrides };
  const state = emptyState();
  return { ...state, records: { [recordId(record)]: record } };
}

function run(state: StoreState, ...commands: Command[]) {
  return applyCommands(state, commands, config);
}

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    slug: ID,
    title: "PT-4363",
    state: "OPEN",
    merged: false,
    isDraft: false,
    authorLogin: "jolie",
    reviews: [],
    ...overrides,
  };
}

describe("upsertScanned", () => {
  const input = {
    pr: { owner: "paranext", repo: "paranext-core", number: 2695 },
    channelId: "chan",
    messageId: "msg",
    messageTimestamp: T0,
    title: "PT-4363",
    prAuthorLogin: "jolie",
    isDraft: false,
  };

  it("creates a record on first sight", () => {
    const out = run(emptyState(), { kind: "upsertScanned", input, now: T0 + HOUR });
    expect(out.results[0]).toEqual({ kind: "created" });
    expect(out.state.records[ID]?.source).toBe("scanned");
  });

  it("is idempotent — re-scanning the same PR does not duplicate or reset it", () => {
    // The second scan must carry its OWN messageTimestamp, distinct from the first — otherwise
    // `firstRequestedAt === T0` can't tell "left alone" from "recreated from this same input".
    const once = run(emptyState(), { kind: "upsertScanned", input, now: T0 + HOUR });
    const secondInput = { ...input, messageTimestamp: T0 + 2 * HOUR, messageId: "msg-2" };
    const twice = run(once.state, { kind: "upsertScanned", input: secondInput, now: T0 + 2 * HOUR });
    expect(Object.keys(twice.state.records)).toHaveLength(1);
    expect(twice.state.records[ID]?.firstRequestedAt).toBe(T0);
    expect(twice.state.records[ID]?.lastRequestedAt).toBe(T0);
  });

  it("does NOT reopen a resolved record — conversational mentions are the common case", () => {
    const resolved = withRecord({ resolvedAt: T0 + HOUR, resolvedBy: "merged" });
    const out = run(resolved, { kind: "upsertScanned", input, now: T0 + 2 * HOUR });
    expect(out.results[0]).toEqual({ kind: "skipped-resolved" });
    expect(out.state.records[ID]?.resolvedAt).toBe(T0 + HOUR);
  });

  it("leaves a commanded record's fields intact when the same PR is scanned", () => {
    const commanded = withRecord({ source: "command", team: "Power", urgency: "blocking" });
    const out = run(commanded, { kind: "upsertScanned", input, now: T0 + HOUR });
    expect(out.state.records[ID]?.team).toBe("Power");
    expect(out.state.records[ID]?.source).toBe("command");
  });
});

describe("upsertRequest", () => {
  const command: Command = {
    kind: "upsertRequest",
    pr: { owner: "paranext", repo: "paranext-core", number: 2695 },
    at: T0 + 2 * HOUR,
    fields: {
      team: "Power",
      urgency: "blocking",
      prdThreadId: "t-1",
      note: "blocks the cut",
      requesterId: "u-1",
      requesterName: "Jolie",
      channelId: "chan",
      messageId: "msg-2",
    },
    title: "PT-4363",
    prAuthorLogin: "jolie",
    isDraft: false,
  };

  it("creates a commanded record when none exists", () => {
    const out = run(emptyState(), command);
    expect(out.results[0]).toEqual({ kind: "created" });
    expect(out.state.records[ID]?.source).toBe("command");
    expect(out.state.records[ID]?.requestCount).toBe(1);
  });

  it("upgrades a scanned record in place rather than duplicating", () => {
    const out = run(withRecord(), command);
    expect(Object.keys(out.state.records)).toHaveLength(1);
    expect(out.state.records[ID]?.source).toBe("command");
    expect(out.state.records[ID]?.urgency).toBe("blocking");
  });

  it("REOPENS a resolved record — this is the headline workflow", () => {
    const resolved = withRecord({ resolvedAt: T0 + HOUR, resolvedBy: "review by Katherine" });
    const out = run(resolved, command);
    expect(out.state.records[ID]?.resolvedAt).toBeNull();
    expect(out.state.records[ID]?.resolutionHistory).toHaveLength(1);
  });

  it("clears a claim and preserves firstRequestedAt on re-request", () => {
    const claimed = withRecord({ source: "command", claimedBy: "u9", claimedByName: "Ira", claimedAt: T0 });
    const out = run(claimed, command);
    expect(out.state.records[ID]?.claimedBy).toBeNull();
    expect(out.state.records[ID]?.firstRequestedAt).toBe(T0);
    expect(out.state.records[ID]?.requestCount).toBe(2);
  });
});

describe("applySnapshot and markSyncPaused", () => {
  it("resolves a record on a qualifying review", () => {
    const out = run(withRecord(), {
      kind: "applySnapshot",
      id: ID,
      now: T0 + 5 * HOUR,
      snapshot: snapshot({
        reviews: [{ submittedAt: T0 + HOUR, state: "COMMENTED", authorLogin: "katherine", authorIsBot: false }],
      }),
    });
    expect(out.state.records[ID]?.resolvedBy).toBe("review by katherine");
  });

  it("returns not-found for an unknown id rather than throwing", () => {
    const out = run(emptyState(), { kind: "applySnapshot", id: ID, now: T0, snapshot: snapshot() });
    expect(out.results[0]).toEqual({ kind: "not-found" });
  });

  it("marks sync paused without resolving — a null is never 'gone'", () => {
    const out = run(withRecord(), { kind: "markSyncPaused", id: ID, at: T0 + HOUR });
    expect(out.state.records[ID]?.syncPausedSince).toBe(T0 + HOUR);
    expect(out.state.records[ID]?.resolvedAt).toBeNull();
  });

  it("does not overwrite an existing syncPausedSince on a later tick", () => {
    const paused = withRecord({ syncPausedSince: T0 });
    const out = run(paused, { kind: "markSyncPaused", id: ID, at: T0 + HOUR });
    expect(out.state.records[ID]?.syncPausedSince).toBe(T0);
  });
});

describe("menu revalidation", () => {
  it("refuses to overwrite a resolvedBy the tick already set", () => {
    // The tick resolved this row 60 seconds ago; the reader's client still shows it.
    // This exercises applyOne's `!isOpen(existing)` check, which runs BEFORE the
    // staleness check below — it is a different guard from the one the next test covers.
    const resolved = withRecord({ resolvedAt: T0 + HOUR, resolvedBy: "review by Katherine" });
    const out = run(resolved, {
      kind: "resolve",
      id: ID,
      by: "cleared by Jolie",
      at: T0 + 2 * HOUR,
      expectLastRequestedAt: T0,
    });
    expect(out.results[0]).toEqual({ kind: "not-open" });
    expect(out.state.records[ID]?.resolvedBy).toBe("review by Katherine");
  });

  it("rejects a resolve whose option value is stale, preserving the audit trail", () => {
    // Open and unresolved, so the `!isOpen` guard above does NOT fire — this is the only
    // test that reaches the resolve path's own staleness check.
    const rerequested = withRecord({ lastRequestedAt: T0 + 3 * HOUR });
    const out = run(rerequested, {
      kind: "resolve",
      id: ID,
      by: "cleared by Jolie",
      at: T0 + 4 * HOUR,
      expectLastRequestedAt: T0,
    });
    expect(out.results[0]).toEqual({ kind: "stale" });
    expect(out.state.records[ID]?.resolvedAt).toBeNull();
  });

  it("rejects a claim whose expected lastRequestedAt no longer matches", () => {
    const rerequested = withRecord({ lastRequestedAt: T0 + 3 * HOUR });
    const out = run(rerequested, {
      kind: "claim",
      id: ID,
      userId: "u1",
      displayName: "Katherine",
      at: T0 + 4 * HOUR,
      expectLastRequestedAt: T0,
    });
    expect(out.results[0]).toEqual({ kind: "stale" });
    expect(out.state.records[ID]?.claimedBy).toBeNull();
  });

  it("accepts a claim whose expected lastRequestedAt matches", () => {
    const out = run(withRecord(), {
      kind: "claim",
      id: ID,
      userId: "u1",
      displayName: "Katherine",
      at: T0 + HOUR,
      expectLastRequestedAt: T0,
    });
    expect(out.results[0]).toEqual({ kind: "ok" });
    expect(out.state.records[ID]?.claimedByName).toBe("Katherine");
  });

  it("skips the check when the expectation is null", () => {
    const out = run(withRecord(), {
      kind: "claim",
      id: ID,
      userId: "u1",
      displayName: "Katherine",
      at: T0 + HOUR,
      expectLastRequestedAt: null,
    });
    expect(out.results[0]).toEqual({ kind: "ok" });
  });
});

describe("claim conflicts", () => {
  it("first write wins: a second claimant is told who holds it", () => {
    const first = run(withRecord(), {
      kind: "claim", id: ID, userId: "u1", displayName: "Katherine", at: T0 + HOUR, expectLastRequestedAt: null,
    });
    const second = applyCommands(first.state, [
      { kind: "claim", id: ID, userId: "u2", displayName: "Ira", at: T0 + 2 * HOUR, expectLastRequestedAt: null },
    ], config);
    expect(second.results[0]).toEqual({ kind: "already-claimed", byName: "Katherine" });
    expect(second.state.records[ID]?.claimedBy).toBe("u1");
  });
});

describe("unclaim", () => {
  it("releases a claim the actor holds", () => {
    const held = withRecord({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0 });
    const out = run(held, { kind: "unclaim", id: ID, userId: "u1" });
    expect(out.results[0]).toEqual({ kind: "ok" });
    expect(out.state.records[ID]?.claimedBy).toBeNull();
    expect(out.state.records[ID]?.claimedAt).toBeNull();
  });

  it("refuses to release someone else's claim and names the holder", () => {
    const held = withRecord({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0 });
    const out = run(held, { kind: "unclaim", id: ID, userId: "u2" });
    expect(out.results[0]).toEqual({ kind: "already-claimed", byName: "Katherine" });
    expect(out.state.records[ID]?.claimedBy).toBe("u1");
  });

  it("returns not-found for an unknown id rather than throwing", () => {
    const out = run(emptyState(), { kind: "unclaim", id: ID, userId: "u1" });
    expect(out.results[0]).toEqual({ kind: "not-found" });
  });
});

describe("reopen", () => {
  it("clears resolvedAt and appends history", () => {
    const resolved = withRecord({ resolvedAt: T0 + HOUR, resolvedBy: "cleared by Jolie" });
    const out = run(resolved, { kind: "reopen", id: ID, at: T0 + 2 * HOUR });
    expect(out.state.records[ID]?.resolvedAt).toBeNull();
    expect(out.state.records[ID]?.resolutionHistory).toHaveLength(1);
  });
});

describe("clearStaleClaims", () => {
  it("clears only claims past the threshold and reports how many", () => {
    const state = emptyState();
    const stale = { ...withRecord({ claimedBy: "u1", claimedByName: "Ira", claimedAt: T0 }).records[ID]! };
    const fresh = {
      ...stale,
      number: 2696,
      claimedAt: T0 + 47 * HOUR,
    };
    const seeded: StoreState = {
      ...state,
      records: { [recordId(stale)]: stale, [recordId(fresh)]: fresh },
    };
    const out = applyCommands(seeded, [{ kind: "clearStaleClaims", now: T0 + 49 * HOUR }], config);
    expect(out.results[0]).toEqual({ kind: "count", count: 1 });
    expect(out.state.records[recordId(stale)]?.lastClaimedByName).toBe("Ira");
    expect(out.state.records[recordId(fresh)]?.claimedBy).toBe("u1");
  });
});

describe("purgeResolved", () => {
  it("purges records resolved beyond retention, capped per tick", () => {
    const records: Record<string, PrRecord> = {};
    for (let i = 0; i < 120; i += 1) {
      const r = resolveRecord(
        { ...withRecord().records[ID]!, number: 3000 + i },
        T0 - 40 * DAY,
        "merged",
      );
      records[recordId(r)] = r;
    }
    const out = applyCommands({ ...emptyState(), records }, [{ kind: "purgeResolved", now: T0 }], config);
    expect(out.results[0]).toEqual({ kind: "count", count: config.budgets.purgePerTick });
    expect(Object.keys(out.state.records)).toHaveLength(120 - config.budgets.purgePerTick);
  });

  it("never purges an open record, however old", () => {
    const ancient = withRecord({ firstRequestedAt: T0 - 400 * DAY, lastRequestedAt: T0 - 400 * DAY });
    const out = applyCommands(ancient, [{ kind: "purgeResolved", now: T0 }], config);
    expect(Object.keys(out.state.records)).toHaveLength(1);
  });

  it("never purges a record resolved inside the retention window", () => {
    const recent = withRecord({ resolvedAt: T0 - 5 * DAY, resolvedBy: "merged" });
    const out = applyCommands(recent, [{ kind: "purgeResolved", now: T0 }], config);
    expect(Object.keys(out.state.records)).toHaveLength(1);
  });
});

describe("setMeta", () => {
  it("patches only the named keys", () => {
    const out = run(emptyState(), { kind: "setMeta", patch: { lastSync: T0 } });
    expect(out.state.meta.lastSync).toBe(T0);
    expect(out.state.meta.digestMessageId).toBeNull();
  });

  it("clears unpinnedReportedAt when told to, so a later unpinning is reported again", () => {
    const reported = { ...emptyState(), meta: { ...emptyState().meta, unpinnedReportedAt: T0 } };
    const out = applyCommands(reported, [{ kind: "setMeta", patch: { unpinnedReportedAt: null } }], config);
    expect(out.state.meta.unpinnedReportedAt).toBeNull();
  });

  it("moves digestBodyVersion on every write of the hash, and only on those", () => {
    // The counter the digest compare-and-set compares on. Its whole value is
    // that it moves on every hash write and never comes back round: a writer
    // that reads it, does its Discord I/O, and finds it unchanged can then
    // conclude nothing wrote the hash meanwhile — which the hash VALUE cannot
    // establish, because three interactions can take it away and back.
    const start = emptyState();
    expect(start.meta.digestBodyVersion).toBe(0);

    // A patch that does not name the hash must not move it, or every setMeta in
    // the codebase (the lease take, lastSync, the daily-post date) would
    // invalidate a tick's compare and the digest would repaint on every tick.
    const unrelated = run(start, { kind: "setMeta", patch: { lastSync: T0 } });
    expect(unrelated.state.meta.digestBodyVersion).toBe(0);

    const first = run(unrelated.state, { kind: "setMeta", patch: { digestBodyHash: "aaaa" } });
    expect(first.state.meta.digestBodyVersion).toBe(1);

    // Writing the SAME value still counts: "the hash is what it was" is exactly
    // the state ABA reaches, and it is not the same as "nobody wrote it".
    const same = run(first.state, { kind: "setMeta", patch: { digestBodyHash: "aaaa" } });
    expect(same.state.meta.digestBodyVersion).toBe(2);

    // And so does clearing it to null — that is the losing writer's write, and a
    // later writer must be able to tell it happened.
    const cleared = run(same.state, { kind: "setMeta", patch: { digestBodyHash: null } });
    expect(cleared.state.meta.digestBodyVersion).toBe(3);
    expect(cleared.state.meta.digestBodyHash).toBeNull();
  });

  it("derives digestBodyVersion rather than accepting it from the patch", () => {
    // `MetaPatch` excludes the field, so this is unreachable through the type —
    // the cast is here to pin the runtime behaviour behind that type, because a
    // patch that could set the counter could set it BACKWARDS and hand ABA
    // straight back. A future `setMeta` that spread the patch after computing
    // the counter would pass every other test in this file.
    const patch = { digestBodyHash: "bbbb", digestBodyVersion: 0 } as { digestBodyHash: string };
    const out = run(emptyState(), { kind: "setMeta", patch });
    expect(out.state.meta.digestBodyVersion).toBe(1);
  });
});

describe("releaseLease", () => {
  const held = (heldSince: number) => ({
    ...emptyState(),
    meta: { ...emptyState().meta, syncLease: { heldSince } },
  });

  it("clears the lease when the releaser still holds it", () => {
    const out = applyCommands(held(T0), [{ kind: "releaseLease", heldSince: T0 }], config);
    expect(out.state.meta.syncLease).toBeNull();
  });

  it("leaves a lease taken by a different tick alone (R52)", () => {
    // The releaser read its lease at T0; a newer tick has since broken it and
    // taken its own. An unconditional release would clear the newer tick's
    // lease and un-serialise the two.
    const newer = T0 + 16 * 60_000;
    const out = applyCommands(held(newer), [{ kind: "releaseLease", heldSince: T0 }], config);
    expect(out.state.meta.syncLease).toEqual({ heldSince: newer });
  });

  it("is a no-op when there is no lease at all", () => {
    const out = applyCommands(emptyState(), [{ kind: "releaseLease", heldSince: T0 }], config);
    expect(out.state.meta.syncLease).toBeNull();
    expect(out.results[0]).toEqual({ kind: "ok" });
  });
});

describe("purity", () => {
  it("never mutates the input state", () => {
    const before = withRecord();
    const frozen = JSON.stringify(before);
    run(before, { kind: "claim", id: ID, userId: "u1", displayName: "K", at: T0, expectLastRequestedAt: null });
    expect(JSON.stringify(before)).toBe(frozen);
  });
});

describe("schema version 3", () => {
  it("emptyState carries both new meta fields", () => {
    const state = emptyState();
    expect(state.schemaVersion).toBe(3);
    expect(state.meta.prdCache).toBeNull();
    expect(state.meta.retryStash).toEqual({});
  });
});

const VALUES = { url: "https://x", team: "Power", urgency: "soon", prdThreadId: null, note: "" };

describe("setRequestMessageId", () => {
  it("writes the message id without moving lastRequestedAt or requestCount", () => {
    const seeded = applyCommands(
      emptyState(),
      [{ kind: "upsertRequest", pr: PR, at: T0, fields: FIELDS, title: "T", prAuthorLogin: "jolie", isDraft: false }],
      config,
    ).state;
    const before = seeded.records["paranext/paranext-core/2695"]!;

    const after = applyCommands(seeded, [{ kind: "setRequestMessageId", id: "paranext/paranext-core/2695", messageId: "m-9" }], config);
    const record = after.state.records["paranext/paranext-core/2695"]!;

    expect(after.results[0]).toEqual({ kind: "ok" });
    expect(record.messageId).toBe("m-9");
    // The whole reason this command exists rather than a second upsertRequest.
    expect(record.lastRequestedAt).toBe(before.lastRequestedAt);
    expect(record.requestCount).toBe(before.requestCount);
    expect(record.requestCount).toBe(1);
  });

  it("reports not-found for a record that is gone", () => {
    const result = applyCommands(emptyState(), [{ kind: "setRequestMessageId", id: "nope/nope/1", messageId: "m" }], config);
    expect(result.results[0]).toEqual({ kind: "not-found" });
  });
});

describe("stashSubmission", () => {
  const entry = (expiresAt: number) => ({ userId: "u-1", values: VALUES, expiresAt });

  it("stores an entry under its key", () => {
    const after = applyCommands(emptyState(), [{ kind: "stashSubmission", key: "i-1", entry: entry(T0 + 1000), now: T0 }], config);
    expect(after.state.meta.retryStash["i-1"]?.userId).toBe("u-1");
  });

  it("prunes entries already past their expiry", () => {
    const seeded = { ...emptyState(), meta: { ...emptyState().meta, retryStash: { old: entry(T0 - 1) } } };
    const after = applyCommands(seeded, [{ kind: "stashSubmission", key: "new", entry: entry(T0 + 1000), now: T0 }], config);
    expect(Object.keys(after.state.meta.retryStash)).toEqual(["new"]);
  });

  it("caps the map at budgets.retryStashEntries, dropping the soonest to expire first", () => {
    const stash: Record<string, ReturnType<typeof entry>> = {};
    for (let i = 0; i < config.budgets.retryStashEntries; i += 1) stash[`k${i}`] = entry(T0 + 1000 + i);
    const seeded = { ...emptyState(), meta: { ...emptyState().meta, retryStash: stash } };

    const after = applyCommands(seeded, [{ kind: "stashSubmission", key: "newest", entry: entry(T0 + 99_999), now: T0 }], config);

    expect(Object.keys(after.state.meta.retryStash)).toHaveLength(config.budgets.retryStashEntries);
    expect(after.state.meta.retryStash["newest"]).toBeDefined();
    expect(after.state.meta.retryStash["k0"]).toBeUndefined();
  });
});
