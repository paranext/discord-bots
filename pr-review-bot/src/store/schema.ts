import { CURRENT_SCHEMA_VERSION, type Meta, type StoreState } from "./types.js";

/**
 * `Meta` as some *earlier* deploy could have written it: every field the current
 * shape has changed, widened to also admit the older form. Today that is exactly
 * `digestBodyVersion`, added in version 2, so version-1 state does not have it.
 *
 * Widening rather than versioning per field is deliberate and has a known limit:
 * a field the current shape has *removed* has to be re-added here as optional,
 * and a renamed one appears under both names. That is fine while the list is
 * short; when it stops being short, this type is the thing to split per version.
 */
type StoredMeta = Omit<Meta, "digestBodyVersion"> & { digestBodyVersion?: number };

/**
 * The persisted object as some earlier deploy could have written it. Version 1 is
 * the pre-deploy baseline, so the only pre-1 shape that exists is an unversioned
 * one — `schemaVersion` absent. Every future shape change widens this type (or
 * `StoredMeta`) by exactly the fields it changes, and adds one step to
 * `migrateState`.
 */
export type StoredState = Omit<StoreState, "schemaVersion" | "meta"> & {
  schemaVersion?: number;
  meta: StoredMeta;
};

/**
 * The type the migration chain walks through: a stored shape that definitely has
 * a version. It is deliberately NOT `StoreState` — a step's intermediate value
 * carries fields the current shape may not have, so typing the local as the
 * current shape would reject exactly the migrations this seam exists for. The
 * chain therefore ends in one narrowing cast at the `return`, which is sound
 * because the last step by construction produces `CURRENT_SCHEMA_VERSION`.
 */
type MigratingState = Omit<StoreState, "schemaVersion" | "meta"> & {
  schemaVersion: number;
  meta: StoredMeta;
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

  // Sound because the last step above produces CURRENT_SCHEMA_VERSION, and
  // anything higher was refused before the chain ran.
  return state as StoreState;
}
