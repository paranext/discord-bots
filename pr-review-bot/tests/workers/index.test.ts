import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index.js";

afterEach(() => vi.unstubAllGlobals());

/** A throwaway 2048-bit RSA key generated for tests only. Never a real credential. */
const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCZFYpDYoXK4C0A\nvVLLbhl+CZXRi3QVcHgS5r2VbcgijdNvqG0gL0uM5jGgO/NqfIWZg9QgX89No6Pv\nrQaLLMGgz7FfIeyHnaJvqeD7W6c7lBsEf8gQEvStKBehbD/ia13yjS99/1XHBjgz\nPg11d7iPGIPzYg4tIpzPwRXVDXtmfLiiMEW/CNT0fS9qvlfpTeSefyagcV0pupeT\n/93ND9yerRytSz+enX9sadm0Z7Q/t+aHfdoN4aLje0LZ+x/AT8Vf/H4K9inXrBtc\nkFADv7rJLvdTSJbPp0kulYPCoE7vpv1yG7j52tzARW/fNxFTB1Bcz1pRJjkUHkGf\nQqtYHaS9AgMBAAECggEAGhM0MNQoS+0xXS3iW2pOh0xkq4Oga0J0AWwyILDJZTFZ\nMWyz4caMjNxs2Yk8pge9ze9Jg5YuPmBAPUPwmGYwOQ8HfFfP7S2pjHGYM9hhvOE2\nVObbEfnYmWH53HIO06dMIlNwInsKhlMF4ZyROFADLMSVPTCXj5KUuUJ/UIHyYftb\nCq4Aqbf6KfgilkVyCo15evcn11Jf6KGHRqKZR9W9IhgEASqOXDO9OkvslvxwzAS0\n6vexhN+5I/4MClwnGcMKBtLcSBEO3QvnL5h/QAw21kPLPA7B5LQYw+6zdf7wWUpt\nRPy18JGUquX/mnSOSE4tSIuI3aJDSU7clUEzi7h9gQKBgQDOyWcHctYEg8A0EIu9\nhOryFu9ChusKEDRCY5wc95TxhEU30SCbnp2SsuQgApOXXGWHAlAEffDMmA2WAQsb\nNR5dOJjdz6rfExjniNA0mDH6PuJTJxHl5P7DbDsNz35CefVI6/PxELYjGVw87TiM\nsEys23/x0XjckYSTjo65PFO44QKBgQC9hEb/4XQ+lp3TgjEg0ynd214EMd/fT7SF\nkt3N2Y/PnEV+DDK5T2oAoS/j3syeZwlszkxNB5le47i1/QGwPoxLd8tlFt5uYVmF\nV5lUw0jLptYc03yF3GrMnwanpvyRgtzf/s5MYz/NtRF1KkSVildBxX5vJToUWaOF\nSbI1GOvbXQKBgQCBefPr4wiEfSY8s1t8CBzABoI7KpVCkNDX/NzD+nWlH8fjYitD\npXZOY3qZXGOjc3QSq+0EUwMSZ+ah1PdqSsE/Z2+3+w6nbKK8XprXQ7CPWw6FOEJp\nqw+ltz/mrtQEta5SwYLVnzwcEAYEFBjDZqQr26hp9lnx6Z+UcL+G1nIpoQKBgQCP\niPPNMRA9pw15+A0Fc2kuIsseGjgYheGPmSBsm+6TqyPmx45TU5ZRS8Ndro0DG77D\nrauUW8EJYSewjiMNPRI8xkpCEgP9TbXji+kRjaZAt+dKhdK1/67Ts03zBEIeYyKu\nc+oDaNgWEKFcP9sZ92EG63FK9ML8TrfOZ3aVSH658QKBgQCZOsZ0vXfXQHOTWkSB\n/6fKyknmXho6iUo1bvArVpBAkXvTa9KgQq2G0h27HvMMCD/X92nbDE9bxj47Qdtk\nERoqrVzXJ4Qa3JkIbpsv5YDJTDlaoFeceEjyM2V1wtMxyM2G968IpxOHo5kSzZ1N\nQHZNz9jlbXPLX9T8nkccuvyf3g==\n-----END PRIVATE KEY-----\n";

const HEALTH_TOKEN = "health-secret";

/** A stand-in ExecutionContext for `worker.fetch`, which now requires one. */
function fetchCtx(): ExecutionContext {
  return createExecutionContext();
}

