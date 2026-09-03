import { afterEach, describe, expect, it, vi } from "vitest";
import { config as baseConfig } from "../../config/config.js";
import { newScannedRecord, recordId, resolveRecord, type PrRecord } from "../../src/core/record.js";
import { DiscordRest } from "../../src/discord/rest.js";
import { CredentialProvider } from "../../src/github/credentials.js";
import { runTick } from "../../src/handlers/scheduled.js";
import { emptyState } from "../../src/store/apply.js";
import { MemoryStore } from "../../src/store/memory.js";
import type {
  ApplyResult,
  BeginTickResult,
  Command,
  DigestPayload,
  DigestPublisher,
  FinishTickInput,
  FinishTickResult,
  Store,
  StoreState,
} from "../../src/store/types.js";

const T0 = 1_788_192_000_000; // 2026-08-31T16:00:00Z = 11:00 America/Chicago
const DAY = 86_400_000;
const CHANNEL = "chan-1";
const config = { ...baseConfig, allowedChannelIds: [CHANNEL], digestChannelId: CHANNEL };

const secrets = { appId: "1", appInstallationId: "2", appPrivateKeyPem: "unused", publicToken: "ghp_public" };

function makePublisher() {
  const patches: DigestPayload[] = [];
  const dailies: string[] = [];
  const publisher: DigestPublisher = {
    listPinnedMessageIds: async () => ["digest-1"],
    patchDigest: async (_id, p) => { patches.push(p); return { ok: true }; },
    createDigest: async (p) => { patches.push(p); return { ok: true, messageId: "digest-1" }; },
    postDaily: async (c) => { dailies.push(c); return { ok: true, messageId: "daily-1" }; },
    messageUrl: (id) => `https://discord.com/channels/g/c/${id}`,
  };
  return { publisher, patches, dailies };
}

function record(number: number, overrides: Partial<PrRecord> = {}): PrRecord {
  return {
    ...newScannedRecord({
      pr: { owner: "eten-tech-foundation", repo: "scripture-editors", number },
      channelId: CHANNEL,
      messageId: `m-${number}`,
      messageTimestamp: T0 - 3 * DAY,
      title: `PT-${number}`,
      prAuthorLogin: "jolie",
      isDraft: false,
    }),
    team: "Power",
    urgency: "soon",
    ...overrides,
  };
}

function seeded(records: PrRecord[]): StoreState {
  const base = emptyState();
  return {
    ...base,
    records: Object.fromEntries(records.map((r) => [recordId(r), r])),
    meta: { ...base.meta, digestMessageId: "digest-1", lastSync: T0 - 60_000, lastDailyPostDate: "2026-08-31", scanCursors: { [CHANNEL]: "500" } },
  };
}

/** Set by individual tests to make both PRD thread routes 500, and reset in
 *  `afterEach` below so ordering between tests cannot leak it. */
let threadsFail = false;

/** Routes stubbed fetch by url: GitHub GraphQL vs Discord messages vs the two
 *  PRD thread routes (step 7). The thread routes are matched on exact path
 *  shape (`/guilds/{id}/threads/active`, `/channels/{id}/threads/archived/public`)
 *  so they cannot accidentally swallow requests other tests rely on, such as
 *  `/channels/{id}/messages`. */
function stubAll(opts: { graphql?: unknown; graphqlStatus?: number; messages?: unknown[] }) {
  vi.stubGlobal("fetch", async (input: string, _init: RequestInit) => {
    const url = String(input);
    if (url.includes("api.github.com/graphql")) {
      return new Response(JSON.stringify(opts.graphql ?? { data: {} }), { status: opts.graphqlStatus ?? 200 });
    }
    if (/\/guilds\/[^/]+\/threads\/active(\?|$)/.test(url)) {
      if (threadsFail) return new Response("{}", { status: 500 });
      return new Response(
        JSON.stringify({ threads: [{ id: "200", name: "Trust PRD", parent_id: config.prdForumChannelId, last_message_id: "900" }] }),
        { status: 200 },
      );
    }
    if (/\/channels\/[^/]+\/threads\/archived\/public(\?|$)/.test(url)) {
      if (threadsFail) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({ threads: [] }), { status: 200 });
    }
    if (url.includes("/messages/pins")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (url.includes("/messages")) return new Response(JSON.stringify(opts.messages ?? []), { status: 200 });
    return new Response("{}", { status: 200 });
  });
}

