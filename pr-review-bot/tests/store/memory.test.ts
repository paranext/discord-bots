import { describe, expect, it } from "vitest";
import { config } from "../../config/config.js";
import { emptyState } from "../../src/store/apply.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { Command, DigestPayload, DigestPublisher, StoreState } from "../../src/store/types.js";
import { renderDigest } from "../../src/core/render/digest.js";
import type { PrSnapshot } from "../../src/core/exit.js";
import { newScannedRecord, recordId, type PrRecord } from "../../src/core/record.js";

const T0 = 1_788_192_000_000; // 2026-08-31T16:00:00Z = 11:00 America/Chicago
const MINUTE = 60_000;
const ID = "paranext/paranext-core/177";

function makeFakePublisher() {
  const patches: DigestPayload[] = [];
  const dailies: string[] = [];
  const pins: string[] = ["digest-1"];
  const publisher: DigestPublisher = {
    listPinnedMessageIds: async () => pins,
    patchDigest: async (_id, payload) => {
      patches.push(payload);
      return { ok: true };
    },
    createDigest: async (payload) => {
      patches.push(payload);
      return { ok: true, messageId: "digest-1" };
    },
    postDaily: async (content) => {
      dailies.push(content);
      return { ok: true, messageId: "daily-1" };
    },
    messageUrl: (id) => `https://discord.com/channels/g/c/${id}`,
  };
  return { publisher, patches, dailies, pins };
}

function seeded(): StoreState {
  const record = {
    ...newScannedRecord({
      pr: { owner: "paranext", repo: "paranext-core", number: 177 },
      channelId: "chan",
      messageId: "msg",
      messageTimestamp: T0 - 3 * 86_400_000,
      title: "PT-4398 P10 backend sync-activity signal",
      prAuthorLogin: "jolie",
      isDraft: false,
    }),
    team: "Power" as const,
    urgency: "blocking" as const,
    note: "blocks the release cut",
  };
  const base = emptyState();
  return {
    ...base,
    records: { [recordId(record)]: record },
    meta: { ...base.meta, digestMessageId: "digest-1", lastSync: T0 - MINUTE, lastDailyPostDate: "2026-08-31" },
  };
}

describe("what actually gets sent to Discord", () => {
  it("sends embeds and components only — never the render's own bookkeeping", async () => {
    // `DigestRender` carries bodyHash, openCount, renderedCount and droppedCount
    // alongside embeds/components. Passing the render straight through
    // type-checks (excess property checks do not apply to a variable), so all
    // four were being serialized into the message body. Discord ignores unknown
    // fields today; if it ever stops, the symptom is a 400 on the PATCH — the
    // one failure this file's comments call out as freezing the pin on PRs that
    // are already done. Asserted on both the PATCH and the CREATE path, because
    // they are separate call sites and only one of them was ever exercised by
    // the tests that existed.
    const { publisher, patches } = makeFakePublisher();

    const store = new MemoryStore(config, publisher, seeded());
    await store.beginTick(T0);
    await store.finishTick({
      commands: [{ kind: "claim", id: ID, userId: "u1", displayName: "Katherine", at: T0, expectLastRequestedAt: null }],
      leaseHeldSince: T0,
      now: T0,
    });

    const created = new MemoryStore(config, publisher, {
      ...seeded(),
      meta: { ...seeded().meta, digestMessageId: null },
    });
    await created.beginTick(T0);
    await created.finishTick({ commands: [], leaseHeldSince: T0, now: T0 });

    expect(patches.length).toBeGreaterThanOrEqual(2);
    for (const payload of patches) {
      expect(Object.keys(payload).sort()).toEqual(["components", "embeds"]);
    }
  });
});

