import { afterEach, describe, expect, it, vi } from "vitest";
import { config as baseConfig } from "../../config/config.js";
import { newScannedRecord, recordId, resolveRecord, type PrRecord } from "../../src/core/record.js";
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

function deps(store: MemoryStore, verified = true) {
  return { store, config, publicKey: "00".repeat(32), now: () => T0, verify: async () => verified };
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
    expect(body.data.flags).toBe(64);
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
