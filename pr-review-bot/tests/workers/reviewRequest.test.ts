import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../config/config.js";
import type { PrSnapshot } from "../../src/core/exit.js";
import { DiscordRest } from "../../src/discord/rest.js";
import { CredentialProvider } from "../../src/github/credentials.js";
import type { FetchOutcome } from "../../src/github/query.js";
import {
  finishSubmit,
  handleModalSubmit,
  handleRetryButton,
  openRequestModal,
  type RequestDeps,
} from "../../src/handlers/reviewRequest.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { Command, DigestPayload, DigestPublisher, Store } from "../../src/store/types.js";

const NOW = 1_756_000_000_000;
const URL_OK = "https://github.com/paranext/paranext-core/pull/9";
const SLUG = "paranext/paranext-core/9";

/**
 * `fetchSnapshots` is mocked at the module boundary rather than driven through a
 * stubbed GraphQL response.
 *
 * The rejection cases this file has to reach include `failedGroups` non-empty —
 * a wholesale credential failure — which through the real function means driving
 * `CredentialProvider` into a failed-closed or throttled state from the outside.
 * That is `credentials.test.ts`'s subject, not this file's; here it would be
 * indirection that makes the test read as being about tokens when it is about
 * which rejection the submit path picks. `githubSpy` doubles as the "no network
 * before validation" probe: the order-of-operations test asserts it was never
 * called.
 */
const { githubSpy } = vi.hoisted(() => ({ githubSpy: vi.fn() }));
vi.mock("../../src/github/query.js", () => ({ fetchSnapshots: githubSpy }));

const OPEN_SNAPSHOT: PrSnapshot = {
  slug: SLUG,
  title: "Fix marker parsing",
  state: "OPEN",
  merged: false,
  isDraft: false,
  authorLogin: "jolie",
  reviews: [],
};

const secrets = { appId: "1", appInstallationId: "2", appPrivateKeyPem: "unused", publicToken: "ghp_public" };

/** What the mocked `fetchSnapshots` hands back. Tests override `snapshot` for a
 *  different PR state and `githubResult` for an outcome with no snapshot at all. */
let snapshot: PrSnapshot;
let githubResult: FetchOutcome | null;
/** Makes `postMessage` fail so the record-survives-a-failed-post path is reached. */
let postFails: boolean;

/** Bodies seen by the two Discord routes the submit path uses. `fetchSpy` is the
 *  stubbed global `fetch` itself, so the modal test can assert that opening the
 *  modal touched no network at all — not merely that it skipped GitHub. */