describe("the lease", () => {
  it("lets one tick in and turns the overlapping one away without writing", async () => {
    const { publisher } = makeFakePublisher();
    const store = new MemoryStore(config, publisher, seeded());

    const first = await store.beginTick(T0);
    const second = await store.beginTick(T0 + 30_000);

    expect(first.acquired).toBe(true);
    expect(second).toMatchObject({ acquired: false, reason: "lease-held" });
  });

  it("breaks a lease older than the scheduled wall-clock limit", async () => {
    const { publisher } = makeFakePublisher();
    const store = new MemoryStore(config, publisher, seeded());
    await store.beginTick(T0);
    const later = await store.beginTick(T0 + 16 * MINUTE);
    expect(later.acquired).toBe(true);
  });

  it("releases the lease at finishTick so the next tick can run", async () => {
    const { publisher } = makeFakePublisher();
    const store = new MemoryStore(config, publisher, seeded());
    await store.beginTick(T0);
    await store.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 20_000 });
    expect(await store.beginTick(T0 + 40_000)).toMatchObject({ acquired: true });
  });

  it("does not let an expired tick's release clear the lease a newer tick now holds (R52)", async () => {
    // Tick A takes the lease at T0 and then takes longer than the scheduled
    // wall-clock limit — a hung GitHub call, a slow Discord PATCH. Tick B
    // therefore breaks A's lease and starts its own. A then finishes and
    // releases. Its release must be FENCED: an unconditional one clears B's
    // lease, and from that moment two ticks are running unserialised, which is
    // exactly what the lease exists to prevent.
    const { publisher } = makeFakePublisher();
    const store = new MemoryStore(config, publisher, seeded());

    const a = await store.beginTick(T0);
    expect(a.acquired).toBe(true);

    const bAt = T0 + 16 * MINUTE;
    const b = await store.beginTick(bAt);
    // The premise: B really did take the lease over. Without this the assertion
    // below could pass simply because A still owned the lease all along.
    expect(b.acquired).toBe(true);
    expect((await store.readState()).meta.syncLease).toEqual({ heldSince: bAt });

    await store.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 17 * MINUTE });

    // B's lease survives A's release, with B's own heldSince intact...
    expect((await store.readState()).meta.syncLease).toEqual({ heldSince: bAt });
    // ...and is still enforced against a third tick, so this is a live lease
    // rather than a leftover value nothing reads.
    expect(await store.beginTick(bAt + 30_000)).toMatchObject({ acquired: false, reason: "lease-held" });
  });

  it("still releases the lease it does hold, so the fence cannot strand a tick", async () => {
    // The other half of the fence: a tick that never lost its lease must still
    // clear it. A fence keyed on the wrong value (or a release dropped
    // altogether) would leave every tick holding its lease for the full
    // timeout, and this suite's other lease tests would not all notice.
    const { publisher } = makeFakePublisher();
    const store = new MemoryStore(config, publisher, seeded());
    await store.beginTick(T0);
    await store.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 20_000 });
    expect((await store.readState()).meta.syncLease).toBeNull();
  });
});

