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

const ID = "eten-tech-foundation/scripture-editors/1";

/** Wraps `seeded` + `MemoryStore` with a throwaway publisher, for step-8 tests
 *  that only care about the reaction path and never assert on posted digests. */
function memoryStoreWith(records: PrRecord[]): MemoryStore {
  const { publisher } = makePublisher();
  return new MemoryStore(config, publisher, seeded(records));
}

/** A `DiscordRest` stub extended with a record of DM sends, so step-8 DM tests
 *  can assert on who was messaged and what the message said without
 *  duplicating the underlying `DiscordRest` shape. */
type RestWithDms = DiscordRest & {
  dmCalls: { userId: string; content: string }[];
  /** Every `createDmChannel` ATTEMPT, delivered or not. `dmCalls` records only
   *  what was delivered, and the Create-DM abuse ceiling counts attempts. */
  openCalls: string[];
  /** "403" answers `createDmChannel` with a rejected-DM-settings response
   *  (logged, never retried); "reject" makes the fetch itself throw, to prove
   *  the DM loop's own guard swallows it without losing the tick's report.
   *  "post-fail" opens the channel fine but answers `postContent` with a
   *  non-2xx `RestResult`, to prove a failed delivery is checked (not just a
   *  rejected fetch) and does not count toward the 2-per-tick cap. Applies to
   *  every DM unless the SAME userId has its own entry in `failDmsFor`. */
  failDms?: "403" | "reject" | "post-fail";
  /** Per-recipient override of `failDms`, for tests where only ONE of several
   *  superseded reactors in the same tick fails — e.g. proving that a later
   *  DM's rejection does not erase the subrequest count for an earlier,
   *  successful one. */
  failDmsFor?: Record<string, "403" | "reject" | "post-fail">;
};

/** A real DiscordRest with `getReactions` overridden, keyed by messageId — the
 *  other routes (scan, PRD threads, GitHub) still go through the stubbed
 *  global fetch set up by `stubAll`, so callers pair this with `stubAll(...)`.
 *  Also stubs the DM route (`createDmChannel` + `postContent`) and records
 *  every successfully DELIVERED DM in `dmCalls`, keyed by the recipient's user
 *  id rather than by the opened channel id. */
function stubRestWithReactions(byMessage: Record<string, { id: string; username: string; global_name?: string | null }[]>): RestWithDms {
  const rest = new DiscordRest("tok") as RestWithDms;
  rest.getReactions = async (_channelId: string, messageId: string) =>
    ({ ok: true, value: byMessage[messageId] ?? [] });
  rest.dmCalls = [];
  rest.openCalls = [];
  const channelToUser = new Map<string, string>();
  rest.createDmChannel = async (userId: string) => {
    rest.openCalls.push(userId);
    const mode = rest.failDmsFor?.[userId] ?? rest.failDms;
    if (mode === "reject") throw new Error("DM channel open rejected");
    if (mode === "403") return { ok: false, status: 403, body: "{}" };
    const channelId = `dm-${userId}`;
    channelToUser.set(channelId, userId);
    return { ok: true, value: { id: channelId } };
  };
  rest.postContent = async (channelId: string, content: string) => {
    const userId = channelToUser.get(channelId) ?? channelId;
    const mode = rest.failDmsFor?.[userId] ?? rest.failDms;
    if (mode === "post-fail") return { ok: false, status: 500, body: "{}" };
    rest.dmCalls.push({ userId, content });
    return { ok: true, value: { id: "posted-dm", content: "", timestamp: "", author: { id: "bot", username: "bot" } } };
  };
  return rest;
}

/** A real DiscordRest whose `getReactions` fails the same way for every call —
 *  the emoji is one hardcoded snowflake, so a failure hits every eligible
 *  record in the same tick. */
function stubRestFailingReactions(opts: { status: number; body: unknown }): DiscordRest {
  const rest = new DiscordRest("tok");
  rest.getReactions = async () => ({ ok: false, status: opts.status, body: JSON.stringify(opts.body) });
  return rest;
}

/** A real DiscordRest whose `getReactions` rejects outright, for proving step
 *  8 is fully guarded and never takes the render down with it. */
