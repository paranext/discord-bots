import { afterEach, describe, expect, it, vi } from "vitest";
import { config as baseConfig } from "../../config/config.js";
import { newScannedRecord, recordId, resolveRecord, type PrRecord } from "../../src/core/record.js";
import { EPHEMERAL_FLAG } from "../../src/discord/components.js";
import { DiscordRest } from "../../src/discord/rest.js";
import { CredentialProvider } from "../../src/github/credentials.js";
import { handleInteraction } from "../../src/handlers/interactions.js";
import { emptyState } from "../../src/store/apply.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { DigestPayload, DigestPublisher, StoreState } from "../../src/store/types.js";

const T0 = 1_788_192_000_000; // 2026-08-31T16:00:00Z = 11:00 America/Chicago
const DAY = 86_400_000;
const CHANNEL = "chan-1";
const config = { ...baseConfig, allowedChannelIds: [CHANNEL], digestChannelId: CHANNEL };
const ID = "eten-tech-foundation/scripture-editors/341";

function record(overrides: Partial<PrRecord> = {}): PrRecord {
  return {
    ...newScannedRecord({
      pr: { owner: "eten-tech-foundation", repo: "scripture-editors", number: 341 },
      channelId: CHANNEL,
      messageId: "m-341",
      messageTimestamp: T0 - 3 * DAY,
      title: "Fix marker parsing",
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
    meta: { ...base.meta, digestMessageId: "digest-1", lastSync: T0 - 60_000, lastDailyPostDate: "2026-08-31" },
  };
}

function makeStore(records: PrRecord[]) {
  const patches: DigestPayload[] = [];
  const publisher: DigestPublisher = {
    listPinnedMessageIds: async () => ["digest-1"],
    patchDigest: async (_id, p) => { patches.push(p); return { ok: true }; },
    createDigest: async (p) => { patches.push(p); return { ok: true, messageId: "digest-1" }; },
    postDaily: async () => ({ ok: true, messageId: "d" }),
    messageUrl: (id) => `https://discord.com/channels/g/c/${id}`,
  };
  return { store: new MemoryStore(config, publisher, seeded(records)), patches };
}

// Signature verification is injected through `deps.verify` below rather than
// mocked: the real Ed25519 path is covered in Task 13 against real keys.
function componentRequest(customId: string, value: string, userId = "u1", userName = "Katherine") {
  const body = JSON.stringify({
    type: 3,
    data: { custom_id: customId, component_type: 3, values: [value] },
    member: { user: { id: userId, global_name: userName, username: userName } },
    channel_id: CHANNEL,
  });
  return new Request("https://bot/interactions", {
    method: "POST",
    body,
    headers: { "x-signature-ed25519": "ab".repeat(64), "x-signature-timestamp": "1756000000" },
  });
}

// A genuine BUTTON payload, unlike componentRequest: no `values` key at all
// (a select menu's field; a button never carries one) and component_type 2.
// The routing-order regression test needs this shape specifically — the bug
// it guards was the shared decode running before custom_id was checked, and
// that only manifests when `values` is absent, not merely empty.
function buttonRequest(customId: string, userId = "u1", userName = "Katherine") {
  const body = JSON.stringify({
    type: 3,
    data: { custom_id: customId, component_type: 2 },
    member: { user: { id: userId, global_name: userName, username: userName } },
    channel_id: CHANNEL,
  });
  return new Request("https://bot/interactions", {
    method: "POST",
    body,
    headers: { "x-signature-ed25519": "ab".repeat(64), "x-signature-timestamp": "1756000000" },
  });
}

/** An arbitrary interaction payload, for the shapes the two helpers above do not
 *  cover: application commands and modal submissions. */
function rawRequest(payload: unknown) {
  return new Request("https://bot/interactions", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "x-signature-ed25519": "ab".repeat(64), "x-signature-timestamp": "1756000000" },
  });
}

function deps(store: MemoryStore, verified = true) {
  return {
    store,
    config,
    publicKey: "00".repeat(32),
    now: () => T0,
    verify: async () => verified,
    waitUntil: () => {},
    // The three request-path deps, so `requestDeps` narrows and the retry
    // button reaches the real `handleRetryButton` rather than being turned away
    // with "not enabled yet". Neither object is exercised on this file's paths:
    // the retry handler does one store read and no I/O.
    rest: new DiscordRest("bot-token"),
    credentials: new CredentialProvider({
      appId: "1",
      appInstallationId: "2",
      appPrivateKeyPem: "unused",
      publicToken: "ghp_public",
    }),
    appId: "app-1",
  };
}