describe("lost-update ordering", () => {
  it("cannot leave the stored hash agreeing with a body the message is not showing", async () => {
    // The one ordering where the digest goes permanently stale, and the reason
    // the previous version of this test proved nothing: it fully `await`ed the
    // apply() BEFORE calling finishTick, so the tick's render already contained
    // the claim and the two PATCHes never overlapped at all.
    //
    // Here they genuinely interleave, and the two orderings that decide the
    // outcome are modelled SEPARATELY, because in reality they are independent:
    //
    //   - `displayed` changes when DISCORD processes a PATCH.
    //   - the returned promise resolves when the RESPONSE comes back.
    //
    // The tick PATCHes body X (no claim). Katherine's claim then PATCHes body Y.
    // Discord processes Y first and X second, so the pinned message shows X —
    // but the tick's response comes back FIRST and Katherine's SECOND, so her
    // hash write lands last. Blindly stored, that hash is hash(Y) while the
    // message shows X: every later tick renders Y, matches the stored hash,
    // reports skipped-unchanged, and never repaints. Forever.
    const displayed = { body: "" };
    const holder: { store: MemoryStore | null } = { store: null };
    let interaction: Promise<unknown> | null = null;
    let interleaved = false;

    // Two one-shot gates, so the interleaving is deterministic rather than a
    // race between microtask queues.
    let katherineReached!: () => void;
    const katherinePatchReached = new Promise<void>((resolve) => { katherineReached = resolve; });
    let letKatherineRespond!: () => void;
    const katherineResponseGate = new Promise<void>((resolve) => { letKatherineRespond = resolve; });

    const publisher: DigestPublisher = {
      listPinnedMessageIds: async () => ["digest-1"],
      patchDigest: async (_id, payload) => {
        const body = payload.embeds.map((e) => e.description).join("\n");
        if (!interleaved) {
          interleaved = true;
          // The tick's PATCH is now in flight. Katherine claims from the menu.
          interaction = holder.store!.apply(
            [{ kind: "claim", id: ID, userId: "u1", displayName: "Katherine", at: T0 + 2_000, expectLastRequestedAt: null }],
            { now: T0 + 2_000, rerender: true },
          );
          await katherinePatchReached;
          displayed.body = body; // Discord processes OUR patch second...
          return { ok: true }; // ...but answers us first.
        }
        displayed.body = body;
        katherineReached();
        await katherineResponseGate;
        return { ok: true };
      },
      createDigest: async (payload) => {
        displayed.body = payload.embeds.map((e) => e.description).join("\n");
        return { ok: true, messageId: "digest-1" };
      },
      postDaily: async () => ({ ok: true, messageId: "daily-1" }),
      messageUrl: (id) => `https://discord.com/channels/g/c/${id}`,
    };

    const store = new MemoryStore(config, publisher, seeded());
    holder.store = store;

    await store.beginTick(T0);
    await store.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 20_000 });
    letKatherineRespond();
    await interaction;

    // The premise of the scenario: the record has the claim, but the message on
    // screen does not show it. If this ever stops holding, the fixture has
    // stopped reproducing the race and the assertions below are vacuous.
    const raced = await store.readState();
    expect(raced.records[ID]?.claimedByName).toBe("Katherine");
    expect(displayed.body).not.toContain("Katherine");

    // The property that matters: the next tick MUST repaint. A stored hash that
    // matched the un-displayed body would make this "skipped-unchanged" and the
    // message would stay wrong for good.
    await store.beginTick(T0 + 5 * MINUTE);
    const next = await store.finishTick({ commands: [], leaseHeldSince: T0 + 5 * MINUTE, now: T0 + 5 * MINUTE + 10_000 });
    expect(next.digest.action).toBe("patched");
    expect(displayed.body).toContain("Being reviewed");
    expect(displayed.body).toContain("Katherine");
  });

  it("never stores a hash for a body Discord did not keep, in the mirrored ordering", async () => {
    // The test above drives the ordering where the INTERACTION's hash write
    // lands last. This one drives the mirror: the tick's PATCH is processed by
    // Discord FIRST (so the message ends up showing Katherine's body) while the
    // tick's response comes back LAST (so the tick's hash write lands last).
    //
    // Only one hash is defensible afterwards: the one for the body actually on
    // screen, or none at all. A tick that writes its own hash unconditionally
    // stores a third value belonging to a body nobody can see — which happens to
    // self-heal in this particular ordering, but is the same unfenced write that
    // is permanent in the other one, so it is pinned here rather than left to
    // luck.
    const displayed = { body: "" };
    const holder: { store: MemoryStore | null } = { store: null };
    let interaction: Promise<{ digest: { bodyHash: string } | null }> | null = null;
    let interleaved = false;

    const publisher: DigestPublisher = {
      listPinnedMessageIds: async () => ["digest-1"],
      patchDigest: async (_id, payload) => {
        const body = payload.embeds.map((e) => e.description).join("\n");
        if (!interleaved) {
          interleaved = true;
          displayed.body = body; // Discord processes OUR patch first...
          // ...and Katherine's claim, PATCH and hash write all complete while our
          // response is still in the air.
          interaction = holder.store!.apply(
            [{ kind: "claim", id: ID, userId: "u1", displayName: "Katherine", at: T0 + 2_000, expectLastRequestedAt: null }],
            { now: T0 + 2_000, rerender: true },
          );
          await interaction;
          return { ok: true };
        }
        displayed.body = body;
        return { ok: true };
      },
      createDigest: async (payload) => {
        displayed.body = payload.embeds.map((e) => e.description).join("\n");
        return { ok: true, messageId: "digest-1" };
      },
      postDaily: async () => ({ ok: true, messageId: "daily-1" }),
      messageUrl: (id) => `https://discord.com/channels/g/c/${id}`,
    };

    const store = new MemoryStore(config, publisher, seeded());
    holder.store = store;

    await store.beginTick(T0);
    await store.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 20_000 });
    const katherineHash = (await interaction!).digest?.bodyHash ?? null;

    // Premise: the message is showing Katherine's body, not the tick's.
    expect(displayed.body).toContain("Katherine");
    expect(katherineHash).not.toBeNull();

    const stored = (await store.readState()).meta.digestBodyHash;
    expect([null, katherineHash]).toContain(stored);
  });

  it("cannot leave the stored hash agreeing with a body the message is not showing, when the INTERACTION's write lands first", async () => {
    // Neither test above drives this ordering, and it is the one where
    // `return {}` (merely "don't overwrite") instead of `return { digestBodyHash:
    // null }` is permanently broken rather than merely untested.
    //
    // Katherine's claim races the tick exactly as above, but here her PATCH,
    // response, AND hash write all complete — landing hash(Y) in the store via a
    // CAS that legitimately passes against H0 — before the tick's own response
    // comes back. Discord then processes the tick's PATCH last, so the message
    // ends up showing X, not Y. The tick's write-back reads current=hash(Y) against
    // its own pre-I/O expected=H0: those disagree, so the tick is the LOSER here,
    // not Katherine.
    //
    // A blind or "leave it alone" loser write keeps hash(Y) stored while the
    // message shows X. The next tick's render is NOT saved by this: the claim
    // already landed in `state.records` (that part is unconditional and
    // synchronous), so every later tick keeps rendering Y, keeps recomputing
    // hash(Y), keeps matching the stale stored hash, and keeps reporting
    // skipped-unchanged. The message is stuck on X forever with nothing to
    // notice the mismatch. Only storing `null` on loss forces the next tick to
    // repaint regardless of what it renders.
    const displayed = { body: "" };
    const holder: { store: MemoryStore | null } = { store: null };
    let interaction: Promise<unknown> | null = null;
    let interleaved = false;

    const publisher: DigestPublisher = {
      listPinnedMessageIds: async () => ["digest-1"],
      patchDigest: async (_id, payload) => {
        const body = payload.embeds.map((e) => e.description).join("\n");
        if (!interleaved) {
          interleaved = true;
          // Katherine's claim, PATCH, response, and hash write all complete
          // while our own response is still in the air.
          interaction = holder.store!.apply(
            [{ kind: "claim", id: ID, userId: "u1", displayName: "Katherine", at: T0 + 2_000, expectLastRequestedAt: null }],
            { now: T0 + 2_000, rerender: true },
          );
          await interaction;
          // Discord processes OUR patch last, overwriting what Katherine's PATCH
          // put on screen.
          displayed.body = body;
          return { ok: true };
        }
        displayed.body = body; // Katherine's PATCH, processed first — then overwritten above.
        return { ok: true };
      },
      createDigest: async (payload) => {
        displayed.body = payload.embeds.map((e) => e.description).join("\n");
        return { ok: true, messageId: "digest-1" };
      },
      postDaily: async () => ({ ok: true, messageId: "daily-1" }),
      messageUrl: (id) => `https://discord.com/channels/g/c/${id}`,
    };

    const store = new MemoryStore(config, publisher, seeded());
    holder.store = store;

    await store.beginTick(T0);
    await store.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 20_000 });
    await interaction;

    // The premise: the record is claimed, but the message on screen is not
    // showing it — the tick's stale PATCH landed last.
    const raced = await store.readState();
    expect(raced.records[ID]?.claimedByName).toBe("Katherine");
    expect(displayed.body).not.toContain("Katherine");

    // The property that matters: the next tick MUST repaint. `return {}` on the
    // loser leaves the stored hash agreeing with the un-displayed body, so the
    // next tick's render — which already contains the claim, independent of any
    // hash — would match the stale stored hash and report "skipped-unchanged"
    // forever instead of "patched".
    await store.beginTick(T0 + 5 * MINUTE);
    const next = await store.finishTick({ commands: [], leaseHeldSince: T0 + 5 * MINUTE, now: T0 + 5 * MINUTE + 10_000 });
    expect(next.digest.action).toBe("patched");
    expect(displayed.body).toContain("Katherine");
  });

  it("cannot be fooled by a hash that returns to the value the tick read (ABA)", async () => {
    // The ordering a VALUE-based compare-and-set cannot see, and the one that
    // does NOT self-heal. Everything here is an ordinary interaction; the only
    // unusual thing is that three of them fit inside one tick's PATCH
    // round-trip.
    //
    // Tick 1 reads stored hash A and PATCHes body T (GitHub reported alice's
    // review on X, so the tick clears X). Discord processes that PATCH, but the
    // response is slow. Meanwhile: Z is claimed (stores Y), X is REOPENED — the
    // interaction reopen exists for, because the tick's auto-clear is sometimes
    // wrong — (stores W), and Z is unclaimed, which returns the records to
    // rendering exactly A again (the digest renders a coarse projection: it
    // never reads resolvedAt, resolutionHistory or claimedAt, so
    // render(reopen(resolve(r))) is byte-identical to render(r)). So the store
    // holds A once more.
    //
    // The tick's response then returns. A compare on the hash VALUE sees
    // A === A, passes spuriously, and stores T for a body the message is not
    // displaying. Nothing corrects it: on tick 2 GitHub still reports the same
    // review, `exitVerdict` derives the same `resolvedBy`, the render hashes to
    // exactly the stored T, and `commitTick` skips the PATCH entirely — so
    // there is no compare left to fail into null. The pinned digest shows a
    // reviewed PR as still needing review, on that tick and every later one.
    //
    // A MONOTONIC counter cannot be fooled: the three interactive writes moved
    // it three times, so the tick's compare fails, the hash goes to null, and
    // tick 2 repaints. Two records are required — one record cannot both be the
    // one the tick clears and the one whose claim/unclaim returns the render.
    const day = 86_400_000;
    const build = (number: number, title: string): PrRecord => ({
      ...newScannedRecord({
        pr: { owner: "paranext", repo: "paranext-core", number },
        channelId: "chan",
        messageId: `m-${number}`,
        messageTimestamp: T0 - 3 * day,
        title,
        prAuthorLogin: "jolie",
        isDraft: false,
      }),
      team: "Power" as const,
      urgency: "soon" as const,
    });
    const x = build(177, "X needs review");
    const z = build(178, "Z needs review");
    const xId = recordId(x);
    const zId = recordId(z);

    // GitHub reports the same human review on X on every tick — deterministic,
    // which is why tick 2 re-derives a byte-identical body.
    const snapshotX: PrSnapshot = {
      slug: xId,
      title: "X needs review",
      state: "OPEN",
      merged: false,
      isDraft: false,
      authorLogin: "jolie",
      reviews: [{ submittedAt: T0 - MINUTE, state: "APPROVED", authorLogin: "alice", authorIsBot: false }],
    };
    const tickCommands = (now: number): Command[] => [
      { kind: "applySnapshot", id: xId, snapshot: snapshotX, now },
      { kind: "setMeta", patch: { lastSync: now } },
    ];
    const hashOf = (records: PrRecord[], lastSync: number, now: number): string =>
      renderDigest({ records, lastSync, now, config }).bodyHash;

    const t1 = T0;
    const t2 = T0 + 5 * MINUTE;
    const A = hashOf([x, z], t1 - MINUTE, t1);

    const base = emptyState();
    const initial: StoreState = {
      ...base,
      records: { [xId]: x, [zId]: z },
      meta: {
        ...base.meta,
        digestMessageId: "digest-1",
        digestBodyHash: A,
        lastSync: t1 - MINUTE,
        lastDailyPostDate: "2026-08-31",
      },
    };

    // `displayed` is assigned at PATCH time, so call order is Discord's
    // PROCESSING order; the gate makes the tick's RESPONSE come back last.
    const displayed = { body: "body(A)" };
    const patched: string[] = [];
    let releaseTickResponse: (() => void) | null = null;
    let gated = false;

    const publisher: DigestPublisher = {
      listPinnedMessageIds: async () => ["digest-1"],
      patchDigest: async (_id, payload) => {
        displayed.body = payload.embeds.map((e) => e.description).join("\n");
        patched.push(displayed.body.slice(0, 20));
        if (!gated) {
          gated = true;
          await new Promise<void>((resolve) => {
            releaseTickResponse = resolve;
          });
        }
        return { ok: true };
      },
      createDigest: async () => ({ ok: true, messageId: "digest-1" }),
      postDaily: async () => ({ ok: true, messageId: "daily-1" }),
      messageUrl: (id) => `https://discord.com/channels/g/c/${id}`,
    };

    const store = new MemoryStore(config, publisher, initial);

    // ---- Tick 1. Its record mutations commit before any I/O; its PATCH then
    // hangs on the gate with the tick still mid-flight.
    await store.beginTick(t1);
    const tick = store.finishTick({ commands: tickCommands(t1), leaseHeldSince: t1, now: t1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const afterCommands = await store.readState();
    const tickHash = hashOf(Object.values(afterCommands.records), t1, t1);
    expect(afterCommands.records[xId]?.resolvedAt).toBe(t1); // committed before I/O
    expect(afterCommands.meta.digestBodyHash).toBe(A); // not written back yet
    expect(tickHash).not.toBe(A);

    // ---- Three interactions, each a legitimate compare-pass of its own.
    await store.apply(
      [{ kind: "claim", id: zId, userId: "u1", displayName: "Katherine", at: t1 + 1_000, expectLastRequestedAt: null }],
      { now: t1 + 1_000, rerender: true },
    );
    await store.apply([{ kind: "reopen", id: xId, at: t1 + 2_000 }], { now: t1 + 2_000, rerender: true });
    await store.apply([{ kind: "unclaim", id: zId, userId: "u1" }], { now: t1 + 3_000, rerender: true });

    const beforeWriteBack = await store.readState();
    // THE ABA PREMISE. Without these two the test proves nothing: the records
    // really do render exactly the body the tick read, and the stored hash
    // really has come back round to that same value.
    //
    // If either goes red, FIX THE FIXTURE — do not delete the assertion. They
    // hold only because `renderDigest` ignores `resolvedAt`, `claimedAt` and
    // `lastRequestedAt`; if the renderer starts reading any of them, this
    // sequence stops returning to the same hash. Deleting the check would leave
    // a test that still passes while no longer exercising ABA at all.
    expect(hashOf(Object.values(beforeWriteBack.records), t1, t1 + 3_000)).toBe(A);
    expect(beforeWriteBack.meta.digestBodyHash).toBe(A);

    // ---- The tick's PATCH response finally comes back. Its compare must FAIL:
    // three writes crossed it, and no value-equality check can tell.
    releaseTickResponse!();
    await tick;

    const afterTick = await store.readState();
    expect(afterTick.meta.digestBodyHash).not.toBe(tickHash);
    expect(afterTick.meta.digestBodyHash).toBeNull();
    // The message is displaying the last body Discord processed, which is the
    // third interaction's — X is back on the list.
    expect(displayed.body).toContain("X needs review");
    expect(displayed.body).not.toContain("Recently cleared");

    // ---- Tick 2 re-resolves X from the same unchanged GitHub data, so its
    // render is byte-identical to tick 1's. Under a value-based compare that
    // render already equals the stored hash and the tick reports
    // skipped-unchanged; the stored null forces the repaint.
    await store.beginTick(t2);
    const second = await store.finishTick({ commands: tickCommands(t2), leaseHeldSince: t2, now: t2 });
    expect(second.digest.bodyHash).toBe(tickHash); // the same body, re-derived
    expect(second.digest.action).toBe("patched");
    expect(displayed.body).toContain("Recently cleared");
    expect(displayed.body).not.toContain("X needs review");
    expect(patched).toHaveLength(5); // T, Y, W, A, and the repaint

    // ---- And it settles: the repaint's hash is now legitimately stored, so
    // tick 3 is a genuine skip rather than a suppressed correction.
    await store.beginTick(t2 + 5 * MINUTE);
    const third = await store.finishTick({
      commands: tickCommands(t2 + 5 * MINUTE),
      leaseHeldSince: t2 + 5 * MINUTE,
      now: t2 + 5 * MINUTE,
    });
    expect(third.digest.action).toBe("skipped-unchanged");
    expect(displayed.body).toContain("Recently cleared");
  });

  it("a resolve committed mid-tick is not undone by the tick", async () => {
    const { publisher } = makeFakePublisher();
    const store = new MemoryStore(config, publisher, seeded());
    await store.beginTick(T0);
    await store.apply(
      [{ kind: "resolve", id: ID, by: "cleared by Jolie", at: T0 + 2_000, expectLastRequestedAt: null }],
      { now: T0 + 2_000, rerender: false },
    );
    await store.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 20_000 });
    expect((await store.readState()).records[ID]?.resolvedBy).toBe("cleared by Jolie");
  });

  it("a claim landing while patchDigest is in flight survives finishTick's write-back", async () => {
    // This is the narrower, later window than the two tests above: the claim
    // doesn't land between beginTick and finishTick — it lands DURING
    // finishTick's own network I/O, inside the patchDigest call itself. A
    // finishTick that writes back a whole state captured before that await
    // (rather than re-reading current state and merging only the meta patch)
    // discards it. This particular PATCH's body is not required to show the
    // claim (it was already sent when the claim landed) — only that the
    // claim's data survives to be picked up by the next tick.
    const patches: DigestPayload[] = [];
    // A mutable holder, not `let store`: the publisher's closure needs to reach
    // the store instance that will be constructed with it, and this avoids a
    // definite-assignment `let` that's actually assigned exactly once.
    const holder: { store: MemoryStore | null } = { store: null };
    const publisher: DigestPublisher = {
      listPinnedMessageIds: async () => ["digest-1"],
      patchDigest: async (_id, payload) => {
        patches.push(payload);
        // The interleave point: an interactive apply() commits mid-flight,
        // while finishTick's own PATCH is still in the air.
        await holder.store!.apply(
          [{ kind: "claim", id: ID, userId: "u1", displayName: "Katherine", at: T0 + 15_000, expectLastRequestedAt: null }],
          { now: T0 + 15_000, rerender: false },
        );
        return { ok: true };
      },
      createDigest: async (payload) => {
        patches.push(payload);
        return { ok: true, messageId: "digest-1" };
      },
      postDaily: async (_content) => ({ ok: true, messageId: "daily-1" }),
      messageUrl: (id) => `https://discord.com/channels/g/c/${id}`,
    };
    const store = new MemoryStore(config, publisher, seeded());
    holder.store = store;

    await store.beginTick(T0);
    await store.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 10_000 });

    const state = await store.readState();
    expect(state.records[ID]?.claimedByName).toBe("Katherine");
  });
});

