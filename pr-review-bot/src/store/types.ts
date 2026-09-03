import type { Config } from "../../config/config.js";
import type { PrSnapshot } from "../core/exit.js";
import type { NewScannedInput, PrRecord, RequestFields } from "../core/record.js";
import type { ParsedPr } from "../core/urls.js";
import type { PrdCache } from "../core/prd.js";
import type { SubmittedValues } from "../core/submit.js";
import type { Reactor } from "../core/reactions.js";

export interface Meta {
  lastSync: number | null;
  digestMessageId: string | null;
  digestBodyHash: string | null;
  /**
   * How many times `digestBodyHash` has been written, ever. The compare half of
   * the digest compare-and-set (`digestHashWriteBack`) is done on THIS, not on
   * the hash value.
   *
   * A writer that reads hash `A`, does its Discord I/O, and comes back to find
   * `A` still stored cannot conclude that nothing happened: three ordinary
   * interactions can move the stored hash away from `A` and back to `A` inside
   * one PATCH round-trip, because the digest renders a coarse projection of each
   * record (`renderDigest` never reads `resolvedAt`, `resolutionHistory` or
   * `claimedAt`, so reopening a row the tick just cleared renders identically to
   * before the tick cleared it). The value-based compare then passes spuriously
   * and stores a hash for a body the message is not showing — and the next tick
   * re-derives that same body from unchanged GitHub data, matches the stored
   * hash, and reports `skipped-unchanged`, so there is no later compare to fail
   * into `null`. ABA, ending in a permanently stale digest.
   *
   * A counter that only ever increases cannot come back round, so the same
   * interleaving is caught structurally rather than probabilistically.
   *
   * NOT patchable by callers: `setMeta`'s patch type (`MetaPatch`) excludes it
   * and `applyOne` derives it, so it is impossible to write the hash without
   * moving the counter — which is the whole guarantee. It nonetheless lives in
   * `Meta` rather than beside `schemaVersion`, unlike the schema version:
   * `schemaVersion` describes the persisted envelope, while this describes the
   * digest, and it has to move in the same atomic write as the field it guards.
   */
  digestBodyVersion: number;
  /** Cleared by any tick that observes the digest pinned, so a second unpinning
   *  weeks later is reported like the first. */
  unpinnedReportedAt: number | null;
  /** YYYY-MM-DD in the configured timezone. Keeps the daily post to once a day. */
  lastDailyPostDate: string | null;
  /** channelId -> last fully processed message id. */
  scanCursors: Record<string, string>;
  /** channelId -> where an unfinished BACKWARD walk resumes. Present only while
   *  a first-run backfill is still working its way back through the lookback
   *  window; a channel is absent once that window is fully walked. Without it a
   *  page-capped first run abandons the older remainder of the window
   *  permanently, because every later tick pages forward from the newest id. */
  scanBackfill: Record<string, string>;
  /** Requires an atomic take, which is why it lives here and not in KV. */
  syncLease: { heldSince: number } | null;
  /** The PRD dropdown's source, refreshed by step 7. Null before the first
   *  successful refresh — the modal then offers only "None" and says so, rather
   *  than refusing to open. */
  prdCache: PrdCache | null;
  /** interactionId -> a rejected submission's values, for the "Fix and retry"
   *  button. Pruned and capped on WRITE (see the `stashSubmission` command),
   *  never by a tick: `purgeResolved` filters `records` and never reads `meta`,
   *  and a tick-driven sweep would not run at all when a tick is turned away
   *  with `lease-held`, nor under READ_ONLY. */
  retryStash: Record<string, StashedSubmission>;
}

/**
 * What a `setMeta` command may change. Everything in `Meta` except
 * `digestBodyVersion`, which `applyOne` derives from the patch itself: any patch
 * carrying `digestBodyHash` increments it.
 *
 * Excluding it here is a GUARDRAIL, not a proof. It stops a call site naming the
 * field directly, and that is worth having — but it is not a type-level
 * guarantee: a value typed `Partial<Meta>` is structurally assignable to this,
 * so a caller holding one can still slip the field through. What actually keeps
 * "every write of the hash moves the counter" true is that `applyOne` derives
 * the counter AFTER spreading the patch, so a caller-supplied value cannot
 * survive — plus the test that pins that ordering. If you reorder the spread,
 * that test is the only thing standing between you and a silent ABA hole.
 */
