# `:code_review:` Reaction Claims Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build refresh-loop step 8 — reading `:code_review:` reactions under a per-tick budget so that adding the reaction claims a PR review and removing it hands the review back.

**Architecture:** Each polled record stores the reactor ids seen at its last poll (`lastReactors`); every poll diffs the freshly observed set against it, so the tick reasons about *changes* rather than presence. Selection and the diff are pure functions in `src/core/reactions.ts`; the diff is applied inside the store, against committed state, via a new `reactionSync` command appended to the tick's existing command list, so no extra store subrequests are spent and a menu claim landing mid-tick still wins.

**Tech Stack:** TypeScript on Cloudflare Workers, Durable Object storage, Vitest (two projects: `core` for `tests/core/**` and `tests/store/**`, `workers` for `tests/workers/**` under `@cloudflare/vitest-plugin`), Discord REST v10.

**Spec:** [`docs/superpowers/specs/2026-09-03-reaction-claims-design.md`](../specs/2026-09-03-reaction-claims-design.md)

**Plan scope:** Plan 3 of 3. It completes refresh-loop step 8 and the reaction claim path. Everything else in the v1 spec is already built by plans 1 and 2.

## Global Constraints

- **`src/core/**` has no I/O and no global `Date`.** `eslint.config.js` enforces this with `no-restricted-globals`. Every core function takes `now` as an explicit argument. `npm run lint` fails otherwise.
- **At most two store subrequests per tick.** `beginTick` and `finishTick`. Step 8 must not add a third — it appends commands to the list `finishTick` already receives.
- **`SUBREQUEST_CEILING` is 50** (Cloudflare free plan, per invocation). `RESERVE` is **5**: one for `finishTick` plus four for the two-DM allowance.
- **Reaction reads use `limit=25`**, issued **sequentially**, never fanned out. This bounds the CPU half of the budget rationale (10 ms per scheduled invocation on the free plan).
- **DM cap is 2 per tick.** Further superseded reactors are logged, not DM'd.
- **Failure handling branches on Discord's JSON error `code`, never on the HTTP status.** `10008` (Unknown Message) is the only branch that mutates state; `10014` (Unknown Emoji) must change nothing.
- **Every path that clears `claimedBy` clears `claimSource`.** `applyUnclaim`, `clearStaleClaim`, `resolveRecord`, `markRequested`.
- **Any change to persisted state bumps `CURRENT_SCHEMA_VERSION` and adds one migration step** in `src/store/schema.ts` (`adr-durable-object-schema-version`).
- **Secrets never appear in the repo**, not even as fake placeholders.
- Commands: `npm test` (both projects), `npm test -- --project=core <path>`, `npm test -- --project=workers <path>`, `npm run typecheck`, `npm run lint`.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/core/reactions.ts` | Pure: `selectReactionTargets` (who to poll, in what order) and `syncReactions` (the diff — releases, claims, promotion). No I/O, no clock. |
| `src/discord/reactions.ts` | The read adapter: one reactions call per record, error-code classification, the burst confirmation read. |
| `tests/core/reactions.test.ts` | Selection and diff tests. |
| `tests/workers/reactions.test.ts` | Adapter tests against a stubbed `fetch`. |

**Modified:**

| File | Change |
|---|---|
| `config/config.ts` | `SUBREQUEST_CEILING` constant. |
| `src/core/record.ts` | `ClaimSource` type; three new `PrRecord` fields; `newScannedRecord`, `resolveRecord`, `markRequested` updated. |
| `src/core/claims.ts` | `applyClaim` takes a source; `applyUnclaim` and `clearStaleClaim` clear it. |
| `src/store/types.ts` | `CURRENT_SCHEMA_VERSION` → 4; `reactionSync` command; `reaction-sync` result. |
| `src/store/schema.ts` | Record-shape widening and the 3 → 4 step. |
| `src/store/apply.ts` | `reactionSync` case; `claim` case passes `"menu"`. |
| `src/discord/rest.ts` | `getReactions`, `createDmChannel`. |
| `src/handlers/interactions.ts` | Menu claim passes `"menu"`. |
| `src/handlers/scheduled.ts` | Step 8, the allowance, the DM loop, the new counters, both return sites. |
| `docs/architecture.md`, `docs/architecture-decisions.md`, `docs/operations.md` | Task 9. |

---

### Task 1: Schema version 4 — the three record fields

**Files:**
- Modify: `src/core/record.ts`
- Modify: `src/store/types.ts`
- Modify: `src/store/schema.ts`
- Test: `tests/store/apply.test.ts`, `tests/workers/do.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ClaimSource = "menu" | "reaction"`; `PrRecord.claimSource: ClaimSource | null`, `PrRecord.reactionCheckedAt: number | null`, `PrRecord.lastReactors: string[] | null`; `CURRENT_SCHEMA_VERSION = 4`.

**Why `lastReactors` is nullable:** null means *unprimed* — nothing has been observed since this record entered (or re-entered) the polling set, so no diff is meaningful and the poll must act on nothing. `[]` means *observed, and nobody was reacting*, which is a perfectly good left-hand side for a diff. Conflating the two is what would make a fresh deploy claim retroactively for every standing reaction.

- [ ] **Step 1: Write the failing migration test**

Add to `tests/store/apply.test.ts` (the file already has a `migrateState` describe block — put these beside the existing version tests):

```ts
it("migrates version 3 records to 4, priming the reaction state", () => {
  const claimed = {
    ...newScannedRecord({
      pr: { owner: "paranext", repo: "paranext-core", number: 1 },
      channelId: "c", messageId: "m", messageTimestamp: 1_756_000_000_000,
      title: "PT-1", prAuthorLogin: "jolie", isDraft: false,
    }),
    claimedBy: "u1", claimedByName: "Katherine", claimedAt: 1_756_000_000_000,
  };
  const v3 = {
    schemaVersion: 3,
    records: { "paranext/paranext-core#1": claimed },
    meta: { ...emptyState().meta },
  };

  const migrated = migrateState(v3 as never);

  expect(migrated.schemaVersion).toBe(4);
  const record = migrated.records["paranext/paranext-core#1"]!;
  // Every claim that existed before this deploy was necessarily made from the menu.
  expect(record.claimSource).toBe("menu");
  expect(record.reactionCheckedAt).toBeNull();
  // null, NOT []: the first poll after deploy primes and claims for nobody.
  expect(record.lastReactors).toBeNull();
});

it("leaves claimSource null on an unclaimed record when migrating to 4", () => {
  const open = newScannedRecord({
    pr: { owner: "paranext", repo: "paranext-core", number: 2 },
    channelId: "c", messageId: "m", messageTimestamp: 1_756_000_000_000,
    title: "PT-2", prAuthorLogin: "jolie", isDraft: false,
  });
  const v3 = { schemaVersion: 3, records: { "paranext/paranext-core#2": open }, meta: { ...emptyState().meta } };

  expect(migrateState(v3 as never).records["paranext/paranext-core#2"]!.claimSource).toBeNull();
});

it("still walks unversioned state all the way to 4", () => {
  const v0 = { records: {}, meta: { ...emptyState().meta, digestBodyVersion: undefined } };
  const migrated = migrateState(v0 as never);
  expect(migrated.schemaVersion).toBe(4);
  expect(migrated.meta.digestBodyVersion).toBe(0);
});
```

If the existing file already has an "unversioned state" test asserting `3`, update that one rather than adding a duplicate.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --project=core tests/store/apply.test.ts`
Expected: FAIL — `expect(migrated.schemaVersion).toBe(4)` receives `3`, and `claimSource` is `undefined`.

- [ ] **Step 3: Add the type and the fields**

In `src/core/record.ts`, above `PrRecord`:

```ts
/** How the current claim was made. Decides whether removing a reaction may
 *  release it: a menu claim is released from the menu. */
export type ClaimSource = "menu" | "reaction";
```

Inside `PrRecord`, immediately after the `claimClearedAt` line:

```ts
  /** Null whenever `claimedBy` is null — every path that clears the claim
   *  clears this too. Read it only to decide HOW a claim was made; read
   *  `claimedBy` to decide WHETHER there is one. */
  claimSource: ClaimSource | null;

  /** When refresh-loop step 8 last polled this record's message. The sort key
   *  for oldest-unchecked-first. */
  reactionCheckedAt: number | null;

  /**
   * Reactor ids observed at that poll — the diff's left-hand side.
   *
   * **`null` means UNPRIMED**, and is not the same as `[]`. The diff's whole
   * licence to read a reaction as present-tense intent is that an absence was
   * actually observed in between; across a gap where nothing was observed —
   * a record that left the polling set, or a fresh deploy — that licence does
   * not exist. A null-valued record's next poll writes the observed set and
   * acts on nothing. `[]` means "observed, nobody was reacting", which is a
   * usable left-hand side.
   */
  lastReactors: string[] | null;
```

In `newScannedRecord`, after `claimClearedAt: null,`:

```ts
    claimSource: null,
    reactionCheckedAt: null,
    lastReactors: null,
```

In `resolveRecord`, alongside the existing claim-clearing fields:

```ts
    claimSource: null,
    // A resolved record leaves the polling set, so the next observation after
    // a reopen must prime rather than diff against a months-old snapshot.
    lastReactors: null,
```

In `markRequested`, beside the three claim fields it already nulls:

```ts
    claimSource: null,
```

