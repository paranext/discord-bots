export type CredentialGroup = "app" | "public";

export interface GithubSecrets {
  appId: string;
  appInstallationId: string;
  appPrivateKeyPem: string;
  publicToken: string;
}

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; failedClosed: boolean; reason: string };

export interface CredentialState {
  token: string | null;
  expiresAt: number | null;
  failedClosed: boolean;
  failureReason: string | null;
  /** Set by a throttle response; cleared by the clock. Distinct from
   *  `failedClosed`, which nothing but a redeploy clears. */
  throttledUntil: number | null;
}

const EXPIRY_MARGIN_MS = 5 * 60_000;
const API = "https://api.github.com";

/** A throttle shorter than one refresh interval buys nothing — the next tick is
 *  five minutes out either way — and one longer than an hour outlives the
 *  isolate holding it. */
const MIN_THROTTLE_MS = 60_000;
const MAX_THROTTLE_MS = 60 * 60_000;

/**
 * GitHub answers a secondary rate limit with **403**, the same status it uses
 * for a revoked token — the two are told apart only by headers. `Retry-After`
 * is the explicit form; a spent primary budget shows up as
 * `x-ratelimit-remaining: 0` plus an `x-ratelimit-reset` epoch.
 *
 * Returns null when nothing says "slow down", which is what makes the caller
 * treat the 403 as permanent. Guessing "transient" on a bare 403 would retry a
 * revoked credential hot every five minutes — the exact behaviour the
 * fail-closed rule exists to prevent.
 */
export function throttleDelayMs(headers: Headers | undefined, now: number): number | null {
  if (headers === undefined) return null;
  const clamp = (ms: number): number => Math.min(MAX_THROTTLE_MS, Math.max(MIN_THROTTLE_MS, ms));

  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return clamp(retryAfter * 1000);

  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) return clamp(reset * 1000 - now);
    return MIN_THROTTLE_MS;
  }

  return null;
}

/** Private repos exist only in paranext, where an App can be installed. */
export function routeOwner(owner: string): CredentialGroup {
  return owner.toLowerCase() === "paranext" ? "app" : "public";
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** RS256 is RSASSA-PKCS1-v1_5 with SHA-256, which Web Crypto provides directly —
 *  no JWT library, and therefore no runtime dependency. */
export async function signAppJwt(appId: string, privateKeyPem: string, now: number): Promise<string> {
  const seconds = Math.floor(now / 1000);
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(
    new TextEncoder().encode(
      // iat is backdated 60s: GitHub rejects a JWT whose iat is in the future,
      // and Workers clocks are not guaranteed to match GitHub's to the second.
      JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

export class CredentialProvider {
  private readonly state: Record<CredentialGroup, CredentialState> = {
    app: { token: null, expiresAt: null, failedClosed: false, failureReason: null, throttledUntil: null },
    public: { token: null, expiresAt: null, failedClosed: false, failureReason: null, throttledUntil: null },
  };

  constructor(private readonly secrets: GithubSecrets) {}

  async tokenFor(group: CredentialGroup, now: number): Promise<TokenResult> {
    const state = this.state[group];
    if (state.failedClosed) {
      return { ok: false, failedClosed: true, reason: state.failureReason ?? "failed closed" };
    }

    // A throttle withholds the token without latching: the group is skipped for
    // this tick and recovers by itself once the window passes. `failedClosed`
    // stays false so nothing downstream reports a dead credential.
    if (state.throttledUntil !== null) {
      if (now < state.throttledUntil) {
        return { ok: false, failedClosed: false, reason: state.failureReason ?? "throttled by GitHub" };
      }
      state.throttledUntil = null;
      state.failureReason = null;
    }

    if (group === "public") return { ok: true, token: this.secrets.publicToken };

    if (state.token !== null && state.expiresAt !== null && now < state.expiresAt - EXPIRY_MARGIN_MS) {
      return { ok: true, token: state.token };
    }

    const jwt = await signAppJwt(this.secrets.appId, this.secrets.appPrivateKeyPem, now);
    const response = await fetch(`${API}/app/installations/${this.secrets.appInstallationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "pr-review-bot",
      },
    });

    // A 403 on the mint is checked for a throttle signal before it is believed:
    // the mint route is rate limited like any other, and latching there would
    // stop App syncing permanently over a limit that clears in minutes.
    if (response.status === 403 || response.status === 429) {
      const delay = throttleDelayMs(response.headers, now);
      if (delay !== null) {
        state.throttledUntil = now + delay;
        state.failureReason = `installation token mint throttled for ${Math.round(delay / 1000)}s`;
        return { ok: false, failedClosed: false, reason: state.failureReason };
      }
    }

    if (response.status === 401 || response.status === 403 || response.status === 404) {
      // Not transient: a bad key, a revoked install, or a wrong installation id.
      // Fail closed rather than retry hot every five minutes.
      state.failedClosed = true;
      state.failureReason = `installation token mint returned ${response.status}`;
      return { ok: false, failedClosed: true, reason: state.failureReason };
    }
    if (!response.ok) {
      return { ok: false, failedClosed: false, reason: `installation token mint returned ${response.status}` };
    }

    const body = (await response.json()) as { token: string; expires_at: string };
    state.token = body.token;
    state.expiresAt = Date.parse(body.expires_at);
    return { ok: true, token: body.token };
  }

  /**
   * Called by the query adapter when a request comes back 401/403/429.
   *
   * 401 means the credential is not a credential any more, and latches. 403 is
   * ambiguous — GitHub uses it for both a revoked token and a secondary rate
   * limit — so the headers decide: a throttle signal backs off, and anything
   * else is read as revoked and latches. Latching on every 403 made one
   * throttled response stop all syncing for the credential until the isolate
   * was recycled, with a redeploy the only documented reset.
   */
  reportStatus(group: CredentialGroup, status: number, now: number, headers?: Headers): void {
    const state = this.state[group];

    if (status === 403 || status === 429) {
      const delay = throttleDelayMs(headers, now);
      if (delay !== null) {
        state.throttledUntil = now + delay;
        state.failureReason = `GitHub throttled this credential for ${Math.round(delay / 1000)}s`;
        // The token itself is still valid — a throttle is about rate, not
        // identity — so it is deliberately not cleared here.
        return;
      }
      if (status === 429) return; // A 429 with no signal is still a rate limit, never a revocation.
    }

    if (status === 401 || status === 403) {
      state.failedClosed = true;
      state.failureReason = `GitHub returned ${status}`;
      state.token = null;
    }
  }

  health(now: number): {
    app: {
      failedClosed: boolean;
      reason: string | null;
      installationId: string;
      tokenExpiresInMs: number | null;
      throttledForMs: number | null;
    };
    public: { failedClosed: boolean; reason: string | null; throttledForMs: number | null };
  } {
    const app = this.state.app;
    const pub = this.state.public;
    const throttledFor = (state: CredentialState): number | null =>
      state.throttledUntil === null || now >= state.throttledUntil ? null : state.throttledUntil - now;
    return {
      app: {
        failedClosed: app.failedClosed,
        reason: app.failureReason,
        installationId: this.secrets.appInstallationId,
        tokenExpiresInMs: app.expiresAt === null ? null : app.expiresAt - now,
        throttledForMs: throttledFor(app),
      },
      public: { failedClosed: pub.failedClosed, reason: pub.failureReason, throttledForMs: throttledFor(pub) },
    };
  }
}