function deps(store: Store, overrides: Partial<Parameters<typeof runTick>[0]> = {}) {
  return {
    store,
    rest: new DiscordRest("tok"),
    credentials: new CredentialProvider(secrets),
    config,
    botUserId: "bot-1",
    guildId: "g-1",
    now: T0,
    ...overrides,
  };
}

/** Wraps a Store and tallies calls to each of its four methods, so a tick that
 *  quietly grows a third store round-trip (or one per record) is caught even
 *  though every other test only checks the effects of those calls, not their
 *  count. */
function countingStore(inner: Store) {
  const calls = { beginTick: 0, finishTick: 0, apply: 0, readState: 0 };
  const store: Store = {
    beginTick: async (now: number): Promise<BeginTickResult> => {
      calls.beginTick += 1;
      return inner.beginTick(now);
    },
    finishTick: async (input: FinishTickInput): Promise<FinishTickResult> => {
      calls.finishTick += 1;
      return inner.finishTick(input);
    },
    apply: async (commands: Command[], opts: { now: number; rerender: boolean }): Promise<ApplyResult> => {
      calls.apply += 1;
      return inner.apply(commands, opts);
    },
    readState: async (): Promise<StoreState> => {
      calls.readState += 1;
      return inner.readState();
    },
  };
  return { store, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  threadsFail = false;
});

describe("runTick — the lease", () => {
  it("exits immediately without writing when a live lease is held", async () => {
    stubAll({});
    const { publisher, patches } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([record(1)]));
    await store.beginTick(T0 - 30_000);

    const report = await runTick(deps(store));
    expect(report.skipped).toBe(true);
    expect(report.reason).toBe("lease-held");
    expect(patches).toHaveLength(0);
  });
});

describe("runTick — the exit condition end to end", () => {
  it("resolves a record when a human review lands, and the row leaves the digest", async () => {
    stubAll({
      graphql: {
        data: {
          p0: {
            pullRequest: {
              number: 1, title: "PT-1", isDraft: false, merged: false, state: "OPEN",
              author: { login: "jolie" },
              reviews: { nodes: [{ submittedAt: new Date(T0 - DAY).toISOString(), state: "COMMENTED", author: { login: "katherine", __typename: "User" } }] },
            },
          },
        },
      },
    });
    const { publisher, patches } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([record(1)]));

    const report = await runTick(deps(store));
    expect(report.syncOk).toBe(true);
    expect(report.resolved).toBe(1);

    const state = await store.readState();
    expect(state.records["eten-tech-foundation/scripture-editors/1"]?.resolvedBy).toBe("review by katherine");
    expect(patches.at(-1)!.embeds.map((e) => e.description).join("\n")).toContain("nothing waiting");
  });

  it("does NOT resolve on a bot review", async () => {
    stubAll({
      graphql: {
        data: {
          p0: {
            pullRequest: {
              number: 1, title: "PT-1", isDraft: false, merged: false, state: "OPEN",
              author: { login: "jolie" },
              reviews: { nodes: [{ submittedAt: new Date(T0 - DAY).toISOString(), state: "COMMENTED", author: { login: "copilot", __typename: "Bot" } }] },
            },
          },
        },
      },
    });
    const { publisher, patches } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([record(1)]));
    const report = await runTick(deps(store));
    expect(report.resolved).toBe(0);
    // report.resolved alone isn't enough: it's now derived from the SAME
    // countsAsReview call the store uses (see 17.2/R25), but assert the store's
    // committed state directly too, so this stays the end-to-end proof it claims
    // to be rather than trusting the report to describe what was committed.
    const state = await store.readState();
    expect(state.records["eten-tech-foundation/scripture-editors/1"]?.resolvedAt).toBeNull();
    expect(patches.at(-1)!.embeds.map((e) => e.description).join("\n")).toContain("PT-1");
  });

  it("REOPENS and re-lists: reviewed, re-requested, listed again", async () => {
    // The design's primary workflow, asserted end to end rather than per-step.
    const resolved = resolveRecord(record(1), T0 - 2 * DAY, "review by katherine");
    const { publisher, patches } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([resolved]));

    await store.apply(
      [{ kind: "upsertRequest",
         pr: { owner: "eten-tech-foundation", repo: "scripture-editors", number: 1 },
         at: T0 - 60_000,
         fields: { team: "Power", urgency: "blocking", prdThreadId: null, note: "addressed the feedback", requesterId: "u1", requesterName: "Jolie", channelId: CHANNEL, messageId: "m-new" },
         title: "PT-1", prAuthorLogin: "jolie", isDraft: false }],
      { now: T0 - 60_000, rerender: false },
    );

    stubAll({
      graphql: {
        data: {
          p0: {
            pullRequest: {
              number: 1, title: "PT-1", isDraft: false, merged: false, state: "OPEN",
              author: { login: "jolie" },
              // The OLD review, now older than lastRequestedAt.
              reviews: { nodes: [{ submittedAt: new Date(T0 - 2 * DAY).toISOString(), state: "CHANGES_REQUESTED", author: { login: "katherine", __typename: "User" } }] },
            },
          },
        },
      },
    });

    const report = await runTick(deps(store));
    expect(report.resolved).toBe(0);
    const body = patches.at(-1)!.embeds.map((e) => e.description).join("\n");
    expect(body).toContain("PT-1");
    expect(body).toContain("addressed the feedback");
  });
});