/** `deps()` minus the three request-path deps — which is exactly what production
 *  runs until Task 12 wires them into `src/index.ts`, so it is the `requestDeps`
 *  branch most worth pinning. */
function narrowDeps(store: MemoryStore) {
  const { rest: _rest, credentials: _credentials, appId: _appId, ...narrow } = deps(store);
  return narrow;
}

afterEach(() => vi.unstubAllGlobals());

describe("handleInteraction — gatekeeping", () => {
  it("answers a PING with a PONG", async () => {
    const { store } = makeStore([]);
    const request = new Request("https://bot/interactions", {
      method: "POST",
      body: JSON.stringify({ type: 1 }),
      headers: { "x-signature-ed25519": "ab".repeat(64), "x-signature-timestamp": "1" },
    });
    const response = await handleInteraction(request, deps(store));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
  });

  it("rejects an unverified request with 401 before parsing or applying anything", async () => {
    const { store } = makeStore([]);
    const response = await handleInteraction(componentRequest("digest:claim", `${ID}:${T0 - 3 * DAY}`), deps(store, false));
    expect(response.status).toBe(401);
  });
});

describe("handleInteraction — claim", () => {
  it("records the claim and confirms ephemerally", async () => {
    const { store, patches } = makeStore([record()]);
    const value = `${ID}:${T0 - 3 * DAY}`;
    const response = await handleInteraction(componentRequest("digest:claim", value), deps(store));

    const body = (await response.json()) as { data: { content: string; flags: number } };
    // The ephemeral BIT, not the whole field: the reply also suppresses unfurls
    // (the title it echoes is free text from GitHub), and this assertion is
    // about who can see the confirmation, not about what else is set.
    expect(body.data.flags & EPHEMERAL_FLAG).toBe(EPHEMERAL_FLAG);
    expect(body.data.content).toContain("Fix marker parsing");

    const state = await store.readState();
    expect(state.records[ID]?.claimedByName).toBe("Katherine");
    expect(patches.length).toBeGreaterThan(0);
  });

  it("names the holder when someone else already claimed it", async () => {
    const { store } = makeStore([record({ claimedBy: "u9", claimedByName: "Ira", claimedAt: T0 - 3600_000 })]);
    const response = await handleInteraction(componentRequest("digest:claim", `${ID}:${T0 - 3 * DAY}`), deps(store));
    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content).toContain("Ira");
  });

  it("releases the claim when the holder selects their own row", async () => {
    const { store } = makeStore([record({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0 - 3600_000 })]);
    const response = await handleInteraction(componentRequest("digest:claim", `${ID}:${T0 - 3 * DAY}`), deps(store));
    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content.toLowerCase()).toContain("released");
    expect((await store.readState()).records[ID]?.claimedBy).toBeNull();
  });

  it("explains and no-ops when the option value is stale", async () => {
    // "changed" also appears in not-open ("Nothing changed."), not-found ("Nothing
    // changed.") and the default branch ("Nothing changed for…") — asserting it
    // alone can't tell "stale" from those other three outcomes. "re-requested" is
    // the one phrase unique to the stale branch.
    const { store } = makeStore([record({ lastRequestedAt: T0 - 60_000 })]);
    const response = await handleInteraction(componentRequest("digest:claim", `${ID}:${T0 - 3 * DAY}`), deps(store));
    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content).toContain("re-requested");
    expect((await store.readState()).records[ID]?.claimedBy).toBeNull();
  });
});