export type MetaPatch = Partial<Omit<Meta, "digestBodyVersion">>;

export interface StashedSubmission {
  userId: string;
  values: SubmittedValues;
  expiresAt: number;
}

export interface StoreState {
  /** Which version of this shape the stored object is. Read on load by
   *  `migrateState` in `src/store/schema.ts`, which is the only place that may
   *  change it. Any change to the persisted shape must bump
   *  `CURRENT_SCHEMA_VERSION` and add a migration step there. */
  schemaVersion: number;
  records: Record<string, PrRecord>;
  meta: Meta;
}

/** The version `emptyState()` writes and `migrateState()` upgrades to. Lives
 *  here, next to `LEASE_TIMEOUT_MS`, for the same reason: both `Store`
 *  implementations import it so they cannot drift apart. Version 1 is the
 *  pre-deploy baseline; version 2 added `Meta.digestBodyVersion`; version 3
 *  added `Meta.prdCache` and `Meta.retryStash`; version 4 added the three
 *  reaction fields to every RECORD — the first migration to touch `records`
 *  rather than `meta`. */
export const CURRENT_SCHEMA_VERSION = 4;

export type Command =
  | { kind: "upsertScanned"; input: NewScannedInput; now: number }
  | {
      kind: "upsertRequest";
      pr: ParsedPr;
      at: number;
      fields: RequestFields;
      title: string;
      prAuthorLogin: string | null;
      isDraft: boolean;
    }
  /**
   * Writes the posted request message's id onto an existing record and nothing
   * else. It exists because the alternative — a second `upsertRequest` — routes
   * through `markRequested`, which advances `lastRequestedAt` and increments
   * `requestCount`. That would land a first-time request at `requestCount: 2`
   * and move the very field the digest's staleness fence compares against, so a
   * claim on the digest that was just rendered would fail as `stale`.
   *
   * Step 8 also uses this to CLEAR the id, passing `messageId: null`, when
   * Discord reports the reaction target message gone (10008): the record
   * survives, the digest row keeps its place and loses its link, and the
   * record drops out of the polling set for good.
   */
  | { kind: "setRequestMessageId"; id: string; messageId: string | null }
  /**
   * Stashes a rejected submission's values for the "Fix and retry" button,
   * pruning expired entries and capping the map in the same atomic step.
   *
   * A command rather than a `setMeta` patch precisely because of that
   * read-modify-write: building the new map in the handler and shipping it as a
   * patch would lose any entry a concurrent tick wrote in between.
   */
  | { kind: "stashSubmission"; key: string; entry: StashedSubmission; now: number }
  | { kind: "applySnapshot"; id: string; snapshot: PrSnapshot; now: number }
  | { kind: "markSyncPaused"; id: string; at: number }
  /**
   * Refresh-loop step 8. Carries the reactor list as OBSERVED by the tick; the
   * store does the diffing, against committed state.
   *
   * The diff is not done in the handler for the same reason step 9 re-reads
   * before rendering: a menu claim landing between `beginTick` and `finishTick`
   * must win, and it only does if the arbitration reads what was committed.
   *
   * There is deliberately no `expectLastRequestedAt` staleness check, unlike
   * `claim` and `resolve`. That check exists because a select menu's options are
   * only as fresh as the reader's Discord client; a reaction is read live from
   * the message and has no rendered option to go stale against.
   */
  | { kind: "reactionSync"; id: string; reactors: Reactor[] | null; now: number }
  | {
      kind: "claim";
      id: string;
      userId: string;
      displayName: string;
      at: number;
      /** From the menu option value. Null skips the staleness check. */
      expectLastRequestedAt: number | null;
    }
  | { kind: "unclaim"; id: string; userId: string }
  | {
      kind: "resolve";
      id: string;
      by: string;
      at: number;
      expectLastRequestedAt: number | null;
    }
  | { kind: "reopen"; id: string; at: number }
  | { kind: "clearStaleClaims"; now: number }
  | { kind: "purgeResolved"; now: number }
  | { kind: "setMeta"; patch: MetaPatch }
  /**
   * Fenced lease release: clears `syncLease` only if the lease still belongs to
   * the releaser. `heldSince` is the identity — `beginTick` stamps it from the
   * caller's `now`, and wall-clock `now` cannot repeat across two acquisitions
   * of one object's lease (a second holder can only exist once the first lease
   * has aged past `LEASE_TIMEOUT_MS`), so it is unique per acquisition.
   *
   * An unconditional release lets a tick whose lease already expired clear a
   * lease now held by a DIFFERENT tick, which un-serialises the two.
   */
  | { kind: "releaseLease"; heldSince: number };

