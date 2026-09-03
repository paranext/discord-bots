import type { RecordsObject } from "./store/do.js";

/**
 * The worker's bindings, declared by hand rather than via `wrangler types` —
 * that command emits a full generated copy of the Workers runtime types,
 * which duplicates (and can conflict with) `@cloudflare/workers-types`
 * already listed in tsconfig's `types`. This file only augments the ambient
 * `Cloudflare.Env` interface (declaration-merged from an empty interface in
 * `@cloudflare/workers-types`) with the bindings and secrets `wrangler.jsonc`
 * declares. Re-run by hand if `wrangler.jsonc`'s bindings change.
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
      GITHUB_APP_ID: string;
      GITHUB_APP_INSTALLATION_ID: string;
      GITHUB_APP_PRIVATE_KEY: string;
      GITHUB_PUBLIC_TOKEN: string;
      /** "true" runs the full loop against live data and writes nothing. */
      READ_ONLY?: string;
      /** Shared secret for `GET /health`. Unset means /health is disabled — see
       *  `handleHealth`. */
      HEALTH_TOKEN?: string;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- ambient `Env` is how the Workers types plumb `Cloudflare.Env` through as the global handler-parameter type
  interface Env extends Cloudflare.Env {}
}

export {};