(`markRequested` deliberately does **not** null `lastReactors`: a re-requested record stays open and unclaimed, so it never leaves the polling set and its observation sequence is unbroken.)

- [ ] **Step 4: Bump the schema version**

In `src/store/types.ts`, replace the `CURRENT_SCHEMA_VERSION` declaration and its comment's final sentence:

```ts
/** The version `emptyState()` writes and `migrateState()` upgrades to. Lives
 *  here, next to `LEASE_TIMEOUT_MS`, for the same reason: both `Store`
 *  implementations import it so they cannot drift apart. Version 1 is the
 *  pre-deploy baseline; version 2 added `Meta.digestBodyVersion`; version 3
 *  added `Meta.prdCache` and `Meta.retryStash`; version 4 added the three
 *  reaction fields to every RECORD — the first migration to touch `records`
 *  rather than `meta`. */
export const CURRENT_SCHEMA_VERSION = 4;
```

- [ ] **Step 5: Widen the stored shapes and add the migration step**

In `src/store/schema.ts`, add above `StoredState`:

```ts
/**
 * A `PrRecord` as some earlier deploy could have written it. Version 4 added
 * three fields, so version-3 records lack them.
 */
type StoredRecord = Omit<PrRecord, "claimSource" | "reactionCheckedAt" | "lastReactors"> & {
  claimSource?: PrRecord["claimSource"];
  reactionCheckedAt?: number | null;
  lastReactors?: string[] | null;
};
```

Import `PrRecord`:

```ts
import type { PrRecord } from "../core/record.js";
```

Replace `StoredState` and `MigratingState` so both widen on `records` as well as `meta`. `MigratingState` inherits `records` at the *current* shape otherwise, which makes the 3 → 4 step's intermediate value untypeable — the trap this file's own doc comment warns about, now reaching `records` for the first time:

```ts
export type StoredState = Omit<StoreState, "schemaVersion" | "meta" | "records"> & {
  schemaVersion?: number;
  meta: StoredMeta;
  records: Record<string, StoredRecord>;
};

type MigratingState = Omit<StoreState, "schemaVersion" | "meta" | "records"> & {
  schemaVersion: number;
  meta: StoredMeta;
  records: Record<string, StoredRecord>;
};
```

Add the step after the 2 → 3 block:

```ts
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
```

- [ ] **Step 6: Fix the one bare record literal in the tests**

`tests/core/record.test.ts` builds a `PrRecord` literal by hand (the other factories spread `newScannedRecord` and need nothing). Add the three fields to it:

```ts
  claimSource: null,
  reactionCheckedAt: null,
  lastReactors: null,
```

- [ ] **Step 7: Run the full suite and the typechecker**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS. `tsc` is what surfaces any remaining `PrRecord` construction site; fix each by adding the three fields with the same defaults.

- [ ] **Step 8: Commit**

```bash
git add src/core/record.ts src/store/types.ts src/store/schema.ts tests/store/apply.test.ts tests/core/record.test.ts
git commit -m "feat: schema v4 — reaction state on every record"
```

---

### Task 2: `claimSource` through the existing claim paths

**Files:**
- Modify: `src/core/claims.ts`
- Modify: `src/store/apply.ts:153-163` (the `claim` case)
- Modify: `src/handlers/interactions.ts:158-167` (the menu claim command)
- Test: `tests/core/claims.test.ts`

**Interfaces:**
- Consumes: `ClaimSource` (Task 1).
- Produces: `applyClaim(r: PrRecord, userId: string, displayName: string, at: number, source: ClaimSource): ClaimOutcome` — note the fifth parameter; every call site must pass it.

- [ ] **Step 1: Write the failing tests**

Add to `tests/core/claims.test.ts`:

```ts
describe("claimSource", () => {
  it("records how the claim was made", () => {
    const menu = applyClaim(record(), "u1", "Katherine", T0, "menu");
    if (menu.kind !== "claimed") throw new Error("unreachable");
    expect(menu.record.claimSource).toBe("menu");

    const reaction = applyClaim(record(), "u1", "Katherine", T0, "reaction");
    if (reaction.kind !== "claimed") throw new Error("unreachable");
    expect(reaction.record.claimSource).toBe("reaction");
  });

  it("unprimes the reaction state on a MENU claim, so a stale reaction cannot inherit the row", () => {
    // The record leaves the polling set the moment it is menu-claimed. Anything
    // that happens to its reactions while it is unpolled is unobserved, so the
    // first poll after it comes back must prime rather than diff.
    const observed = record({ lastReactors: ["u9"] });
    const outcome = applyClaim(observed, "u1", "Katherine", T0, "menu");
    if (outcome.kind !== "claimed") throw new Error("unreachable");
    expect(outcome.record.lastReactors).toBeNull();
  });

  it("keeps the reaction state on a REACTION claim — the same sync just observed it", () => {
    const observed = record({ lastReactors: ["u1"] });
    const outcome = applyClaim(observed, "u1", "Katherine", T0, "reaction");
    if (outcome.kind !== "claimed") throw new Error("unreachable");
    expect(outcome.record.lastReactors).toEqual(["u1"]);
  });

  it("is cleared by every path that clears the claim", () => {
    const held = record({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0, claimSource: "reaction" });

    const unclaimed = applyUnclaim(held, "u1");
    if (unclaimed.kind !== "released") throw new Error("unreachable");
    expect(unclaimed.record.claimSource).toBeNull();

    expect(clearStaleClaim(held, T0 + STALE, STALE).claimSource).toBeNull();
    expect(resolveRecord(held, T0 + HOUR, "github").claimSource).toBeNull();
  });
});
```

Add `resolveRecord` to the existing import from `../../src/core/record.js` if it is not already there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=core tests/core/claims.test.ts`
Expected: FAIL — `applyClaim` takes four arguments, and `claimSource` is `undefined` on the results.

- [ ] **Step 3: Thread the source through `applyClaim`**

In `src/core/claims.ts`, import the type and change the signature:

```ts
import { isOpen, type ClaimSource, type PrRecord } from "./record.js";
```

```ts
export function applyClaim(
  r: PrRecord,
  userId: string,
  displayName: string,
  at: number,
  source: ClaimSource,
): ClaimOutcome {
  if (!isOpen(r)) return { kind: "not-open" };

  if (r.claimedBy !== null && r.claimedBy !== userId) {
    return { kind: "already-claimed", byName: r.claimedByName ?? "someone" };
  }
  // Returns the record UNCHANGED, so an idempotent re-claim cannot repair a
  // wrong `claimSource`. Nothing may depend on it doing so.
  if (r.claimedBy === userId) return { kind: "claimed", record: r };

  return {
    kind: "claimed",
    record: {
      ...r,
      claimedBy: userId,
      claimedByName: displayName,
      claimedAt: at,
      claimSource: source,
      // A menu claim removes the record from the reaction polling set, so the
      // observation sequence breaks here and the next poll after it returns
      // must prime. A reaction claim was itself produced by an observation, so
      // the set the same sync just wrote stays valid.
      lastReactors: source === "menu" ? null : r.lastReactors,
      // A new claim resets the auto-clear markers.
      lastClaimedByName: null,
      claimClearedAt: null,
    },
  };
}
```

- [ ] **Step 4: Clear the source everywhere the claim is cleared**

In `applyUnclaim`'s returned record:

```ts
    record: { ...r, claimedBy: null, claimedByName: null, claimedAt: null, claimSource: null },
```

In `clearStaleClaim`'s returned record, beside the other nulls:

```ts
    claimSource: null,
```

(`resolveRecord` and `markRequested` were done in Task 1.)

- [ ] **Step 5: Update the two production call sites**

`src/store/apply.ts`, the `claim` case — the menu is the only thing that reaches this command:

```ts
      const outcome = applyClaim(existing, command.userId, command.displayName, command.at, "menu");
```

`src/handlers/interactions.ts` needs no signature change (it builds a `claim` command, not a direct call), but confirm by reading it that the menu path still routes through `Command`. It does; no edit is expected there. If `tsc` reports otherwise, pass `"menu"` at that site too.

- [ ] **Step 6: Run the suite**

Run: `npm test && npm run typecheck`
Expected: PASS. Any other `applyClaim` call the typechecker finds gets `"menu"` unless it is the reaction path (which does not exist yet).

- [ ] **Step 7: Commit**

```bash
git add src/core/claims.ts src/store/apply.ts tests/core/claims.test.ts
git commit -m "feat: track how a claim was made, and clear it wherever the claim clears"
```

---

### Task 3: Selecting which records to poll

**Files:**
- Create: `src/core/reactions.ts`
- Test: `tests/core/reactions.test.ts`

**Interfaces:**
- Consumes: `PrRecord` (Task 1).
- Produces: `selectReactionTargets(records: PrRecord[]): string[]` — every eligible record id, in poll order, **unsliced**. The caller applies the allowance, so it can report the eligible count separately.

- [ ] **Step 1: Write the failing tests**

Create `tests/core/reactions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectReactionTargets } from "../../src/core/reactions.js";
import { newScannedRecord, recordId, type PrRecord } from "../../src/core/record.js";

const T0 = 1_756_000_000_000;
const HOUR = 3_600_000;

function record(number: number, overrides: Partial<PrRecord> = {}): PrRecord {
  const base = newScannedRecord({
    pr: { owner: "paranext", repo: "paranext-core", number },
    channelId: "chan",
    messageId: `msg-${number}`,
    messageTimestamp: T0,
    title: `PT-${number}`,
    prAuthorLogin: "jolie",
    isDraft: false,
  });
  return { ...base, ...overrides };
}

