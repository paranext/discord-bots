import type { RecordsObject } from "./store/do.js";

/**
 * The worker's bindings, declared by hand rather than via `wrangler types` —
 * that command emits a full generated copy of the Workers runtime types,
 * which duplicates (and can conflict with) `@cloudflare/workers-types`
 * already listed in tsconfig's `types`. This file only augments the ambient
 * `Cloudflare.Env` interface (declaration-merged from an empty interface in
 * `@cloudflare/workers-types`) with the bindings `wrangler.jsonc` declares and
 * the secrets set with `wrangler secret put` — the channel IDs among them,
 * which stay out of `wrangler.jsonc` because this repo is public. Re-run by
 * hand if `wrangler.jsonc`'s bindings or the secrets change.
 *
 * Deliberately absent: a KV namespace / `META` binding. The cache that would
 * have needed it now lives in the Durable Object instead — see
 * `adr-no-kv-namespace`.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      RECORDS: DurableObjectNamespace<RecordsObject>;
      DISCORD_BOT_TOKEN: string;
      DISCORD_PUBLIC_KEY: string;
      DISCORD_GUILD_ID: string;
      DISCORD_BOT_USER_ID: string;
      /** The application id, for `PATCH /webhooks/{app_id}/{token}/...`. Kept as
       *  its own secret rather than derived from DISCORD_BOT_USER_ID: the two are
       *  the same snowflake for a bot application in practice, but that equality
       *  is undocumented, and getting it wrong 404s every followup edit on a path
       *  that must not fail. `docs/setup.md` and `scripts/register-commands.ts`
       *  already use this secret. */
      DISCORD_APP_ID: string;
      GH_APP_ID: string;
      GH_APP_INSTALLATION_ID: string;
      GH_APP_PRIVATE_KEY: string;
      GH_PUBLIC_TOKEN: string;
      /** Shared secret for `GET /health`. Unset means /health is disabled — see
       *  `handleHealth`. */
      HEALTH_TOKEN?: string;
      /** Shared secret for `GET /stats`. Unset means /stats is disabled — same
       *  rule as `HEALTH_TOKEN`. */
      STATS_TOKEN?: string;
      /** Comma-separated channel IDs the bot accepts submissions from. Secrets,
       *  not vars: deploy-specific, never committed, and a var prints in the
       *  public deploy log. Read and validated by `loadConfig`. Optional because
       *  an unset secret is `undefined` at runtime; only `loadConfig` should
       *  read it, and it fails loudly when it is missing. */
      REVIEW_CHANNEL_IDS?: string;
      /** The channel the digest is pinned in. Must be one of
       *  `REVIEW_CHANNEL_IDS` — same rule, same reader. */
      DIGEST_CHANNEL_ID?: string;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- ambient `Env` is how the Workers types plumb `Cloudflare.Env` through as the global handler-parameter type
  interface Env extends Cloudflare.Env {}
}

export {};