let posted: { content?: string }[];
let edited: { content?: string; components?: unknown[] }[];
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  snapshot = OPEN_SNAPSHOT;
  githubResult = null;
  postFails = false;
  posted = [];
  edited = [];

  githubSpy.mockReset();
  githubSpy.mockImplementation(
    async (): Promise<FetchOutcome> =>
      githubResult ?? { snapshots: new Map([[SLUG, snapshot]]), notFound: [], failedGroups: [], subrequests: 1 },
  );

  fetchSpy = vi.fn(async (input: string, init: RequestInit) => {
    const url = String(input);
    const body = init.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);

    if (/\/webhooks\/[^/]+\/[^/]+\/messages\/@original$/.test(url)) {
      edited.push(body);
      return new Response(null, { status: 204 });
    }
    if (/\/channels\/[^/]+\/messages$/.test(url)) {
      if (postFails) return new Response("forbidden", { status: 403 });
      posted.push(body);
      return new Response(JSON.stringify({ id: "posted-1", channel_id: "chan-1" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => vi.unstubAllGlobals());

function publisher(): DigestPublisher {
  const patches: DigestPayload[] = [];
  return {
    listPinnedMessageIds: async () => ["digest-1"],
    patchDigest: async (_id, p) => { patches.push(p); return { ok: true }; },
    createDigest: async (p) => { patches.push(p); return { ok: true, messageId: "digest-1" }; },
    postDaily: async () => ({ ok: true, messageId: "daily-1" }),
    messageUrl: (id) => `https://discord.com/channels/g/c/${id}`,
  };
}

/**
 * Wraps a store and records the commands each `apply` carried.
 *
 * The message-id write-back cannot be pinned by `lastRequestedAt` alone:
 * `finishSubmit` reads the clock ONCE, so a regressive second `upsertRequest`
 * would carry the same `at` as the first and leave `lastRequestedAt` equal to
 * `firstRequestedAt` exactly as the correct code does. What the two shapes
 * cannot share is the command kind, so that is what gets asserted.
 */
function recordingStore(inner: Store): { store: Store; applied: Command[][] } {
  const applied: Command[][] = [];
  return {
    store: {
      beginTick: (now) => inner.beginTick(now),
      finishTick: (input) => inner.finishTick(input),
      apply: (commands, opts) => {
        applied.push(commands);
        return inner.apply(commands, opts);
      },
      readState: () => inner.readState(),
    },
    applied,
  };
}

function deps(store: Store, now = NOW): RequestDeps {
  return {
    store,
    config,
    rest: new DiscordRest("bot-token"),
    credentials: new CredentialProvider(secrets),
    appId: "app-1",
    now: () => now,
    waitUntil: () => {},
  };
}

function submission(over: Record<string, string> = {}) {
  const v = { url: URL_OK, team: "Power", urgency: "soon", prd: "none", note: "", ...over };
  return {
    id: "i-1",
    token: "tok",
    channel_id: "chan-1",
    member: { user: { id: "u-1", username: "jolie", global_name: "Jolie" } },
    data: {
      custom_id: "request:modal",
      components: Object.entries(v).map(([id, value]) => ({
        type: 18,
        component: { type: 4, custom_id: id, value },
      })),
    },
  };
}

describe("openRequestModal", () => {
  it("answers with a modal from the cache without fetching anything", async () => {
    const store = new MemoryStore(config, publisher());
    await store.apply(
      [{ kind: "setMeta", patch: { prdCache: { options: [{ id: "t-1", name: "Trust" }], truncated: false, refreshedAt: NOW } } }],
      { now: NOW, rerender: false },
    );
    const response = await openRequestModal(deps(store));

    expect(response.type).toBe(9);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still opens on a cold cache", async () => {
    const response = await openRequestModal(deps(new MemoryStore(config, publisher())));
    expect(response.type).toBe(9);
  });
});

describe("handleModalSubmit", () => {
  it("answers synchronously with a deferred ephemeral and schedules the work", async () => {
    const store = new MemoryStore(config, publisher());
    const scheduled: Promise<unknown>[] = [];
    // A capturing `waitUntil`, not a no-op one. A no-op both drops the
    // assertion that anything was scheduled — half the constraint, and a
    // handler that deferred and scheduled NOTHING would pass the two type
    // assertions below — and leaves an unawaited `finishSubmit` running against
    // a stubbed `fetch` that `afterEach` unstubs underneath it, so any rejection
    // resurfaces as an unhandled rejection blamed on a later test.
    const response = handleModalSubmit(submission(), {
      ...deps(store),
      waitUntil: (work) => { scheduled.push(work); },
    });

    // Asserted before anything is awaited: a handler that did the work first and
    // deferred afterwards would not have returned yet.
    expect(response.type).toBe(5);
    expect(response.data?.flags).toBe(1 << 6);
    expect(scheduled).toHaveLength(1);

    await scheduled[0];
    // And the scheduled work is the real submit, not a placeholder.
    expect(Object.keys((await store.readState()).records)).toHaveLength(1);
  });
});

describe("finishSubmit", () => {
  let store: MemoryStore;
  beforeEach(() => { store = new MemoryStore(config, publisher()); });

  it("does not touch GitHub when offline validation fails", async () => {
    await finishSubmit(submission({ url: "https://github.com/someone/else/pull/1" }), deps(store));
    expect(githubSpy).not.toHaveBeenCalled();
    expect(Object.keys((await store.readState()).records)).toHaveLength(0);
    expect(edited[0]?.content).toContain("not on the repo allowlist");
  });

  it("stashes the values and offers a retry button on rejection", async () => {
    await finishSubmit(submission({ urgency: "blocking" }), deps(store));
    expect((await store.readState()).meta.retryStash["i-1"]?.values.urgency).toBe("blocking");
    expect(JSON.stringify(edited[0]?.components)).toContain("request:retry:i-1");
  });

  it("still shows the real rejection when the stash write fails", async () => {
    // The stash is a convenience; the rejection is the answer. A throw out of
    // the stash write used to escape `reject`, land in `finishSubmit`'s catch,
    // and replace "that repo is not on the allowlist" with "the PR may already
    // be tracked — check /review-list", which is false: nothing was recorded,
    // and the user never learns what was actually wrong with their submission.
    const failing: Store = {
      beginTick: (now) => store.beginTick(now),
      finishTick: (input) => store.finishTick(input),
      apply: async (commands, opts) => {
        if (commands.some((c) => c.kind === "stashSubmission")) throw new Error("DO write failed");
        return store.apply(commands, opts);
      },
      readState: () => store.readState(),
    };

    await finishSubmit(submission({ url: "https://github.com/someone/else/pull/1" }), deps(failing));

    expect(edited[0]?.content).toContain("not on the repo allowlist");
    expect(edited[0]?.content).not.toContain("may already be tracked");
    // No stash was written, so there is nothing for a retry button to reopen.
    expect(JSON.stringify(edited[0]?.components)).not.toContain("request:retry:");
  });

  it("offers no retry button when there is no actor to stash the values against", async () => {
    // Reachable, not theoretical: offline validation is rejected BEFORE the
    // missing-actor throw, so a submission carrying neither `member` nor `user`
    // lands here. The stash write needs a user id and skips; the button used to
    // render anyway, and pressing it could only ever answer "that form has
    // expired" about a form that was never stored.
    const { member: _member, ...actorless } = submission({ urgency: "blocking" });
    await finishSubmit(actorless, deps(store));

    expect((await store.readState()).meta.retryStash).toEqual({});
    expect(edited[0]?.components).toEqual([]);
    expect(JSON.stringify(edited[0]?.components)).not.toContain("request:retry:");
  });

  it("rejects a merged PR without recording anything", async () => {
    snapshot = { ...OPEN_SNAPSHOT, state: "MERGED", merged: true };
    await finishSubmit(submission(), deps(store));
    expect(edited[0]?.content).toContain("merged");
    expect(Object.keys((await store.readState()).records)).toHaveLength(0);
  });

  it("rejects a closed PR without recording anything", async () => {
    snapshot = { ...OPEN_SNAPSHOT, state: "CLOSED", merged: false };
    await finishSubmit(submission(), deps(store));
    expect(edited[0]?.content).toContain("closed");
    expect(Object.keys((await store.readState()).records)).toHaveLength(0);
  });

  it("distinguishes a credential failure from a missing PR", async () => {
    githubResult = { snapshots: new Map(), notFound: [], failedGroups: ["public"], subrequests: 1 };
    await finishSubmit(submission(), deps(store));
    expect(edited[0]?.content).toContain("credential");
  });

  it("calls a snapshot that is merely absent not-found, not a credential failure", async () => {
    // The other half of the split, and not redundant: a regression that dropped
    // the `failedGroups.length > 0` guard and always answered `credential` would
    // pass the test above on its own. GitHub returns NOT_FOUND for a private PR
    // and a nonexistent one alike, so this wording has to name both.
    githubResult = { snapshots: new Map(), notFound: [SLUG], failedGroups: [], subrequests: 1 };
    await finishSubmit(submission(), deps(store));
    expect(edited[0]?.content).toContain("does not exist, or the bot");
    expect(edited[0]?.content).not.toContain("credential");
  });

  it("records the request, posts the message, and writes the message id back", async () => {
    await finishSubmit(submission(), deps(store));

    const record = (await store.readState()).records[SLUG]!;
    expect(record.source).toBe("command");
    expect(record.messageId).toBe("posted-1");
    expect(posted[0]?.content).toContain(URL_OK);
    expect(edited[0]?.content).toContain("on the list");
  });

  it("writes the message id back with setRequestMessageId, not a second upsertRequest", async () => {
    const { store: recording, applied } = recordingStore(store);
    await finishSubmit(submission(), deps(recording));

    // The direct pin: exactly two writes, and the second is the narrow command.
    // A second `upsertRequest` here routes through `markRequested`, which moves
    // `lastRequestedAt` — the very field the digest's staleness fence compares
    // against — so a claim on the digest just rendered would fail as `stale`.
    expect(applied.map((commands) => commands.map((c) => c.kind))).toEqual([
      ["upsertRequest"],
      ["setRequestMessageId"],
    ]);

    const record = (await store.readState()).records[SLUG]!;
    // Genuinely pins its half: `newScannedRecord` starts at 1 and
    // `markRequested` would increment it, so a first-time request landing at 2
    // is exactly the regression.
    expect(record.requestCount).toBe(1);
    // Kept for what it does say — that nothing on this path stamps a clock onto
    // the fence field. It cannot fail on a same-clock regression, since
    // `finishSubmit` reads the clock once and both commands would carry that one
    // `at`; the command-kind assertion above is what closes that gap.
    expect(record.lastRequestedAt).toBe(record.firstRequestedAt);
  });

  it("clamps an over-long note at the record write — the modal is client-side, not the trust boundary", async () => {
    await finishSubmit(submission({ note: "n".repeat(5000) }), deps(store));
    const record = (await store.readState()).records[SLUG]!;
    expect(record.note?.length).toBe(500);
  });

  it("keeps the record and says the post failed when Discord rejects the message", async () => {
    postFails = true;
    await finishSubmit(submission(), deps(store));

    expect(Object.keys((await store.readState()).records)).toHaveLength(1);
    expect(edited[0]?.content).toContain("could not post");
  });

  it("says something true and logs when the path throws instead of returning a result", async () => {
    // A bare `fetch` rejecting is the real hazard, not a hypothetical one:
    // `fetchSnapshots` and both REST paths call `fetch` and `response.json()`
    // unguarded, so a DNS failure or a 200 carrying non-JSON rejects rather than
    // returning `{ ok: false }`. Unhandled, `waitUntil` swallows it and the
    // spinner never resolves.
    githubSpy.mockRejectedValueOnce(new TypeError("network error"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await finishSubmit(submission(), deps(store));

    expect(logged).toHaveBeenCalled();
    // The record is written before the channel post, so "nothing happened" would
    // be a lie on some failures. The message has to be honest about not knowing.
    expect(edited[0]?.content).toContain("/review-list");
    logged.mockRestore();
  });

  it("re-requesting an existing record updates it rather than creating a second", async () => {
    await finishSubmit(submission(), deps(store));
    // A later clock, not the brief's second `deps(store)`: `firstRequestedAt` is
    // `at` on the create, so at an unmoved clock the last assertion here and the
    // no-drift test above are each other's negation.
    await finishSubmit({ ...submission({ urgency: "blocking", note: "demo" }), id: "i-2" }, deps(store, NOW + 60_000));

    const state = await store.readState();
    expect(Object.keys(state.records)).toHaveLength(1);
    const record = state.records[SLUG]!;
    expect(record.requestCount).toBe(2);
    expect(record.urgency).toBe("blocking");
    expect(record.firstRequestedAt).toBeLessThan(record.lastRequestedAt);
  });
});

describe("handleRetryButton", () => {
  it("reopens the modal prefilled from the stash", async () => {
    const store = new MemoryStore(config, publisher());
    await finishSubmit(submission({ urgency: "blocking" }), deps(store));

    const response = await handleRetryButton({ id: "x", member: { user: { id: "u-1", username: "j" } } }, "request:retry:i-1", deps(store));
    expect(response.type).toBe(9);
    expect(JSON.stringify(response.data)).toContain("blocking");
  });

  // The spec asks for a reopened, empty modal "with a note saying so". This
  // sends an ephemeral message instead — a deliberate, accepted deviation
  // (see docs/architecture.md's retry-flow section): a blank form the user
  // has to refill from scratch is worse than telling them their old values
  // are still readable above and to run the command again.
  it("says the stash expired with an ephemeral message rather than reopening an empty modal", async () => {
    const store = new MemoryStore(config, publisher());
    await finishSubmit(submission({ urgency: "blocking" }), deps(store));

    const late = deps(store, NOW + config.retryStashMs + 1);
    const response = await handleRetryButton({ id: "x", member: { user: { id: "u-1", username: "j" } } }, "request:retry:i-1", late);
    expect(response.type).toBe(4);
    expect(response.data?.content).toContain("expired");
  });

  it("refuses a stash key belonging to someone else", async () => {
    const store = new MemoryStore(config, publisher());
    await finishSubmit(submission({ urgency: "blocking" }), deps(store));

    const response = await handleRetryButton({ id: "x", member: { user: { id: "someone-else", username: "b" } } }, "request:retry:i-1", deps(store));
    expect(response.type).toBe(4);
    expect(response.data?.content).toContain("your form");
  });
});
