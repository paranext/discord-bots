import type { PrRecord } from "../core/record.js";
import { CURRENT_SCHEMA_VERSION, type Meta, type StashedSubmission, type StoreState } from "./types.js";

/**
 * `Meta` as some *earlier* deploy could have written it: every field the current
 * shape has changed, widened to also admit the older form. `digestBodyVersion`
 * was added in version 2, so version-1 state does not have it; `prdCache` was
 * added in version 3 and retired in version 5, which keeps it only as a `null`
 * tombstone (see the 4 → 5 step). Stashed values before version 5 carry
 * `prdThreadId`. `scanCursors` and `scanBackfill` were in `Meta` until version
 * 6, which keeps both only as `{}` tombstones (see the 5 → 6 step).
 *
 * Widening rather than versioning per field is deliberate and has a known limit:
 * a field the current shape has *removed* has to be re-added here as optional,
 * and a renamed one appears under both names. That is fine while the list is
 * short; when it stops being short, this type is the thing to split per version.
 */
type StoredMeta = Omit<Meta, "digestBodyVersion" | "retryStash"> & {
  digestBodyVersion?: number;
  /** `unknown` because its type was deleted with it, and nothing reads its
   *  contents: 2 → 3 writes `null`, and from 5 on it is only ever `null`. */
  prdCache?: unknown;
  retryStash?: Record<string, StoredStashedSubmission>;
  scanCursors?: Record<string, string>;
  scanBackfill?: Record<string, string>;
};

/** A `StashedSubmission` as some earlier deploy could have written it: before
 *  version 5 its `values` carried `prdThreadId`. */
type StoredStashedSubmission = Omit<StashedSubmission, "values"> & {
  values: StashedSubmission["values"] & { prdThreadId?: string | null };
};

/**
 * A `PrRecord` as some earlier deploy could have written it. Version 4 added
 * three fields, so version-3 records lack them; version 5 removed
 * `prdThreadId`, so records before it carry it; version 6 removed `source`, so
 * records before it carry it.
 */
type StoredRecord = Omit<PrRecord, "claimSource" | "reactionCheckedAt" | "lastReactors"> & {
  claimSource?: PrRecord["claimSource"];
  reactionCheckedAt?: number | null;
  lastReactors?: string[] | null;
  prdThreadId?: string | null;
  source?: "command" | "scanned";
};

/**
 * The persisted object as some earlier deploy could have written it. Version 1 is
 * the pre-deploy baseline, so the only pre-1 shape that exists is an unversioned
 * one — `schemaVersion` absent. Every future shape change widens this type (or
 * `StoredMeta`) by exactly the fields it changes, and adds one step to
 * `migrateState`.
 */
export type StoredState = Omit<StoreState, "schemaVersion" | "meta" | "records"> & {
  schemaVersion?: number;
  meta: StoredMeta;
  records: Record<string, StoredRecord>;
};

/**
 * The type the migration chain walks through: a stored shape that definitely has
 * a version. It is deliberately NOT `StoreState` — a step's intermediate value
 * carries fields the current shape may not have, so typing the local as the
 * current shape would reject exactly the migrations this seam exists for. The
 * chain therefore ends in one narrowing cast at the `return`, which is sound
 * because the last step by construction produces `CURRENT_SCHEMA_VERSION`.
 */
type MigratingState = Omit<StoreState, "schemaVersion" | "meta" | "records"> & {
  schemaVersion: number;
  meta: StoredMeta;
  records: Record<string, StoredRecord>;
};

/**
 * The one place a Durable Object schema migration goes.
 *
 * Called on every load, before anything reads the state: it takes whatever an
 * earlier version of this Worker wrote and returns state at
 * `CURRENT_SCHEMA_VERSION`.
 *
 * The rule (see `adr-durable-object-schema-version` in
 * `docs/architecture-decisions.md`): **any change to the persisted state shape
 * must bump `CURRENT_SCHEMA_VERSION` and add a step below.** Steps are a chain,
 * each upgrading exactly one version and falling through to the next, so state
 * written three versions ago walks forward through every step instead of needing
 * a direct conversion per (from, to) pair.
 *
 * How to add a step, concretely — this matters because the obvious spelling does
 * not compile:
 *
 * - Reassign `state`; it is a `let` for that reason (a `const` gives `TS2588`).
 * - Widen `StoredMeta` (or `StoredState`) by the fields the change touches, so
 *   the *old* shape stays expressible. Without that, old state becomes
 *   untypeable and the step has nothing to read.
 * - A step may produce an intermediate that is not yet a valid `StoreState`;
 *   `MigratingState` is what makes that legal. The cast at the `return` is the
 *   single place that asserts the chain finished.
 */
