import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newScannedRecord, recordId } from "../../src/core/record.js";
import type { PrSnapshot } from "../../src/core/exit.js";
import { CURRENT_SCHEMA_VERSION, type Command, type DigestPayload, type DigestPublisher, type FinishTickInput, type Store, type StoreState } from "../../src/store/types.js";

const T0 = 1_788_192_000_000; // 2026-08-31T16:00:00Z = 11:00 America/Chicago
const ID = "paranext/paranext-core/177";

function fakePublisher(patches: DigestPayload[]): DigestPublisher {
  return {
    listPinnedMessageIds: async () => ["digest-1"],
    patchDigest: async (_id, payload) => {
      patches.push(payload);
      return { ok: true };
    },
    createDigest: async (payload) => {
      patches.push(payload);
      return { ok: true, messageId: "digest-1" };
    },
    postDaily: async () => ({ ok: true, messageId: "daily-1" }),
    messageUrl: (id) => `https://discord.com/channels/g/c/${id}`,
  };
}

describe("RecordsObject", () => {
  it("persists state across separate stub calls", async () => {
    const id = env.RECORDS.idFromName("test-persist");
    const stub = env.RECORDS.get(id);

    const record = newScannedRecord({
      pr: { owner: "paranext", repo: "paranext-core", number: 177 },
      channelId: "chan",
      messageId: "msg",
      messageTimestamp: T0,
      title: "PT-4398",
      prAuthorLogin: "jolie",
      isDraft: false,
    });

    await stub.apply(
      [{ kind: "upsertScanned", input: {
          pr: { owner: "paranext", repo: "paranext-core", number: 177 },
          channelId: "chan", messageId: "msg", messageTimestamp: T0,
          title: "PT-4398", prAuthorLogin: "jolie", isDraft: false,
        }, now: T0 }],
      { now: T0, rerender: false },
    );

    const state = await stub.readState();
    expect(Object.keys(state.records)).toEqual([recordId(record)]);
  });

  it("refuses a second overlapping beginTick", async () => {
    const id = env.RECORDS.idFromName("test-lease");
    const stub = env.RECORDS.get(id);
    expect(await stub.beginTick(T0)).toMatchObject({ acquired: true });
    expect(await stub.beginTick(T0 + 30_000)).toMatchObject({ acquired: false });
  });

  it("breaks a lease older than LEASE_TIMEOUT_MS, same as MemoryStore", async () => {
    // do.ts and memory.ts both import LEASE_TIMEOUT_MS from types.ts. This pins the
    // Durable Object side of that shared constant so the two cannot silently drift —
    // a mismatch here would break a live lease mid-tick and let the loop overlap.
    const id = env.RECORDS.idFromName("test-lease-break");
    const stub = env.RECORDS.get(id);
    expect(await stub.beginTick(T0)).toMatchObject({ acquired: true });
    expect(await stub.beginTick(T0 + 16 * 60_000)).toMatchObject({ acquired: true });
  });

  it("does not let an expired tick's release clear the lease a newer tick now holds (R52)", async () => {
    // The Durable Object twin of the MemoryStore R52 test, and it is not
    // redundant with it. `tickWriteBack` is shared, so both stores emit the same
    // `releaseLease` COMMAND shape — but the fence's IDENTITY argument is
    // written out separately at each call site, and the identity is the part
    // that is hard to get right: it must come from the CALLER
    // (`FinishTickInput.leaseHeldSince`), never from the state read at commit
    // time, because the whole case being guarded is a tick that overran the
    // timeout, by which point the stored lease belongs to a newer tick. Reading
    // it from `fresh` — which `do.ts` conveniently has in scope two lines above
    // the release — fences against the interloper's own identity and clears its
    // lease: an unconditional release wearing a fence's clothes. That mutation
    // fails one test in `MemoryStore` and, before this test, left the whole
    // suite green in the deployed store.
    const patches: DigestPayload[] = [];
    const id = env.RECORDS.idFromName("test-lease-fence-do");
    const stub = env.RECORDS.get(id);

    await runInDurableObject(stub, (instance: unknown) => {
      (instance as unknown as { setPublisherFactory: (f: unknown) => void }).setPublisherFactory(
        () => fakePublisher(patches),
      );
    });

    // Tick A takes the lease, then overruns the scheduled wall-clock limit — a
    // hung GitHub call, a slow Discord PATCH.
    expect(await stub.beginTick(T0)).toMatchObject({ acquired: true });

    const bAt = T0 + 16 * 60_000;
    expect(await stub.beginTick(bAt)).toMatchObject({ acquired: true });
    // The premise: B really did take the lease over. Without this the assertion
    // below could pass simply because A still owned the lease all along.
    expect((await stub.readState()).meta.syncLease).toEqual({ heldSince: bAt });

    // A now finishes and releases, still passing its OWN heldSince.
    await stub.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 17 * 60_000 });

    // B's lease survives, with B's own heldSince intact...
    expect((await stub.readState()).meta.syncLease).toEqual({ heldSince: bAt });
    // ...and is still enforced against a third tick, so this is a live lease
    // rather than a leftover value nothing reads.
    expect(await stub.beginTick(bAt + 30_000)).toMatchObject({ acquired: false, reason: "lease-held" });
  });

  it("still releases the lease it does hold, so the fence cannot strand a tick", async () => {
    // The other half of the fence, mirrored from `MemoryStore`: a tick that
    // never lost its lease must still clear it. A fence keyed on the wrong value
    // would leave every tick holding its lease for the full timeout, and the
    // test above would not notice.
    const patches: DigestPayload[] = [];
    const id = env.RECORDS.idFromName("test-lease-fence-do-releases");
    const stub = env.RECORDS.get(id);

    await runInDurableObject(stub, (instance: unknown) => {
      (instance as unknown as { setPublisherFactory: (f: unknown) => void }).setPublisherFactory(
        () => fakePublisher(patches),
      );
    });

    await stub.beginTick(T0);
    await stub.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 20_000 });
    expect((await stub.readState()).meta.syncLease).toBeNull();
  });

  it("keeps a mid-tick claim through finishTick", async () => {
    const patches: DigestPayload[] = [];
    const id = env.RECORDS.idFromName("test-ordering");
    const stub = env.RECORDS.get(id);

    await runInDurableObject(stub, (instance: unknown) => {
      (instance as unknown as { setPublisherFactory: (f: unknown) => void }).setPublisherFactory(
        () => fakePublisher(patches),
      );
    });

    await stub.apply(
      [{ kind: "upsertRequest",
         pr: { owner: "paranext", repo: "paranext-core", number: 177 },
         at: T0 - 86_400_000,
         fields: { team: "Power", urgency: "blocking", prdThreadId: null, note: "blocks the cut", requesterId: "u0", requesterName: "Jolie", channelId: "chan", messageId: "msg" },
         title: "PT-4398", prAuthorLogin: "jolie", isDraft: false }],
      { now: T0, rerender: false },
    );
    await stub.apply([{ kind: "setMeta", patch: { digestMessageId: "digest-1", lastSync: T0, lastDailyPostDate: "2026-08-31" } }], { now: T0, rerender: false });

    await stub.beginTick(T0);
    await stub.apply(
      [{ kind: "claim", id: ID, userId: "u1", displayName: "Katherine", at: T0 + 2_000, expectLastRequestedAt: null }],
      { now: T0 + 2_000, rerender: false },
    );
    await stub.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 20_000 });

    const state = await stub.readState();
    expect(state.records[ID]?.claimedByName).toBe("Katherine");
    expect(patches.at(-1)!.embeds.map((e) => e.description).join("\n")).toContain("Katherine");
  });

  it("compare-and-sets the body hash, so an apply() crossing finishTick's PATCH cannot freeze the digest", async () => {
    // The MemoryStore twin of this test drives the interleave in one isolate.
    // This drives it through the real object, whose write-backs go through
    // ctx.storage inside blockConcurrencyWhile: the fake publisher re-enters the
    // live instance's own apply() while finishTick's PATCH is in flight, which is
    // legal precisely because that I/O is deliberately outside
    // blockConcurrencyWhile. Both writers reach the durable hash; the loser must
    // not leave it agreeing with a body the message is not showing, or every
    // later tick reports skipped-unchanged and the pinned list never repaints.
    //
    // The apply() is called on the instance rather than through a second stub: a
    // stub built in the test's own context cannot perform I/O on the object's
    // behalf ("Cannot perform I/O on behalf of a different Durable Object").
    const displayed = { body: "" };
    const id = env.RECORDS.idFromName("test-hash-cas");
    const stub = env.RECORDS.get(id);
    let interleaved = false;
    let interaction: Promise<unknown> | null = null;
    const live: { apply: Store["apply"] | null } = { apply: null };

    await runInDurableObject(stub, (instance: unknown) => {
      live.apply = (instance as unknown as Store).apply.bind(instance as unknown as Store);
      (instance as unknown as { setPublisherFactory: (f: unknown) => void }).setPublisherFactory(
        (): DigestPublisher => ({
          listPinnedMessageIds: async () => ["digest-1"],
          patchDigest: async (_m, payload) => {
            const body = payload.embeds.map((e) => e.description).join("\n");
            if (!interleaved) {
              interleaved = true;
              displayed.body = body; // Discord processes the tick's PATCH first
              interaction = live.apply!(
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
          messageUrl: (m) => `https://discord.com/channels/g/c/${m}`,
        }),
      );
    });

    await stub.apply(
      [{ kind: "upsertRequest",
         pr: { owner: "paranext", repo: "paranext-core", number: 177 },
         at: T0 - 86_400_000,
         fields: { team: "Power", urgency: "blocking", prdThreadId: null, note: "blocks the cut", requesterId: "u0", requesterName: "Jolie", channelId: "chan", messageId: "msg" },
         title: "PT-4398", prAuthorLogin: "jolie", isDraft: false }],
      { now: T0, rerender: false },
    );
    await stub.apply(
      [{ kind: "setMeta", patch: { digestMessageId: "digest-1", lastSync: T0, lastDailyPostDate: "2026-08-31" } }],
      { now: T0, rerender: false },
    );

    await stub.beginTick(T0);
    await stub.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 20_000 });
    const applied = (await interaction) as unknown as { digest: { bodyHash: string } | null };
    const katherineHash = applied.digest?.bodyHash ?? null;

    expect(displayed.body).toContain("Katherine");
    expect(katherineHash).not.toBeNull();
    const stored = (await stub.readState()).meta.digestBodyHash;
    expect([null, katherineHash]).toContain(stored);
  });

  it("compare-and-sets on the apply() side too, so an interaction whose response returns last cannot freeze the digest", async () => {
    // The mirror of the test above, and the ordering with the permanent
    // consequence: Discord processes the INTERACTION's PATCH first and the
    // tick's second (so the message shows the tick's pre-claim body), while the
    // tick's response returns first and the interaction's last (so the
    // interaction's hash write lands last). If apply() writes its hash blindly,
    // the stored hash describes the claimed body while the message shows the
    // unclaimed one, every later tick recomputes that same hash, and the pinned
    // digest never repaints again.
    const displayed = { body: "" };
    const id = env.RECORDS.idFromName("test-hash-cas-apply");
    const stub = env.RECORDS.get(id);
    let interleaved = false;
    let interaction: Promise<unknown> | null = null;
    const live: { apply: Store["apply"] | null } = { apply: null };

    let interactionReached!: () => void;
    const interactionPatchReached = new Promise<void>((resolve) => { interactionReached = resolve; });
    let letInteractionRespond!: () => void;
    const interactionResponseGate = new Promise<void>((resolve) => { letInteractionRespond = resolve; });

    await runInDurableObject(stub, (instance: unknown) => {
      live.apply = (instance as unknown as Store).apply.bind(instance as unknown as Store);
      (instance as unknown as { setPublisherFactory: (f: unknown) => void }).setPublisherFactory(
        (): DigestPublisher => ({
          listPinnedMessageIds: async () => ["digest-1"],
          patchDigest: async (_m, payload) => {
            const body = payload.embeds.map((e) => e.description).join("\n");
            if (!interleaved) {
              interleaved = true;
              interaction = live.apply!(
                [{ kind: "claim", id: ID, userId: "u1", displayName: "Katherine", at: T0 + 2_000, expectLastRequestedAt: null }],
                { now: T0 + 2_000, rerender: true },
              );
              await interactionPatchReached;
              displayed.body = body; // Discord processes ours second...
              return { ok: true }; // ...but answers us first.
            }
            displayed.body = body;
            interactionReached();
            await interactionResponseGate;
            return { ok: true };
          },
          createDigest: async (payload) => {
            displayed.body = payload.embeds.map((e) => e.description).join("\n");
            return { ok: true, messageId: "digest-1" };
          },
          postDaily: async () => ({ ok: true, messageId: "daily-1" }),
          messageUrl: (m) => `https://discord.com/channels/g/c/${m}`,
        }),
      );
    });

    await stub.apply(
      [{ kind: "upsertRequest",
         pr: { owner: "paranext", repo: "paranext-core", number: 177 },
         at: T0 - 86_400_000,
         fields: { team: "Power", urgency: "blocking", prdThreadId: null, note: "blocks the cut", requesterId: "u0", requesterName: "Jolie", channelId: "chan", messageId: "msg" },
         title: "PT-4398", prAuthorLogin: "jolie", isDraft: false }],
      { now: T0, rerender: false },
    );
    await stub.apply(
      [{ kind: "setMeta", patch: { digestMessageId: "digest-1", lastSync: T0, lastDailyPostDate: "2026-08-31" } }],
      { now: T0, rerender: false },
    );

    await stub.beginTick(T0);
    await stub.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 20_000 });
    letInteractionRespond();
    await interaction;

    // Premise: the record is claimed but the message is not showing it.
    expect((await stub.readState()).records[ID]?.claimedByName).toBe("Katherine");
    expect(displayed.body).not.toContain("Katherine");

    // The property: the next tick must repaint rather than report
    // skipped-unchanged against a hash for a body nobody can see.
    await stub.beginTick(T0 + 5 * 60_000);
    const next = await stub.finishTick({ commands: [], leaseHeldSince: T0 + 5 * 60_000, now: T0 + 5 * 60_000 + 10_000 });
    expect(next.digest.action).toBe("patched");
    expect(displayed.body).toContain("Katherine");
  });

  it("compare-and-sets on the tick side too, when the INTERACTION's write lands first", async () => {
    // Neither DO race test above drives this ordering, and it is the one where
    // `return {}` (merely "don't overwrite") instead of `return { digestBodyHash:
    // null }` is permanently broken rather than merely untested.
    //
    // Katherine's claim, PATCH, response, and hash write all complete — landing
    // hash(Y) in storage via a CAS that legitimately passes against H0 — before
    // the tick's own response comes back. Discord then processes the tick's
    // PATCH last, so the message ends up showing X, not Y. The tick's
    // write-back reads current=hash(Y) against its own pre-I/O expected=H0:
    // those disagree, so the TICK is the loser here.
    //
    // A blind or "leave it alone" loser write keeps hash(Y) stored while the
    // message shows X. The claim already landed in records unconditionally, so
    // every later tick keeps rendering Y, keeps recomputing hash(Y), keeps
    // matching the stale stored hash, and reports skipped-unchanged forever.
    // Only storing null on loss forces the next tick to repaint.
    const displayed = { body: "" };
    const id = env.RECORDS.idFromName("test-hash-cas-tick-loses");
    const stub = env.RECORDS.get(id);
    let interleaved = false;
    let interaction: Promise<unknown> | null = null;
    const live: { apply: Store["apply"] | null } = { apply: null };

    await runInDurableObject(stub, (instance: unknown) => {
      live.apply = (instance as unknown as Store).apply.bind(instance as unknown as Store);
      (instance as unknown as { setPublisherFactory: (f: unknown) => void }).setPublisherFactory(
        (): DigestPublisher => ({
          listPinnedMessageIds: async () => ["digest-1"],
          patchDigest: async (_m, payload) => {
            const body = payload.embeds.map((e) => e.description).join("\n");
            if (!interleaved) {
              interleaved = true;
              // Katherine's claim, PATCH, response, and hash write all
              // complete while our own response is still in the air.
              interaction = live.apply!(
                [{ kind: "claim", id: ID, userId: "u1", displayName: "Katherine", at: T0 + 2_000, expectLastRequestedAt: null }],
                { now: T0 + 2_000, rerender: true },
              );
              await interaction;
              // Discord processes OUR patch last, overwriting what Katherine's
              // PATCH put on screen.
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
          messageUrl: (m) => `https://discord.com/channels/g/c/${m}`,
        }),
      );
    });

    await stub.apply(
      [{ kind: "upsertRequest",
         pr: { owner: "paranext", repo: "paranext-core", number: 177 },
         at: T0 - 86_400_000,
         fields: { team: "Power", urgency: "blocking", prdThreadId: null, note: "blocks the cut", requesterId: "u0", requesterName: "Jolie", channelId: "chan", messageId: "msg" },
         title: "PT-4398", prAuthorLogin: "jolie", isDraft: false }],
      { now: T0, rerender: false },
    );
    await stub.apply(
      [{ kind: "setMeta", patch: { digestMessageId: "digest-1", lastSync: T0, lastDailyPostDate: "2026-08-31" } }],
      { now: T0, rerender: false },
    );

    await stub.beginTick(T0);
    await stub.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 20_000 });
    await interaction;

    // Premise: the record is claimed, but the message on screen is not
    // showing it — the tick's stale PATCH landed last.
    expect((await stub.readState()).records[ID]?.claimedByName).toBe("Katherine");
    expect(displayed.body).not.toContain("Katherine");

    // The property: the next tick must repaint rather than report
    // skipped-unchanged against a hash for a body nobody can see.
    await stub.beginTick(T0 + 5 * 60_000);
    const next = await stub.finishTick({ commands: [], leaseHeldSince: T0 + 5 * 60_000, now: T0 + 5 * 60_000 + 10_000 });
    expect(next.digest.action).toBe("patched");
    expect(displayed.body).toContain("Katherine");
  });

  it("cannot be fooled by a hash that returns to the value the tick read (ABA)", async () => {
    // The Durable Object twin of the MemoryStore ABA test. It belongs here and
    // not only there: the DO's write-back re-reads inside
    // blockConcurrencyWhile, which closes the check-then-write window but does
    // NOT close ABA — the compare is the same compare, and if it were on a value
    // the extra serialisation would hide nothing.
    //
    // Three ordinary interactions land inside the tick's PATCH round-trip: Z is
    // claimed, X — the row this tick just cleared from GitHub's review data — is
    // REOPENED, and Z is unclaimed. Those return the records to rendering
    // exactly the body the tick read, and so return the stored hash to exactly
    // the value the tick read. A compare on the hash value passes there and
    // stores a body nobody is looking at; and the next tick re-derives that same
    // body from the same GitHub data, matches the stored hash, and skips — so no
    // later compare ever fails into null.
    const displayed = { body: "" };
    const id = env.RECORDS.idFromName("test-hash-cas-aba");
    const stub = env.RECORDS.get(id);
    const xId = "paranext/paranext-core/177";
    const zId = "paranext/paranext-core/178";
    const t1 = T0;
    const t2 = T0 + 5 * 60_000;

    // GitHub reports the same human review on X on every tick, so `exitVerdict`
    // derives the same `resolvedBy` and tick 2's body is byte-identical.
    const snapshotX: PrSnapshot = {
      slug: xId,
      title: "X needs review",
      state: "OPEN",
      merged: false,
      isDraft: false,
      authorLogin: "jolie",
      reviews: [{ submittedAt: T0 - 60_000, state: "APPROVED", authorLogin: "alice", authorIsBot: false }],
    };
    const tickCommands = (now: number): Command[] => [
      { kind: "applySnapshot", id: xId, snapshot: snapshotX, now },
      { kind: "setMeta", patch: { lastSync: now } },
    ];

    let armed = false;
    const patched: string[] = [];
    const live: { apply: Store["apply"] | null; readState: Store["readState"] | null } = {
      apply: null,
      readState: null,
    };
    let hashWhenTickResponded: string | null = null;

    await runInDurableObject(stub, (instance: unknown) => {
      const object = instance as unknown as Store;
      live.apply = object.apply.bind(object);
      live.readState = object.readState.bind(object);
      (instance as unknown as { setPublisherFactory: (f: unknown) => void }).setPublisherFactory(
        (): DigestPublisher => ({
          listPinnedMessageIds: async () => ["digest-1"],
          patchDigest: async (_m, payload) => {
            // Discord PROCESSES each PATCH here, in call order.
            displayed.body = payload.embeds.map((e) => e.description).join("\n");
            patched.push(displayed.body.slice(0, 24));
            if (armed) {
              armed = false;
              // ...and the tick's RESPONSE is slow: three interactions complete
              // in full — PATCH, response and hash write each — before it lands.
              await live.apply!(
                [{ kind: "claim", id: zId, userId: "u1", displayName: "Katherine", at: t1 + 1_000, expectLastRequestedAt: null }],
                { now: t1 + 1_000, rerender: true },
              );
              await live.apply!([{ kind: "reopen", id: xId, at: t1 + 2_000 }], { now: t1 + 2_000, rerender: true });
              await live.apply!([{ kind: "unclaim", id: zId, userId: "u1" }], { now: t1 + 3_000, rerender: true });
              hashWhenTickResponded = (await live.readState!()).meta.digestBodyHash;
            }
            return { ok: true };
          },
          createDigest: async (payload) => {
            displayed.body = payload.embeds.map((e) => e.description).join("\n");
            return { ok: true, messageId: "digest-1" };
          },
          postDaily: async () => ({ ok: true, messageId: "daily-1" }),
          messageUrl: (m) => `https://discord.com/channels/g/c/${m}`,
        }),
      );
    });

    for (const [number, title] of [[177, "X needs review"], [178, "Z needs review"]] as const) {
      await stub.apply(
        [{ kind: "upsertRequest",
           pr: { owner: "paranext", repo: "paranext-core", number },
           at: T0 - 3 * 86_400_000,
           fields: { team: "Power", urgency: "soon", prdThreadId: null, note: null, requesterId: "u0", requesterName: "Jolie", channelId: "chan", messageId: `m-${number}` },
           title, prAuthorLogin: "jolie", isDraft: false }],
        { now: T0 - 3 * 86_400_000, rerender: false },
      );
    }
    await stub.apply(
      [{ kind: "setMeta", patch: { digestMessageId: "digest-1", lastSync: t1 - 60_000, lastDailyPostDate: "2026-08-31" } }],
      { now: t1, rerender: false },
    );

    // A plain tick first, purely to put the CURRENT body's hash in storage the
    // legitimate way — this is the "A" the racing tick will read.
    await stub.beginTick(t1 - 1);
    const setup = await stub.finishTick({ commands: [], leaseHeldSince: t1 - 1, now: t1 });
    const A = setup.digest.bodyHash;
    expect(setup.digest.action).toBe("patched");
    expect((await stub.readState()).meta.digestBodyHash).toBe(A);

    // ---- The racing tick. GitHub reports alice's review, so it clears X.
    armed = true;
    await stub.beginTick(t1);
    const racing = await stub.finishTick({ commands: tickCommands(t1), leaseHeldSince: t1, now: t1 });
    const tickHash = racing.digest.bodyHash;
    expect(racing.digest.action).toBe("patched");
    expect(tickHash).not.toBe(A);

    // THE ABA PREMISE, sampled inside the tick's own PATCH call: by the time the
    // tick's response came back, the stored hash had come round to exactly the
    // value the tick read. Without this the test proves nothing.
    //
    // If this line ever goes red, FIX THE FIXTURE — do not delete the
    // assertion. It holds only because `renderDigest` ignores `resolvedAt`,
    // `claimedAt` and `lastRequestedAt`; if the renderer starts reading any of
    // them, this sequence stops coming round to the same hash. Deleting the
    // check would leave a test that still passes while no longer exercising ABA
    // at all, which is worse than having no test here.
    expect(hashWhenTickResponded).toBe(A);

    // So the compare must FAIL, even though the values agree.
    const afterRacing = await stub.readState();
    expect(afterRacing.meta.digestBodyHash).not.toBe(tickHash);
    expect(afterRacing.meta.digestBodyHash).toBeNull();
    // The message shows the last body Discord processed — X back on the list.
    expect(displayed.body).toContain("X needs review");
    expect(displayed.body).not.toContain("Recently cleared");

    // ---- Tick 2 re-derives the identical body from the identical GitHub data.
    // Under a value-based compare it would match the stored hash and report
    // skipped-unchanged; the stored null forces the repaint.
    await stub.beginTick(t2);
    const second = await stub.finishTick({ commands: tickCommands(t2), leaseHeldSince: t2, now: t2 });
    expect(second.digest.bodyHash).toBe(tickHash); // the same body, re-derived
    expect(second.digest.action).toBe("patched");
    expect(displayed.body).toContain("Recently cleared");
    expect(displayed.body).not.toContain("X needs review");
  });

  it("has a created digest's id in DURABLE storage before a later postDaily can reject", async () => {
    // The memory-store twin of this test proves the logic; this one proves it
    // holds where it has to hold. A DO instance is evicted between requests, so
    // "we kept it in a field" is not the same as "the next tick will see it" —
    // the id has to be in ctx.storage before the call that can reject is made.
    // Read back through readState(), which loads from storage.
    const created: string[] = [];
    const id = env.RECORDS.idFromName("test-created-id-durable");
    const stub = env.RECORDS.get(id);

    await runInDurableObject(stub, (instance: unknown) => {
      (instance as unknown as { setPublisherFactory: (f: unknown) => void }).setPublisherFactory(
        (): DigestPublisher => ({
          listPinnedMessageIds: async () => [],
          patchDigest: async () => ({ ok: true }),
          createDigest: async () => {
            created.push(`digest-${created.length + 1}`);
            return { ok: true, messageId: created.at(-1)! };
          },
          postDaily: async () => {
            throw new Error("connection reset by peer");
          },
          messageUrl: (m) => `https://discord.com/channels/g/c/${m}`,
        }),
      );
    });

    await stub.apply(
      [{ kind: "upsertRequest",
         pr: { owner: "paranext", repo: "paranext-core", number: 177 },
         at: T0 - 86_400_000,
         fields: { team: "Power", urgency: "blocking", prdThreadId: null, note: "blocks the cut", requesterId: "u0", requesterName: "Jolie", channelId: "chan", messageId: "msg" },
         title: "PT-4398", prAuthorLogin: "jolie", isDraft: false }],
      { now: T0, rerender: false },
    );
    // digestMessageId stays null: this is the first live tick, so the tick
    // creates the digest and then the daily post rejects.
    await stub.apply([{ kind: "setMeta", patch: { lastSync: T0, lastDailyPostDate: null } }], { now: T0, rerender: false });

    await stub.beginTick(T0);
    // Called on the instance rather than through the stub: an RPC whose promise
    // rejects is ALSO reported by the runtime as an uncaught exception inside the
    // object, which vitest counts as an unhandled error and fails the run on.
    // The behaviour under test is the same either way.
    await runInDurableObject(stub, async (instance: unknown) => {
      const object = instance as unknown as { finishTick: (i: FinishTickInput) => Promise<unknown> };
      await expect(object.finishTick({ commands: [], leaseHeldSince: T0, now: T0 + 10_000 })).rejects.toThrow(/connection reset/);
    });

    expect(created).toEqual(["digest-1"]);
    expect((await stub.readState()).meta.digestMessageId).toBe("digest-1");
  });

  it("loads state written without a schemaVersion and returns it at the current version (R53.3)", async () => {
    // What a deploy from before `schemaVersion` existed would have left under the
    // one "state" key. The `meta` object is hand-written rather than spread from
    // `emptyState().meta`, so this fixture keeps describing the OLD shape even
    // after the current one moves on — a fixture derived from today's shape would
    // silently start testing today's shape against itself.
    const id = env.RECORDS.idFromName("test-schema-migration");
    const stub = env.RECORDS.get(id);

    const record = newScannedRecord({
      pr: { owner: "paranext", repo: "paranext-core", number: 177 },
      channelId: "chan",
      messageId: "msg",
      messageTimestamp: T0 - 86_400_000,
      title: "PT-4398",
      prAuthorLogin: "jolie",
      isDraft: false,
    });

    await runInDurableObject(stub, async (_instance: unknown, doState: DurableObjectState) => {
      await doState.storage.put("state", {
        records: { [recordId(record)]: record },
        meta: {
          lastSync: T0,
          digestMessageId: "digest-1",
          digestBodyHash: "cafef00d",
          unpinnedReportedAt: null,
          lastDailyPostDate: "2026-08-31",
          scanCursors: { chan: "500" },
          scanBackfill: { chan: "400" },
          syncLease: null,
        },
      });
    });

    const loaded = await stub.readState();
    // Comes back AT the current version...
    expect(loaded.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    // ...and loads correctly: every field the older deploy wrote survives. A
    // migration that rebuilt state from defaults instead of upgrading it would
    // pass the version assertion above and fail every one of these.
    expect(Object.keys(loaded.records)).toEqual([recordId(record)]);
    expect(loaded.meta.digestMessageId).toBe("digest-1");
    expect(loaded.meta.digestBodyHash).toBe("cafef00d");
    expect(loaded.meta.lastSync).toBe(T0);
    expect(loaded.meta.lastDailyPostDate).toBe("2026-08-31");
    expect(loaded.meta.scanCursors).toEqual({ chan: "500" });
    expect(loaded.meta.scanBackfill).toEqual({ chan: "400" });
    // ...and the fields later versions added arrive initialised, not undefined.
    // The fixture above has no `digestBodyVersion` — version 1 did not have one
    // — so this is the 1 → 2 step doing its job. An `undefined` here would make
    // the digest compare-and-set compare undefined to undefined and pass
    // spuriously on the very first tick after a load.
    expect(loaded.meta.digestBodyVersion).toBe(0);

    // And the migrated version is what gets WRITTEN BACK, so the next load has
    // nothing left to migrate. A hook that only decorated the value it returned
    // would satisfy every assertion above and leave storage unversioned forever.
    await stub.apply([{ kind: "setMeta", patch: { lastSync: T0 + 1 } }], { now: T0 + 1, rerender: false });
    const persisted = await runInDurableObject(stub, (_instance: unknown, doState: DurableObjectState) =>
      doState.storage.get<StoreState>("state"),
    );
    expect(persisted?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("refuses state from a NEWER schema version rather than silently rewriting it", async () => {
    // A Cloudflare rollback is one click and is the standard response to a bad
    // release. Version N+1 ships, runs for an hour, writes a shape this build
    // cannot parse, and is rolled back. Without a guard, `schemaVersion ?? 1`
    // yields N+1, no migration step matches, the unknown shape is handed to every
    // caller as if it were current, and the first `save()` writes it back — still
    // labelled N+1, with whatever this build put on top. No error, no log line,
    // and the roll-forward that would have fixed everything now has corrupted
    // state to fix instead. Failing closed lets cron retry in five minutes with
    // the state intact.
    const id = env.RECORDS.idFromName("test-schema-newer");
    const stub = env.RECORDS.get(id);

    const fromTheFuture = {
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      records: {},
      // Deliberately a shape this build does NOT understand: the point is that
      // it is never inspected, only refused.
      meta: { somethingThisBuildHasNeverHeardOf: true },
    };
    await runInDurableObject(stub, async (_instance: unknown, doState: DurableObjectState) => {
      await doState.storage.put("state", fromTheFuture);
    });

    // Called on the instance, not through the stub: an RPC whose promise rejects
    // is also surfaced as an uncaught exception inside the object, which vitest
    // counts as an unhandled error.
    await runInDurableObject(stub, async (instance: unknown) => {
      const object = instance as unknown as Store;
      await expect(object.readState()).rejects.toThrow(/newer than this build/);
    });

    // And the refusal left the newer state exactly as it was, which is the whole
    // point — a throw that had already written something would be worse than the
    // silent path it replaces.
    const untouched = await runInDurableObject(stub, (_instance: unknown, doState: DurableObjectState) =>
      doState.storage.get<Record<string, unknown>>("state"),
    );
    expect(untouched).toEqual(fromTheFuture);
  });
});