describe("selectReactionTargets", () => {
  it("polls never-checked records before checked ones", () => {
    const checked = record(1, { reactionCheckedAt: T0 });
    const never = record(2);
    expect(selectReactionTargets([checked, never])).toEqual([recordId(never), recordId(checked)]);
  });

  it("orders checked records oldest-first, tie-breaking on firstRequestedAt", () => {
    const older = record(1, { reactionCheckedAt: T0 });
    const newer = record(2, { reactionCheckedAt: T0 + HOUR });
    const tie = record(3, { reactionCheckedAt: T0, firstRequestedAt: T0 - HOUR });
    expect(selectReactionTargets([newer, older, tie])).toEqual([
      recordId(tie), recordId(older), recordId(newer),
    ]);
  });

  it("skips records that share a messageId — a single reaction cannot say which PR was meant", () => {
    const a = record(1, { messageId: "shared" });
    const b = record(2, { messageId: "shared" });
    const alone = record(3);
    expect(selectReactionTargets([a, b, alone])).toEqual([recordId(alone)]);
  });

  it("skips resolved records and records with no message", () => {
    const resolved = record(1, { resolvedAt: T0 });
    const noMessage = record(2, { messageId: null });
    const emptyMessage = record(3, { messageId: "" });
    expect(selectReactionTargets([resolved, noMessage, emptyMessage])).toEqual([]);
  });

  it("polls a reaction-claimed record so its release can be detected, but not a menu-claimed one", () => {
    const byReaction = record(1, { claimedBy: "u1", claimSource: "reaction" });
    const byMenu = record(2, { claimedBy: "u1", claimSource: "menu" });
    expect(selectReactionTargets([byReaction, byMenu])).toEqual([recordId(byReaction)]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=core tests/core/reactions.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/reactions.js'`.

- [ ] **Step 3: Write the selector**

Create `src/core/reactions.ts`:

```ts
import { isOpen, recordId, type PrRecord } from "./record.js";

/**
 * Refresh-loop step 8's poll order: every eligible record id, oldest-unchecked
 * first. Deliberately NOT truncated — the caller applies the per-tick allowance
 * and reports the untruncated length, because "how many are eligible" is the
 * number an operator reads the cycle time off, and it is not bounded (see the
 * spec's Known cost: `purgeResolved` only purges RESOLVED records, so an open
 * PR nobody ever reviews stays eligible indefinitely).
 */
export function selectReactionTargets(records: PrRecord[]): string[] {
  // A message that produced two records is skipped entirely: one reaction on it
  // cannot say which PR the reactor meant, claiming both asserts a commitment
  // nobody made, and picking one by iteration order is worse. The digest menu,
  // which names the row, remains available for those.
  const perMessage = new Map<string, number>();
  for (const record of records) {
    if (record.messageId === null || record.messageId === "") continue;
    perMessage.set(record.messageId, (perMessage.get(record.messageId) ?? 0) + 1);
  }

  return records
    .filter((r) => {
      if (!isOpen(r)) return false;
      if (r.messageId === null || r.messageId === "") return false;
      if (perMessage.get(r.messageId) !== 1) return false;
      // Unclaimed, or claimed by a reaction — the latter so that removing the
      // reaction is detectable. A menu claim is invisible to this path by
      // design: no reaction on it can change anything.
      return r.claimedBy === null || r.claimSource === "reaction";
    })
    .sort((a, b) => {
      const left = a.reactionCheckedAt;
      const right = b.reactionCheckedAt;
      if (left !== right) {
        if (left === null) return -1;
        if (right === null) return 1;
        return left - right;
      }
      return a.firstRequestedAt - b.firstRequestedAt;
    })
    .map(recordId);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --project=core tests/core/reactions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/reactions.ts tests/core/reactions.test.ts
git commit -m "feat: choose which records step 8 polls, oldest-unchecked first"
```

---

### Task 4: The diff — releases, claims, promotion

**Files:**
- Modify: `src/core/reactions.ts`
- Test: `tests/core/reactions.test.ts`

**Interfaces:**
- Consumes: `applyClaim`/`applyUnclaim` (Task 2).
- Produces:
  ```ts
  export interface Reactor { id: string; name: string }
  export interface ReactionSyncOutcome {
    record: PrRecord;
    claimed: string[];
    released: string[];
    superseded: { userId: string; byName: string }[];
  }
  export function syncReactions(record: PrRecord, reactors: Reactor[] | null, now: number): ReactionSyncOutcome
  ```
  `reactors: null` means **the read failed** — stamp `reactionCheckedAt` and change nothing else. It is not the same as `[]`, which means "read succeeded, nobody is reacting". Writing `[]` after a failed read would be a lie about an observation that never happened, and the next successful poll would then read every standing reactor as newly present.

**The three rules, in the order they must be applied:**

1. **Releases first.** A removes and B adds between polls: claims-first would hand B an "already claimed by A" notice that is false by the time it lands, and then release to nobody.
2. **Claims** for newly-present reactors.
3. **Promotion** — only if step 1 released — re-runs the claim attempt across everyone still standing on the message. Without it the second reactor is stranded: they were told "already claimed", the claim then went away, and their unchanged reaction can never claim it. Promotion cannot fire on the auto-clear path, because an auto-clear happens in `clearStaleClaims` (step 5) and produces no release inside any sync — which is what keeps "a standing reaction does not silently re-claim two days later" true.

- [ ] **Step 1: Write the failing tests**

Add to `tests/core/reactions.test.ts` (extend the imports with `syncReactions`):

```ts
describe("syncReactions", () => {
  const A = { id: "u1", name: "Katherine" };
  const B = { id: "u2", name: "Ira" };

  it("primes without acting when lastReactors is null", () => {
    const outcome = syncReactions(record(1, { lastReactors: null }), [A], T0);
    expect(outcome.record.lastReactors).toEqual(["u1"]);
    expect(outcome.record.reactionCheckedAt).toBe(T0);
    expect(outcome.record.claimedBy).toBeNull();
    expect(outcome.claimed).toEqual([]);
  });

  it("does not act on the SECOND poll either, if nothing changed after priming", () => {
    const primed = record(1, { lastReactors: ["u1"] });
    expect(syncReactions(primed, [A], T0 + HOUR).record.claimedBy).toBeNull();
  });

  it("claims for a newly present reactor", () => {
    const outcome = syncReactions(record(1, { lastReactors: [] }), [A], T0);
    expect(outcome.record.claimedBy).toBe("u1");
    expect(outcome.record.claimSource).toBe("reaction");
    expect(outcome.claimed).toEqual(["u1"]);
  });

  it("reports the loser when two reactors arrive at once, and claims for the first", () => {
    const outcome = syncReactions(record(1, { lastReactors: [] }), [A, B], T0);
    expect(outcome.record.claimedBy).toBe("u1");
    expect(outcome.superseded).toEqual([{ userId: "u2", byName: "Katherine" }]);
  });

  it("releases when the holder's reaction is gone", () => {
    const held = record(1, {
      lastReactors: ["u1"], claimedBy: "u1", claimedByName: "Katherine",
      claimedAt: T0, claimSource: "reaction",
    });
    const outcome = syncReactions(held, [], T0 + HOUR);
    expect(outcome.record.claimedBy).toBeNull();
    expect(outcome.released).toEqual(["u1"]);
    // Handing a review back on purpose is not the 48-hour auto-clear and must
    // not render as `previously claimed`.
    expect(outcome.record.lastClaimedByName).toBeNull();
    expect(outcome.record.claimClearedAt).toBeNull();
  });

  it("does not release a MENU claim when a reaction disappears", () => {
    const held = record(1, {
      lastReactors: ["u1"], claimedBy: "u1", claimedByName: "Katherine",
      claimedAt: T0, claimSource: "menu",
    });
    expect(syncReactions(held, [], T0 + HOUR).record.claimedBy).toBe("u1");
  });

  it("does not release when the departing reactor is not the holder", () => {
    const held = record(1, {
      lastReactors: ["u1", "u2"], claimedBy: "u1", claimedByName: "Katherine",
      claimedAt: T0, claimSource: "reaction",
    });
    expect(syncReactions(held, [A], T0 + HOUR).record.claimedBy).toBe("u1");
  });

  it("promotes a still-standing reactor when the holder leaves", () => {
    // B reacted, was told it was already claimed, and is still standing on the
    // message. Without promotion B is stranded forever.
    const held = record(1, {
      lastReactors: ["u1", "u2"], claimedBy: "u1", claimedByName: "Katherine",
      claimedAt: T0, claimSource: "reaction",
    });
    const outcome = syncReactions(held, [B], T0 + HOUR);
    expect(outcome.released).toEqual(["u1"]);
    expect(outcome.record.claimedBy).toBe("u2");
    expect(outcome.claimed).toEqual(["u2"]);
  });

  it("applies releases BEFORE claims when one leaves and one arrives in the same poll", () => {
    // Claims-first would tell B "already claimed by Katherine" — false by the
    // time the DM lands — and then release to nobody.
    const held = record(1, {
      lastReactors: ["u1"], claimedBy: "u1", claimedByName: "Katherine",
      claimedAt: T0, claimSource: "reaction",
    });
    const outcome = syncReactions(held, [B], T0 + HOUR);
    expect(outcome.record.claimedBy).toBe("u2");
    expect(outcome.superseded).toEqual([]);
  });

  it("does not report a promoted reactor as superseded — they took no action now", () => {
    const held = record(1, {
      lastReactors: ["u1", "u2", "u3"], claimedBy: "u1", claimedByName: "Katherine",
      claimedAt: T0, claimSource: "reaction",
    });
    const C = { id: "u3", name: "Sam" };
    const outcome = syncReactions(held, [B, C], T0 + HOUR);
    expect(outcome.record.claimedBy).toBe("u2");
    expect(outcome.superseded).toEqual([]);
  });

  it("does not re-claim for a standing reaction after a 48-hour auto-clear", () => {
    // clearStaleClaims (step 5) already cleared the claim this tick. No release
    // happened inside the sync, so nothing promotes, and the unchanged reaction
    // stays unchanged.
    const cleared = record(1, {
      lastReactors: ["u1"], claimedBy: null, claimSource: null,
      lastClaimedByName: "Katherine", claimClearedAt: T0 + HOUR,
    });
    const outcome = syncReactions(cleared, [A], T0 + 2 * HOUR);
    expect(outcome.record.claimedBy).toBeNull();
    expect(outcome.claimed).toEqual([]);
  });

  it("stamps only the check time when the read failed, leaving the observed set alone", () => {
    // null reactors = "we did not see anything". Writing [] here would claim an
    // observation that never happened, and the next successful poll would then
    // read every standing reactor as newly present.
    const primed = record(1, { lastReactors: ["u1"] });
    const outcome = syncReactions(primed, null, T0 + HOUR);
    expect(outcome.record.reactionCheckedAt).toBe(T0 + HOUR);
    expect(outcome.record.lastReactors).toEqual(["u1"]);
    expect(outcome.claimed).toEqual([]);
  });

  it("leaves an unprimed record unprimed when the read failed", () => {
    expect(syncReactions(record(1, { lastReactors: null }), null, T0).record.lastReactors).toBeNull();
  });

  it("stamps the check time and the observed set on every poll, including an empty one", () => {
    const outcome = syncReactions(record(1, { lastReactors: ["u1"] }), [], T0 + HOUR);
    expect(outcome.record.reactionCheckedAt).toBe(T0 + HOUR);
    // The empty SET, not null: this is an observation, and it is what makes the
    // next arrival detectable.
    expect(outcome.record.lastReactors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=core tests/core/reactions.test.ts`
Expected: FAIL — `syncReactions` is not exported.

- [ ] **Step 3: Write the diff**

Append to `src/core/reactions.ts` (add the claims import at the top):

```ts
import { applyClaim, applyUnclaim } from "./claims.js";
```

```ts
/** One person reacting, as the adapter reports them. */
export interface Reactor {
  id: string;
  name: string;
}

export interface ReactionSyncOutcome {
  record: PrRecord;
  /** Users who gained the claim in this sync. */
  claimed: string[];
  /** Users whose claim was released because their reaction is gone. */
  released: string[];
  /** Users whose reaction lost to an existing claim. Only users who ACTED in
   *  this sync appear here — a promoted reactor who loses took no action now
   *  and must not be told anything. */
  superseded: { userId: string; byName: string }[];
}

/**
 * The diff at the heart of the reaction path: not "who is reacting?" but "what
 * changed since the last poll?"
 *
 * A null `lastReactors` means unprimed — nothing has been observed since this
 * record entered the polling set — so the poll records the set and acts on
 * nothing. See `adr-reaction-diff-not-presence`.
 */
export function syncReactions(record: PrRecord, reactors: Reactor[] | null, now: number): ReactionSyncOutcome {
  // A failed read is not an observation. Stamp the check time so the record
  // rotates to the back of the queue, and leave `lastReactors` exactly as it
  // was — writing `[]` here would assert an emptiness nobody saw, and the next
  // successful poll would read every standing reactor as newly present.
  if (reactors === null) {
    return {
      record: { ...record, reactionCheckedAt: now },
      claimed: [], released: [], superseded: [],
    };
  }

  const observed = reactors.map((r) => r.id);
  const stamp = (r: PrRecord): PrRecord => ({ ...r, reactionCheckedAt: now, lastReactors: observed });

  if (record.lastReactors === null) {
    return { record: stamp(record), claimed: [], released: [], superseded: [] };
  }

  const previous = new Set(record.lastReactors);
  const present = new Set(observed);
  let current = stamp(record);
  const released: string[] = [];
  const claimed: string[] = [];
  const superseded: { userId: string; byName: string }[] = [];

  // 1. Releases, before anything else.
  for (const userId of record.lastReactors) {
    if (present.has(userId)) continue;
    if (current.claimedBy !== userId || current.claimSource !== "reaction") continue;
    const outcome = applyUnclaim(current, userId);
    if (outcome.kind === "released") {
      current = outcome.record;
      released.push(userId);
    }
  }

  // 2. Newly present reactors, then 3. promotion — everyone still standing, but
  // only where this sync actually released a claim. Scoping promotion to a real
  // release is what keeps a standing reaction from re-claiming after the
  // 48-hour auto-clear, which produces no release here.
  const arrivals = reactors.filter((r) => !previous.has(r.id));
  const promoted = released.length > 0 ? reactors.filter((r) => previous.has(r.id)) : [];

  for (const reactor of [...arrivals, ...promoted]) {
    const isArrival = !previous.has(reactor.id);
    const held = current.claimedBy;
    const outcome = applyClaim(current, reactor.id, reactor.name, now, "reaction");
    if (outcome.kind === "claimed") {
      if (held !== reactor.id) claimed.push(reactor.id);
      current = outcome.record;
    } else if (outcome.kind === "already-claimed" && isArrival) {
      superseded.push({ userId: reactor.id, byName: outcome.byName });
    }
  }

  return { record: current, claimed, released, superseded };
}
```

Ordering within arrivals is the order Discord returned them: arbitrary but deterministic, and the only ordering available — the reactions endpoint carries no per-reaction timestamp, which is the same fact that makes first-write-wins the strongest rule this API supports.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --project=core tests/core/reactions.test.ts`
Expected: PASS (17 tests total in the file).

- [ ] **Step 5: Commit**

```bash
git add src/core/reactions.ts tests/core/reactions.test.ts
git commit -m "feat: diff observed reactors against the last poll"
```

---

### Task 5: The `reactionSync` store command

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/apply.ts`
- Test: `tests/store/apply.test.ts`

**Interfaces:**
- Consumes: `syncReactions`, `Reactor` (Task 4).
- Produces:
  ```ts
  | { kind: "reactionSync"; id: string; reactors: Reactor[] | null; now: number }
  ```
  (`null` reactors = the read failed; stamp the check time and change nothing else)

  and the result variant
  ```ts
  | { kind: "reaction-sync"; id: string; claimed: string[]; released: string[]; superseded: { userId: string; byName: string }[] }
  ```

- [ ] **Step 1: Write the failing tests**

Add to `tests/store/apply.test.ts`:

```ts
describe("reactionSync", () => {
  it("claims for a newly present reactor and reports it", () => {
    const base = stateWith(record({ lastReactors: [] }));
    const { state, results } = applyCommands(
      base,
      [{ kind: "reactionSync", id: ID, reactors: [{ id: "u1", name: "Katherine" }], now: T0 }],
      config,
    );
    expect(state.records[ID]!.claimedBy).toBe("u1");
    expect(results[0]).toEqual({
      kind: "reaction-sync", id: ID, claimed: ["u1"], released: [], superseded: [],
    });
  });

  it("loses to a menu claim already committed, and reports the reactor as superseded", () => {
    // This is the arbitration the whole command exists to get right: the menu
    // claim landed between beginTick and finishTick, and it wins.
    const held = record({ lastReactors: [], claimedBy: "u9", claimedByName: "Ira", claimedAt: T0, claimSource: "menu" });
    const { state, results } = applyCommands(
      stateWith(held),
      [{ kind: "reactionSync", id: ID, reactors: [{ id: "u1", name: "Katherine" }], now: T0 }],
      config,
    );
    expect(state.records[ID]!.claimedBy).toBe("u9");
    expect(results[0]).toEqual({
      kind: "reaction-sync", id: ID, claimed: [], released: [],
      superseded: [{ userId: "u1", byName: "Ira" }],
    });
  });

  it("returns not-found for a record that is gone", () => {
    const { results } = applyCommands(
      stateWith(record()),
      [{ kind: "reactionSync", id: "paranext/paranext-core#404", reactors: [], now: T0 }],
      config,
    );
    expect(results[0]).toEqual({ kind: "not-found" });
  });

  it("stamps the check time even when nothing changed", () => {
    const { state } = applyCommands(
      stateWith(record({ lastReactors: [] })),
      [{ kind: "reactionSync", id: ID, reactors: [], now: T0 + 1 }],
      config,
    );
    expect(state.records[ID]!.reactionCheckedAt).toBe(T0 + 1);
  });
});
```

Use whatever record/state helpers `tests/store/apply.test.ts` already defines — `stateWith`, `record` and `ID` above stand for them. If the file has no such helpers, add:

```ts
const ID = "paranext/paranext-core#2695";
function stateWith(r: PrRecord) {
  return { ...emptyState(), records: { [ID]: r } };
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=core tests/store/apply.test.ts`
Expected: FAIL — `reactionSync` is not a valid `Command` kind (a type error, and at runtime the switch falls through).

- [ ] **Step 3: Add the command and result types**

In `src/store/types.ts`, import the reactor type:

```ts
import type { Reactor } from "../core/reactions.js";
```

Add to the `Command` union, after `markSyncPaused`:

```ts
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
```

`reactors: null` means the read failed: stamp `reactionCheckedAt` so the record
rotates to the back of the queue, and leave the observed set untouched. `[]` is
a real observation and is not interchangeable with it.

Add to `CommandResult`:

```ts
  /** `id` is carried explicitly rather than recovered by index from the command
   *  list: the DM names the PR, and `resultCounters` is a standing demonstration
   *  of how easy index-alignment is to get subtly wrong. */
  | {
      kind: "reaction-sync";
      id: string;
      claimed: string[];
      released: string[];
      superseded: { userId: string; byName: string }[];
    }
```

- [ ] **Step 4: Handle the command**

In `src/store/apply.ts`, import the diff:

```ts
import { syncReactions } from "../core/reactions.js";
```

Add the case immediately after `markSyncPaused`:

```ts
    case "reactionSync": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      const outcome = syncReactions(existing, command.reactors, command.now);
      return {
        state: { ...state, records: put(state.records, outcome.record) },
        result: {
          kind: "reaction-sync",
          id: command.id,
          claimed: outcome.claimed,
          released: outcome.released,
          superseded: outcome.superseded,
        },
      };
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- --project=core tests/store/apply.test.ts && npm run typecheck`
Expected: PASS. `tsc` may flag exhaustive `switch` statements over `CommandResult` elsewhere; handle the new variant where it does.

- [ ] **Step 6: Commit**

```bash
git add src/store/types.ts src/store/apply.ts tests/store/apply.test.ts
git commit -m "feat: apply the reaction diff inside the store, against committed state"
```

---

### Task 6: The Discord read adapter

**Files:**
- Modify: `src/discord/rest.ts`
- Create: `src/discord/reactions.ts`
- Test: `tests/workers/reactions.test.ts`

**Interfaces:**
- Consumes: `DiscordRest`, `Reactor` (Task 4).
- Produces:
  ```ts
  // on DiscordRest:
  getReactions(channelId: string, messageId: string, emoji: string, opts: { limit: number; type?: 0 | 1 }): Promise<RestResult<DiscordUser[]>>
  // in src/discord/reactions.ts:
  export const REACTION_READ_LIMIT = 25
  export type ReactionRead =
    | { kind: "ok"; reactors: Reactor[]; requests: number }
    | { kind: "message-gone"; requests: number }
    | { kind: "emoji-invalid"; requests: number }
    | { kind: "rate-limited"; requests: number }
    | { kind: "failed"; status: number; requests: number }
  export function readReactors(rest, args: { channelId: string; messageId: string; emoji: string; botUserId: string; confirmHolderId: string | null }): Promise<ReactionRead>
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/workers/reactions.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordRest } from "../../src/discord/rest.js";
import { readReactors } from "../../src/discord/reactions.js";

const EMOJI = "code_review:1075535230087221248";

interface Call { url: string }

function stubFetch(responses: { status: number; json?: unknown }[]): Call[] {
  const calls: Call[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (input: string) => {
    calls.push({ url: String(input) });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(response.json === undefined ? null : JSON.stringify(response.json), {
      status: response.status,
    });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

function rest(): DiscordRest {
  return new DiscordRest("test-token-not-a-real-credential");
}

describe("readReactors", () => {
  it("requests the reactions route with the colon UNESCAPED and limit=25", async () => {
    const calls = stubFetch([{ status: 200, json: [] }]);
    await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: null,
    });
    // Discord requires the literal `name:id` in the path. Percent-encoding the
    // colon produces 10014 Unknown Emoji on every read.
    expect(calls[0]!.url).toContain(`/channels/c1/messages/m1/reactions/${EMOJI}`);
    expect(calls[0]!.url).not.toContain("%3A");
    expect(calls[0]!.url).toContain("limit=25");
  });

  it("maps users to reactors, preferring global_name and dropping the bot", async () => {
    stubFetch([{ status: 200, json: [
      { id: "u1", username: "katherine", global_name: "Katherine" },
      { id: "u2", username: "ira", global_name: null },
      { id: "bot", username: "reviewbot", global_name: null },
    ] }]);
    const result = await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: null,
    });
    expect(result).toEqual({
      kind: "ok",
      reactors: [{ id: "u1", name: "Katherine" }, { id: "u2", name: "ira" }],
      requests: 1,
    });
  });

  it("classifies 10008 as message-gone", async () => {
    stubFetch([{ status: 404, json: { code: 10008, message: "Unknown Message" } }]);
    const result = await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: null,
    });
    expect(result.kind).toBe("message-gone");
  });

  it("classifies 10014 as emoji-invalid — the branch that must NOT touch state", async () => {
    // Keyed on the error code, not the status: Discord does not document which
    // status wraps which code, and a deleted emoji fails on EVERY record in the
    // same tick. Had this shared the 404 branch, one emoji deletion would null
    // every messageId on the list, permanently.
    stubFetch([{ status: 400, json: { code: 10014, message: "Unknown Emoji" } }]);
    const result = await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: null,
    });
    expect(result.kind).toBe("emoji-invalid");
  });

  it("classifies a 404 with an unrecognised code as a plain failure, not message-gone", async () => {
    stubFetch([{ status: 404, json: { code: 50001, message: "Missing Access" } }]);
    const result = await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: null,
    });
    expect(result).toEqual({ kind: "failed", status: 404, requests: 1 });
  });

  it("reports 429 separately so the caller can abandon the step", async () => {
    stubFetch([{ status: 429, json: { message: "You are being rate limited." } }]);
    const result = await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: null,
    });
    expect(result.kind).toBe("rate-limited");
  });

  it("confirms an absent claim holder against the BURST list before reporting them gone", async () => {
    // A reviewer who upgrades a normal reaction to a super one vanishes from the
    // default type-0 read. Releasing on that would take the row away from
    // someone who did the opposite of releasing.
    const calls = stubFetch([
      { status: 200, json: [] },
      { status: 200, json: [{ id: "u1", username: "katherine", global_name: "Katherine" }] },
    ]);
    const result = await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: "u1",
    });
    expect(calls[1]!.url).toContain("type=1");
    expect(result).toEqual({ kind: "ok", reactors: [{ id: "u1", name: "Katherine" }], requests: 2 });
  });

  it("does not make the burst read when the holder is present in the normal list", async () => {
    const calls = stubFetch([
      { status: 200, json: [{ id: "u1", username: "katherine", global_name: "Katherine" }] },
    ]);
    const result = await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: "u1",
    });
    expect(calls).toHaveLength(1);
    expect(result.kind).toBe("ok");
  });

  it("treats a failed burst confirmation as 'still there' rather than releasing on a guess", async () => {
    stubFetch([{ status: 200, json: [] }, { status: 500 }]);
    const result = await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: "u1",
    });
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.reactors.map((r) => r.id)).toEqual(["u1"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=workers tests/workers/reactions.test.ts`
Expected: FAIL — `Cannot find module '../../src/discord/reactions.js'`.

- [ ] **Step 3: Add the REST route**

In `src/discord/rest.ts`, add the user shape beside `DiscordMessage`:

```ts
export interface DiscordUser {
  id: string;
  username: string;
  /** Discord's display name. Nullable — fall back to `username`. */
  global_name?: string | null;
}
```

Add the method after `getMessages`:

```ts
  /**
   * Reactors for one custom emoji on one message.
   *
   * `emoji` must be the literal `name:id` form — Discord requires the colon in
   * the path, and `encodeURIComponent` correctly leaves `:` alone. It is applied
   * anyway, defensively, for a future emoji whose NAME needs escaping; for
   * today's value it is the identity function.
   *
   * `type` is Discord's reaction type: 0 NORMAL (the default), 1 BURST (super
   * reactions). Only the release path reads type 1 — see `readReactors`.
   */
  getReactions(
    channelId: string,
    messageId: string,
    emoji: string,
    opts: { limit: number; type?: 0 | 1 },
  ): Promise<RestResult<DiscordUser[]>> {
    const params = new URLSearchParams({ limit: String(opts.limit) });
    if (opts.type !== undefined) params.set("type", String(opts.type));
    return this.call<DiscordUser[]>(
      "GET",
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?${params.toString()}`,
    );
  }
```

- [ ] **Step 4: Write the adapter**

Create `src/discord/reactions.ts`:

```ts
import type { Reactor } from "../core/reactions.js";
import type { DiscordRest, DiscordUser } from "./rest.js";

/**
 * Deliberately 25, not Discord's maximum of 100. The 10 ms per-invocation CPU
 * limit is the other half of why the reaction budget exists (the v1 spec names
 * "reaction payloads" by name), and a full budget of 100-user pages is 1,000
 * objects to parse in a tick that also parses a chunked GraphQL response and
 * renders the digest. A review request draws a handful of reactors; 25 is far
 * past the real distribution.
 */
export const REACTION_READ_LIMIT = 25;

/** Discord JSON error codes. The HTTP status that wraps each is undocumented,
 *  and exactly one branch below mutates state, so the code is what we branch
 *  on. */
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_EMOJI = 10014;

export type ReactionRead =
  | { kind: "ok"; reactors: Reactor[]; requests: number }
  | { kind: "message-gone"; requests: number }
  | { kind: "emoji-invalid"; requests: number }
  | { kind: "rate-limited"; requests: number }
  | { kind: "failed"; status: number; requests: number };

function errorCode(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === "number" ? parsed.code : null;
  } catch {
    return null;
  }
}

function toReactors(users: DiscordUser[], botUserId: string): Reactor[] {
  return users
    .filter((u) => u.id !== botUserId)
    .map((u) => ({ id: u.id, name: u.global_name ?? u.username }));
}

/**
 * One record's worth of refresh-loop step 8.
 *
 * `confirmHolderId` is the user who currently holds this record's claim by
 * reaction, or null. If they are missing from the normal reaction list, one
 * extra read of the BURST list decides whether they actually left or merely
 * upgraded to a super reaction. Only the release path pays for that read: a
 * super-only reactor never claiming is an accepted silent no-op, but releasing
 * a row out from under an active reviewer is not.
 */
export async function readReactors(
  rest: DiscordRest,
  args: {
    channelId: string;
    messageId: string;
    emoji: string;
    botUserId: string;
    confirmHolderId: string | null;
  },
): Promise<ReactionRead> {
  const response = await rest.getReactions(args.channelId, args.messageId, args.emoji, {
    limit: REACTION_READ_LIMIT,
  });
  let requests = 1;

  if (!response.ok) {
    const code = errorCode(response.body);
    if (code === UNKNOWN_MESSAGE) return { kind: "message-gone", requests };
    if (code === UNKNOWN_EMOJI) return { kind: "emoji-invalid", requests };
    if (response.status === 429) return { kind: "rate-limited", requests };
    return { kind: "failed", status: response.status, requests };
  }

  const users = response.value ?? [];
  if (users.length === REACTION_READ_LIMIT) {
    // A full page is indistinguishable from exactly-25 without another request.
    console.warn(`[REACTIONS] full page on ${args.messageId}; reactors beyond ${REACTION_READ_LIMIT} are not seen`);
  }
  const reactors = toReactors(users, args.botUserId);

  const holderId = args.confirmHolderId;
  if (holderId !== null && !reactors.some((r) => r.id === holderId)) {
    const burst = await rest.getReactions(args.channelId, args.messageId, args.emoji, {
      limit: REACTION_READ_LIMIT,
      type: 1,
    });
    requests += 1;
    // A failed confirmation reads as "still there". Releasing on a failed read
    // is a guess, and the direction of that guess takes a review away from
    // someone actively doing it.
    const burstReactors = burst.ok ? toReactors(burst.value ?? [], args.botUserId) : [];
    const holder = burstReactors.find((r) => r.id === holderId);
    if (holder !== undefined) reactors.push(holder);
    // The id doubles as the name only in the unreachable-name case: a failed
    // burst read tells us nothing about the display name, and the record
    // already stores the one the claim was made with.
    else if (!burst.ok) reactors.push({ id: holderId, name: holderId });
  }

  return { kind: "ok", reactors, requests };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- --project=workers tests/workers/reactions.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add src/discord/rest.ts src/discord/reactions.ts tests/workers/reactions.test.ts
git commit -m "feat: read reactions, classified by Discord's error code"
```

---

### Task 7: Refresh-loop step 8

**Files:**
- Modify: `config/config.ts`
- Modify: `src/handlers/scheduled.ts`
- Test: `tests/workers/scheduled.test.ts`

**Interfaces:**
- Consumes: `selectReactionTargets`, `readReactors`, the `reactionSync` command.
- Produces: `TickReport.reactionsRead`, `.reactionClaims`, `.reactionReleases`, `.reactionsEligible`, `.reactionsBudgetShed`; `SUBREQUEST_CEILING` exported from `config/config.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/workers/scheduled.test.ts`, following the existing harness in that file for building `TickDeps` (a `MemoryStore`, a stubbed `DiscordRest`, a fake credential provider):

```ts
it("polls eligible records and claims for a newly present reactor", async () => {
  // Record is primed (lastReactors: []), so the reaction is newly present.
  const store = memoryStoreWith([record({ lastReactors: [] })]);
  const rest = stubRestWithReactions({ "msg-1": [{ id: "u1", username: "katherine", global_name: "Katherine" }] });

  const report = await runTick({ ...deps, store, rest, now: T0 });

  expect(report.reactionsRead).toBe(1);
  expect(report.reactionClaims).toBe(1);
  const state = await store.readState();
  expect(state.records[ID]!.claimedBy).toBe("u1");
  expect(state.records[ID]!.claimSource).toBe("reaction");
});

it("sums the counters across every polled record, not just the first", async () => {
  // resultCounters uses results.find() for the existing count commands; there is
  // exactly one of each of those per tick and up to `allowance` reactionSyncs,
  // so reusing that shape would report at most one claim.
  const store = memoryStoreWith([
    record({ number: 1, messageId: "msg-1", lastReactors: [] }),
    record({ number: 2, messageId: "msg-2", lastReactors: [] }),
  ]);
  const rest = stubRestWithReactions({
    "msg-1": [{ id: "u1", username: "katherine" }],
    "msg-2": [{ id: "u2", username: "ira" }],
  });

  const report = await runTick({ ...deps, store, rest, now: T0 });

  expect(report.reactionsRead).toBe(2);
  expect(report.reactionClaims).toBe(2);
});

it("reports the eligible count untruncated and the budget it surrendered", async () => {
  const many = Array.from({ length: 14 }, (_, i) =>
    record({ number: i + 1, messageId: `msg-${i + 1}`, lastReactors: [] }));
  const store = memoryStoreWith(many);

  const report = await runTick({ ...deps, store, rest: stubRestWithReactions({}), now: T0 });

  expect(report.reactionsEligible).toBe(14);
  expect(report.reactionsRead).toBe(config.budgets.reactionReadsPerTick);
  // Nothing was shed: this is ordinary round-robin rotation, which is why
  // `reactionsBudgetShed` is the budget surrendered and NOT eligible-minus-read.
  expect(report.reactionsBudgetShed).toBe(0);
});

it("nulls messageId on 10008 and leaves everything alone on 10014", async () => {
  const store = memoryStoreWith([record({ lastReactors: [] })]);
  const report = await runTick({
    ...deps, store, now: T0,
    rest: stubRestFailingReactions({ status: 404, body: { code: 10008 } }),
  });
  expect((await store.readState()).records[ID]!.messageId).toBeNull();
  expect(report.reactionClaims).toBe(0);

  const store2 = memoryStoreWith([record({ lastReactors: [] })]);
  await runTick({
    ...deps, store: store2, now: T0,
    rest: stubRestFailingReactions({ status: 400, body: { code: 10014 } }),
  });
  // The emoji failing must change NO state: it fails on every record at once.
  expect((await store2.readState()).records[ID]!.messageId).toBe("msg-1");
});

it("stamps reactionCheckedAt on a plain failure so the record rotates to the back", async () => {
  const store = memoryStoreWith([record({ lastReactors: [] })]);
  await runTick({
    ...deps, store, now: T0,
    rest: stubRestFailingReactions({ status: 403, body: { code: 50001 } }),
  });
  // Retrying a systematic 4xx every tick is what the abuse ceiling punishes.
  expect((await store.readState()).records[ID]!.reactionCheckedAt).toBe(T0);
});

it("still renders the digest when the reaction read throws", async () => {
  const store = memoryStoreWith([record({ lastReactors: [] })]);
  const rest = stubRestThrowingReactions();
  const report = await runTick({ ...deps, store, rest, now: T0 });
  expect(report.digest).not.toBeNull();
  expect(report.reactionsRead).toBe(0);
});
```

Write the three `stubRest*` helpers beside the file's existing REST stub, returning the same object shape it already builds and overriding only `getReactions`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=workers tests/workers/scheduled.test.ts`
Expected: FAIL — `report.reactionsRead` is `undefined`.

- [ ] **Step 3: Add the ceiling to config**

In `config/config.ts`, above `export const config`:

```ts
/**
 * Cloudflare's free-plan subrequest limit per invocation. A PLATFORM BOUND, not
 * a tuning knob — it tracks what Cloudflare enforces, and hitting the real
 * ceiling kills a tick mid-write, which is the failure the two-store-subrequest
 * invariant exists to prevent. (`LEASE_TIMEOUT_MS` makes the same distinction
 * but lives in `src/store/types.ts`, because both `Store` implementations
 * import it; nothing outside the tick handler needs this one.)
 */
export const SUBREQUEST_CEILING = 50;
```

- [ ] **Step 4: Extend the tick report**

In `src/handlers/scheduled.ts`, add to `TickReport`:

```ts
  /** Records actually polled by step 8. */
  reactionsRead: number;
  reactionClaims: number;
  reactionReleases: number;
  /** Eligible records, UNTRUNCATED — the number the cycle time is read off.
   *  Not bounded: `purgeResolved` only purges resolved records. */
  reactionsEligible: number;
  /** How much of `budgets.reactionReadsPerTick` the subrequest guard took away.
   *  NOT `eligible - read`: with 45 records and a budget of 10 that is 35 on
   *  every healthy tick, which is round-robin rotation, and a counter that is
   *  always nonzero signals nothing. */
  reactionsBudgetShed: number;
```

Add all five to the `empty` literal with `0`.

- [ ] **Step 5: Sum the new counters in the shared helper**

Still in `src/handlers/scheduled.ts`, extend `resultCounters` — it must stay shared between the live and read-only paths, for the reason its own comment gives:

```ts
function resultCounters(
  commands: Command[],
  results: CommandResult[],
): { scanned: number; staleClaimsCleared: number; purged: number; reactionClaims: number; reactionReleases: number } {
  const counted = (kind: Command["kind"]): number => {
    const hit = results.find((r, i) => commands[i]?.kind === kind && r.kind === "count");
    return hit?.kind === "count" ? hit.count : 0;
  };
  // SUMMED, not `find`ed: there is one `clearStaleClaims` per tick but up to
  // `allowance` reactionSyncs, so a first-match read would report at most one.
  const syncs = results.filter((r) => r.kind === "reaction-sync");
  return {
    scanned: results.filter((r, i) => commands[i]?.kind === "upsertScanned" && r.kind === "created").length,
    staleClaimsCleared: counted("clearStaleClaims"),
    purged: counted("purgeResolved"),
    reactionClaims: syncs.reduce((sum, r) => sum + (r.kind === "reaction-sync" ? r.claimed.length : 0), 0),
    reactionReleases: syncs.reduce((sum, r) => sum + (r.kind === "reaction-sync" ? r.released.length : 0), 0),
  };
}
```

- [ ] **Step 6: Write step 8**

Insert between step 7's `console.log` and step 10's `purgeResolved`. Add three imports — `config` itself already arrives on `deps`, so the config import brings in only the ceiling:

```ts
import { SUBREQUEST_CEILING, type Config } from "../../config/config.js";
import { selectReactionTargets } from "../core/reactions.js";
import { readReactors } from "../discord/reactions.js";
```

(`type Config` is already imported in this file; merge the named import rather than adding a second import line from the same module.)

```ts
    // 8. Read `:code_review:` reactions, oldest-unchecked first, under an
    // allowance that sheds when the tick is near its subrequest ceiling. The v1
    // spec makes this the FIRST work to shed, because it is the only optional
    // work in the loop.
    //
    // The whole step is guarded: it sits between the scan and the render, and a
    // throw here would take the render with it — suppressing the stale banner,
    // which Monitoring names as the failure it most needs to avoid.
    const RESERVE = 5; // finishTick, plus two DMs at two subrequests each.
    const eligible = selectReactionTargets(Object.values(opening.state.records));
    const allowance = Math.max(
      0,
      Math.min(config.budgets.reactionReadsPerTick, SUBREQUEST_CEILING - subrequests - RESERVE),
    );
    let reactionsRead = 0;
    try {
      for (const id of eligible.slice(0, allowance)) {
        const record = opening.state.records[id];
        if (record === undefined || record.messageId === null) continue;
        const read = await readReactors(rest, {
          channelId: record.channelId,
          messageId: record.messageId,
          emoji: config.claimEmoji,
          botUserId: deps.botUserId,
          // Only a claim held BY REACTION can be released by one disappearing,
          // so only that holder is worth a burst confirmation.
          confirmHolderId: record.claimSource === "reaction" ? record.claimedBy : null,
        });
        subrequests += read.requests;
        reactionsRead += 1;

        if (read.kind === "ok") {
          commands.push({ kind: "reactionSync", id, reactors: read.reactors, now });
          continue;
        }
        if (read.kind === "message-gone") {
          // The v1 spec's documented "Request message deleted": the record
          // survives, the digest row keeps its place and loses its link, and the
          // record drops out of the polling set for good.
          commands.push({ kind: "setRequestMessageId", id, messageId: null });
          continue;
        }
        if (read.kind === "emoji-invalid") {
          // NO state change. `claimEmoji` is one hardcoded snowflake, so this
          // fails on every eligible record in the same tick; anything mutating
          // here would apply to the whole list at once.
          console.error(`[REACTION_EMOJI_INVALID] ${config.claimEmoji} was rejected by Discord; the reaction path is disabled until it is fixed`);
          break;
        }
        if (read.kind === "rate-limited") break;
        // Any other 4xx/5xx: stamp the check time so the record rotates to the
        // back of the queue instead of being retried every tick. A systematic
        // 4xx must fail cold — 10,000 invalid responses in 10 minutes risks a
        // temporary IP ban.
        console.warn(`[REACTIONS] read failed for ${id} (${read.status})`);
        commands.push({ kind: "reactionSync", id, reactors: null, now });
      }
    } catch (error) {
      console.error(`[REACTIONS] step 8 aborted: ${String(error)}`);
    }
    console.log(`[REACTIONS] eligible=${eligible.length} read=${reactionsRead} allowance=${allowance}`);
```

**On the failure branch's `reactors: null`:** it stamps `reactionCheckedAt` and touches nothing else, which is what rotates a systematically failing record to the back of the queue without asserting an observation that never happened.

- [ ] **Step 7: Report the counters at both return sites**

`setRequestMessageId` currently types `messageId: string`; widen it to `string | null` in `src/store/types.ts`. Its case in `src/store/apply.ts` assigns `command.messageId` straight onto the record, so it needs no change — but add a line to that command's doc comment saying step 8 also uses it to *clear* the id when Discord reports the message gone.

Then add to the read-only return object:

```ts
        reactionsRead,
        reactionsEligible: eligible.length,
        reactionsBudgetShed: config.budgets.reactionReadsPerTick - allowance,
```

(`reactionClaims` and `reactionReleases` arrive through the existing `...resultCounters(commands, projected.results)` spread.) Add the same three lines to the live return object, whose spread is `...resultCounters(commands, finished.results)`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -- --project=workers tests/workers/scheduled.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add config/config.ts src/handlers/scheduled.ts src/store/types.ts tests/workers/scheduled.test.ts
git commit -m "feat: refresh-loop step 8 — read reactions under a shedding budget"
```

---

### Task 8: The private notice to a superseded reactor

**Files:**
- Modify: `src/discord/rest.ts`
- Modify: `src/handlers/scheduled.ts`
- Test: `tests/workers/scheduled.test.ts`, `tests/workers/rest.test.ts`

**Interfaces:**
- Consumes: the `reaction-sync` result's `superseded` array (Task 5).
- Produces: `DiscordRest.createDmChannel(userId: string): Promise<RestResult<{ id: string }>>`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/workers/scheduled.test.ts`:

```ts
it("DMs a reactor whose claim lost, naming the PR and the holder", async () => {
  const held = record({ lastReactors: [], claimedBy: "u9", claimedByName: "Ira", claimedAt: T0, claimSource: "menu" });
  const store = memoryStoreWith([held]);
  const rest = stubRestWithReactions({ "msg-1": [{ id: "u1", username: "katherine", global_name: "Katherine" }] });

  await runTick({ ...deps, store, rest, now: T0 });

  expect(rest.dmCalls).toEqual([
    { userId: "u1", content: expect.stringContaining("paranext/paranext-core#2695") },
  ]);
  expect(rest.dmCalls[0]!.content).toContain("Ira");
});

it("sends no DM when the reaction claim succeeded", async () => {
  const store = memoryStoreWith([record({ lastReactors: [] })]);
  const rest = stubRestWithReactions({ "msg-1": [{ id: "u1", username: "katherine" }] });
  await runTick({ ...deps, store, rest, now: T0 });
  expect(rest.dmCalls).toEqual([]);
});

it("counts DM subrequests into the report", async () => {
  const reactors = { "msg-1": [{ id: "u1", username: "katherine" }] };
  const held = record({ lastReactors: [], claimedBy: "u9", claimedByName: "Ira", claimedAt: T0, claimSource: "menu" });
  // Identical ticks apart from who holds the claim: the same one read either
  // way, so the whole difference is the DM.
  const withoutDm = await runTick({
    ...deps, store: memoryStoreWith([record({ lastReactors: [] })]),
    rest: stubRestWithReactions(reactors), now: T0,
  });
  const withDm = await runTick({
    ...deps, store: memoryStoreWith([held]),
    rest: stubRestWithReactions(reactors), now: T0,
  });
  // Open the channel, then post: two per DM, and they are outbound worker
  // fetches that charge against the same 50.
  expect(withDm.subrequests).toBe(withoutDm.subrequests + 2);
});

it("does not fail the tick when the DM is rejected", async () => {
  const held = record({ lastReactors: [], claimedBy: "u9", claimedByName: "Ira", claimedAt: T0, claimSource: "menu" });
  const rest = stubRestWithReactions({ "msg-1": [{ id: "u1", username: "katherine" }] });
  rest.failDms = "reject"; // throws, rather than returning a 403

  // The loop runs AFTER finishTick, which is after leaseReleased = true, so
  // runTick's `finally` does nothing for it: unguarded, this would throw out of
  // a tick whose work is fully committed and whose digest is already patched,
  // losing the whole report.
  const report = await runTick({ ...deps, store: memoryStoreWith([held]), rest, now: T0 });
  expect(report.digest).not.toBeNull();
});

it("sends no DMs in read-only mode", async () => {
  const held = record({ lastReactors: [], claimedBy: "u9", claimedByName: "Ira", claimedAt: T0, claimSource: "menu" });
  const rest = stubRestWithReactions({ "msg-1": [{ id: "u1", username: "katherine" }] });
  await runTick({ ...deps, store: memoryStoreWith([held]), rest, now: T0, readOnly: true });
  expect(rest.dmCalls).toEqual([]);
});
```

Extend the REST stub with `dmCalls: { userId: string; content: string }[]` and a `failDms` switch.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=workers tests/workers/scheduled.test.ts`
Expected: FAIL — `rest.dmCalls` is empty; no DM code exists.

- [ ] **Step 3: Add the DM route**

In `src/discord/rest.ts`, after `postMessage`:

```ts
  /**
   * Opens (or returns) the DM channel with one user. Idempotent — Discord
   * returns the existing channel if there is one.
   */
  createDmChannel(userId: string): Promise<RestResult<{ id: string }>> {
    return this.call<{ id: string }>("POST", "/users/@me/channels", { recipient_id: userId });
  }
```

- [ ] **Step 4: Send the notices**

In `src/handlers/scheduled.ts`, add above `runTick`:

```ts
/** Two subrequests each (open the channel, post), so the cap and `RESERVE` in
 *  step 8 have to agree: 2 DMs, 4 subrequests, reserved up front because the
 *  count is not knowable until `finishTick` returns. */
const DM_CAP = 2;

async function notifySuperseded(
  rest: DiscordRest,
  results: CommandResult[],
  records: Record<string, PrRecord>,
): Promise<number> {
  let subrequests = 0;
  let sent = 0;
  for (const result of results) {
    if (result.kind !== "reaction-sync") continue;
    for (const loser of result.superseded) {
      if (sent >= DM_CAP) {
        console.warn(`[REACTIONS] superseded notice for ${loser.userId} on ${result.id} not sent — per-tick DM cap reached`);
        continue;
      }
      const channel = await rest.createDmChannel(loser.userId);
      subrequests += 1;
      if (!channel.ok) {
        // Almost always "DMs from server members disabled" — a stable property
        // of the recipient's settings. Never retried: a hot retry against a
        // stable 4xx is what the abuse ceiling punishes.
        console.warn(`[REACTIONS] could not open a DM with ${loser.userId} (${channel.status})`);
        continue;
      }
      const title = records[result.id]?.title ?? result.id;
      await rest.postMessage(channel.value.id, {
        content: `\`${result.id}\` (${title}) is already claimed by ${loser.byName} — your \`:code_review:\` reaction did not take.`,
      });
      subrequests += 1;
      sent += 1;
    }
  }
  return subrequests;
}
```

Import `PrRecord` in that file if it is not already imported.

Then, in `runTick`, immediately after the `finishTick` call and before the live `return`:

```ts
    // Its own guard, deliberately. This runs after `leaseReleased = true`, so
    // the `finally` below does nothing for it — an unguarded rejected fetch here
    // would propagate out of a tick whose work is already committed and whose
    // digest is already patched, losing the entire TickReport for the sake of a
    // DM.
    try {
      subrequests += await notifySuperseded(rest, finished.results, opening.state.records);
    } catch (error) {
      console.error(`[REACTIONS] superseded notices failed: ${String(error)}`);
    }
```

Read-only mode never reaches this code, since it returns before `finishTick`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/discord/rest.ts src/handlers/scheduled.ts tests/workers/scheduled.test.ts tests/workers/rest.test.ts
git commit -m "feat: privately tell a reactor whose claim lost to an existing one"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/architecture-decisions.md`
- Modify: `docs/operations.md`

- [ ] **Step 1: Remove both plan-3 placeholders in `docs/architecture.md`**

In the step-7 paragraph, replace the final sentence "Step 8 (reaction reads) is still plan 3." with a step-8 paragraph:

```markdown
Step 8 reads `:code_review:` reactions for eligible records — open, with a
`messageId` no other record shares, and either unclaimed or claimed by a
reaction — oldest-unchecked first, under a per-tick allowance that sheds first
when the tick nears its subrequest ceiling. It does not ask "who is reacting?"
but "what changed since the last poll?": each record stores the reactor ids seen
at its previous poll (`PrRecord.lastReactors`), and the store diffs the observed
set against it. Adding the reaction claims; removing it releases a claim that
was made by reacting (`PrRecord.claimSource` is what keeps a menu claim out of
the reaction path's reach); a release promotes anyone still standing on the
message. A null `lastReactors` means unprimed — the record has entered or
re-entered the polling set and nothing has been observed yet — so that poll
records the set and acts on nothing. See
`adr-reaction-diff-not-presence`.
```

Delete the `:code_review:` bullet from *What's deliberately not here*, and update the sentence in *Claiming and removal* row of the spec table to name `src/core/reactions.ts`.

- [ ] **Step 2: Add the ADR**

Append to `docs/architecture-decisions.md`, in the house style of the existing entries:

```markdown
## adr-reaction-diff-not-presence

**Decision.** Step 8 stores the set of reactors observed at each record's last
poll and diffs the next observation against it, rather than checking who is
currently reacting. `lastReactors` is nullable, and null means *unprimed*.

**Why not a presence check.** Every hard case on this path is a change question,
not a state question. A reaction is permanent; a claim is not. With a presence
check, the standing reaction of someone whose claim auto-cleared at 48 hours
re-claims on the very next poll, silently, forever. The suppression rule that
fixes that ("a user may only re-claim once per record") needs its own persisted
per-user state and still gets the removal case wrong. The diff subsumes both: an
unchanged reaction is not an event, and a removed one is.

**Why null is distinct from empty.** The diff's licence to read a reaction as
present-tense intent is that an absence was observed in between. Across a gap
where nothing was observed — a record menu-claimed for a week, a record resolved
and later reopened, a fresh deploy — that licence does not exist. Treating the
gap as `[]` makes every reaction that accumulated during it read as newly
present, which on deploy day would claim retroactively across the whole list and
park rows in Being reviewed under names that are wrong for 48 hours. So leaving
the polling set nulls the field, and null-valued records prime instead of
diffing.

**Why a release promotes.** Two people react; the first claims; the second is
told it was taken. When the first removes their reaction, the second's unchanged
reaction can never claim under the diff's own rules — they are stranded
holding a signal the bot has stopped reading. A sync that releases therefore
re-runs the claim attempt across everyone still standing. Promotion is scoped to
a sync that actually released, which is what keeps the auto-clear case correct:
`clearStaleClaims` produces no release inside a sync, so nothing is promoted
there.

**Why a release is silent and unmarked.** No DM: you meant to do it. And no
`claimClearedAt`/`lastClaimedByName`, so the row returns to its team section
clean rather than tagged `previously claimed` — that tag is for the 48-hour
auto-clear, where a row went stale on someone. Handing a review back on purpose
is a different event and must not read like one.

**Why failure handling keys on Discord's error code, not the HTTP status.**
Exactly one branch mutates state (nulling `messageId` when the request message
is gone), and Discord documents error codes without documenting which status
wraps each one. `claimEmoji` is a single hardcoded snowflake, so a deleted or
re-uploaded emoji fails on every eligible record in the same tick — if that
surfaced as a 404 and the branch keyed on the status, one emoji deletion would
null every message link on the list, permanently, with nothing able to rebuild
them.
```

- [ ] **Step 3: Add the operations notes**

Append to `docs/operations.md`, beside the existing log-line documentation:

```markdown
### Reaction claims (refresh-loop step 8)

- `[REACTIONS] eligible=N read=M allowance=A` on every tick. `read=0` every tick
  with `eligible` above zero means the path has stopped working; `eligible`
  climbing means the polling cycle is getting longer.
- `[REACTION_EMOJI_INVALID]` means Discord rejected `config.claimEmoji` — it has
  been deleted or re-uploaded with a new id. The reaction path is disabled until
  the snowflake in `config/config.ts` is updated. Nothing else is affected and
  no state is damaged.
- **Release latency.** Removing a reaction releases the claim on the record's
  next poll, not immediately: `ceil(eligible / allowance)` ticks, which is 25
  minutes at 10 reads per tick across 45 eligible records and an hour at 120.
  The eligible set is not bounded — resolved records are purged at 30 days but
  open ones never are — so it grows with the number of long-lived open PRs.
  Anyone who needs a row freed immediately should use the digest's claim menu,
  which is instant.
- **Reactions that predate the deploy do not claim.** Schema v4 migrates every
  record to `lastReactors: null`, so the first poll records who is standing on
  each message and claims for nobody. Anyone who wants a row they already
  reacted to must remove and re-add the reaction, or use the menu.
```

- [ ] **Step 4: Verify and commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

```bash
git add docs/architecture.md docs/architecture-decisions.md docs/operations.md
git commit -m "docs: refresh-loop step 8, the diff ADR, and the reaction runbook"
```

---

## Spec coverage

| Spec section | Task |
|---|---|
| Removal releases a claim (diff, priming, promotion, silent release) | 4 |
| Selection and the budget (eligibility, ordering, allowance, `SUBREQUEST_CEILING`, `RESERVE`) | 3, 7 |
| CPU bound (`limit=25`, sequential reads) | 6, 7 |
| The read (route, encoding, `global_name`, bot filtering, permissions) | 6 |
| Burst reactions (confirming read on the release path only) | 6 |
| The diff as a command (ordering, no staleness check, result variant with `id`) | 4, 5 |
| The private notice (DM, cap, 403 tolerated, own guard, counted subrequests) | 8 |
| Storage (three fields, `claimSource` plumbing, migration, `newScannedRecord`, `MigratingState`, the bare test literal) | 1, 2 |
| Failure modes (`10008`, `10014`, other 4xx, 429, rejected fetch, full page) | 6, 7 |
| Observability (five counters, summed, `[REACTIONS]`, both return sites, read-only) | 7, 8 |
| Documentation | 9 |