function stubRestThrowingReactions(): DiscordRest {
  const rest = new DiscordRest("tok");
  rest.getReactions = async () => { throw new Error("reactions fetch rejected"); };
  return rest;
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
    // (step 7) + 10 reaction reads (step 8, capped by `reactionReadsPerTick`,
    // since all 40 records are open, unclaimed, and eligible) + 1 finishTick.
    expect(report.subrequests).toBe(17);
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
    // 2 PRD thread reads (step 7) + 1 reaction read (step 8: the one record is
    // open, unclaimed and eligible) + 1 lease-releasing apply = 7. Undercounting
    // would report 6.
    stubAll({ graphql: { data: { p0: { pullRequest: { number: 1, title: "PT-1", isDraft: false, merged: false, state: "OPEN", author: { login: "jolie" }, reviews: { nodes: [] } } } } } });
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([record(1)]));

    const report = await runTick(deps(store, { readOnly: true }));
    expect(report.subrequests).toBe(7);
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

describe("refresh loop step 8 — reaction reads", () => {
  it("polls eligible records and claims for a newly present reactor", async () => {
    // Record is primed (lastReactors: []), so the reaction is newly present.
    stubAll({});
    const store = memoryStoreWith([record(1, { messageId: "msg-1", lastReactors: [] })]);
    const rest = stubRestWithReactions({ "msg-1": [{ id: "u1", username: "katherine", global_name: "Katherine" }] });

    const report = await runTick(deps(store, { rest }));

    expect(report.reactionsRead).toBe(1);
    expect(report.reactionClaims).toBe(1);
    const state = await store.readState();
    expect(state.records[ID]!.claimedBy).toBe("u1");
    expect(state.records[ID]!.claimSource).toBe("reaction");
  });

  it("sums the counters across every polled record, not just the first", async () => {
    // resultCounters uses results.find() for the existing count commands; there is
    // exactly one of each of those per tick and up to `allowance` reactionSyncs,
    // so reusing that shape would report at most one claim.
    stubAll({});
    const store = memoryStoreWith([
      record(1, { messageId: "msg-1", lastReactors: [] }),
      record(2, { messageId: "msg-2", lastReactors: [] }),
    ]);
    const rest = stubRestWithReactions({
      "msg-1": [{ id: "u1", username: "katherine" }],
      "msg-2": [{ id: "u2", username: "ira" }],
    });

    const report = await runTick(deps(store, { rest }));

    expect(report.reactionsRead).toBe(2);
    expect(report.reactionClaims).toBe(2);
  });

  it("reports the eligible count untruncated and the budget it surrendered", async () => {
    stubAll({});
    const many = Array.from({ length: 14 }, (_, i) =>
      record(i + 1, { messageId: `msg-${i + 1}`, lastReactors: [] }));
    const store = memoryStoreWith(many);

    const report = await runTick(deps(store, { rest: stubRestWithReactions({}) }));

    expect(report.reactionsEligible).toBe(14);
    expect(report.reactionsRead).toBe(config.budgets.reactionReadsPerTick);
    // Nothing was shed: this is ordinary round-robin rotation, which is why
    // `reactionsBudgetShed` is the budget surrendered and NOT eligible-minus-read.
    expect(report.reactionsBudgetShed).toBe(0);
  });

  it("nulls messageId on 10008 and leaves everything alone on 10014", async () => {
    stubAll({});
    const store = memoryStoreWith([record(1, { lastReactors: [] })]);
    const report = await runTick(deps(store, { rest: stubRestFailingReactions({ status: 404, body: { code: 10008 } }) }));
    expect((await store.readState()).records[ID]!.messageId).toBeNull();
    expect(report.reactionClaims).toBe(0);

    const store2 = memoryStoreWith([record(1, { lastReactors: [] })]);
    await runTick(deps(store2, { rest: stubRestFailingReactions({ status: 400, body: { code: 10014 } }) }));
    // The emoji failing must change NO state: it fails on every record at once.
    expect((await store2.readState()).records[ID]!.messageId).toBe("m-1");
  });

  it("stamps reactionCheckedAt on a plain failure so the record rotates to the back", async () => {
    stubAll({});
    const store = memoryStoreWith([record(1, { lastReactors: [] })]);
    await runTick(deps(store, { rest: stubRestFailingReactions({ status: 403, body: { code: 50001 } }) }));
    // Retrying a systematic 4xx every tick is what the abuse ceiling punishes.
    expect((await store.readState()).records[ID]!.reactionCheckedAt).toBe(T0);
  });

  it("counts the subrequest a thrown read already issued", async () => {
    // `subrequests += read.requests` used to run only after `readReactors`
    // resolved, so a rejecting fetch left 1-2 issued-but-uncounted requests and
    // the tick under-reported its spend against a 50-subrequest ceiling. This is
    // the defect already fixed for the DM path in 36a496f. Asserted
    // differentially: a thrown read must cost the tick exactly what a
    // successful one costs, because both issue the same request.
    stubAll({});
    const succeeded = await runTick(deps(memoryStoreWith([heldByReaction(1, "u9", "Ira")]), {
      rest: stubRestWithReactions({ "msg-1": [{ id: "u9", username: "ira" }] }),
    }));
    stubAll({});
    const threw = await runTick(deps(memoryStoreWith([heldByReaction(1, "u9", "Ira")]), {
      rest: stubRestThrowingReactions(),
    }));

    expect(threw.subrequests).toBe(succeeded.subrequests);
  });

  it("treats a FULL reactor page as a failed read and leaves the claim alone", async () => {
    // 25 reactors is a truncated page, and the holder can sort outside it.
    // Releasing on that hands an active review to whoever happens to be inside
    // the first page.
    stubAll({});
    const store = memoryStoreWith([heldByReaction(1, "u9", "Ira")]);
    const rest = stubRestWithReactions({
      "msg-1": Array.from({ length: 25 }, (_, i) => ({ id: `u${i}`, username: `user${i}` })),
    });

    await runTick(deps(store, { rest }));

    const held = (await store.readState()).records[ID]!;
    expect(held.claimedBy).toBe("u9");
    // A failed read is not an observation: the diff basis must survive it.
    expect(held.lastReactors).toEqual(["u9"]);
    expect(held.reactionCheckedAt).not.toBeNull();
  });

  it("still renders the digest when the reaction read throws", async () => {
    stubAll({});
    const store = memoryStoreWith([record(1, { lastReactors: [] })]);
    const rest = stubRestThrowingReactions();
    const report = await runTick(deps(store, { rest }));
    expect(report.digest).not.toBeNull();
    expect(report.reactionsRead).toBe(0);
  });
});