describe("handleInteraction — resolve and reopen", () => {
  it("resolves a row, recording the actor", async () => {
    const { store } = makeStore([record()]);
    const response = await handleInteraction(componentRequest("digest:resolve", `${ID}:${T0 - 3 * DAY}`), deps(store));
    expect((await response.json() as { data: { content: string } }).data.content).toContain("Cleared");
    expect((await store.readState()).records[ID]?.resolvedBy).toBe("cleared by Katherine");
  });

  it("refuses to overwrite a resolvedBy the tick already set", async () => {
    // The specific bug: selecting Resolve on a row the tick resolved 60 seconds
    // ago would destroy the audit trail retention exists to provide.
    const alreadyResolved = resolveRecord(record(), T0 - 60_000, "review by katherine");
    const { store } = makeStore([alreadyResolved]);
    const response = await handleInteraction(componentRequest("digest:resolve", `${ID}:${T0 - 3 * DAY}`), deps(store));
    const body = (await response.json()) as { data: { content: string } };
    // "already" alone is also produced by applyOne's OWN not-open guard inside the
    // store — deleting the handler's early return this test names would still pass,
    // since describe()'s not-open branch also contains "already" (just not the
    // resolver's name). Assert the message only the handler's own check can produce.
    expect(body.data.content).toContain("review by katherine");
    expect((await store.readState()).records[ID]?.resolvedBy).toBe("review by katherine");
  });

  it("reopens a row resolved within the last 24 hours", async () => {
    const resolved = resolveRecord(record(), T0 - 3600_000, "cleared by Jolie");
    const { store } = makeStore([resolved]);
    const response = await handleInteraction(
      componentRequest("digest:resolve", `reopen:${ID}:${T0 - 3 * DAY}`),
      deps(store),
    );
    expect((await response.json() as { data: { content: string } }).data.content.toLowerCase()).toContain("back");
    expect((await store.readState()).records[ID]?.resolvedAt).toBeNull();
  });

  it("refuses to reopen a row resolved more than config.reopenWindowMs ago", async () => {
    // No test previously covered a reopen REFUSAL: if the renderer's window ever
    // exceeded the handler's, the digest would offer options that always answer
    // "cannot be reopened from here" and nothing would go red.
    const resolved = resolveRecord(record(), T0 - 30 * 3600_000, "cleared by Jolie");
    const { store } = makeStore([resolved]);
    const response = await handleInteraction(
      componentRequest("digest:resolve", `reopen:${ID}:${T0 - 3 * DAY}`),
      deps(store),
    );
    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content).toContain("cannot be reopened");
    expect((await store.readState()).records[ID]?.resolvedAt).not.toBeNull();
  });

  it("reports not-found for a record that has been purged", async () => {
    const { store } = makeStore([]);
    const response = await handleInteraction(componentRequest("digest:resolve", `${ID}:${T0}`), deps(store));
    expect((await response.json() as { data: { content: string } }).data.content.toLowerCase()).toContain("no longer");
  });

  it("rejects a malformed option value without throwing", async () => {
    const { store } = makeStore([record()]);
    const response = await handleInteraction(componentRequest("digest:resolve", "garbage"), deps(store));
    expect(response.status).toBe(200);
    expect((await response.json() as { data: { content: string } }).data.content.toLowerCase()).toContain("could not");
  });

  it("returns 200 with an explanation for an unknown custom_id", async () => {
    const { store } = makeStore([record()]);
    const response = await handleInteraction(componentRequest("digest:unknown", `${ID}:${T0}`), deps(store));
    expect(response.status).toBe(200);
  });
});

describe("handleInteraction — component routing order", () => {
  it("routes a component by custom_id before it tries to decode a selection value", async () => {
    // A button carries no `values` key at all (buttonRequest omits it — unlike
    // componentRequest's empty-string element, which does not reproduce the
    // bug). Before this fix, the shared decode ran first on the missing
    // `values` and swallowed every button with "Could not read that
    // selection". The positive assertion is on `handleRetryButton`'s own
    // expiry wording — reachable only by actually arriving there, since the
    // stash is empty — which also rules out control silently falling through to
    // the unrelated "no longer in use" branch, or being turned away by the
    // `requestDeps` gate; neither of those contains "expired" either, and
    // neither would mean routing worked.
    const { store } = makeStore([]);
    const response = await handleInteraction(buttonRequest("request:retry:missing"), deps(store));
    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content).toContain("expired");
  });

  it("still reports an undecodable value for a SELECT menu", async () => {
    const { store } = makeStore([record()]);
    const response = await handleInteraction(componentRequest("digest:claim", "garbage"), deps(store));
    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content).toContain("Could not read that selection");
  });
});

