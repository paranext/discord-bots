import { config } from "../config/config.js";
import { DiscordRest } from "./discord/rest.js";
import { CredentialProvider } from "./github/credentials.js";
import { handleHealth } from "./handlers/health.js";
import { handleInteraction } from "./handlers/interactions.js";
import { runTick } from "./handlers/scheduled.js";
import { assertMessageContentIntent } from "./handlers/startup.js";
import { RecordsObject } from "./store/do.js";
import type { Store } from "./store/types.js";

export { RecordsObject };

function storeFor(env: Env): Store {
  const id = env.RECORDS.idFromName("v1");
  return env.RECORDS.get(id) as unknown as Store;
}

/**
 * Reused across invocations within an isolate. A provider built fresh per
 * invocation makes three documented behaviours structurally impossible: the
 * 401 fail-closed latch dies with the invocation that set it (so a dead
 * credential is retried hot every five minutes forever), `/health`'s
 * `credentials.*.failedClosed` and `tokenExpiresInMs` can only ever report
 * `false`/`null` — which is the one field `docs/operations.md` routes its main
 * diagnosis through — and the installation token is minted on every tick
 * instead of being reused for its hour (288/day rather than 24).
 *
 * Keyed on the secrets themselves so a rotated token or App key cannot be
 * served by a provider still holding the old one's latch or minted token. The
 * key is derived from values already resident in this isolate's memory and is
 * never logged or transmitted.
 *
 * An isolate is not a global: a fresh isolate starts with the latch cleared,
 * which is why `docs/operations.md` names redeploying as the reset.
 */
let credentials: { key: string; provider: CredentialProvider } | null = null;

function credentialsFor(env: Env): CredentialProvider {
  const secrets = {
    appId: env.GITHUB_APP_ID,
    appInstallationId: env.GITHUB_APP_INSTALLATION_ID,
    appPrivateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
    publicToken: env.GITHUB_PUBLIC_TOKEN,
  };
  const key = JSON.stringify(secrets);
  if (credentials !== null && credentials.key === key) return credentials.provider;
  credentials = { key, provider: new CredentialProvider(secrets) };
  return credentials.provider;
}

/**
 * Shadow mode is the last checkpoint before the bot writes to a real channel,
 * and a posted Discord message has no undo — so this gate must not fail open on
 * a spelling. `READ_ONLY === "true"` alone treats `True`, `TRUE` and a pasted
 * `"true "` as "go live", silently, at the step the runbook promises writes
 * nothing.
 *
 * Anything unrecognised is also treated as read-only: on this one setting the
 * safe reading of an unclear answer is "don't write". Only the explicit,
 * recognised off-spellings turn writing on.
 */
export function isReadOnly(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "false" || value === "0" || value === "no" || value === "off" || value === "") return false;
  return true;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // GET (and HEAD) only. The handler is read-only, but the route previously
    // answered any method, so a POST to /health was a valid way to reach it.
    if (url.pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed", { status: 405 });
      }
      return handleHealth({
        store: storeFor(env),
        credentials: credentialsFor(env),
        now: Date.now(),
        staleBannerMs: config.staleBannerMs,
        token: env.HEALTH_TOKEN,
        authorization: request.headers.get("Authorization"),
      });
    }

    if (url.pathname === "/interactions" && request.method === "POST") {
      return handleInteraction(request, {
        store: storeFor(env),
        config,
        publicKey: env.DISCORD_PUBLIC_KEY,
        now: () => Date.now(),
        waitUntil: (work) => ctx.waitUntil(work),
        rest: new DiscordRest(env.DISCORD_BOT_TOKEN),
        credentials: credentialsFor(env),
        appId: env.DISCORD_APP_ID,
      });
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const rest = new DiscordRest(env.DISCORD_BOT_TOKEN);

    // Falsifiable, and checked every tick rather than only at deploy: someone can
    // turn the intent off in the portal at any time, and the symptom is silence.
    const intent = await assertMessageContentIntent(rest);
    if (!intent.ok) {
      console.error(`[${intent.code}] ${intent.detail}`);
      if (intent.code === "INTENT_MISSING") return;
    } else if (intent.limited) {
      // `assertMessageContentIntent` distinguishes the two message-content
      // application flags and this is the only place the distinction is
      // observable. Both are accepted — the abort behaviour is unchanged — but an
      // operator debugging an empty digest needs to know WHICH one this app has:
      // "the intent is on" and "the limited variant is on" are different
      // configurations in the Developer Portal, and only the log can tell them
      // apart.
      console.warn(
        "[INTENT_LIMITED] MESSAGE CONTENT is enabled through the LIMITED application " +
          "flag; the full flag is not set. Scanning proceeds. If the digest is " +
          "unexpectedly empty, check Developer Portal → Bot → Privileged Gateway " +
          "Intents before looking anywhere else.",
      );
    }

    const report = await runTick({
      store: storeFor(env),
      rest,
      credentials: credentialsFor(env),
      config,
      botUserId: env.DISCORD_BOT_USER_ID,
      now: Date.now(),
      readOnly: isReadOnly(env.READ_ONLY),
    });

    console.log(JSON.stringify({ tick: report }));
    ctx.waitUntil(Promise.resolve());
  },
};