export type CommandResult =
  | { kind: "ok" }
  | { kind: "created" }
  | { kind: "updated" }
  | { kind: "skipped-resolved" }
  | { kind: "stale" }
  | { kind: "already-claimed"; byName: string }
  | { kind: "not-found" }
  | { kind: "not-open" }
  | { kind: "count"; count: number }
  /** `id` is carried explicitly rather than recovered by index from the command
   *  list: the DM names the PR, and `resultCounters` is a standing demonstration
   *  of how easy index-alignment is to get subtly wrong. */
  | {
      kind: "reaction-sync";
      id: string;
      claimed: string[];
      released: string[];
      superseded: { userId: string; byName: string }[];
    };

export type DigestPayload = {
  embeds: { color: number; description: string }[];
  components: unknown[];
};

/** The store's seam to Discord. The PATCH happens inside the store so the record,
 *  the message and the body hash are all written by the same tick. */
export interface DigestPublisher {
  listPinnedMessageIds(): Promise<string[]>;
  patchDigest(messageId: string, payload: DigestPayload): Promise<{ ok: true } | { ok: false; status: number }>;
  createDigest(payload: DigestPayload): Promise<{ ok: true; messageId: string } | { ok: false; status: number }>;
  postDaily(content: string): Promise<{ ok: true; messageId: string } | { ok: false; status: number }>;
  messageUrl(messageId: string): string;
}

/** A tick that finds a live lease younger than this exits immediately without
 *  writing. Cron gives no overlap prevention. Exported here — not derived from
 *  `config.refreshIntervalMs` — because this value tracks Cloudflare's scheduled
 *  wall-clock limit, not the tick interval; coupling them would let a future
 *  interval change silently move a platform bound. `memory.ts` and `do.ts` both
 *  import this constant so the two implementations cannot drift apart. */
export const LEASE_TIMEOUT_MS = 15 * 60_000;

export type BeginTickResult =
  | { acquired: true; state: StoreState }
  | { acquired: false; reason: "lease-held"; heldSince: number };

export interface FinishTickInput {
  commands: Command[];
  now: number;
  /**
   * `heldSince` of the lease the caller took at `beginTick` — i.e. the `now` it
   * passed there, read back off the returned snapshot. `finishTick` releases the
   * lease, and the release is FENCED against this value.
   *
   * It has to arrive from the caller and cannot be read from stored state: the
   * whole case being guarded is a tick that overran `LEASE_TIMEOUT_MS`, by which
   * point the lease in the store is a *newer* tick's. Reading it at commit time
   * would fence against the interloper's own identity and clear its lease, which
   * is the unconditional release wearing a disguise.
   */
  leaseHeldSince: number;
}

export interface DigestOutcome {
  action: "patched" | "created" | "skipped-unchanged" | "failed" | "unpinned-reported";
  bodyHash: string;
  openCount: number;
  renderedCount: number;
}

export interface FinishTickResult {
  results: CommandResult[];
  digest: DigestOutcome;
  dailyPosted: boolean;
}

export interface ApplyResult {
  results: CommandResult[];
  digest: DigestOutcome | null;
}

export interface Store {
  /** Takes the lease atomically and returns a snapshot. One subrequest. */
  beginTick(now: number): Promise<BeginTickResult>;
  /**
   * Applies mutations, RE-READS, renders, PATCHes, stores the hash on success,
   * posts the daily message if due, and releases the lease. One subrequest.
   */
  finishTick(input: FinishTickInput): Promise<FinishTickResult>;
  /** The interactive path: apply atomically and optionally re-render. */
  apply(commands: Command[], opts: { now: number; rerender: boolean }): Promise<ApplyResult>;
  /** Read-only, for the health endpoint and /review-list. */
  readState(): Promise<StoreState>;
}

export type { Config };