export function migrateState(stored: StoredState): StoreState {
  // A version HIGHER than this build knows is a rollback, and the only correct
  // response is to refuse. Cloudflare rollbacks are one click and are the
  // standard response to a bad release: version N+1 ships, runs for an hour,
  // writes state in a shape this build cannot parse, and gets rolled back. With
  // no guard, `stored.schemaVersion ?? 1` yields N+1, no step matches, and the
  // unknown shape is handed to every caller as if it were current — and then
  // written straight back on the first `save()`, still labelled N+1, with
  // whatever this build put on top of it. Silent, and unrecoverable by the
  // roll-forward that would otherwise have fixed everything.
  //
  // Throwing is the cheap outcome: `beginTick` fails, cron retries in five
  // minutes, and the state is intact when the newer version returns. Refusing to
  // serve beats corrupting state written by a version we cannot understand.
  const storedVersion = stored.schemaVersion ?? 1;
  if (storedVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Stored state is at schema version ${storedVersion}, newer than this build's ${CURRENT_SCHEMA_VERSION}. ` +
        "This is a rollback: roll forward rather than letting an older build rewrite newer state.",
    );
  }

  let state: MigratingState = {
    // Unversioned → 1. Anything written before `schemaVersion` existed IS the
    // version 1 shape by definition: version 1 was frozen before the first
    // deploy, so no other unversioned shape was ever written.
    //
    // The literal `1` here is deliberate and must NOT be replaced with
    // `CURRENT_SCHEMA_VERSION`: it records the historical fact "the unversioned
    // shape is version 1", not "whatever the current version happens to be".
    // Writing the constant would make a future bump silently relabel old state
    // as current and skip every step below it.
    ...stored,
    schemaVersion: stored.schemaVersion ?? 1,
  };

  // 1 → 2: `Meta.digestBodyVersion` appeared, the monotonic counter the digest
  // compare-and-set compares on. Version-1 state has no counter, and 0 is the
  // right start: the counter's only job is to differ from itself after a write,
  // and every writer reads it before it compares, so where it starts is
  // immaterial as long as it starts somewhere and only ever increases.
  if (state.schemaVersion === 1) {
    state = {
      ...state,
      schemaVersion: 2,
      meta: { ...state.meta, digestBodyVersion: 0 },
    };
  }

  // 2 → 3: `Meta.prdCache` and `Meta.retryStash` appeared. Both default to
  // "nothing cached, nothing stashed", which is exactly the state a fresh
  // deploy was in. Historical, as of version 3: the readers then were the
  // modal, which offered only "None" until the since-retired step 7 first
  // succeeded, and the stash, where an absent key is the same as an expired one.
  if (state.schemaVersion === 2) {
    state = {
      ...state,
      schemaVersion: 3,
      meta: { ...state.meta, prdCache: state.meta.prdCache ?? null, retryStash: state.meta.retryStash ?? {} },
    };
  }

  // 3 → 4: every record gained `claimSource`, `reactionCheckedAt` and
  // `lastReactors`. `lastReactors: null` is the deploy behaviour and is chosen,
  // not incidental: null means unprimed, so the first poll of each record
  // records who is standing on its message and claims for nobody. Seeding `[]`
  // instead would read every reaction that already exists in the channel as
  // newly present and claim retroactively — parking rows in Being reviewed
  // under names that are wrong for a fresh 48 hours, and fanning DMs out to
  // many users in a few minutes, which is the pattern Discord's Create DM docs
  // warn can get a bot blocked from opening DMs.
  if (state.schemaVersion === 3) {
    const records: Record<string, StoredRecord> = {};
    for (const [id, record] of Object.entries(state.records)) {
      records[id] = {
        ...record,
        claimSource: record.claimedBy !== null ? "menu" : null,
        reactionCheckedAt: null,
        lastReactors: null,
      };
    }
    state = { ...state, schemaVersion: 4, records };
  }

  // 4 → 5: the PRD field was removed when the bot moved to the public server
  // only (the PRD forum lived on a server it no longer reaches). Every record's
  // and every stashed retry's `prdThreadId` is deleted. `prdCache` is NOT
  // deleted but set to `null`: while a deploy rolls out, Worker processes on the
  // old build still serve interactions against this state, and the old modal
  // builder treats `null` as "cold cache, offer only None" but crashes on
  // `undefined`. The tombstone costs a few bytes and keeps that window safe.
  if (state.schemaVersion === 4) {
    state = { ...stripRetiredPrd(state), schemaVersion: 5 };
  }

  // 5 → 6: the channel scan was removed, and /review-request became the only
  // way a PR reaches the digest. Every record the scan created
  // (`source: "scanned"`) is deleted — nobody asked for those reviews, so
  // carrying them forward would keep rows on the digest that no command put
  // there — and `source` is deleted from the rest, since every record is now a
  // command record. `scanCursors` and `scanBackfill` are NOT deleted but set to
  // `{}`: while a deploy rolls out, Worker processes on the old build still run
  // the scan against this state, and the old scan reads `cursors[channelId]`
  // with no fallback, so it crashes on an absent map but treats an empty one as
  // a channel it has not walked yet. Same reasoning as the `prdCache` tombstone.
  if (state.schemaVersion === 5) {
    state = { ...stripRetiredScan(state), schemaVersion: 6 };
  }

  // Every version, every load: the same strips again. An old-build tick that
  // was already running when the deploy landed can still commit through the new
  // Durable Object — writing a full `prdCache` back with `setMeta`, a
  // `prdThreadId` onto a record with `markRequested`, or the scan's advanced
  // cursors with `setMeta` — into state already stamped with the new version,
  // which the steps above never revisit. Re-running the strips here means
  // anything such a write leaves behind is gone on the next load.
  //
  // What an old-build scan can actually get committed is narrower than that
  // list suggests. If its batch carries any `upsertScanned` — likely, since
  // the `{}` tombstone reads to the old scan as an unwalked channel and it
  // backfills the whole lookback window — the new `applyOne` has no case for
  // it, `applyCommands` throws, and `finishTick` rejects the WHOLE batch
  // before `save`: nothing is written, cursors included. That is a loud
  // failure, not a silent drop. The old tick's own `finally` then releases
  // its lease with a separate `releaseLease`; only if that release fails too
  // does the lease stay held until `LEASE_TIMEOUT_MS`, turning the next
  // new-build ticks away with `lease-held` until it ages out. Either way the
  // next new-build tick to take the lease recovers with state intact. An old
  // scan that found no PR links has no `upsertScanned` to trip on, so its
  // batch commits and writes its cursors back — which is what the cursor half
  // of this re-run resets. The scanned-record half re-runs too, so that
  // dropping those records does not rest on `applyOne` continuing to reject
  // `upsertScanned`.
  state = stripRetiredScan(stripRetiredPrd(state));

  // Sound because the last step above produces CURRENT_SCHEMA_VERSION, and
  // anything higher was refused before the chain ran.
  return state as StoreState;
}