describe("refresh loop step 8 — the allowance is a subrequest BUDGET, not a record count (Finding 3)", () => {
  /** Inflates `spent` (the running subrequest count going into step 8) by
   *  forcing many GraphQL chunks — `fetchSnapshots` spends one subrequest per
   *  25-record chunk, and this is the honest way to make step 8's allowance
   *  shrink: a fixture pretending `spent` is high some other way would not be
   *  exercising the real code path the finding is about. */
  function manyOpenRecords(n: number): PrRecord[] {
    return Array.from({ length: n }, (_, i) => record(i + 1, { lastReactors: [] }));
  }

  it("sheds allowance when the subrequest count is already high, and the tick stays under the ceiling", async () => {
    stubAll({ graphql: { data: {} } });
    // 900 records -> ceil(900/25) = 36 GraphQL chunks. Before step 8: 1
    // (beginTick) + 36 (GraphQL) + 1 (scan, no messages) + 2 (PRD threads) =
    // 40 spent. allowance = min(10, 50 - 40 - 5) = 5, so 5 of the budget's 10
    // is shed.
    const store = memoryStoreWith(manyOpenRecords(900));

    const report = await runTick(deps(store, { rest: stubRestWithReactions({}) }));

    expect(report.reactionsBudgetShed).toBeGreaterThan(0);
    expect(report.reactionsRead).toBeLessThan(config.budgets.reactionReadsPerTick);
    expect(report.subrequests).toBeLessThan(50);
  });

  it("skips step 8 entirely when the allowance is zero", async () => {
    stubAll({ graphql: { data: {} } });
    // 1050 records -> ceil(1050/25) = 42 chunks -> 46 spent before step 8.
    // allowance = min(10, 50 - 46 - 5) = min(10, -1) clamped to 0.
    const store = memoryStoreWith(manyOpenRecords(1050));

    const report = await runTick(deps(store, { rest: stubRestWithReactions({}) }));

    expect(report.reactionsBudgetShed).toBe(config.budgets.reactionReadsPerTick);
    expect(report.reactionsRead).toBe(0);
    const state = await store.readState();
    // No record was touched by step 8 at all: everything is still unprimed.
    for (const r of Object.values(state.records)) expect(r.reactionCheckedAt).toBeNull();
    expect(report.subrequests).toBeLessThan(50);
  });

  it("charges a burst confirmation's SECOND subrequest against the same allowance, so it cannot push a tick past its ceiling", async () => {
    // Every record here is claimed BY REACTION with its holder MISSING from
    // the normal reactor list, so every read pays for a burst confirmation —
    // 2 subrequests, not 1. Before the fix, the allowance was spent as a
    // RECORD COUNT (`eligible.slice(0, allowance)`), so all
    // `reactionReadsPerTick` records would be read regardless of real cost:
    // 10 records * 2 requests = 20, twice the budget. After the fix, a
    // remaining BUDGET is decremented by the actual cost, so at most half as
    // many records are read.
    stubAll({});
    const held = Array.from({ length: 10 }, (_, i) => heldByReaction(i + 1, "u9", "Ira"));
    const store = memoryStoreWith(held);
    // u9 (the holder) is absent from every message's reactor list, in both
    // the normal (type 0) and burst (type 1) reads `stubRestWithReactions`
    // answers identically for — so every read confirms and costs 2.
    const byMessage = Object.fromEntries(held.map((_, i) => [`msg-${i + 1}`, [{ id: "u1", username: "katherine" }]]));
    const rest = stubRestWithReactions(byMessage);

    const report = await runTick(deps(store, { rest }));

    expect(report.reactionsRead).toBeLessThanOrEqual(config.budgets.reactionReadsPerTick / 2);
    expect(report.reactionsEligible).toBe(10);
  });

  it("does not start a two-subrequest read on the last single unit of allowance", async () => {
    // 1000 records -> ceil(1000/25) = 40 GraphQL chunks -> 1 (beginTick) + 40 +
    // 1 (scan) + 2 (PRD threads) = 44 spent, so allowance = min(10, 50 - 44 - 5)
    // = 1. Every record here is claimed by reaction with its holder absent, so
    // every read costs 2. `remaining <= 0` let one of them start anyway and
    // spend `allowance + 1` — one over the ceiling on a tick that also pays for
    // finishTick and two DMs, which is exactly what RESERVE is sized to prevent.
    stubAll({ graphql: { data: {} } });
    const held = Array.from({ length: 1000 }, (_, i) => heldByReaction(i + 1, "u9", "Ira"));
    const store = memoryStoreWith(held);

    const report = await runTick(deps(store, { rest: stubRestWithReactions({}) }));

    expect(report.reactionsRead).toBe(0);
    expect(report.subrequests).toBeLessThanOrEqual(50);
  });
});