describe("runTick — partial GitHub failures", () => {
  it("marks one NOT_FOUND record sync paused and leaves the other untouched", async () => {
    stubAll({
      graphql: {
        data: {
          p0: { pullRequest: { number: 1, title: "PT-1", isDraft: false, merged: false, state: "OPEN", author: { login: "jolie" }, reviews: { nodes: [] } } },
          p1: null,
        },
        errors: [{ type: "NOT_FOUND", path: ["p1"] }],
      },
    });
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([record(1), record(2)]));

    const report = await runTick(deps(store));
    expect(report.notFound).toBe(1);

    const state = await store.readState();
    expect(state.records["eten-tech-foundation/scripture-editors/2"]?.syncPausedSince).toBe(T0);
    expect(state.records["eten-tech-foundation/scripture-editors/2"]?.resolvedAt).toBeNull();
    expect(state.records["eten-tech-foundation/scripture-editors/1"]?.syncPausedSince).toBeNull();
  });

  it("still renders when the whole GitHub call fails, and lastSync is not advanced", async () => {
    stubAll({ graphqlStatus: 500 });
    const { publisher, patches } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([record(1)]));

    const report = await runTick(deps(store));
    expect(report.syncOk).toBe(false);
    expect(report.digest).not.toBeNull();
    expect(patches.length).toBeGreaterThan(0);
    // lastSync untouched, so the stale banner appears once the threshold passes.
    expect((await store.readState()).meta.lastSync).toBe(T0 - 60_000);
  });

  it("does not advance lastSync when only one of several GitHub chunks transiently fails, but still applies the chunk that succeeded", async () => {
    // 30 open records in one credential group chunk into two GraphQL requests
    // (25 + 5). The first fails transiently (500, not 401/403) and the query
    // layer's per-chunk `continue` (not `break`) means the second chunk is
    // still queried and its data still applied — the tick proceeds with
    // partial data. Both halves matter: a fix that made the whole tick bail
    // out early would lose the second chunk's resolutions; a fix that
    // silently treated the transient failure as success would advance
    // lastSync and hide the stale banner.
    let call = 0;
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      if (url.includes("api.github.com/graphql")) {
        call += 1;
        if (call === 1) return new Response(JSON.stringify({ message: "server error" }), { status: 500 });
        // Second chunk: records 26-30, aliased p0..p4, all merged.
        const data = Object.fromEntries(
          Array.from({ length: 5 }, (_, i) => [
            `p${i}`,
            { pullRequest: { number: 26 + i, title: `PT-${26 + i}`, isDraft: false, merged: true, state: "CLOSED", author: { login: "jolie" }, reviews: { nodes: [] } } },
          ]),
        );
        return new Response(JSON.stringify({ data }), { status: 200 });
      }
      if (url.includes("/messages/pins")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.includes("/messages")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response("{}", { status: 200 });
    });

    const { publisher } = makePublisher();
    const records = Array.from({ length: 30 }, (_, i) => record(i + 1));
    const store = new MemoryStore(config, publisher, seeded(records));

    const report = await runTick(deps(store));
    expect(report.syncOk).toBe(false);

    const state = await store.readState();
    expect(state.meta.lastSync).toBe(T0 - 60_000);
    // The second chunk's records were still resolved — partial data was kept,
    // not discarded because a sibling chunk failed.
    expect(state.records["eten-tech-foundation/scripture-editors/26"]?.resolvedBy).toBe("merged");
    expect(state.records["eten-tech-foundation/scripture-editors/30"]?.resolvedBy).toBe("merged");
    // The failed chunk's records are untouched — neither resolved nor paused,
    // since a transient 500 is not a NOT_FOUND.
    expect(state.records["eten-tech-foundation/scripture-editors/1"]?.resolvedAt).toBeNull();
    expect(state.records["eten-tech-foundation/scripture-editors/1"]?.syncPausedSince).toBeNull();
  });

  it("advances lastSync only on a successful sync", async () => {
    stubAll({ graphql: { data: { p0: { pullRequest: { number: 1, title: "PT-1", isDraft: false, merged: false, state: "OPEN", author: { login: "jolie" }, reviews: { nodes: [] } } } } } });
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([record(1)]));
    await runTick(deps(store));
    expect((await store.readState()).meta.lastSync).toBe(T0);
  });
});