describe("a rejected call after the digest was created", () => {
  it("keeps digestMessageId, so the next tick edits that digest instead of posting a second one", async () => {
    // Setup step 13: READ_ONLY goes false, digestMessageId is null, the daily
    // post is due, and postDaily's fetch REJECTS (connection reset) rather than
    // returning {ok: false}. If the created message's id only lived in the patch
    // commitTick returns, the throw would discard it and the next tick would
    // create a SECOND digest — orphaning the first in the channel with nobody
    // editing it, at the exact step the runbook tells the operator to pin one
    // message by hand.
    const created: string[] = [];
    const dailies: string[] = [];
    let dailyRejects = true;
    const publisher: DigestPublisher = {
      listPinnedMessageIds: async () => [],
      patchDigest: async () => ({ ok: true }),
      createDigest: async () => {
        created.push(`digest-${created.length + 1}`);
        return { ok: true, messageId: created.at(-1)! };
      },
      postDaily: async (content) => {
        if (dailyRejects) throw new Error("connection reset by peer");
        dailies.push(content);
        return { ok: true, messageId: "daily-1" };
      },
      messageUrl: (id) => `https://discord.com/channels/g/c/${id}`,
    };
    const base = seeded();
    const store = new MemoryStore(config, publisher, {
      ...base,
      meta: { ...base.meta, digestMessageId: null, lastDailyPostDate: null },
    });

    await store.beginTick(T0);
    await expect(store.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 10_000 })).rejects.toThrow("connection reset");

    expect(created).toEqual(["digest-1"]);
    const afterThrow = await store.readState();
    expect(afterThrow.meta.digestMessageId).toBe("digest-1");
    // The body that went into that message is durable too, so the next tick does
    // not repaint an identical body just to re-learn its own hash.
    expect(afterThrow.meta.digestBodyHash).not.toBeNull();

    // runTick's `finally` is what frees the lease after a throw; stand in for it
    // here so the next tick can actually run.
    await store.apply([{ kind: "setMeta", patch: { syncLease: null } }], { now: T0 + 11_000, rerender: false });

    dailyRejects = false;
    await store.beginTick(T0 + 5 * MINUTE);
    const second = await store.finishTick({ commands: [], leaseHeldSince: T0 + 5 * MINUTE, now: T0 + 5 * MINUTE + 10_000 });

    expect(created).toEqual(["digest-1"]);
    expect(second.digest.action).not.toBe("created");
    expect(dailies).toHaveLength(1);
  });
});

