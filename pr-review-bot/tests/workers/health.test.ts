import { describe, expect, it } from "vitest";
import { config } from "../../config/config.js";
import { newScannedRecord, recordId, resolveRecord, type PrRecord } from "../../src/core/record.js";
import { CredentialProvider } from "../../src/github/credentials.js";
import { handleHealth } from "../../src/handlers/health.js";
import { emptyState } from "../../src/store/apply.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { DigestPublisher, Meta, StoreState } from "../../src/store/types.js";

const T0 = 1_788_192_000_000; // 2026-08-31T16:00:00Z
const MINUTE = 60_000;
const DAY = 86_400_000;

const secrets = { appId: "1", appInstallationId: "67890", appPrivateKeyPem: "unused", publicToken: "ghp_public" };

/** The health endpoint reads only through `Store.readState`, so no publisher is
 *  ever called; this exists to satisfy the constructor. */
const publisher: DigestPublisher = {
  listPinnedMessageIds: async () => [],
  patchDigest: async () => ({ ok: true }),
  createDigest: async () => ({ ok: true, messageId: "digest-1" }),
  postDaily: async () => ({ ok: true, messageId: "daily-1" }),
  messageUrl: (id) => `https://discord.com/channels/g/c/${id}`,
};

function record(number: number, overrides: Partial<PrRecord> = {}): PrRecord {
  return {
    ...newScannedRecord({
      pr: { owner: "paranext", repo: "paranext-core", number },
      channelId: "chan",
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

function state(records: PrRecord[], meta: Partial<Meta> = {}): StoreState {
  const base = emptyState();
  return {
    ...base,
    records: Object.fromEntries(records.map((r) => [recordId(r), r])),
    meta: { ...base.meta, ...meta },
  };
}

interface HealthBody {
  status: string;
  lastSync: string | null;
  lastSyncAgeMs: number | null;
  openRecords: number;
  totalRecords: number;
  syncPaused: number;
  claimed: number;
  digestMessageId: string | null;
  digestUnpinnedReportedAt: number | null;
  lastDailyPostDate: string | null;
  leaseHeld: boolean;
  credentials: {
    app: { failedClosed: boolean; reason: string | null; installationId: string; tokenExpiresInMs: number | null };
    public: { failedClosed: boolean; reason: string | null };
  };
}

const TOKEN = "health-secret";

async function health(
  initial: StoreState,
  opts: { now?: number; credentials?: CredentialProvider } = {},
): Promise<{ response: Response; body: HealthBody }> {
  const store = new MemoryStore(config, publisher, initial);
  const response = await handleHealth({
    store,
    credentials: opts.credentials ?? new CredentialProvider(secrets),
    now: opts.now ?? T0,
    staleBannerMs: config.staleBannerMs,
    token: TOKEN,
    authorization: `Bearer ${TOKEN}`,
  });
  return { response, body: (await response.json()) as HealthBody };
}

/** Auth only — the body is never reached, so no store state is needed. */
async function healthAuth(opts: {
  token?: string | undefined;
  authorization?: string | null | undefined;
}): Promise<Response> {
  return handleHealth({
    store: new MemoryStore(config, publisher, state([])),
    credentials: new CredentialProvider(secrets),
    now: T0,
    staleBannerMs: config.staleBannerMs,
    ...opts,
  });
}

describe("handleHealth — who is allowed to read it", () => {
  // The body names the App installation id, each credential's failure reason,
  // the digest message id, the record census and the lease state. Served
  // unauthenticated on any method, that was a map of the deployment for anyone
  // who guessed the workers.dev hostname.
  it("serves the body to a correct bearer token", async () => {
    // Never-synced state answers 503 by design, so the assertion is that the
    // BODY was served — the auth check let the request through — rather than a
    // particular status.
    const response = await healthAuth({ token: TOKEN, authorization: `Bearer ${TOKEN}` });
    expect(await response.text()).toContain("installationId");
  });

  it("refuses a wrong, malformed or absent token without leaking the body", async () => {
    for (const authorization of [`Bearer wrong`, `Bearer ${TOKEN}x`, TOKEN, "", null, undefined]) {
      const response = await healthAuth({ token: TOKEN, authorization });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("installationId");
    }
  });

  it("disables the endpoint entirely when no token is configured", async () => {
    // Fail closed, and 404 rather than 401: an operator who has not set the
    // secret yet gets no endpoint instead of an open one, and a scanner is not
    // told a health endpoint exists here to be guessed at.
    for (const token of [undefined, ""]) {
      const response = await healthAuth({ token, authorization: `Bearer ${TOKEN}` });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("installationId");
    }
  });
});

// `/health` is the diagnostic docs/operations.md routes every investigation
// through, so each branch is asserted on the FIELDS an operator reads, not just
// on the status code. A test that only checks `200` (or that `status` is
// defined) cannot fail for any of the reasons this endpoint exists.
describe("handleHealth", () => {
  it("reports ok and the full census when the last sync is recent", async () => {
    const { response, body } = await health(
      state(
        [
          record(1),
          record(2, { claimedBy: "u1", claimedByName: "Ira", claimedAt: T0 - MINUTE }),
          record(3, { syncPausedSince: T0 - 2 * MINUTE }),
          record(4, { syncPausedSince: T0 - 3 * MINUTE }),
          resolveRecord(record(5), T0 - MINUTE, "merged"),
        ],
        { lastSync: T0 - MINUTE, digestMessageId: "digest-1", lastDailyPostDate: "2026-08-31" },
      ),
    );

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.lastSync).toBe(new Date(T0 - MINUTE).toISOString());
    expect(body.lastSyncAgeMs).toBe(MINUTE);
    // Five records, one of them resolved: `openRecords` and `totalRecords` are
    // different numbers here, so neither can stand in for the other.
    expect(body.openRecords).toBe(4);
    expect(body.totalRecords).toBe(5);
    // Counted over OPEN records only, and deliberately different numbers from
    // each other and from the two above, so a copy-paste between any of the four
    // cannot pass.
    expect(body.syncPaused).toBe(2);
    expect(body.claimed).toBe(1);
    expect(body.digestMessageId).toBe("digest-1");
    expect(body.digestUnpinnedReportedAt).toBeNull();
    expect(body.lastDailyPostDate).toBe("2026-08-31");
    expect(body.leaseHeld).toBe(false);
  });

  it("reports stale and 503 once the last sync is older than the stale banner", async () => {
    // A silent cron failure is the failure this endpoint exists to surface: the
    // digest keeps showing its last body, so the only signal is here. 503 is what
    // makes it visible to an uptime check that reads status codes and nothing else.
    const age = config.staleBannerMs + MINUTE;
    const { response, body } = await health(
      state([record(1)], { lastSync: T0 - age, digestMessageId: "digest-1" }),
    );

    expect(response.status).toBe(503);
    expect(body.status).toBe("stale");
    expect(body.lastSyncAgeMs).toBe(age);
    // The timestamp is still reported, not suppressed: "stale since when" is the
    // first thing the runbook asks for.
    expect(body.lastSync).toBe(new Date(T0 - age).toISOString());
  });

  it("treats a sync that has never run as stale, with null rather than a fabricated age", async () => {
    // A brand-new deploy, or one whose very first tick never completed. `null`
    // must not be rendered as an epoch-0 date or an age of `now`.
    const { response, body } = await health(state([], { lastSync: null }));

    expect(response.status).toBe(503);
    expect(body.status).toBe("stale");
    expect(body.lastSync).toBeNull();
    expect(body.lastSyncAgeMs).toBeNull();
    expect(body.openRecords).toBe(0);
    expect(body.totalRecords).toBe(0);
  });

  it("reports a fail-closed credential group, per group, with its reason", async () => {
    // docs/operations.md routes its main diagnosis through
    // `credentials.<group>.failedClosed`: a dead token stops the sync without
    // stopping the bot, and this field is the difference between "GitHub is down"
    // and "rotate the token". The other group must stay clean, so a single
    // whole-provider flag could not pass this.
    const credentials = new CredentialProvider(secrets);
    credentials.reportStatus("public", 401, T0);

    const { body } = await health(state([record(1)], { lastSync: T0 - MINUTE }), { credentials });

    expect(body.credentials.public.failedClosed).toBe(true);
    expect(body.credentials.public.reason).toContain("401");
    expect(body.credentials.app.failedClosed).toBe(false);
    expect(body.credentials.app.reason).toBeNull();
    expect(body.credentials.app.installationId).toBe("67890");
    expect(body.credentials.app.tokenExpiresInMs).toBeNull();
  });

  it("reports a held lease and a reported unpinning, which are otherwise invisible", async () => {
    // Two states an operator cannot see from the channel: a lease stuck from a
    // tick that died mid-flight (every later tick is turned away with
    // `lease-held`), and a digest somebody unpinned (already reported once, so
    // the log will not say it again).
    const { body } = await health(
      state([record(1)], {
        lastSync: T0 - MINUTE,
        digestMessageId: "digest-1",
        syncLease: { heldSince: T0 - 3 * MINUTE },
        unpinnedReportedAt: T0 - 4 * MINUTE,
      }),
    );

    expect(body.leaseHeld).toBe(true);
    expect(body.digestUnpinnedReportedAt).toBe(T0 - 4 * MINUTE);
  });

  it("serves JSON, which is what the runbook pipes into jq", async () => {
    const { response } = await health(state([], { lastSync: T0 }));
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});