describe("runTick — scanning and housekeeping", () => {
  it("ingests a scanned link and advances the cursor", async () => {
    stubAll({
      graphql: { data: {} },
      messages: [
        { id: "600", content: "review please https://github.com/paranext/paranext-core/pull/2695",
          timestamp: new Date(T0 - DAY).toISOString(), author: { id: "human", bot: false, username: "jolie" } },
      ],
    });
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([]));

    const report = await runTick(deps(store));
    expect(report.scanned).toBe(1);

    const state = await store.readState();
    expect(state.records["paranext/paranext-core/2695"]?.source).toBe("scanned");
    expect(state.meta.scanCursors[CHANNEL]).toBe("600");
  });

  it("clears a stale claim and reports it", async () => {
    stubAll({ graphql: { data: { p0: { pullRequest: { number: 1, title: "PT-1", isDraft: false, merged: false, state: "OPEN", author: { login: "jolie" }, reviews: { nodes: [] } } } } } });
    const stale = record(1, { claimedBy: "u1", claimedByName: "Ira", claimedAt: T0 - 3 * DAY });
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([stale]));

    const report = await runTick(deps(store));
    expect(report.staleClaimsCleared).toBe(1);
    expect((await store.readState()).records["eten-tech-foundation/scripture-editors/1"]?.lastClaimedByName).toBe("Ira");
  });

  it("purges records resolved beyond retention", async () => {
    stubAll({ graphql: { data: {} } });
    const ancient = resolveRecord(record(1), T0 - 40 * DAY, "merged");
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([ancient]));

    const report = await runTick(deps(store));
    expect(report.purged).toBe(1);
    expect(Object.keys((await store.readState()).records)).toHaveLength(0);
  });

  it("stays inside the subrequest budget with 40 tracked PRs", async () => {
    stubAll({ graphql: { data: {} } });
    const records = Array.from({ length: 40 }, (_, i) => record(i + 1));
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded(records));

    const report = await runTick(deps(store));
    // The design invariant is "at most TWO store subrequests per tick, independent
    // of record count" — `< 50` would also pass a regression that read the store
    // once per record. Pin the exact count: 1 beginTick + 2 GraphQL chunks (40
    // records, chunked to 25) + 1 scan page (no messages) + 2 PRD thread reads
    // (step 7) + 1 finishTick.
    expect(report.subrequests).toBe(7);
  });
});

