import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialProvider, routeOwner, signAppJwt } from "../../src/github/credentials.js";

const T0 = 1_788_192_000_000; // 2026-08-31T16:00:00Z = 11:00 America/Chicago
const HOUR = 3_600_000;

// A throwaway 2048-bit RSA key generated for tests only. Never a real credential.
const TEST_PEM_PLACEHOLDER =
  "-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCZFYpDYoXK4C0A\nvVLLbhl+CZXRi3QVcHgS5r2VbcgijdNvqG0gL0uM5jGgO/NqfIWZg9QgX89No6Pv\nrQaLLMGgz7FfIeyHnaJvqeD7W6c7lBsEf8gQEvStKBehbD/ia13yjS99/1XHBjgz\nPg11d7iPGIPzYg4tIpzPwRXVDXtmfLiiMEW/CNT0fS9qvlfpTeSefyagcV0pupeT\n/93ND9yerRytSz+enX9sadm0Z7Q/t+aHfdoN4aLje0LZ+x/AT8Vf/H4K9inXrBtc\nkFADv7rJLvdTSJbPp0kulYPCoE7vpv1yG7j52tzARW/fNxFTB1Bcz1pRJjkUHkGf\nQqtYHaS9AgMBAAECggEAGhM0MNQoS+0xXS3iW2pOh0xkq4Oga0J0AWwyILDJZTFZ\nMWyz4caMjNxs2Yk8pge9ze9Jg5YuPmBAPUPwmGYwOQ8HfFfP7S2pjHGYM9hhvOE2\nVObbEfnYmWH53HIO06dMIlNwInsKhlMF4ZyROFADLMSVPTCXj5KUuUJ/UIHyYftb\nCq4Aqbf6KfgilkVyCo15evcn11Jf6KGHRqKZR9W9IhgEASqOXDO9OkvslvxwzAS0\n6vexhN+5I/4MClwnGcMKBtLcSBEO3QvnL5h/QAw21kPLPA7B5LQYw+6zdf7wWUpt\nRPy18JGUquX/mnSOSE4tSIuI3aJDSU7clUEzi7h9gQKBgQDOyWcHctYEg8A0EIu9\nhOryFu9ChusKEDRCY5wc95TxhEU30SCbnp2SsuQgApOXXGWHAlAEffDMmA2WAQsb\nNR5dOJjdz6rfExjniNA0mDH6PuJTJxHl5P7DbDsNz35CefVI6/PxELYjGVw87TiM\nsEys23/x0XjckYSTjo65PFO44QKBgQC9hEb/4XQ+lp3TgjEg0ynd214EMd/fT7SF\nkt3N2Y/PnEV+DDK5T2oAoS/j3syeZwlszkxNB5le47i1/QGwPoxLd8tlFt5uYVmF\nV5lUw0jLptYc03yF3GrMnwanpvyRgtzf/s5MYz/NtRF1KkSVildBxX5vJToUWaOF\nSbI1GOvbXQKBgQCBefPr4wiEfSY8s1t8CBzABoI7KpVCkNDX/NzD+nWlH8fjYitD\npXZOY3qZXGOjc3QSq+0EUwMSZ+ah1PdqSsE/Z2+3+w6nbKK8XprXQ7CPWw6FOEJp\nqw+ltz/mrtQEta5SwYLVnzwcEAYEFBjDZqQr26hp9lnx6Z+UcL+G1nIpoQKBgQCP\niPPNMRA9pw15+A0Fc2kuIsseGjgYheGPmSBsm+6TqyPmx45TU5ZRS8Ndro0DG77D\nrauUW8EJYSewjiMNPRI8xkpCEgP9TbXji+kRjaZAt+dKhdK1/67Ts03zBEIeYyKu\nc+oDaNgWEKFcP9sZ92EG63FK9ML8TrfOZ3aVSH658QKBgQCZOsZ0vXfXQHOTWkSB\n/6fKyknmXho6iUo1bvArVpBAkXvTa9KgQq2G0h27HvMMCD/X92nbDE9bxj47Qdtk\nERoqrVzXJ4Qa3JkIbpsv5YDJTDlaoFeceEjyM2V1wtMxyM2G968IpxOHo5kSzZ1N\nQHZNz9jlbXPLX9T8nkccuvyf3g==\n-----END PRIVATE KEY-----\n";

const secrets = {
  appId: "12345",
  appInstallationId: "67890",
  appPrivateKeyPem: TEST_PEM_PLACEHOLDER,
  publicToken: "ghp_public",
};