describe("the write-skip", () => {
  it("does not PATCH when the body is unchanged", async () => {
    const { publisher, patches } = makeFakePublisher();
    const store = new MemoryStore(config, publisher, seeded());

    await store.beginTick(T0);
    await store.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 10_000 });
    const afterFirst = patches.length;

    await store.beginTick(T0 + 5 * MINUTE);
    await store.finishTick({ commands: [], leaseHeldSince: T0 + 5 * MINUTE, now: T0 + 5 * MINUTE + 10_000 });

    expect(patches.length).toBe(afterFirst);
  });

  it("does not write the hash when the PATCH fails, so the correction is not suppressed", async () => {
    const { publisher } = makeFakePublisher();
    const failing: DigestPublisher = { ...publisher, patchDigest: async () => ({ ok: false, status: 500 }) };
    const base = seeded();
    // Seed a known, deliberately-wrong hash so we can prove it survives the failed PATCH —
    // comparing against seeded()'s null hash can't distinguish "left alone" from "erased".
    const store = new MemoryStore(config, failing, {
      ...base,
      meta: { ...base.meta, digestBodyHash: "deadbeef" },
    });

    await store.beginTick(T0);
    const first = await store.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 10_000 });
    // The PATCH failed (not a 404), so the action reported is "failed", not "patched" —
    // attempting a PATCH is not the same as it having succeeded.
    expect(first.digest.action).toBe("failed");
    const stored = (await store.readState()).meta.digestBodyHash;
    expect(stored).toBe("deadbeef");
  });
});