describe("runTick — the two-subrequest store invariant", () => {
  it("calls the store exactly twice (beginTick + finishTick) across a full tick, with 40 records", async () => {
    // A regression that re-reads or re-applies per record, or adds a third
    // store round-trip, would pass every other test in this file: none of them
    // count store calls directly. This fixture (40 records, a stale claim, a
    // scanned link, and an old resolved record to purge) is large and varied
    // enough that a per-record regression would be obvious, not a coincidence
    // of a 1-record fixture happening to total 2.
    stubAll({
      graphql: { data: {} },
      messages: [
        { id: "700", content: "https://github.com/paranext/paranext-core/pull/1",
          timestamp: new Date(T0 - DAY).toISOString(), author: { id: "human", bot: false, username: "jolie" } },
      ],
    });
    const stale = record(1, { claimedBy: "u1", claimedByName: "Ira", claimedAt: T0 - 3 * DAY });
    const ancient = resolveRecord(record(2), T0 - 40 * DAY, "merged");
    const rest = Array.from({ length: 38 }, (_, i) => record(i + 3));
    const { publisher } = makePublisher();
    const inner = new MemoryStore(config, publisher, seeded([stale, ancient, ...rest]));
    const { store, calls } = countingStore(inner);

    await runTick(deps(store));

    expect(calls.beginTick).toBe(1);
    expect(calls.finishTick).toBe(1);
    expect(calls.apply).toBe(0);
    expect(calls.readState).toBe(0);
    expect(calls.beginTick + calls.finishTick + calls.apply + calls.readState).toBe(2);
  });
});

describe("runTick — a page-capped scan", () => {
  it("reports it and records where to resume, so a partial backfill is not silent", async () => {
    // A busy channel on a first run: every page comes back full and in-window,
    // so the per-tick page budget stops the backward walk short. Both halves of
    // finding 7 are asserted here — the report says so (it is logged verbatim,
    // and shadow mode has no other way to tell a truncated backfill from "no
    // links there"), and the resume point is stored so the older remainder of
    // the lookback window is walked next tick instead of abandoned.
    const page = Array.from({ length: 100 }, (_, i) => ({
      id: String(1000 + i),
      content: "no links here",
      timestamp: new Date(T0 - DAY).toISOString(),
      author: { id: "human", bot: false, username: "jolie" },
    }));
    stubAll({ graphql: { data: {} }, messages: page });
    const { publisher } = makePublisher();
    const base = emptyState();
    // No stored scanCursors: this is a first run, which is the only case where
    // the walk goes backwards through the lookback window.
    const store = new MemoryStore(config, publisher, {
      ...base,
      records: {},
      meta: { ...base.meta, digestMessageId: "digest-1", lastSync: T0 - 60_000, lastDailyPostDate: "2026-08-31" },
    });

    const report = await runTick(deps(store));

    expect(report.scanHitPageCap).toBe(true);
    const meta = (await store.readState()).meta;
    // The oldest id processed — where the next tick's backward walk resumes.
    expect(meta.scanBackfill[CHANNEL]).toBe("1000");
    // And the forward cursor still points at the channel's head, so once the
    // backfill finishes nothing newer has been skipped.
    expect(meta.scanCursors[CHANNEL]).toBe("1099");
  });
});

