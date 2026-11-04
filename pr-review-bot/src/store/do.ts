import { DurableObject } from "cloudflare:workers";
import { loadConfig } from "../../config/config.js";
import { DiscordRest, makeDigestPublisher } from "../discord/rest.js";
import { applyCommands, emptyState } from "./apply.js";
import { commitTick, digestHashWriteBack, renderAndPatch, tickWriteBack } from "./memory.js";
import { migrateState, type StoredState } from "./schema.js";
import {
  LEASE_TIMEOUT_MS,
  type ApplyResult,
  type BeginTickResult,
  type Command,
  type Config,
  type DigestPublisher,
  type FinishTickInput,
  type FinishTickResult,
  type MetaPatch,
  type Store,
  type StoreState,
} from "./types.js";

const STATE_KEY = "state";

export interface RecordsObjectEnv {
  DISCORD_BOT_TOKEN: string;
  DISCORD_GUILD_ID: string;
  /** Optional: unset at runtime until the secret exists. Read only through
   *  `loadConfig`. */
  REVIEW_CHANNEL_IDS?: string;
  DIGEST_CHANNEL_ID?: string;
}

/**
 * All record state in one serialized object. Reads and writes below use
 * DO-internal `ctx.storage`, which does NOT count against the invoking worker's
 * subrequest ceiling — which is what holds the "at most two store subrequests per
 * tick" invariant regardless of record count.
 */
export class RecordsObject extends DurableObject<RecordsObjectEnv> implements Store {
  private loadedConfig: Config | null = null;

  /**
   * Read from this instance's own env, not handed over by the Worker: the
   * channel IDs are Worker secrets, and a DO sees the same bindings. Lazy
   * rather than built in the constructor, so a bad secret fails only the calls
   * that need channels: `readState`, which `/health` and `/stats` use, never
   * reads it, and those routes stay up to diagnose the bad secret. Memoized
   * because `env` cannot change under a live instance.
   *
   * Callers read it before entering `blockConcurrencyWhile`, never inside: a
   * `ConfigError` thrown inside that callback resets the whole object rather
   * than failing the one call.
   */
  private get config(): Config {
    this.loadedConfig ??= loadConfig(this.env);
    return this.loadedConfig;
  }

  /**
   * A lazily-built module-level default, not per-instance mutable state that
   * only a test ever sets: DO instances are evicted between requests, so an
   * RPC-based "inject once" scheme can hit a fresh instance with no factory
   * set. `setPublisherFactory` exists purely as a test override — the real
   * production factory is built from `this.env` the first time it's needed,
   * so eviction between requests can never leave an instance without one.
   */
  private publisherFactory: ((env: RecordsObjectEnv, config: Config) => DigestPublisher) | null = null;

  /** Test-only override. */
  setPublisherFactory(factory: (env: RecordsObjectEnv, config: Config) => DigestPublisher): void {
    this.publisherFactory = factory;
  }

  /** Builds the real Discord-backed publisher from this instance's own env,
   *  unless a test has already installed an override via
   *  `setPublisherFactory`. Called lazily (not in the constructor) so a test
   *  override set after construction still wins. */
  private ensurePublisher(): void {
    if (this.publisherFactory !== null) return;
    this.publisherFactory = (env, config) =>
      makeDigestPublisher(new DiscordRest(env.DISCORD_BOT_TOKEN), env.DISCORD_GUILD_ID, config);
  }

  private publisher(): DigestPublisher {
    this.ensurePublisher();
    // Non-null: ensurePublisher() just guaranteed it above.
    return this.publisherFactory!(this.env, this.config);
  }

  /**
   * Every read of persisted state goes through `migrateState`, so no caller can
   * see a shape an older deploy wrote — today, stamping `schemaVersion: 1` onto
   * unversioned state and then walking it forward to the current version. The
   * call site is what makes the seam real for the next shape change.
   */
  private async load(): Promise<StoreState> {
    const stored = await this.ctx.storage.get<StoredState>(STATE_KEY);
    return stored === undefined ? emptyState() : migrateState(stored);
  }