/**
 * Removes every stored PRD value: `prdThreadId` from each record and each
 * stashed retry's values, and `prdCache` collapsed to its `null` tombstone when
 * present (left absent when absent — state created at version 5 never had it).
 */
function stripRetiredPrd(state: MigratingState): MigratingState {
  // This runs on every load, so state with nothing to strip — every load once
  // the rollout window has passed — is returned as is rather than copied.
  const dirty =
    (state.meta.prdCache !== undefined && state.meta.prdCache !== null) ||
    Object.values(state.records).some((record) => "prdThreadId" in record) ||
    Object.values(state.meta.retryStash ?? {}).some((entry) => "prdThreadId" in entry.values);
  if (!dirty) return state;

  const records: Record<string, StoredRecord> = {};
  for (const [id, record] of Object.entries(state.records)) {
    const { prdThreadId: _prd, ...rest } = record;
    records[id] = rest;
  }
  const retryStash: Record<string, StoredStashedSubmission> = {};
  for (const [key, entry] of Object.entries(state.meta.retryStash ?? {})) {
    const { prdThreadId: _prd, ...values } = entry.values;
    retryStash[key] = { ...entry, values };
  }
  const meta: StoredMeta = { ...state.meta, retryStash };
  if ("prdCache" in meta) meta.prdCache = null;
  return { ...state, records, meta };
}

/**
 * Removes every stored trace of the channel scan: each record the scan created,
 * `source` from every remaining record, and both scan maps reduced to their `{}`
 * tombstones. Unlike `prdCache`, the tombstones are written even when absent,
 * because the old scan indexes into both maps unconditionally. `emptyState()`
 * does not carry them, and does not need to: a Durable Object with no stored
 * state has never been touched by an old build, so no old build is rolling out
 * against it. Its first save is followed by a load, which adds them here.
 */
function stripRetiredScan(state: MigratingState): MigratingState {
  // Skipped on clean state for the same reason as `stripRetiredPrd`.
  const isTombstone = (map: Record<string, string> | undefined): boolean =>
    map !== undefined && Object.keys(map).length === 0;
  const dirty =
    !isTombstone(state.meta.scanCursors) ||
    !isTombstone(state.meta.scanBackfill) ||
    Object.values(state.records).some((record) => "source" in record);
  if (!dirty) return state;

  const records: Record<string, StoredRecord> = {};
  for (const [id, record] of Object.entries(state.records)) {
    const { source, ...rest } = record;
    if (source === "scanned") continue;
    records[id] = rest;
  }
  return { ...state, records, meta: { ...state.meta, scanCursors: {}, scanBackfill: {} } };
}