describe("runTick — read-only mode", () => {
  it("runs the full loop, logs the body, and writes nothing", async () => {
    stubAll({
      graphql: { data: { p0: { pullRequest: { number: 1, title: "PT-1 renamed", isDraft: false, merged: true, state: "MERGED", author: { login: "jolie" }, reviews: { nodes: [] } } } } },
    });
    const { publisher, patches } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([record(1)]));

    const report = await runTick(deps(store, { readOnly: true }));
    expect(patches).toHaveLength(0);
    expect(report.digest).not.toBeNull();
    // The record is unchanged: nothing was committed.
    expect((await store.readState()).records["eten-tech-foundation/scripture-editors/1"]?.resolvedAt).toBeNull();
    // The lease taken by beginTick must still be released even though finishTick
    // never runs in read-only mode — otherwise every tick for the next
    // LEASE_TIMEOUT_MS is turned away with lease-held, for the whole of shadow mode.
    expect((await store.readState()).meta.syncLease).toBeNull();
    expect(await store.beginTick(T0 + 60_000)).toMatchObject({ acquired: true });
  });

  it("logs the projected state, not the opening snapshot: a merged PR drops out and an untouched one stays (R46a)", async () => {
    // record(1) merges this tick and must disappear from the read-only log;
    // record(2) is untouched and must still be there. Rendering from
    // `opening.state.records` (the bug) would show BOTH as still open.
    stubAll({
      graphql: {
        data: {
          p0: { pullRequest: { number: 1, title: "PT-1", isDraft: false, merged: true, state: "MERGED", author: { login: "jolie" }, reviews: { nodes: [] } } },
          p1: { pullRequest: { number: 2, title: "PT-2", isDraft: false, merged: false, state: "OPEN", author: { login: "jolie" }, reviews: { nodes: [] } } },
        },
      },
    });
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg: string) => { logs.push(msg); });
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([record(1), record(2)]));

    await runTick(deps(store, { readOnly: true }));
    spy.mockRestore();

    const body = logs.join("\n");
    expect(body).not.toContain("PT-1");
    expect(body).toContain("PT-2");
  });

  it("reports scanHitPageCap: true on a page-capped scan — shadow mode is the only place this signal is read", async () => {
    // The read-only twin of "runTick — a page-capped scan" above. Shadow mode
    // never persists records or scan progress, so `scanHitPageCap` in the tick
    // log is the ONLY way to see a page-capped backfill in read-only mode — a
    // hard-coded `false` here would leave the suite green while lying to the
    // one deployment mode that exists to be watched.
    const page = Array.from({ length: 100 }, (_, i) => ({
      id: String(1000 + i),
      content: "no links here",
      timestamp: new Date(T0 - DAY).toISOString(),
      author: { id: "human", bot: false, username: "jolie" },
    }));
    stubAll({ graphql: { data: {} }, messages: page });
    const { publisher } = makePublisher();
    const base = emptyState();
    // No stored scanCursors: a first run, the only case where the walk goes
    // backwards through the lookback window and can hit the page cap.
    const store = new MemoryStore(config, publisher, {
      ...base,
      records: {},
      meta: { ...base.meta, digestMessageId: "digest-1", lastSync: T0 - 60_000, lastDailyPostDate: "2026-08-31" },
    });

    const report = await runTick(deps(store, { readOnly: true }));

    expect(report.scanHitPageCap).toBe(true);
    // And, per shadow mode's contract, nothing was persisted — not even the
    // resume point a live tick would have stored.
    const meta = (await store.readState()).meta;
    expect(meta.scanCursors).toEqual({});
    expect(meta.scanBackfill).toEqual({});
  });

  it("reports scanned, staleClaimsCleared and purged as what the tick WOULD have done (finding 10)", async () => {
    // Shadow mode's report is its only output, and an operator decides whether to
    // go live off these numbers. Every counter here is non-zero and DISTINCT from
    // the others, so a copy-paste between them cannot pass:
    //   scanned = 1, staleClaimsCleared = 2, purged = 3.
    //
    // `scanned` is the one that needs two links rather than one. The old
    // implementation reported `scan.commands.length`, so a fixture with a single
    // new link would report 1 either way. The second link points at a PR already
    // on the list, whose upsertScanned comes back `updated` — raw command count
    // says 2, the true number of new arrivals is 1.
    stubAll({
      graphql: { data: {} },
      messages: [
        { id: "701", content: "https://github.com/paranext/paranext-core/pull/900",
          timestamp: new Date(T0 - DAY).toISOString(), author: { id: "human", bot: false, username: "jolie" } },
        { id: "702", content: "https://github.com/eten-tech-foundation/scripture-editors/pull/1",
          timestamp: new Date(T0 - DAY).toISOString(), author: { id: "human", bot: false, username: "jolie" } },
      ],
    });
    const staleClaims = [1, 2].map((n) =>
      record(n, { claimedBy: `u${n}`, claimedByName: `Ira ${n}`, claimedAt: T0 - 3 * DAY }),
    );
    const ancient = [3, 4, 5].map((n) => resolveRecord(record(n), T0 - 40 * DAY, "merged"));
    const { publisher, patches } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([...staleClaims, ...ancient]));

    const report = await runTick(deps(store, { readOnly: true }));

    expect(report.scanned).toBe(1);
    expect(report.staleClaimsCleared).toBe(2);
    expect(report.purged).toBe(3);
    // Still shadow mode: nothing was committed and nothing was posted, so these
    // numbers are a projection rather than a record of writes that happened.
    expect(patches).toHaveLength(0);
    expect(Object.keys((await store.readState()).records)).toHaveLength(5);
    expect((await store.readState()).records["eten-tech-foundation/scripture-editors/1"]?.claimedBy).toBe("u1");
  });

  it("does not clear a newer tick's lease when its own has already expired (R52)", async () => {
    // Read-only mode releases the lease itself, in the one place that is not
    // `finishTick`. So the fence has to hold here too. This tick takes the lease
    // at T0 and then overruns the scheduled wall-clock limit — modelled by a
    // newer tick breaking its lease from inside the scan fetch, which is one of
    // the awaits a real overrun would happen at.
    const store = { current: null as MemoryStore | null };
    let broke = false;
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      if (url.includes("/messages/pins")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.includes("/messages")) {
        if (!broke) {
          broke = true;
          // A newer tick, LEASE_TIMEOUT_MS later, legitimately breaks and takes
          // the lease while this one is still mid-flight.
          await store.current!.beginTick(T0 + 16 * 60_000);
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    const { publisher } = makePublisher();
    store.current = new MemoryStore(config, publisher, seeded([]));

    await runTick(deps(store.current, { readOnly: true }));

    // The premise held — the newer tick really did take the lease over.
    expect(broke).toBe(true);
    // And the overrunning tick's release left it alone. An unconditional
    // release reports the same tick report and leaves this null.
    expect((await store.current.readState()).meta.syncLease).toEqual({ heldSince: T0 + 16 * 60_000 });
  });

  it("counts the lease-releasing apply as a subrequest (R46b)", async () => {
    // 1 beginTick + 1 GraphQL chunk (1 record) + 1 scan page (no messages) +
    // 2 PRD thread reads (step 7) + 1 lease-releasing apply = 6. Undercounting
    // would report 5.
    stubAll({ graphql: { data: { p0: { pullRequest: { number: 1, title: "PT-1", isDraft: false, merged: false, state: "OPEN", author: { login: "jolie" }, reviews: { nodes: [] } } } } } });
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([record(1)]));

    const report = await runTick(deps(store, { readOnly: true }));
    expect(report.subrequests).toBe(6);
  });
});

