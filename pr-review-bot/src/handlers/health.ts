import { isOpen } from "../core/record.js";
import type { CredentialProvider } from "../github/credentials.js";
import type { Store } from "../store/types.js";

export interface HealthDeps {
  store: Store;
  credentials: CredentialProvider;
  now: number;
  staleBannerMs: number;
  /** The configured shared secret, or undefined when none is set. */
  token?: string | undefined;
  /** The request's `Authorization` header, or null. */
  authorization?: string | null | undefined;
}

/**
 * Compares without an early return on the first differing byte. The timing
 * signal here is thin — one request per comparison, over the internet — but the
 * whole check is three lines either way.
 */
function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The body names the GitHub App installation id, each credential's failure
 * reason, the digest message id, record counts and the lease state. That is a
 * useful map of the deployment to anyone who guesses the `*.workers.dev`
 * hostname, so it is behind a shared secret.
 *
 * With no `HEALTH_TOKEN` configured the endpoint answers 404 rather than
 * serving the body: an operator who has not set the secret yet gets no endpoint,
 * not an open one, and 404 (rather than 401) does not confirm to a scanner that
 * a health endpoint is there to find. `docs/setup.md` sets the secret in the
 * same step that deploys, and `docs/operations.md` passes it.
 */
export function healthAuthFailure(token: string | undefined, authorization: string | null | undefined): Response | null {
  if (token === undefined || token === "") {
    return new Response("not found", { status: 404 });
  }
  const presented = (authorization ?? "").startsWith("Bearer ") ? (authorization ?? "").slice("Bearer ".length) : "";
  if (!secretEquals(presented, token)) {
    return new Response("unauthorized", { status: 401 });
  }
  return null;
}

/** A silent cron failure must be discoverable without reading the channel. */
export async function handleHealth(deps: HealthDeps): Promise<Response> {
  const denied = healthAuthFailure(deps.token, deps.authorization);
  if (denied !== null) return denied;

  const state = await deps.store.readState();
  const records = Object.values(state.records);
  const open = records.filter(isOpen);
  const lastSync = state.meta.lastSync;
  const ageMs = lastSync === null ? null : deps.now - lastSync;
  const stale = ageMs === null || ageMs >= deps.staleBannerMs;

  const body = {
    status: stale ? "stale" : "ok",
    lastSync: lastSync === null ? null : new Date(lastSync).toISOString(),
    lastSyncAgeMs: ageMs,
    openRecords: open.length,
    totalRecords: records.length,
    syncPaused: open.filter((r) => r.syncPausedSince !== null).length,
    claimed: open.filter((r) => r.claimedBy !== null).length,
    digestMessageId: state.meta.digestMessageId,
    digestUnpinnedReportedAt: state.meta.unpinnedReportedAt,
    lastDailyPostDate: state.meta.lastDailyPostDate,
    leaseHeld: state.meta.syncLease !== null,
    credentials: deps.credentials.health(deps.now),
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: stale ? 503 : 200,
    headers: { "Content-Type": "application/json" },
  });
}