/** `/health` is behind a shared secret, so every reader here must present it.
 *  The env it is checked against comes from `healthEnv`. */
function healthRequest(): Request {
  return new Request("https://bot/health", { headers: { Authorization: `Bearer ${HEALTH_TOKEN}` } });
}

function healthEnv(overrides: Record<string, unknown> = {}): Env {
  return { ...env, HEALTH_TOKEN, ...overrides } as unknown as Env;
}

const DISCORD_APP_ID = "app-1";

/** A throwaway Ed25519 keypair, generated fresh per call — same approach as
 *  `tests/workers/verify.test.ts`'s `signed` helper, since `worker.fetch`
 *  reaches the real `verifyDiscordRequest` (index.ts injects no `deps.verify`)
 *  and so needs a genuinely signed body and a matching public key in env. */
function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** An env with the three request-path secrets set, plus a Discord public key
 *  whose matching private key `signedInteraction` signs with. */
async function fullEnv(): Promise<{ env: Env; publicKeyHex: string; sign: (body: string, timestamp: string) => Promise<string> }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  const publicKeyHex = toHex(raw);
  const sign = async (body: string, timestamp: string) =>
    toHex(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(timestamp + body)));
  return {
    env: {
      ...env,
      DISCORD_PUBLIC_KEY: publicKeyHex,
      DISCORD_APP_ID,
      DISCORD_BOT_TOKEN: "bot-token",
    } as unknown as Env,
    publicKeyHex,
    sign,
  };
}

/** A genuinely-signed `/interactions` request for the given payload, signed
 *  against the keypair `fullEnv` produced. */