  private async save(state: StoreState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }

  async beginTick(now: number): Promise<BeginTickResult> {
    const config = this.config;
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.load();
      const lease = state.meta.syncLease;
      if (lease !== null && now - lease.heldSince < LEASE_TIMEOUT_MS) {
        return { acquired: false as const, reason: "lease-held" as const, heldSince: lease.heldSince };
      }
      const taken = applyCommands(state, [{ kind: "setMeta", patch: { syncLease: { heldSince: now } } }], config).state;
      await this.save(taken);
      return { acquired: true as const, state: taken };
    });
  }

  async finishTick(input: FinishTickInput): Promise<FinishTickResult> {
    const config = this.config;
    // Commit this tick's own mutations first, and durably, before any Discord
    // I/O — this is its own short blockConcurrencyWhile, not the long one
    // below that would serialise interactive handlers behind a network call.
    const appliedCommands = await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.load();
      const next = applyCommands(state, input.commands, config);
      await this.save(next.state);
      return next;
    });

    // NOT wrapped in blockConcurrencyWhile: this does outbound Discord I/O, and
    // blocking the object for the duration would serialise interactive handlers
    // behind a network call. commitTick reads `appliedCommands.state` as it was
    // the instant we got here, purely to decide what to render and publish.
    // `persist` writes DURABLY and immediately, inside its own short
    // blockConcurrencyWhile: this instance can be evicted between requests, so
    // an id held only in memory (or only in the returned patch) is an id a
    // rejected daily post loses — and the next tick then posts a second digest.
    const outcome = await commitTick(appliedCommands.state, input.now, config, this.publisher(), (patch) =>
      this.ctx.blockConcurrencyWhile(async () => {
        const fresh = await this.load();
        await this.save(applyCommands(fresh, [{ kind: "setMeta", patch }], config).state);
      }),
    );

    // Re-read the CURRENT state and merge only the decided meta patch onto it —
    // not the pre-I/O snapshot commitTick was handed. An apply() RPC can have
    // committed to storage at any of commitTick's awaits; a whole-state
    // write-back built from that stale snapshot would silently discard it. The
    // body hash is compare-and-set against what is durably stored right now,
    // inside the same blockConcurrencyWhile as the write, so no apply() can slip
    // between the check and the write.
    await this.ctx.blockConcurrencyWhile(async () => {
      const fresh = await this.load();
      const patch: MetaPatch = { ...outcome.metaPatch };
      if (outcome.newBodyHash !== null) {
        Object.assign(
          patch,
          digestHashWriteBack(fresh.meta.digestBodyVersion, outcome.expectedBodyVersion, outcome.newBodyHash),
        );
      }
      // The fenced release rides along in the same apply, after the patch, so
      // finishTick still costs the caller exactly one store subrequest.
      await this.save(applyCommands(fresh, tickWriteBack(patch, input.leaseHeldSince), config).state);
    });

    return { results: appliedCommands.results, digest: outcome.digest, dailyPosted: outcome.dailyPosted };
  }

  async apply(commands: Command[], opts: { now: number; rerender: boolean }): Promise<ApplyResult> {
    const config = this.config;
    const applied = await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.load();
      const next = applyCommands(state, commands, config);
      await this.save(next.state);
      return next;
    });

    if (!opts.rerender) return { results: applied.results, digest: null };

    const state = await this.load();
    const { digest, newHash, expectedVersion } = await renderAndPatch(state, opts.now, config, this.publisher());
    if (newHash !== null) {
      await this.ctx.blockConcurrencyWhile(async () => {
        const fresh = await this.load();
        const patch = digestHashWriteBack(fresh.meta.digestBodyVersion, expectedVersion, newHash);
        await this.save(applyCommands(fresh, [{ kind: "setMeta", patch }], config).state);
      });
    }
    return { results: applied.results, digest };
  }

  async readState(): Promise<StoreState> {
    return this.load();
  }
}