describe("rendering when the sync failed", () => {
  it("still renders, and the stale banner appears", async () => {
    const { publisher, patches } = makeFakePublisher();
    const state = seeded();
    const store = new MemoryStore(config, publisher, {
      ...state,
      meta: { ...state.meta, lastSync: T0 - 47 * MINUTE },
    });

    await store.beginTick(T0);
    const result = await store.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 10_000 });

    expect(result.digest.action).toBe("patched");
    expect(patches.at(-1)!.embeds[0]!.description).toContain("Not syncing");
    expect(result.digest.renderedCount).toBe(1);
  });
});

describe("the unpinned latch", () => {
  it("reports once and resets when the digest is pinned again", async () => {
    const { publisher, pins } = makeFakePublisher();
    const store = new MemoryStore(config, publisher, seeded());

    pins.length = 0; // someone unpinned it
    await store.beginTick(T0);
    await store.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 10_000 });
    const first = (await store.readState()).meta.unpinnedReportedAt;
    expect(first).not.toBeNull();

    await store.beginTick(T0 + 5 * MINUTE);
    await store.finishTick({ commands: [], leaseHeldSince: T0 + 5 * MINUTE, now: T0 + 5 * MINUTE + 10_000 });
    expect((await store.readState()).meta.unpinnedReportedAt).toBe(first);

    pins.push("digest-1"); // re-pinned
    await store.beginTick(T0 + 10 * MINUTE);
    await store.finishTick({ commands: [], leaseHeldSince: T0 + 10 * MINUTE, now: T0 + 10 * MINUTE + 10_000 });
    expect((await store.readState()).meta.unpinnedReportedAt).toBeNull();
  });
});