/**
 * A record already claimed BY REACTION, still reacting (`lastReactors`
 * includes the holder) — the one `superseded` shape reachable through the
 * real pipeline. A menu claim is unreachable here on purpose: `applyClaim`
 * nulls `lastReactors` on every menu claim (see its comment in
 * `src/core/claims.ts`), so the very next `reactionSync` treats the record as
 * unprimed and reports nothing — `syncReactions`'s "loses to a menu claim
 * already committed" case (`tests/store/apply.test.ts`) is a store-level
 * arbitration guarantee, not a reachable end-to-end scenario. A record still
 * held by reaction stays eligible (`selectReactionTargets` keeps
 * `claimSource === "reaction"` in the polling set) and a second, later
 * reactor loses to it exactly the way a menu claim would have.
 */
function heldByReaction(n: number, holderId: string, holderName: string): PrRecord {
  return record(n, {
    messageId: `msg-${n}`,
    lastReactors: [holderId],
    claimedBy: holderId,
    claimedByName: holderName,
    claimedAt: T0,
    claimSource: "reaction",
  });
}

describe("refresh loop step 8 — the private notice to a superseded reactor", () => {
  it("DMs a reactor whose claim lost, naming the PR and the holder", async () => {
    stubAll({});
    const held = heldByReaction(1, "u9", "Ira");
    const store = memoryStoreWith([held]);
    // u9 (the holder) is still reacting, so this sync sees only u1 as an arrival.
    const rest = stubRestWithReactions({
      "msg-1": [{ id: "u9", username: "ira" }, { id: "u1", username: "katherine", global_name: "Katherine" }],
    });

    await runTick(deps(store, { rest }));

    expect(rest.dmCalls).toEqual([
      { userId: "u1", content: expect.stringContaining(ID) },
    ]);
    expect(rest.dmCalls[0]!.content).toContain("Ira");
  });

  it("sends no DM when the reaction claim succeeded", async () => {
    stubAll({});
    const store = memoryStoreWith([record(1, { messageId: "msg-1", lastReactors: [] })]);
    const rest = stubRestWithReactions({ "msg-1": [{ id: "u1", username: "katherine" }] });
    await runTick(deps(store, { rest }));
    expect(rest.dmCalls).toEqual([]);
  });

  it("counts DM subrequests into the report", async () => {
    stubAll({});
    // Identical ticks apart from whether u1's reaction lands a fresh claim or
    // loses to an existing one: the same reaction is read either way, so the
    // whole difference in subrequests is the DM.
    const withoutDm = await runTick(deps(
      memoryStoreWith([record(1, { messageId: "msg-1", lastReactors: [] })]),
      { rest: stubRestWithReactions({ "msg-1": [{ id: "u1", username: "katherine" }] }) },
    ));
    const withDm = await runTick(deps(
      memoryStoreWith([heldByReaction(1, "u9", "Ira")]),
      { rest: stubRestWithReactions({ "msg-1": [{ id: "u9", username: "ira" }, { id: "u1", username: "katherine" }] }) },
    ));
    // Open the channel, then post: two per DM, and they are outbound worker
    // fetches that charge against the same 50.
    expect(withDm.subrequests).toBe(withoutDm.subrequests + 2);
  });

  it("does not fail the tick when the DM is rejected", async () => {
    stubAll({});
    const store = memoryStoreWith([heldByReaction(1, "u9", "Ira")]);
    const rest = stubRestWithReactions({
      "msg-1": [{ id: "u9", username: "ira" }, { id: "u1", username: "katherine" }],
    });
    rest.failDms = "reject"; // throws, rather than returning a 403

    // The loop runs AFTER finishTick, which is after leaseReleased = true, so
    // runTick's `finally` does nothing for it: unguarded, this would throw out of
    // a tick whose work is fully committed and whose digest is already patched,
    // losing the whole report.
    const report = await runTick(deps(store, { rest }));
    expect(report.digest).not.toBeNull();
  });

  it("logs a 403 without retrying and sends no DM", async () => {
    stubAll({});
    const store = memoryStoreWith([heldByReaction(1, "u9", "Ira")]);
    const rest = stubRestWithReactions({
      "msg-1": [{ id: "u9", username: "ira" }, { id: "u1", username: "katherine" }],
    });
    rest.failDms = "403";

    const report = await runTick(deps(store, { rest }));
    expect(report.digest).not.toBeNull();
    expect(rest.dmCalls).toEqual([]);
  });

  it("counts the first DM's subrequests even when a later one in the same tick rejects", async () => {
    stubAll({});
    const reactors = {
      "msg-1": [{ id: "u9", username: "ira" }, { id: "u1", username: "katherine" }],
      "msg-2": [{ id: "u9", username: "ira" }, { id: "u2", username: "kalinda" }],
    };
    // Same eligible set and same reads either way — an unclaimed-and-claimed
    // baseline isolates exactly the DM subrequests, the same trick the
    // "counts DM subrequests into the report" test above uses.
    const baseline = await runTick(deps(
      memoryStoreWith([
        record(1, { messageId: "msg-1", lastReactors: [] }),
        record(2, { messageId: "msg-2", lastReactors: [] }),
      ]),
      { rest: stubRestWithReactions({ "msg-1": [{ id: "u1", username: "katherine" }], "msg-2": [{ id: "u2", username: "kalinda" }] }) },
    ));

    const store = memoryStoreWith([heldByReaction(1, "u9", "Ira"), heldByReaction(2, "u9", "Ira")]);
    const rest = stubRestWithReactions(reactors);
    rest.failDmsFor = { u2: "reject" }; // u1 processes first and fully succeeds; u2's channel-open then throws.

    const report = await runTick(deps(store, { rest }));

    // u1's DM (open + post, 2 subrequests) went out before u2's channel-open
    // rejected. A mid-loop throw must not discard u1's count along with it.
    expect(report.subrequests).toBe(baseline.subrequests + 2);
    expect(rest.dmCalls).toEqual([{ userId: "u1", content: expect.stringContaining(ID) }]);
    // The tick itself must survive: this is the same guard as "does not fail
    // the tick when the DM is rejected", just with a successful DM ahead of it.
    expect(report.digest).not.toBeNull();
  });

  it("charges a failed post against the reserve it actually spent", async () => {
    stubAll({});
    // Three records so the accounting is observable: u1's failed post still
    // cost two subrequests (open + post), which is half the four step 8
    // reserves for this loop, so exactly one more recipient fits.
    const store = memoryStoreWith([
      heldByReaction(1, "u9", "Ira"),
      heldByReaction(2, "u9", "Ira"),
      heldByReaction(3, "u9", "Ira"),
    ]);
    const rest = stubRestWithReactions({
      "msg-1": [{ id: "u9", username: "ira" }, { id: "u1", username: "katherine" }],
      "msg-2": [{ id: "u9", username: "ira" }, { id: "u2", username: "kalinda" }],
      "msg-3": [{ id: "u9", username: "ira" }, { id: "u3", username: "morgan" }],
    });
    // The channel opens fine for u1; only the post itself (a checked
    // `RestResult`, not a thrown fetch) fails.
    rest.failDmsFor = { u1: "post-fail" };

    const report = await runTick(deps(store, { rest }));

    // u1's failed post is not delivered, but the two subrequests it spent are
    // gone. u2 fits in what is left; u3 does not, and is logged instead.
    expect(rest.dmCalls.map((c) => c.userId)).toEqual(["u2"]);
    expect(rest.openCalls).toEqual(["u1", "u2"]);
    expect(report.digest).not.toBeNull();
  });

  it("bounds Create-DM calls when every recipient has DMs disabled", async () => {
    // The cap used to count DMs DELIVERED, and a 403 never increments that — so
    // a tick where nobody accepts DMs issued one Create-DM call per loser with
    // no bound at all, blew through the four subrequests step 8 reserved, and
    // hammered the same blocked recipients again every five minutes. That is
    // precisely the abuse ceiling this path exists to stay under.
    stubAll({});
    const store = memoryStoreWith([
      heldByReaction(1, "u9", "Ira"),
      heldByReaction(2, "u9", "Ira"),
      heldByReaction(3, "u9", "Ira"),
      heldByReaction(4, "u9", "Ira"),
      heldByReaction(5, "u9", "Ira"),
    ]);
    const rest = stubRestWithReactions({
      "msg-1": [{ id: "u9", username: "ira" }, { id: "u1", username: "katherine" }],
      "msg-2": [{ id: "u9", username: "ira" }, { id: "u2", username: "kalinda" }],
      "msg-3": [{ id: "u9", username: "ira" }, { id: "u3", username: "morgan" }],
      "msg-4": [{ id: "u9", username: "ira" }, { id: "u4", username: "alicia" }],
      "msg-5": [{ id: "u9", username: "ira" }, { id: "u5", username: "diane" }],
    });
    rest.failDms = "403";

    const report = await runTick(deps(store, { rest }));

    expect(rest.dmCalls).toEqual([]);
    expect(rest.openCalls.length).toBeLessThanOrEqual(4);
    expect(report.subrequests).toBeLessThanOrEqual(50);
  });

  it("caps at two DMs per tick and logs the third rather than sending it", async () => {
    stubAll({});
    const store = memoryStoreWith([
      heldByReaction(1, "u9", "Ira"),
      heldByReaction(2, "u9", "Ira"),
      heldByReaction(3, "u9", "Ira"),
    ]);
    const rest = stubRestWithReactions({
      "msg-1": [{ id: "u9", username: "ira" }, { id: "u1", username: "katherine" }],
      "msg-2": [{ id: "u9", username: "ira" }, { id: "u2", username: "kalinda" }],
      "msg-3": [{ id: "u9", username: "ira" }, { id: "u3", username: "morgan" }],
    });

    await runTick(deps(store, { rest }));

    expect(rest.dmCalls).toHaveLength(2);
  });

  it("sends no DMs in read-only mode", async () => {
    stubAll({});
    const store = memoryStoreWith([heldByReaction(1, "u9", "Ira")]);
    const rest = stubRestWithReactions({
      "msg-1": [{ id: "u9", username: "ira" }, { id: "u1", username: "katherine" }],
    });
    await runTick(deps(store, { rest, readOnly: true }));
    expect(rest.dmCalls).toEqual([]);
  });
});