describe("handleInteraction — /review-request routing", () => {
  /** A modal submission carrying whatever `custom_id` is under test. The URL is
   *  deliberately off the allowlist so the scheduled work is turned down by
   *  OFFLINE validation and touches GitHub not at all — this file is about
   *  routing, and `reviewRequest.test.ts` owns the submit path. */
  function modalRequest(customId: string) {
    return rawRequest({
      type: 5,
      id: "i-1",
      token: "tok",
      channel_id: CHANNEL,
      member: { user: { id: "u1", global_name: "Katherine", username: "Katherine" } },
      data: {
        custom_id: customId,
        components: [
          { type: 18, component: { type: 4, custom_id: "url", value: "https://github.com/someone/else/pull/1" } },
          { type: 18, component: { type: 4, custom_id: "team", value: "Power" } },
          { type: 18, component: { type: 4, custom_id: "urgency", value: "soon" } },
        ],
      },
    });
  }

  function commandRequest(name: string) {
    return rawRequest({
      type: 2,
      id: "c-1",
      token: "tok",
      channel_id: CHANNEL,
      member: { user: { id: "u1", global_name: "Katherine", username: "Katherine" } },
      data: { name },
    });
  }

  it("answers the /review-request command with a modal", async () => {
    const { store } = makeStore([]);
    const response = await handleInteraction(commandRequest("review-request"), deps(store));
    const body = (await response.json()) as { type: number; data: { custom_id: string } };
    expect(body.type).toBe(9);
    expect(body.data.custom_id).toBe("request:modal");
  });

  it("answers the modal submission with a deferral and schedules the work", async () => {
    const { store } = makeStore([]);
    const scheduled: Promise<unknown>[] = [];
    // 204 on everything: the only network an offline-rejected submit reaches is
    // the deferred-reply edit. Captured and awaited rather than dropped, so the
    // background work cannot outlive `afterEach`'s unstub.
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));

    const response = await handleInteraction(modalRequest("request:modal"), {
      ...deps(store),
      waitUntil: (work: Promise<unknown>) => { scheduled.push(work); },
    });

    const body = (await response.json()) as { type: number; data: { flags: number } };
    expect(body.type).toBe(5);
    expect(body.data.flags & EPHEMERAL_FLAG).toBe(EPHEMERAL_FLAG);
    expect(scheduled).toHaveLength(1);
    await scheduled[0];
  });

  it("turns away a modal that is not the request modal without scheduling anything", async () => {
    // A foreign modal reaching `finishSubmit` would have its values STASHED,
    // consuming a slot under `budgets.retryStashEntries` and evicting a real
    // user's pending retry. So this asserts on the stash, not merely the wording.
    const { store } = makeStore([]);
    const scheduled: Promise<unknown>[] = [];

    const response = await handleInteraction(modalRequest("someone:elses:modal"), {
      ...deps(store),
      waitUntil: (work: Promise<unknown>) => { scheduled.push(work); },
    });

    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content).toContain("no longer in use");
    expect(scheduled).toHaveLength(0);
    expect((await store.readState()).meta.retryStash).toEqual({});
  });

  it("says the command is not enabled when rest, credentials and appId are absent", async () => {
    // The branch production actually takes until Task 12 wires the three deps
    // into `src/index.ts`. All three entry points share the one gate.
    const { store } = makeStore([]);
    for (const request of [
      commandRequest("review-request"),
      modalRequest("request:modal"),
      buttonRequest("request:retry:i-1"),
    ]) {
      const response = await handleInteraction(request, narrowDeps(store));
      const body = (await response.json()) as { data: { content: string } };
      expect(body.data.content).toContain("That command is not enabled yet.");
    }
  });

  it("rejects the command, the modal submit, and the retry button from a channel not on the allowlist", async () => {
    const { store } = makeStore([]);
    const OTHER = "some-other-channel";
    for (const request of [
      commandRequest("review-request"),
      modalRequest("request:modal"),
      buttonRequest("request:retry:i-1"),
    ]) {
      const raw = JSON.parse((await request.clone().text())) as { channel_id: string };
      raw.channel_id = OTHER;
      const response = await handleInteraction(rawRequest(raw), deps(store));
      const body = (await response.json()) as { data: { content: string } };
      expect(body.data.content).toContain(`<#${CHANNEL}>`);
      expect(body.data.content.toLowerCase()).not.toContain("not enabled");
    }
    expect((await store.readState()).meta.retryStash).toEqual({});
  });

  it("still answers an unknown application command with the not-enabled message", async () => {
    const { store } = makeStore([]);
    const response = await handleInteraction(commandRequest("review-nonsense"), deps(store));
    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content).toContain("That command is not enabled yet.");
  });
});