describe("the daily post", () => {
  it("posts once when rows are open and the hour has passed", async () => {
    const { publisher, dailies } = makeFakePublisher();
    const state = seeded();
    const store = new MemoryStore(config, publisher, {
      ...state,
      meta: { ...state.meta, lastDailyPostDate: null },
    });

    await store.beginTick(T0);
    const result = await store.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 10_000 });
    expect(result.dailyPosted).toBe(true);
    expect(dailies).toHaveLength(1);
    expect(dailies[0]).toContain("1 PR waiting");

    await store.beginTick(T0 + 5 * MINUTE);
    const second = await store.finishTick({ commands: [], leaseHeldSince: T0 + 5 * MINUTE, now: T0 + 5 * MINUTE });
    expect(second.dailyPosted).toBe(false);
    expect(dailies).toHaveLength(1);
  });

  it("posts nothing when the queue is clear, and does not retry every tick", async () => {
    const { publisher, dailies } = makeFakePublisher();
    const base = emptyState();
    const store = new MemoryStore(config, publisher, {
      ...base,
      records: {},
      meta: { ...base.meta, digestMessageId: "digest-1", lastSync: T0 - MINUTE, lastDailyPostDate: null },
    });

    await store.beginTick(T0);
    await store.finishTick({ commands: [], leaseHeldSince: T0, now: T0 });
    expect(dailies).toHaveLength(0);
    expect((await store.readState()).meta.lastDailyPostDate).toBe("2026-08-31");
  });
});