async function signedInteraction(
  payload: unknown,
  sign: (body: string, timestamp: string) => Promise<string>,
): Promise<Request> {
  const body = JSON.stringify(payload);
  const timestamp = "1756000000";
  const signature = await sign(body, timestamp);
  return new Request("https://bot/interactions", {
    method: "POST",
    body,
    headers: { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
  });
}

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

/** Seeds one open record into the DO the worker actually reaches
 *  (`idFromName("v1")`), so a tick has something to query GitHub about. */
async function seedOpenRecord(owner: string, repo: string, number: number): Promise<void> {
  const stub = env.RECORDS.get(env.RECORDS.idFromName("v1"));
  await stub.apply(
    [{ kind: "upsertRequest",
       pr: { owner, repo, number },
       at: Date.now() - 3_600_000,
       fields: { urgency: "soon", note: "", requesterId: "u0", requesterName: "Jolie", channelId: "chan", messageId: "msg" },
       title: `${repo}#${number}`, prAuthorLogin: "someone-else", isDraft: false }],
    { now: Date.now(), rerender: false },
  );
}

describe("fetch", () => {
  it("serves /health", async () => {
    const response = await worker.fetch(healthRequest(), healthEnv(), fetchCtx());
    const body = (await response.json()) as { status: string };
    expect(body.status).toBeDefined();
  });

  it("refuses /health without the shared secret, and 404s it when none is configured", async () => {
    // The route used to answer any request on any method, handing out the App
    // installation id, credential failure reasons, the digest message id and the
    // lease state to anyone who guessed the workers.dev hostname.
    const noAuth = await worker.fetch(new Request("https://bot/health"), healthEnv(), fetchCtx());
    expect(noAuth.status).toBe(401);

    const wrong = await worker.fetch(
      new Request("https://bot/health", { headers: { Authorization: "Bearer nope" } }),
      healthEnv(),
      fetchCtx(),
    );
    expect(wrong.status).toBe(401);

    const unconfigured = await worker.fetch(healthRequest(), env, fetchCtx());
    expect(unconfigured.status).toBe(404);
  });

  it("405s a non-GET /stats", async () => {
    const response = await worker.fetch(
      new Request("https://bot/stats", { method: "POST", headers: { Authorization: "Bearer stats-secret" } }),
      { ...env, STATS_TOKEN: "stats-secret" } as unknown as Env,
      fetchCtx(),
    );
    expect(response.status).toBe(405);
  });

  it("405s a non-GET /health", async () => {
    const response = await worker.fetch(
      new Request("https://bot/health", { method: "POST", headers: { Authorization: `Bearer ${HEALTH_TOKEN}` } }),
      healthEnv(),
      fetchCtx(),
    );
    expect(response.status).toBe(405);
  });

  it("404s an unknown path", async () => {
    const response = await worker.fetch(new Request("https://bot/nope"), env, fetchCtx());
    expect(response.status).toBe(404);
  });

  it("does not route a non-POST request to /interactions to the interaction handler", async () => {
    const response = await worker.fetch(new Request("https://bot/interactions", { method: "GET" }), env, fetchCtx());
    // The interaction handler would 401 an unsigned POST; a GET must not reach
    // it at all, so it falls through to the generic 404 instead.
    expect(response.status).toBe(404);
  });

  it("passes the Discord client, credentials and app id to the interactions handler", async () => {
    // Reaching the modal at all proves all three arrived: requestDeps() returns
    // null without them and the command answers "not enabled yet".
    const { env: withDeps, sign } = await fullEnv();
    // allowedChannelIds gates the command by channel, and the Worker reads it
    // from env — this channel is the `REVIEW_CHANNEL_IDS` test binding in
    // `vitest.config.ts`, so the request has to originate there to reach the
    // modal at all.
    const request = await signedInteraction(
      { type: 2, data: { name: "review-request" }, channel_id: "100000000000000001" },
      sign,
    );
    const response = await worker.fetch(request, withDeps, fetchCtx());
    const body = (await response.json()) as { type: number };
    expect(body.type).toBe(9);
  });

  it("answers 500 on /interactions when the channel config is invalid, without echoing it", async () => {
    // A bad secret is often a pasted token or the wrong secret entirely, so the
    // response must not carry it back to whoever sent the request.
    const { env: withDeps, sign } = await fullEnv();
    const broken = { ...withDeps, REVIEW_CHANNEL_IDS: "nope" } as unknown as Env;
    const request = await signedInteraction(
      { type: 2, data: { name: "review-request" }, channel_id: "100000000000000001" },
      sign,
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await worker.fetch(request, broken, fetchCtx());
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("nope");
    } finally {
      errors.mockRestore();
    }
  });

  it("answers an unsigned /interactions with 401, not the config error, and logs nothing", async () => {
    // The config is read only after the signature checks out, so nobody
    // outside Discord can learn the bot is misconfigured or flood the logs.
    const { env: withDeps } = await fullEnv();
    const broken = { ...withDeps, REVIEW_CHANNEL_IDS: "nope" } as unknown as Env;
    const request = new Request("https://bot/interactions", {
      method: "POST",
      body: JSON.stringify({ type: 1 }),
      headers: { "x-signature-ed25519": "00".repeat(64), "x-signature-timestamp": "1756000000" },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await worker.fetch(request, broken, fetchCtx());
      expect(response.status).toBe(401);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("still serves /health when the channel config is invalid", async () => {
    // /health is how an operator diagnoses a broken deploy, so a broken
    // channel secret must not take it down with the rest of the bot.
    // A fresh sync, so the 200 is about the route surviving and not hostage to
    // the staleness check, which answers 503 before any tick has run.
    const stub = env.RECORDS.get(env.RECORDS.idFromName("v1"));
    await stub.apply([{ kind: "setMeta", patch: { lastSync: Date.now() } }], { now: Date.now(), rerender: false });
    const { env: withDeps } = await fullEnv();
    const broken = { ...withDeps, REVIEW_CHANNEL_IDS: "nope", HEALTH_TOKEN } as unknown as Env;
    const response = await worker.fetch(healthRequest(), broken, fetchCtx());
    expect(response.status).toBe(200);
  });
});

describe("scheduled", () => {
  /** The stub the replaced tests used, minus the /applications/@me branch. Records
   *  every call so a test can see what the tick reached. */
  function stubDiscord(calls: { url: string; method: string }[]): void {
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/messages/pins")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.includes("/messages") && method === "POST") {
        return new Response(JSON.stringify({ id: "digest-live" }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });
  }

  it("never calls GET /applications/@me", async () => {
    const calls: { url: string; method: string }[] = [];
    stubDiscord(calls);

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(calls.filter((c) => c.url.includes("/applications/@me"))).toHaveLength(0);
  });

  it("writes even when a READ_ONLY variable is still set from an old deploy", async () => {
    const calls: { url: string; method: string }[] = [];
    stubDiscord(calls);
    // An open record, so the digest has something to render and post.
    await seedOpenRecord("eten-tech-foundation", "scripture-editors", 1);

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), { ...env, READ_ONLY: "true" } as typeof env, ctx);
    await waitOnExecutionContext(ctx);

    // The tick reached finishTick: the digest message was written.
    const writes = calls.filter((c) => c.url.includes("/messages/") && (c.method === "PATCH" || c.method === "POST"));
    expect(writes.length).toBeGreaterThan(0);
  });
});

// Last in the file on purpose: the credential provider is module-level state
// scoped to the isolate — which is the whole point of finding 3 — so a
// fail-closed latch set here would be visible to any test that ran afterwards.
describe("the credential provider across invocations", () => {
  it("keeps a 401 fail-closed, and /health can therefore report it", async () => {
    // Every consequence of building a provider per invocation is visible here:
    // the tick sees the 401 and fails that group closed, and a LATER, separate
    // invocation — the /health fetch the runbook tells the operator to read —
    // must still see it. A fresh provider per invocation makes
    // `credentials.public.failedClosed` structurally incapable of being true,
    // which is the field `docs/operations.md` routes its main diagnosis through.
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes("api.github.com/graphql")) return new Response("{}", { status: 401 });
      if (url.includes("/messages/pins")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.includes("/messages") && (init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ id: "digest-1" }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });

    // A non-paranext owner routes to the public token, which needs no App JWT.
    await seedOpenRecord("eten-tech-foundation", "scripture-editors", 1);

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, ctx);
    await waitOnExecutionContext(ctx);

    const response = await worker.fetch(healthRequest(), healthEnv(), ctx);
    const body = (await response.json()) as { credentials: { public: { failedClosed: boolean; reason: string | null } } };
    expect(body.credentials.public.failedClosed).toBe(true);
    expect(body.credentials.public.reason).toContain("401");
  });

  it("does not serve a stale provider after a secret changes", async () => {
    // Self-contained: this test earns its own latch rather than relying on the
    // "keeps a 401 fail-closed" test above having run first and left the
    // isolate's module-level provider latched. Without this setup, the
    // assertion below would pass vacuously — failedClosed starts `false` — if
    // this test ran alone or were reordered ahead of that one.
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes("api.github.com/graphql")) return new Response("{}", { status: 401 });
      if (url.includes("/messages/pins")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.includes("/messages") && (init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ id: "digest-1" }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });

    // A non-paranext owner routes to the public token, which needs no App JWT.
    await seedOpenRecord("eten-tech-foundation", "scripture-editors", 1);

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, ctx);
    await waitOnExecutionContext(ctx);

    // The premise: this invocation's provider is now latched fail-closed. If
    // this ever stops holding, the fixture has stopped earning the latch and
    // the assertion below is vacuous.
    const latched = await worker.fetch(healthRequest(), healthEnv(), ctx);
    const latchedBody = (await latched.json()) as { credentials: { public: { failedClosed: boolean } } };
    expect(latchedBody.credentials.public.failedClosed).toBe(true);

    // The property that matters: the latch above must not outlive the
    // credential that earned it. An operator who rotates the token and
    // redeploys gets a provider that has never failed.
    const response = await worker.fetch(healthRequest(), healthEnv({ GH_PUBLIC_TOKEN: "ghp_rotated" }), ctx);
    const body = (await response.json()) as { credentials: { public: { failedClosed: boolean } } };
    expect(body.credentials.public.failedClosed).toBe(false);
  });

  it("reuses the installation token across ticks instead of minting one every five minutes", async () => {
    // The spec's budget: "one extra subrequest at most once an hour, cached
    // between ticks". A provider rebuilt per invocation mints 288 a day.
    const mints: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes("/access_tokens")) {
        mints.push(url);
        return new Response(
          JSON.stringify({ token: "ghs_installation", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
          { status: 200 },
        );
      }
      if (url.includes("api.github.com/graphql")) return new Response(JSON.stringify({ data: {} }), { status: 200 });
      if (url.includes("/messages/pins")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.includes("/messages") && (init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ id: "digest-1" }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });

    // paranext routes to the App installation, which is the group with a token
    // to cache at all.
    await seedOpenRecord("paranext", "paranext-core", 4398);
    const withKey = {
      ...env,
      GH_APP_ID: "12345",
      GH_APP_INSTALLATION_ID: "67890",
      GH_APP_PRIVATE_KEY: TEST_PEM,
    };

    for (const _tick of [1, 2, 3]) {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController(), withKey, ctx);
      await waitOnExecutionContext(ctx);
    }

    expect(mints).toHaveLength(1);
  });
});
