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
 * Deliberately absent: a KV namespace / `META` binding. An earlier ruling
 * dropped it as unused — the cache that would need it belongs to a later plan.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      RECORDS: DurableObjectNamespace<RecordsObject>;
      DISCORD_BOT_TOKEN: string;
      DISCORD_PUBLIC_KEY: string;
      DISCORD_GUILD_ID: string;
      DISCORD_BOT_USER_ID: string;
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