function stubFetch(responses: { status: number; json?: unknown; headers?: Record<string, string> }[]) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    calls.push({ url: String(input), method: init.method ?? "GET", headers: init.headers as Record<string, string> });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(response.json === undefined ? null : JSON.stringify(response.json), {
      status: response.status,
      headers: response.headers ?? {},
    });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("routeOwner", () => {
  it("routes paranext to the App installation", () => {
    expect(routeOwner("paranext")).toBe("app");
    expect(routeOwner("Paranext")).toBe("app");
  });

  it("routes every other owner to the public token", () => {
    expect(routeOwner("eten-tech-foundation")).toBe("public");
  });
});

describe("signAppJwt", () => {
  it("produces three base64url segments with RS256 and the app id as issuer", async () => {
    const jwt = await signAppJwt("12345", secrets.appPrivateKeyPem, T0);
    const [header, payload, signature] = jwt.split(".");
    expect(signature).toBeTruthy();
    const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    expect(decode(header!).alg).toBe("RS256");
    expect(decode(payload!).iss).toBe("12345");
  });

  it("backdates iat by 60 seconds to tolerate clock skew, and expires within 10 minutes", async () => {
    const jwt = await signAppJwt("12345", secrets.appPrivateKeyPem, T0);
    const payload = JSON.parse(atob(jwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    const nowSeconds = Math.floor(T0 / 1000);
    expect(payload.iat).toBe(nowSeconds - 60);
    // Pinned to the exact value, not just an upper bound: `<=` alone is satisfied by
    // any already-expired JWT (exp === iat, or even 0), and GitHub's 401 on an expired
    // JWT is what trips the fail-closed latch below — this is the one direction with
    // a large blast radius.
    expect(payload.exp).toBe(nowSeconds + 540);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
  });
});

describe("CredentialProvider", () => {
  it("returns the public token without any network call", async () => {
    const calls = stubFetch([]);
    const provider = new CredentialProvider(secrets);
    expect(await provider.tokenFor("public", T0)).toEqual({ ok: true, token: "ghp_public" });
    expect(calls).toHaveLength(0);
  });

  it("mints an installation token on first use", async () => {
    const calls = stubFetch([
      { status: 201, json: { token: "ghs_installation", expires_at: new Date(T0 + HOUR).toISOString() } },
    ]);
    const provider = new CredentialProvider(secrets);
    expect(await provider.tokenFor("app", T0)).toEqual({ ok: true, token: "ghs_installation" });
    expect(calls[0]!.url).toBe("https://api.github.com/app/installations/67890/access_tokens");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.Authorization).toMatch(/^Bearer ey/);
  });

  it("caches the installation token until it nears expiry", async () => {
    const calls = stubFetch([
      { status: 201, json: { token: "ghs_a", expires_at: new Date(T0 + HOUR).toISOString() } },
      { status: 201, json: { token: "ghs_b", expires_at: new Date(T0 + 2 * HOUR).toISOString() } },
    ]);
    const provider = new CredentialProvider(secrets);
    await provider.tokenFor("app", T0);
    expect(await provider.tokenFor("app", T0 + 30 * 60_000)).toEqual({ ok: true, token: "ghs_a" });
    expect(calls).toHaveLength(1);
  });

  it("re-mints inside the 5-minute expiry margin", async () => {
    const calls = stubFetch([
      { status: 201, json: { token: "ghs_a", expires_at: new Date(T0 + HOUR).toISOString() } },
      { status: 201, json: { token: "ghs_b", expires_at: new Date(T0 + 2 * HOUR).toISOString() } },
    ]);
    const provider = new CredentialProvider(secrets);
    await provider.tokenFor("app", T0);
    expect(await provider.tokenFor("app", T0 + HOUR - 60_000)).toEqual({ ok: true, token: "ghs_b" });
    expect(calls).toHaveLength(2);
  });

  it("FAILS CLOSED on a 401 and stops retrying", async () => {
    // 10,000 invalid responses in 10 minutes risks a temporary IP ban, so an
    // expired-credential bug must not retry hot every five minutes.
    const calls = stubFetch([{ status: 401, json: { message: "Bad credentials" } }]);
    const provider = new CredentialProvider(secrets);
    const first = await provider.tokenFor("app", T0);
    expect(first).toMatchObject({ ok: false, failedClosed: true });

    const second = await provider.tokenFor("app", T0 + 5 * 60_000);
    expect(second).toMatchObject({ ok: false, failedClosed: true });
    expect(calls).toHaveLength(1);
  });

  it("distinguishes a transient 500 from a 401 and retries it", async () => {
    const calls = stubFetch([
      { status: 500, json: {} },
      { status: 201, json: { token: "ghs_a", expires_at: new Date(T0 + HOUR).toISOString() } },
    ]);
    const provider = new CredentialProvider(secrets);
    expect(await provider.tokenFor("app", T0)).toMatchObject({ ok: false, failedClosed: false });
    expect(await provider.tokenFor("app", T0 + 5 * 60_000)).toEqual({ ok: true, token: "ghs_a" });
    expect(calls).toHaveLength(2);
  });

  it("fails the public credential closed on a reported 401", async () => {
    const provider = new CredentialProvider(secrets);
    provider.reportStatus("public", 401, T0);
    expect(await provider.tokenFor("public", T0)).toMatchObject({ ok: false, failedClosed: true });
  });

  it("backs a 403 with Retry-After off for that long, then recovers on its own", async () => {
    // The defect this pins: a secondary rate limit and a revoked token share
    // status 403, and latching on both meant one throttled response stopped all
    // syncing for the isolate's life — redeploy the only documented reset.
    const provider = new CredentialProvider(secrets);
    provider.reportStatus("public", 403, T0, new Headers({ "retry-after": "120" }));

    expect(await provider.tokenFor("public", T0)).toMatchObject({ ok: false, failedClosed: false });
    // Still inside the window.
    expect(await provider.tokenFor("public", T0 + 119_000)).toMatchObject({ ok: false, failedClosed: false });
    // Past it, with no intervention.
    expect(await provider.tokenFor("public", T0 + 121_000)).toEqual({ ok: true, token: "ghp_public" });
  });

  it("backs off on a spent primary budget signalled by x-ratelimit-remaining", async () => {
    const provider = new CredentialProvider(secrets);
    const reset = Math.floor((T0 + 10 * 60_000) / 1000);
    provider.reportStatus(
      "public",
      403,
      T0,
      new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }),
    );
    expect(await provider.tokenFor("public", T0)).toMatchObject({ ok: false, failedClosed: false });
    expect(await provider.tokenFor("public", T0 + 11 * 60_000)).toEqual({ ok: true, token: "ghp_public" });
  });

  it("still fails closed on a 403 that carries no throttle signal", async () => {
    // The other half of the split. A bare 403 is read as revoked, so the
    // fail-closed rule — never retry a dead credential every five minutes —
    // survives the fix intended to loosen it.
    const provider = new CredentialProvider(secrets);
    provider.reportStatus("public", 403, T0, new Headers({ "x-ratelimit-remaining": "4999" }));
    expect(await provider.tokenFor("public", T0)).toMatchObject({ ok: false, failedClosed: true });
    // And still latched well past any plausible backoff window.
    expect(await provider.tokenFor("public", T0 + 24 * HOUR)).toMatchObject({ ok: false, failedClosed: true });
  });

  it("treats a 429 as a rate limit even with no headers at all, never as a revocation", async () => {
    const provider = new CredentialProvider(secrets);
    provider.reportStatus("public", 429, T0);
    expect(provider.health(T0).public.failedClosed).toBe(false);
    expect(await provider.tokenFor("public", T0)).toEqual({ ok: true, token: "ghp_public" });
  });

  it("reports a throttle in health as a countdown, distinct from failedClosed", async () => {
    // operations.md diagnoses from this endpoint: "throttled, comes back by
    // itself" and "rotate the token" are different jobs and must not read the
    // same on /health.
    const provider = new CredentialProvider(secrets);
    provider.reportStatus("public", 403, T0, new Headers({ "retry-after": "300" }));
    const health = provider.health(T0);
    expect(health.public.failedClosed).toBe(false);
    expect(health.public.throttledForMs).toBe(300_000);
    expect(provider.health(T0 + 301_000).public.throttledForMs).toBeNull();
  });

  it("does not latch the App credential when the token mint itself is throttled", async () => {
    stubFetch([
      { status: 403, json: { message: "rate limited" }, headers: { "retry-after": "120" } },
      { status: 201, json: { token: "ghs_a", expires_at: new Date(T0 + 3 * HOUR).toISOString() } },
    ]);
    const provider = new CredentialProvider(secrets);
    expect(await provider.tokenFor("app", T0)).toMatchObject({ ok: false, failedClosed: false });
    expect(await provider.tokenFor("app", T0 + 121_000)).toEqual({ ok: true, token: "ghs_a" });
  });

  it("reports health per credential — token expiry for the App, not a key age", async () => {
    // health() has no private-key-age field: key creation time isn't derivable from
    // a PEM, and reporting it would mean inventing a new secret. It reports
    // tokenExpiresInMs instead; the gap this leaves (a rotated-late key is caught by
    // a human, not this endpoint) is recorded as a runbook line in Task 20.
    const provider = new CredentialProvider(secrets);
    expect(provider.health(T0).app.tokenExpiresInMs).toBeNull();

    stubFetch([{ status: 201, json: { token: "ghs_a", expires_at: new Date(T0 + HOUR).toISOString() } }]);
    await provider.tokenFor("app", T0);
    const health = provider.health(T0);
    expect(health.app).toMatchObject({ failedClosed: false, installationId: "67890", tokenExpiresInMs: HOUR });
    expect(health.public).toMatchObject({ failedClosed: false });
  });
});