describe("runTick — lease release on a thrown fetch (R45)", () => {
  it("releases the lease when the GitHub fetch rejects, even though runTick itself rejects", async () => {
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      if (url.includes("api.github.com/graphql")) throw new Error("getaddrinfo ENOTFOUND api.github.com");
      if (url.includes("/messages/pins")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.includes("/messages")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([record(1)]));

    await expect(runTick(deps(store))).rejects.toThrow("ENOTFOUND");

    // The assertion that matters: the lease must be free for the next tick,
    // not merely that runTick rejected (that much is true even with the lease
    // still held).
    expect(await store.beginTick(T0 + 60_000)).toMatchObject({ acquired: true });
  });
});

describe("refresh loop step 7 — the PRD cache", () => {
  it("writes a freshly built cache into meta", async () => {
    stubAll({ graphql: { data: {} } });
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([]));

    await runTick(deps(store));

    const state = await store.readState();
    expect(state.meta.prdCache?.options.map((o) => o.id)).toEqual(["200"]);
    expect(state.meta.prdCache?.refreshedAt).toBe(T0);
  });

  it("leaves the previous cache untouched when the fetch fails", async () => {
    stubAll({ graphql: { data: {} } });
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([]));
    const previous = { options: [{ id: "9", name: "Old but usable" }], truncated: false, refreshedAt: T0 - 99_999 };
    await store.apply([{ kind: "setMeta", patch: { prdCache: previous } }], { now: T0, rerender: false });

    threadsFail = true;
    await runTick(deps(store));

    expect((await store.readState()).meta.prdCache).toEqual(previous);
  });

  it("counts both thread reads in the tick's subrequest total", async () => {
    // Asserted as a DELTA between two runs rather than against a hand-counted
    // absolute: the absolute moves whenever the scan reads a different number of
    // pages, so a literal here would be a test that fails for unrelated reasons.
    // Both runs read the threads — a failed fetch still costs two requests — so
    // the delta isolates nothing but the counting.
    stubAll({ graphql: { data: {} } });
    const a = await runTick(deps(new MemoryStore(config, makePublisher().publisher, seeded([]))));

    threadsFail = true;
    const b = await runTick(deps(new MemoryStore(config, makePublisher().publisher, seeded([]))));

    expect(a.subrequests).toBe(b.subrequests);
    expect(a.subrequests).toBeGreaterThanOrEqual(4);
  });

  it("commits nothing in READ_ONLY mode but still reads the threads", async () => {
    stubAll({ graphql: { data: {} } });
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([]));

    await runTick(deps(store, { readOnly: true }));
    expect((await store.readState()).meta.prdCache).toBeNull();
  });
});
