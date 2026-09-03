# `/review-request` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/review-request` — a modal that opens instantly from cached data, a validated submit path that posts a consistent request message and tracks the PR, and the PRD thread cache that feeds the modal's dropdown.

**Architecture:** Three interaction entry points (`APPLICATION_COMMAND` → modal, `MODAL_SUBMIT` → deferred work, `MESSAGE_COMPONENT` → retry) over the seams plan 1 built. Everything decidable without I/O — the modal payload, the parse, the validation, the rejection text, the PRD merge — is a pure function in `core/`, snapshot-tested. The submit path is the first handler in this codebase that answers before it finishes, so it needs an `ExecutionContext` the worker does not currently have; that plumbing is a first-class part of this plan, not a detail.

**Tech Stack:** TypeScript 6.0.3 (strict), Cloudflare Workers + Durable Objects, Wrangler 4.127.1, Vitest 4.1 with `@cloudflare/vitest-plugin` 1.1.2, Istanbul coverage. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-02-review-request-design.md`, which supplements `docs/superpowers/specs/2026-08-26-pr-review-bot-design.md`.

**Plan scope:** Plan 2 of 3. It builds rollout stage 3 and does **not** perform it — `/review-request` stays unregistered until the shadow-mode threshold in the v1 spec is met. Deferred to plan 3: the `:code_review:` reaction claim path and refresh-loop step 8.

**Correcting plan 1.** Plan 1 recorded that "plan 2 is the modal plus validation and nothing structural." That is wrong, and Tasks 9 and 10 are the correction. The worker's `fetch` has no `ExecutionContext`; `DiscordRest` has no webhook route and hardcodes a bot `Authorization` header; `handleComponent` decodes `values[0]` before it reads `custom_id`, so a button can never reach a handler. None of that is optional.

## Global Constraints

Every task's requirements implicitly include this section, **and every constraint in plan 1's Global Constraints section still applies** — `core/` has no I/O, records are resolved and never deleted, at most two store subrequests per tick, snapshots stay time-independent, coverage 95% on `core/` and 70% on adapters.

Added by this plan, copied verbatim from the spec:

- **Nothing on the modal path may fetch.** A modal cannot be sent after a deferred response, so a missed 3-second budget is an outage on the primary command with no escape hatch. The only I/O allowed between receiving `APPLICATION_COMMAND` and returning callback type 9 is the one store read.
- **Discord character caps**, clamped by the renderer rather than discovered at runtime: `Label.label` 45, `Label.description` 100, select option `label` / `value` / `description` 100 each, modal `title` 45, `custom_id` 100, text input `value` 4000.
- **A string select carries at most 25 options in total.** The PRD select spends one on **None**, so the cache contributes **24**.
- **`setRequestMessageId` must not touch `lastRequestedAt` or `requestCount`.** Re-issuing `upsertRequest` to write the message id would route through `markRequested`, landing a first-time request at `requestCount: 2` and moving the field the digest's staleness fence compares against.
- **`config.retryStashMs` is 30 minutes — longer than Discord's 15-minute interaction token — deliberately.** At exactly 15 minutes the expiry branch is unreachable, because the button dies with the token that created the message it lives on.
- **The stash prunes on write, never on a tick.** `purgeResolved` filters `state.records` and never reads `state.meta`; a tick-driven sweep would also not run when a tick is turned away with `lease-held`, nor in `READ_ONLY` mode.
- **`/review-request` is not registered by default.** `npm run register-commands` keeps registering only `/review-list`; `--all` adds the new command.

---

## File Structure

```
src/core/prd.ts                  PrdOption, PrdCache, buildPrdCache — merge/sort/cap
src/core/modal.ts                buildRequestModal — the callback-type-9 payload
src/core/submit.ts               SubmittedValues, parseSubmission — parse + offline validation
src/core/render/rejection.ts     renderRejection — ephemeral text + Fix and retry button

src/discord/threads.ts           fetchPrdThreads — the two thread endpoints, merged

src/handlers/reviewRequest.ts    the three interaction entry points and the deferred submit

MODIFIED
config/config.ts                 retryStashMs, budgets.retryStashEntries
src/store/types.ts               Meta.prdCache, Meta.retryStash, two new commands, version 3
src/store/schema.ts              StoredMeta widened, the 2 → 3 step
src/store/apply.ts               emptyState, stashSubmission, setRequestMessageId
src/discord/rest.ts              getActiveThreads, getArchivedPublicThreads, editInteractionResponse
src/discord/components.ts        CallbackType 5 and 9, InteractionResponse.data widened, CUSTOM_IDS
src/handlers/interactions.ts     custom_id-first routing, ctx/waitUntil, new deps
src/handlers/scheduled.ts        refresh-loop step 7
src/index.ts                     ctx on fetch, rest/credentials/appId into InteractionDeps
src/env.d.ts                     DISCORD_APP_ID
scripts/register-commands.ts     --all adds /review-request
preview/build.ts                 the modal and every rejection
```

---

## Task 1: Config, the two `Meta` fields, and schema version 3

**Files:**
- Modify: `config/config.ts`, `src/store/types.ts`, `src/store/schema.ts`, `src/store/apply.ts:17-32`
- Create: `src/core/prd.ts` (types only in this task; the function lands in Task 3)
- Test: `tests/store/apply.test.ts`, `tests/workers/do.test.ts`

**Interfaces:**
- Consumes: `Meta`, `StoreState`, `CURRENT_SCHEMA_VERSION` from plan 1's Task 11.
- Produces:
  - `interface PrdOption { id: string; name: string }`
  - `interface PrdCache { options: PrdOption[]; truncated: boolean; refreshedAt: number }`
  - `interface StashedSubmission { userId: string; values: SubmittedValues; expiresAt: number }` — `SubmittedValues` arrives in Task 7; until then it is declared in `src/core/submit.ts` as the shape below and imported by name.
  - `Meta.prdCache: PrdCache | null`, `Meta.retryStash: Record<string, StashedSubmission>`
  - `CURRENT_SCHEMA_VERSION = 3`
  - `config.retryStashMs`, `config.budgets.retryStashEntries`

`SubmittedValues` is defined in Task 7 but referenced here, so this task creates `src/core/submit.ts` containing **only** that interface. Task 7 adds the parser to the same file.

- [ ] **Step 1: Write the failing tests**

Add to `tests/store/apply.test.ts`:

```ts
describe("schema version 3", () => {
  it("emptyState carries both new meta fields", () => {
    const state = emptyState();
    expect(state.schemaVersion).toBe(3);
    expect(state.meta.prdCache).toBeNull();
    expect(state.meta.retryStash).toEqual({});
  });
});
```

Add to `tests/workers/do.test.ts`:

```ts
it("migrates version 2 state forward with defaults for the new meta fields", () => {
  const v2 = {
    schemaVersion: 2,
    records: {},
    meta: {
      lastSync: 1_756_000_000_000,
      digestMessageId: "m-1",
      digestBodyHash: "h",
      digestBodyVersion: 4,
      unpinnedReportedAt: null,
      lastDailyPostDate: "2026-08-31",
      scanCursors: { c1: "9" },
      scanBackfill: {},
      syncLease: null,
    },
  };

  const migrated = migrateState(v2 as never);

  expect(migrated.schemaVersion).toBe(3);
  expect(migrated.meta.prdCache).toBeNull();
  expect(migrated.meta.retryStash).toEqual({});
  // Everything version 2 already carried survives untouched.
  expect(migrated.meta.digestBodyVersion).toBe(4);
  expect(migrated.meta.scanCursors).toEqual({ c1: "9" });
});

it("still walks unversioned state all the way to 3", () => {
  const v0 = { records: {}, meta: { ...emptyState().meta, digestBodyVersion: undefined } };
  const migrated = migrateState(v0 as never);
  expect(migrated.schemaVersion).toBe(3);
  expect(migrated.meta.digestBodyVersion).toBe(0);
  expect(migrated.meta.retryStash).toEqual({});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=core tests/store/apply.test.ts && npm test -- --project=workers tests/workers/do.test.ts`
Expected: FAIL — `schemaVersion` is 2 and `prdCache` does not exist.

- [ ] **Step 3: Add the config fields**

In `config/config.ts`, add to the `Config` interface, immediately after `reopenWindowMs`:

```ts
  /** How long a rejected submission's values stay stashed for the "Fix and
   *  retry" button. Deliberately LONGER than Discord's 15-minute interaction
   *  token: at exactly 15 minutes the expiry branch is unreachable, because the
   *  button lives on a message created by that same token and dies with it. A
   *  longer window makes the token the binding constraint and the "your form
   *  expired" message a path a user can actually reach. */
  retryStashMs: number;
```

Extend the `budgets` field's type in the same interface:

```ts
  budgets: {
    scanPagesPerTick: number;
    purgePerTick: number;
    reactionReadsPerTick: number;
    /** Hard cap on stashed submissions. All state lives under one Durable
     *  Object key, so an unbounded map on a path with no cap is a storage-size
     *  problem, not untidiness. Oldest are dropped first. */
    retryStashEntries: number;
  };
```

And in the exported `config` value:

```ts
  retryStashMs: 30 * MINUTE,
  budgets: { scanPagesPerTick: 5, purgePerTick: 50, reactionReadsPerTick: 10, retryStashEntries: 50 },
```

- [ ] **Step 4: Add the types**

Create `src/core/prd.ts`:

```ts
/** One PRD forum thread, as the modal's dropdown needs it. */
export interface PrdOption {
  id: string;
  name: string;
}

/**
 * The cached PRD list the modal is built from. Refreshed by the cron (refresh
 * loop step 7) and never fetched on the modal path: a modal cannot be sent after
 * a deferred response, so any live call there is a latent outage with no escape
 * hatch.
 *
 * `truncated` is what lets the modal say "25 most recent shown" instead of
 * quietly presenting a partial list as complete.
 */
export interface PrdCache {
  options: PrdOption[];
  truncated: boolean;
  refreshedAt: number;
}
```

Create `src/core/submit.ts`:

```ts
/**
 * A modal submission exactly as the user typed it, before any interpretation.
 *
 * Raw strings, not parsed values, because this is what the "Fix and retry"
 * prefill has to put back into the form — a normalised or partially-parsed copy
 * would hand the user back something they did not type.
 */
export interface SubmittedValues {
  url: string;
  team: string;
  urgency: string;
  prdThreadId: string | null;
  note: string;
}
```

In `src/store/types.ts`, import the new types and add the two `Meta` fields:

```ts
import type { PrdCache } from "../core/prd.js";
import type { SubmittedValues } from "../core/submit.js";
```

```ts
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
```

And, next to `MetaPatch`:

```ts
export interface StashedSubmission {
  userId: string;
  values: SubmittedValues;
  expiresAt: number;
}
```

Bump the version constant, extending its existing comment:

```ts
/** ... Version 1 is the pre-deploy baseline; version 2 added
 *  `Meta.digestBodyVersion`; version 3 added `Meta.prdCache` and
 *  `Meta.retryStash`. */
export const CURRENT_SCHEMA_VERSION = 3;
```

- [ ] **Step 5: Widen `StoredMeta` and add the migration step**

In `src/store/schema.ts`, widen the stored shape — without this the version-2 state is untypeable and the step has nothing to read:

```ts
type StoredMeta = Omit<Meta, "digestBodyVersion" | "prdCache" | "retryStash"> & {
  digestBodyVersion?: number;
  prdCache?: Meta["prdCache"];
  retryStash?: Meta["retryStash"];
};
```

Add the step after the 1 → 2 step:

```ts
  // 2 → 3: `Meta.prdCache` and `Meta.retryStash` appeared. Both default to
  // "nothing cached, nothing stashed", which is exactly the state a fresh
  // deploy is in and which every reader already handles: the modal offers only
  // "None" until step 7 first succeeds, and an absent stash key is the same as
  // an expired one.
  if (state.schemaVersion === 2) {
    state = {
      ...state,
      schemaVersion: 3,
      meta: { ...state.meta, prdCache: state.meta.prdCache ?? null, retryStash: state.meta.retryStash ?? {} },
    };
  }
```

- [ ] **Step 6: Extend `emptyState`**

In `src/store/apply.ts`, add both fields to the `meta` object returned by `emptyState()`, after `syncLease: null`:

```ts
      prdCache: null,
      retryStash: {},
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run typecheck && npm test -- --project=core tests/store/apply.test.ts && npm test -- --project=workers tests/workers/do.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add config/config.ts src/core/prd.ts src/core/submit.ts src/store/types.ts src/store/schema.ts src/store/apply.ts tests/store/apply.test.ts tests/workers/do.test.ts
git commit -m "feat(store): schema version 3 adds the PRD cache and the retry stash"
```

---

## Task 2: The two new store commands

**Files:**
- Modify: `src/store/types.ts`, `src/store/apply.ts`
- Test: `tests/store/apply.test.ts`

**Interfaces:**
- Consumes: `StashedSubmission`, `Config`, `applyOne` from Task 1 and plan 1's Task 11.
- Produces:
  - `{ kind: "setRequestMessageId"; id: string; messageId: string }` → `{ kind: "ok" }` or `{ kind: "not-found" }`
  - `{ kind: "stashSubmission"; key: string; entry: StashedSubmission; now: number }` → `{ kind: "ok" }`

There is deliberately **no** `setPrdCache` command: `prdCache` is an ordinary `Meta` field, so `MetaPatch` covers it and the existing `setMeta` writes it. `stashSubmission` is a command rather than a `setMeta` patch because it must read the existing map, prune it, add an entry and cap it — a read-modify-write that has to happen *inside* the atomic apply. Building the new map in the handler and shipping it as a patch would lose any entry a concurrent tick wrote in between.

- [ ] **Step 1: Write the failing tests**

Add to `tests/store/apply.test.ts`:

```ts
const VALUES = { url: "https://x", team: "Power", urgency: "soon", prdThreadId: null, note: "" };

describe("setRequestMessageId", () => {
  it("writes the message id without moving lastRequestedAt or requestCount", () => {
    const seeded = applyOne(
      emptyState(),
      { kind: "upsertRequest", pr: PR, at: T0, fields: FIELDS, title: "T", prAuthorLogin: "jolie", isDraft: false },
      config,
    ).state;
    const before = seeded.records["paranext/paranext-core/1"]!;

    const after = applyOne(seeded, { kind: "setRequestMessageId", id: "paranext/paranext-core/1", messageId: "m-9" }, config);
    const record = after.state.records["paranext/paranext-core/1"]!;

    expect(after.result).toEqual({ kind: "ok" });
    expect(record.messageId).toBe("m-9");
    // The whole reason this command exists rather than a second upsertRequest.
    expect(record.lastRequestedAt).toBe(before.lastRequestedAt);
    expect(record.requestCount).toBe(before.requestCount);
    expect(record.requestCount).toBe(1);
  });

  it("reports not-found for a record that is gone", () => {
    const result = applyOne(emptyState(), { kind: "setRequestMessageId", id: "nope/nope/1", messageId: "m" }, config);
    expect(result.result).toEqual({ kind: "not-found" });
  });
});

describe("stashSubmission", () => {
  const entry = (expiresAt: number) => ({ userId: "u-1", values: VALUES, expiresAt });

  it("stores an entry under its key", () => {
    const after = applyOne(emptyState(), { kind: "stashSubmission", key: "i-1", entry: entry(T0 + 1000), now: T0 }, config);
    expect(after.state.meta.retryStash["i-1"]?.userId).toBe("u-1");
  });

  it("prunes entries already past their expiry", () => {
    const seeded = { ...emptyState(), meta: { ...emptyState().meta, retryStash: { old: entry(T0 - 1) } } };
    const after = applyOne(seeded, { kind: "stashSubmission", key: "new", entry: entry(T0 + 1000), now: T0 }, config);
    expect(Object.keys(after.state.meta.retryStash)).toEqual(["new"]);
  });

  it("caps the map at budgets.retryStashEntries, dropping the soonest to expire first", () => {
    const stash: Record<string, ReturnType<typeof entry>> = {};
    for (let i = 0; i < config.budgets.retryStashEntries; i += 1) stash[`k${i}`] = entry(T0 + 1000 + i);
    const seeded = { ...emptyState(), meta: { ...emptyState().meta, retryStash: stash } };

    const after = applyOne(seeded, { kind: "stashSubmission", key: "newest", entry: entry(T0 + 99_999), now: T0 }, config);

    expect(Object.keys(after.state.meta.retryStash)).toHaveLength(config.budgets.retryStashEntries);
    expect(after.state.meta.retryStash["newest"]).toBeDefined();
    expect(after.state.meta.retryStash["k0"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=core tests/store/apply.test.ts`
Expected: FAIL — neither command kind exists in the union.

- [ ] **Step 3: Add the commands to the union**

In `src/store/types.ts`, add to `Command`, after the `upsertRequest` member:

```ts
  /**
   * Writes the posted request message's id onto an existing record and nothing
   * else. It exists because the alternative — a second `upsertRequest` — routes
   * through `markRequested`, which advances `lastRequestedAt` and increments
   * `requestCount`. That would land a first-time request at `requestCount: 2`
   * and move the very field the digest's staleness fence compares against, so a
   * claim on the digest that was just rendered would fail as `stale`.
   */
  | { kind: "setRequestMessageId"; id: string; messageId: string }
  /**
   * Stashes a rejected submission's values for the "Fix and retry" button,
   * pruning expired entries and capping the map in the same atomic step.
   *
   * A command rather than a `setMeta` patch precisely because of that
   * read-modify-write: building the new map in the handler and shipping it as a
   * patch would lose any entry a concurrent tick wrote in between.
   */
  | { kind: "stashSubmission"; key: string; entry: StashedSubmission; now: number }
```

- [ ] **Step 4: Implement both branches**

In `src/store/apply.ts`, add to `applyOne`'s switch, after the `upsertRequest` case:

```ts
    case "setRequestMessageId": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      return {
        state: { ...state, records: put(state.records, { ...existing, messageId: command.messageId }) },
        result: { kind: "ok" },
      };
    }

    case "stashSubmission": {
      // Prune first, then add, then cap — in that order. Pruning after adding
      // could drop the entry just written if the clock is at its expiry, and
      // capping before adding leaves the map one over.
      const live = Object.entries(state.meta.retryStash).filter(([, e]) => e.expiresAt > command.now);
      const withNew = [...live.filter(([k]) => k !== command.key), [command.key, command.entry] as const];

      // Soonest-to-expire is dropped first, so the entry most likely to still be
      // wanted survives.
      const capped = withNew
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
        .slice(Math.max(0, withNew.length - config.budgets.retryStashEntries));

      return {
        state: { ...state, meta: { ...state.meta, retryStash: Object.fromEntries(capped) } },
        result: { kind: "ok" },
      };
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run typecheck && npm test -- --project=core tests/store/apply.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store/types.ts src/store/apply.ts tests/store/apply.test.ts
git commit -m "feat(store): setRequestMessageId and stashSubmission commands"
```

---

## Task 3: The PRD merge, sort, and cap

**Files:**
- Modify: `src/core/prd.ts`
- Test: `tests/core/prd.test.ts`

**Interfaces:**
- Consumes: `PrdOption`, `PrdCache` from Task 1.
- Produces:
  - `interface RawThread { id: string; name: string; parent_id?: string | null; last_message_id?: string | null }`
  - `const PRD_OPTION_CAP = 24`
  - `function buildPrdCache(input: { active: RawThread[]; archived: RawThread[]; parentId: string; refreshedAt: number }): PrdCache`

- [ ] **Step 1: Write the failing tests**

`tests/core/prd.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildPrdCache, PRD_OPTION_CAP, type RawThread } from "../../src/core/prd.js";

const T0 = 1_756_000_000_000;
const PARENT = "forum-1";

function thread(id: string, over: Partial<RawThread> = {}): RawThread {
  return { id, name: `PRD ${id}`, parent_id: PARENT, last_message_id: id, ...over };
}

function build(active: RawThread[], archived: RawThread[] = []) {
  return buildPrdCache({ active, archived, parentId: PARENT, refreshedAt: T0 });
}

describe("buildPrdCache", () => {
  it("drops threads belonging to another parent — /threads/active is guild-wide", () => {
    const cache = build([thread("100"), thread("200", { parent_id: "other-forum" })]);
    expect(cache.options.map((o) => o.id)).toEqual(["100"]);
  });

  it("sorts by last_message_id descending, not by thread id", () => {
    // Thread 300 is the newest thread but has been quiet; 100 is older with
    // recent activity. Activity wins — the dropdown is ordered by what people
    // are actually discussing.
    const cache = build([
      thread("300", { last_message_id: "310" }),
      thread("100", { last_message_id: "900" }),
    ]);
    expect(cache.options.map((o) => o.id)).toEqual(["100", "300"]);
  });

  it("falls back to the thread id when last_message_id is absent, null, or unparseable", () => {
    const cache = build([
      thread("500", { last_message_id: null }),
      thread("700", { last_message_id: undefined }),
      thread("600", { last_message_id: "not-a-snowflake" }),
    ]);
    expect(cache.options.map((o) => o.id)).toEqual(["700", "600", "500"]);
  });

  it("merges archived threads and dedupes by id, preferring the active copy", () => {
    const cache = build([thread("100", { name: "live name" })], [thread("100", { name: "stale name" }), thread("50")]);
    expect(cache.options).toEqual([
      { id: "100", name: "live name" },
      { id: "50", name: "PRD 50" },
    ]);
  });

  it("caps at 24 and reports truncated, leaving the 25th select slot for None", () => {
    const many = Array.from({ length: 30 }, (_, i) => thread(String(1000 + i)));
    const cache = build(many);
    expect(cache.options).toHaveLength(PRD_OPTION_CAP);
    expect(PRD_OPTION_CAP).toBe(24);
    expect(cache.truncated).toBe(true);
    // Newest kept, oldest dropped.
    expect(cache.options[0]!.id).toBe("1029");
  });

  it("is not truncated at exactly the cap", () => {
    const cache = build(Array.from({ length: PRD_OPTION_CAP }, (_, i) => thread(String(1000 + i))));
    expect(cache.truncated).toBe(false);
  });

  it("clamps names to Discord's 100-character option label limit", () => {
    const cache = build([thread("100", { name: "x".repeat(400) })]);
    expect(cache.options[0]!.name.length).toBe(100);
  });

  it("records refreshedAt", () => {
    expect(build([thread("100")]).refreshedAt).toBe(T0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --project=core tests/core/prd.test.ts`
Expected: FAIL with "buildPrdCache is not exported".

- [ ] **Step 3: Implement**

Append to `src/core/prd.ts`:

```ts
/** A thread as either Discord threads endpoint returns it, narrowed to the
 *  fields this module reads. `last_message_id` is optional AND nullable, and
 *  Discord documents that it "may not point to an existing or valid message" —
 *  so all three of absent, null and unparseable are handled the same way. */
export interface RawThread {
  id: string;
  name: string;
  parent_id?: string | null;
  last_message_id?: string | null;
}

/**
 * How many cached threads the modal's PRD select may carry.
 *
 * Discord caps a string select at 25 options and "None" is one of them, so the
 * cache contributes 24. `src/core/render/digest.ts` does the same reservation
 * for the resolve menu's reopen options.
 */
export const PRD_OPTION_CAP = 24;

const OPTION_LABEL_LIMIT = 100;

/**
 * Sort key: last activity, falling back to creation.
 *
 * Both are snowflakes and therefore time-ordered, but they encode DIFFERENT
 * clocks — a thread id is creation time, `last_message_id` is last activity —
 * so a list sorted across both is an approximation of "most recently active",
 * not a total order on it. That is acceptable for a 24-entry dropdown and is
 * written down so nobody later reads the sort as exact.
 */
function activityKey(t: RawThread): bigint {
  const raw = t.last_message_id;
  if (raw !== null && raw !== undefined && /^\d+$/.test(raw)) return BigInt(raw);
  return /^\d+$/.test(t.id) ? BigInt(t.id) : 0n;
}

export function buildPrdCache(input: {
  active: RawThread[];
  archived: RawThread[];
  parentId: string;
  refreshedAt: number;
}): PrdCache {
  // Active first so its copy wins the dedupe: an archived listing can carry a
  // stale name for a thread that has since been renamed and revived.
  const byId = new Map<string, RawThread>();
  for (const t of [...input.active, ...input.archived]) {
    // `/guilds/{id}/threads/active` is guild-wide, so this filter is not
    // optional — without it the dropdown fills with every thread in the server.
    if ((t.parent_id ?? null) !== input.parentId) continue;
    if (!byId.has(t.id)) byId.set(t.id, t);
  }

  const sorted = [...byId.values()].sort((a, b) => {
    const ka = activityKey(a);
    const kb = activityKey(b);
    return ka === kb ? 0 : kb > ka ? 1 : -1;
  });

  return {
    options: sorted.slice(0, PRD_OPTION_CAP).map((t) => ({ id: t.id, name: t.name.slice(0, OPTION_LABEL_LIMIT) })),
    truncated: sorted.length > PRD_OPTION_CAP,
    refreshedAt: input.refreshedAt,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run typecheck && npm run lint && npm test -- --project=core tests/core/prd.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/prd.ts tests/core/prd.test.ts
git commit -m "feat(core): merge, sort and cap PRD forum threads for the modal"
```

---

## Task 4: Fetching the PRD threads

**Files:**
- Modify: `src/discord/rest.ts`
- Create: `src/discord/threads.ts`
- Test: `tests/workers/threads.test.ts`

**Interfaces:**
- Consumes: `DiscordRest`, `RestResult` from plan 1's Task 13; `RawThread`, `buildPrdCache`, `PrdCache` from Task 3.
- Produces:
  - `DiscordRest.getActiveThreads(guildId: string): Promise<RestResult<{ threads: RawThread[] }>>`
  - `DiscordRest.getArchivedPublicThreads(channelId: string, limit: number): Promise<RestResult<{ threads: RawThread[]; has_more?: boolean }>>`
  - `function fetchPrdThreads(rest: DiscordRest, guildId: string, parentId: string, now: number): Promise<{ cache: PrdCache | null; requests: number }>`

A `null` cache means "do not write" — the caller skips the `setMeta` patch, leaving whatever was cached before in place.

- [ ] **Step 1: Write the failing test**

`tests/workers/threads.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordRest } from "../../src/discord/rest.js";
import { fetchPrdThreads } from "../../src/discord/threads.js";

const T0 = 1_756_000_000_000;
const GUILD = "g-1";
const FORUM = "forum-1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(handler: (url: string) => Response) {
  const spy = vi.fn((input: RequestInfo | URL) => Promise.resolve(handler(String(input))));
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchPrdThreads", () => {
  it("reads both endpoints and merges them into one cache", async () => {
    const spy = stubFetch((url) =>
      url.includes("/guilds/")
        ? jsonResponse({ threads: [{ id: "200", name: "Active", parent_id: FORUM, last_message_id: "900" }] })
        : jsonResponse({ threads: [{ id: "100", name: "Archived", parent_id: FORUM, last_message_id: "100" }] }),
    );

    const result = await fetchPrdThreads(new DiscordRest("t"), GUILD, FORUM, T0);

    expect(result.requests).toBe(2);
    expect(result.cache?.options.map((o) => o.name)).toEqual(["Active", "Archived"]);
    expect(spy.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://discord.com/api/v10/guilds/g-1/threads/active",
      "https://discord.com/api/v10/channels/forum-1/threads/archived/public?limit=25",
    ]);
  });

  it("returns a null cache when the active-threads call fails, so the caller keeps the old list", async () => {
    stubFetch((url) => (url.includes("/guilds/") ? jsonResponse({ message: "nope" }, 403) : jsonResponse({ threads: [] })));
    const result = await fetchPrdThreads(new DiscordRest("t"), GUILD, FORUM, T0);
    expect(result.cache).toBeNull();
  });

  it("returns a null cache when the archived call fails", async () => {
    stubFetch((url) => (url.includes("/guilds/") ? jsonResponse({ threads: [] }) : jsonResponse({}, 500)));
    const result = await fetchPrdThreads(new DiscordRest("t"), GUILD, FORUM, T0);
    expect(result.cache).toBeNull();
  });

  it("still counts both requests when one fails, so the tick's subrequest budget stays honest", async () => {
    stubFetch((url) => (url.includes("/guilds/") ? jsonResponse({ threads: [] }) : jsonResponse({}, 500)));
    const result = await fetchPrdThreads(new DiscordRest("t"), GUILD, FORUM, T0);
    expect(result.requests).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --project=workers tests/workers/threads.test.ts`
Expected: FAIL — `src/discord/threads.ts` does not exist.

- [ ] **Step 3: Add the two REST methods**

In `src/discord/rest.ts`, import the thread type and add the methods after `getPins`:

```ts
import type { RawThread } from "../core/prd.js";
```

```ts
  /**
   * Guild-wide, NOT per-channel: results must be filtered by `parent_id`. There
   * is no channel-scoped active-threads route.
   */
  getActiveThreads(guildId: string): Promise<RestResult<{ threads: RawThread[] }>> {
    return this.call<{ threads: RawThread[] }>("GET", `/guilds/${guildId}/threads/active`);
  }

  /**
   * Ordered by `archive_timestamp` descending, and it reports `has_more`. We
   * read ONE page and ignore `has_more` deliberately: only the newest slice can
   * survive the 24-option cap anyway. (Pagination is available if that ever
   * changes — `before` here is an ISO8601 timestamp, not a snowflake.)
   */
  getArchivedPublicThreads(
    channelId: string,
    limit: number,
  ): Promise<RestResult<{ threads: RawThread[]; has_more?: boolean }>> {
    return this.call<{ threads: RawThread[]; has_more?: boolean }>(
      "GET",
      `/channels/${channelId}/threads/archived/public?limit=${limit}`,
    );
  }
```

- [ ] **Step 4: Implement the fetch**

Create `src/discord/threads.ts`:

```ts
import { buildPrdCache, type PrdCache } from "../core/prd.js";
import type { DiscordRest } from "./rest.js";

/** One page is enough: the cap is 24 and the archived listing is
 *  newest-archived-first, so a second page could only contribute entries the
 *  cap would discard. */
const ARCHIVED_PAGE_LIMIT = 25;

/**
 * Refresh-loop step 7.
 *
 * A `null` cache means DO NOT WRITE — the caller skips the `setMeta` patch and
 * whatever was cached before survives. That is the whole failure policy: a
 * week-old PRD list is a working dropdown, and an empty one is exactly the
 * outage the cache exists to prevent. Both requests are counted either way so
 * the tick's subrequest total stays honest.
 */
export async function fetchPrdThreads(
  rest: DiscordRest,
  guildId: string,
  parentId: string,
  now: number,
): Promise<{ cache: PrdCache | null; requests: number }> {
  const active = await rest.getActiveThreads(guildId);
  const archived = await rest.getArchivedPublicThreads(parentId, ARCHIVED_PAGE_LIMIT);
  const requests = 2;

  if (!active.ok || !archived.ok) {
    const failed = !active.ok ? `active ${active.status}` : `archived ${(archived as { status: number }).status}`;
    console.warn(`[PRD_CACHE_SKIPPED] thread fetch failed (${failed}); keeping the previously cached list`);
    return { cache: null, requests };
  }

  return {
    cache: buildPrdCache({
      active: active.value.threads ?? [],
      archived: archived.value.threads ?? [],
      parentId,
      refreshedAt: now,
    }),
    requests,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run typecheck && npm run lint && npm test -- --project=workers tests/workers/threads.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/discord/rest.ts src/discord/threads.ts tests/workers/threads.test.ts
git commit -m "feat(discord): fetch active and archived PRD forum threads"
```

---

## Task 5: Refresh-loop step 7

**Files:**
- Modify: `src/handlers/scheduled.ts:174` (the `// 7 (PRD cache) and 8 ...` comment), `src/index.ts:118-127`
- Test: `tests/workers/scheduled.test.ts`

**Interfaces:**
- Consumes: `fetchPrdThreads` from Task 4; `TickDeps`, `runTick` from plan 1's Task 17.
- Produces: `TickDeps.guildId: string`; step 7 emits a `setMeta` patch carrying `prdCache`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/workers/scheduled.test.ts`, following the fake-`fetch` and `MemoryStore` setup already used there:

```ts
describe("refresh loop step 7 — the PRD cache", () => {
  it("writes a freshly built cache into meta", async () => {
    const store = new MemoryStore(config, publisher());
    await runTick({ ...deps(store), guildId: "g-1" });

    const state = await store.readState();
    expect(state.meta.prdCache?.options.map((o) => o.id)).toEqual(["200"]);
    expect(state.meta.prdCache?.refreshedAt).toBe(NOW);
  });

  it("leaves the previous cache untouched when the fetch fails", async () => {
    const store = new MemoryStore(config, publisher());
    const previous = { options: [{ id: "9", name: "Old but usable" }], truncated: false, refreshedAt: NOW - 99_999 };
    await store.apply([{ kind: "setMeta", patch: { prdCache: previous } }], { now: NOW, rerender: false });

    threadsFail = true;
    await runTick({ ...deps(store), guildId: "g-1" });

    expect((await store.readState()).meta.prdCache).toEqual(previous);
  });

  it("counts both thread reads in the tick's subrequest total", async () => {
    // Asserted as a DELTA between two runs rather than against a hand-counted
    // absolute: the absolute moves whenever the scan reads a different number of
    // pages, so a literal here would be a test that fails for unrelated reasons.
    // Both runs read the threads — a failed fetch still costs two requests — so
    // the delta isolates nothing but the counting.
    const a = await runTick({ ...deps(new MemoryStore(config, publisher())), guildId: "g-1" });

    threadsFail = true;
    const b = await runTick({ ...deps(new MemoryStore(config, publisher())), guildId: "g-1" });

    expect(a.subrequests).toBe(b.subrequests);
    expect(a.subrequests).toBeGreaterThanOrEqual(4);
  });

  it("commits nothing in READ_ONLY mode but still reads the threads", async () => {
    const store = new MemoryStore(config, publisher());
    await runTick({ ...deps(store), guildId: "g-1", readOnly: true });
    expect((await store.readState()).meta.prdCache).toBeNull();
  });
});
```

Extend the file's existing fake `fetch` router with the two thread routes, returning
`{ threads: [{ id: "200", name: "Trust PRD", parent_id: config.prdForumChannelId, last_message_id: "900" }] }`
for the guild route and `{ threads: [] }` for the archived route, and a 500 for both when `threadsFail` is set. Record `baselineSubrequests` by running one tick with the thread routes stubbed out before adding step 7 — or simply assert the `+2` delta between a `threadsFail` run and a successful one, which is what the third test does.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=workers tests/workers/scheduled.test.ts`
Expected: FAIL — `guildId` is not on `TickDeps` and `prdCache` is never written.

- [ ] **Step 3: Add `guildId` to `TickDeps`**

In `src/handlers/scheduled.ts`:

```ts
  botUserId: string;
  /** For `GET /guilds/{id}/threads/active`, which has no channel-scoped
   *  equivalent — step 7 must ask guild-wide and filter. */
  guildId: string;
```

- [ ] **Step 4: Implement step 7**

Replace the placeholder comment at `src/handlers/scheduled.ts:174` with:

```ts
    // 7. Refresh the cached PRD thread list. A failed fetch returns a null cache
    // and emits NO command, so the previously cached list survives — an empty
    // dropdown is the outage the cache exists to prevent, and a stale one is a
    // working dropdown. Step 8 (reaction reads) belongs to plan 3.
    const prd = await fetchPrdThreads(rest, deps.guildId, config.prdForumChannelId, now);
    subrequests += prd.requests;
    if (prd.cache !== null) commands.push({ kind: "setMeta", patch: { prdCache: prd.cache } });
```

Add the import at the top of the file:

```ts
import { fetchPrdThreads } from "../discord/threads.js";
```

- [ ] **Step 5: Pass `guildId` from the worker**

In `src/index.ts`, inside the `runTick` call:

```ts
      botUserId: env.DISCORD_BOT_USER_ID,
      guildId: env.DISCORD_GUILD_ID,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run typecheck && npm test -- --project=workers tests/workers/scheduled.test.ts`
Expected: PASS. `READ_ONLY` needs no new code — the read-only branch already returns before `finishTick`, so the command is projected and discarded like every other.

- [ ] **Step 7: Commit**

```bash
git add src/handlers/scheduled.ts src/index.ts tests/workers/scheduled.test.ts
git commit -m "feat(tick): refresh the PRD thread cache as step 7"
```

---

## Task 6: The modal

**Files:**
- Create: `src/core/modal.ts`
- Test: `tests/core/modal.test.ts`

**Interfaces:**
- Consumes: `Config`, `PrdCache` from Task 1, `SubmittedValues` from Task 1's stub.
- Produces:
  - `const MODAL_ID = "request:modal"`, `const FIELD_IDS = { url, team, urgency, prd, note }`, `const PRD_NONE = "none"`
  - `function buildRequestModal(config: Config, prd: PrdCache | null, prefill?: SubmittedValues): InteractionResponse`

- [ ] **Step 1: Write the failing test**

`tests/core/modal.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { config } from "../../config/config.js";
import { buildRequestModal, FIELD_IDS, MODAL_ID, PRD_NONE } from "../../src/core/modal.js";
import type { PrdCache } from "../../src/core/prd.js";

const T0 = 1_756_000_000_000;

function cache(count: number, truncated = false): PrdCache {
  return {
    options: Array.from({ length: count }, (_, i) => ({ id: `t-${i}`, name: `PRD ${i}` })),
    truncated,
    refreshedAt: T0,
  };
}

// The payload is a nested tree; these read one field out of it by custom_id.
function field(response: ReturnType<typeof buildRequestModal>, id: string) {
  const labels = (response.data?.components ?? []) as { label: string; description?: string; component: Record<string, unknown> }[];
  return labels.find((l) => l.component["custom_id"] === id)!;
}

describe("buildRequestModal", () => {
  it("is a callback type 9 with the modal's custom_id and exactly five components", () => {
    const modal = buildRequestModal(config, cache(3));
    expect(modal.type).toBe(9);
    expect(modal.data?.custom_id).toBe(MODAL_ID);
    expect(modal.data?.components).toHaveLength(5);
  });

  it("wraps every input in a Label (type 18) — string selects are invalid in an action row in modals", () => {
    const modal = buildRequestModal(config, cache(3));
    const labels = modal.data?.components as { type: number }[];
    expect(labels.every((l) => l.type === 18)).toBe(true);
  });

  it("offers None plus the cached threads, never more than 25 options in total", () => {
    const prd = field(buildRequestModal(config, cache(24, true)), FIELD_IDS.prd);
    const options = prd.component["options"] as { value: string }[];
    expect(options).toHaveLength(25);
    expect(options[0]!.value).toBe(PRD_NONE);
  });

  it("says the list is truncated in the PRD label's description", () => {
    const prd = field(buildRequestModal(config, cache(24, true)), FIELD_IDS.prd);
    expect(prd.description).toContain("most recent");
  });

  it("offers only None on a cold cache and says the list is still loading", () => {
    const prd = field(buildRequestModal(config, null), FIELD_IDS.prd);
    expect(prd.component["options"]).toHaveLength(1);
    expect(prd.description).toContain("still loading");
  });

  it("puts the note requirement on the blocking urgency OPTION, not on the note field", () => {
    const modal = buildRequestModal(config, cache(3));
    const urgency = field(modal, FIELD_IDS.urgency);
    const blocking = (urgency.component["options"] as { value: string; description?: string }[]).find(
      (o) => o.value === "blocking",
    );
    expect(blocking?.description).toContain("note");
    // `required` is static in the payload Discord renders before any choice is
    // made, so the note field itself must stay optional and the rule is enforced
    // on submit.
    expect(field(modal, FIELD_IDS.note).component["required"]).toBe(false);
  });

  it("prefills the text inputs and marks the chosen select options default", () => {
    const modal = buildRequestModal(config, cache(3), {
      url: "https://github.com/paranext/paranext-core/pull/9",
      team: "Simple",
      urgency: "blocking",
      prdThreadId: "t-1",
      note: "just the CSS bit",
    });
    expect(field(modal, FIELD_IDS.url).component["value"]).toBe("https://github.com/paranext/paranext-core/pull/9");
    expect(field(modal, FIELD_IDS.note).component["value"]).toBe("just the CSS bit");
    const team = (field(modal, FIELD_IDS.team).component["options"] as { value: string; default?: boolean }[]).find(
      (o) => o.value === "Simple",
    );
    expect(team?.default).toBe(true);
  });

  it("clamps every string to its documented cap", () => {
    const long = { options: [{ id: "t", name: "n".repeat(400) }], truncated: false, refreshedAt: T0 };
    const modal = buildRequestModal(config, long, {
      url: "u".repeat(5000),
      team: "Power",
      urgency: "soon",
      prdThreadId: null,
      note: "x".repeat(5000),
    });
    expect((modal.data?.title ?? "").length).toBeLessThanOrEqual(45);
    for (const label of modal.data?.components as { label: string; description?: string }[]) {
      expect(label.label.length).toBeLessThanOrEqual(45);
      expect((label.description ?? "").length).toBeLessThanOrEqual(100);
    }
    expect((field(modal, FIELD_IDS.url).component["value"] as string).length).toBeLessThanOrEqual(4000);
    const prdOption = (field(modal, FIELD_IDS.prd).component["options"] as { label: string }[])[1]!;
    expect(prdOption.label.length).toBeLessThanOrEqual(100);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --project=core tests/core/modal.test.ts`
Expected: FAIL — `src/core/modal.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/core/modal.ts`:

```ts
import type { Config } from "../../config/config.js";
import { CallbackType, type InteractionResponse } from "../discord/components.js";
import type { PrdCache } from "./prd.js";
import type { SubmittedValues } from "./submit.js";

export const MODAL_ID = "request:modal";

export const FIELD_IDS = {
  url: "url",
  team: "team",
  urgency: "urgency",
  prd: "prd",
  note: "note",
} as const;

/** The PRD select's "no PRD" option. A sentinel rather than an empty string, so
 *  "the user chose None" and "the select returned nothing" stay distinguishable
 *  in the submit parser. */
export const PRD_NONE = "none";

// Discord's documented caps. Clamped here rather than discovered at runtime: a
// 400 from Discord on this path is an outage on the primary command.
const TITLE = 45;
const LABEL = 45;
const DESCRIPTION = 100;
const OPTION = 100;
const TEXT_VALUE = 4000;

const COMPONENT_LABEL = 18;
const COMPONENT_SELECT = 3;
const COMPONENT_TEXT = 4;
const TEXT_STYLE_SHORT = 1;

function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function label(text: string, description: string | undefined, component: Record<string, unknown>) {
  return {
    type: COMPONENT_LABEL,
    label: clamp(text, LABEL),
    ...(description === undefined ? {} : { description: clamp(description, DESCRIPTION) }),
    component,
  };
}

function select(
  customId: string,
  options: { label: string; value: string; description?: string }[],
  chosen: string | null,
) {
  return {
    type: COMPONENT_SELECT,
    custom_id: customId,
    min_values: 1,
    max_values: 1,
    options: options.map((o) => ({
      label: clamp(o.label, OPTION),
      value: clamp(o.value, OPTION),
      ...(o.description === undefined ? {} : { description: clamp(o.description, OPTION) }),
      ...(chosen !== null && o.value === chosen ? { default: true } : {}),
    })),
  };
}

function text(customId: string, opts: { required: boolean; placeholder?: string; value?: string }) {
  return {
    type: COMPONENT_TEXT,
    custom_id: customId,
    style: TEXT_STYLE_SHORT,
    required: opts.required,
    ...(opts.placeholder === undefined ? {} : { placeholder: opts.placeholder }),
    ...(opts.value === undefined ? {} : { value: clamp(opts.value, TEXT_VALUE) }),
  };
}

/**
 * The `/review-request` modal, built ENTIRELY from cached data.
 *
 * Nothing here may fetch. A modal cannot be sent after a deferred response, so
 * if the 3-second budget is missed the user sees "The application did not
 * respond" on the primary command with no escape hatch — any live call on this
 * path is a latent outage.
 *
 * A cold or failed cache is not an error: the PRD select falls back to None
 * alone and says why. One request with no PRD attached is exactly what every
 * scanned record already looks like.
 */
export function buildRequestModal(config: Config, prd: PrdCache | null, prefill?: SubmittedValues): InteractionResponse {
  const prdOptions = [
    { label: "None", value: PRD_NONE },
    ...(prd?.options ?? []).map((o) => ({ label: o.name, value: o.id })),
  ];

  // The two notes are mutually exclusive: an empty cache is never truncated.
  const prdNote =
    prd === null || prd.options.length === 0
      ? "The PRD list is still loading — pick None and re-request later if you need one."
      : prd.truncated
        ? "Showing the 24 most recently active PRDs."
        : undefined;

  return {
    type: CallbackType.Modal,
    data: {
      custom_id: MODAL_ID,
      title: clamp("Request a review", TITLE),
      components: [
        label("PR link", undefined, text(FIELD_IDS.url, {
          required: true,
          placeholder: "https://github.com/owner/repo/pull/123",
          value: prefill?.url,
        })),
        label("Team", undefined, select(
          FIELD_IDS.team,
          config.teams.map((t) => ({ label: t, value: t })),
          prefill?.team ?? null,
        )),
        label("Urgency", undefined, select(
          FIELD_IDS.urgency,
          config.urgencies.map((u) => ({
            label: `${u.emoji} ${u.label}`,
            value: u.key,
            // The requirement rides on the OPTION that triggers it, not on the
            // note field: the field's `required` is static in a payload Discord
            // renders before any choice is made, so the rule is enforced on
            // submit and this is the only place a user can be warned in advance.
            ...(u.requiresNote ? { description: "Requires a note explaining what is blocked." } : {}),
          })),
          prefill?.urgency ?? null,
        )),
        label("PRD", prdNote, select(FIELD_IDS.prd, prdOptions, prefill?.prdThreadId ?? PRD_NONE)),
        label("Note", "Optional, except for 🔥 Blocking.", text(FIELD_IDS.note, {
          required: false,
          placeholder: "just the CSS bit / needs a P10 build",
          value: prefill?.note,
        })),
      ],
    },
  };
}
```

This references `CallbackType.Modal` and a widened `InteractionResponse.data`, both of which land in Task 9. Implement Task 9's Step 3 before running these tests, or run them after Task 9 — the plan orders Task 6 first because the modal is the deliverable and the type widening is bookkeeping in service of it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run typecheck && npm run lint && npm test -- --project=core tests/core/modal.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/modal.ts tests/core/modal.test.ts
git commit -m "feat(core): the /review-request modal, built from cached data alone"
```

---

## Task 7: Parsing and validating a submission

**Files:**
- Modify: `src/core/submit.ts`
- Test: `tests/core/submit.test.ts`

**Interfaces:**
- Consumes: `parsePrUrl`, `isAllowlisted`, `prSlug`, `ParsedPr` from plan 1's Task 2; `FIELD_IDS`, `PRD_NONE` from Task 6.
- Produces:
  - `type SubmitRejection = { reason: "not-a-pr"; detail: ParseFailure } | { reason: "not-allowlisted"; slug: string } | { reason: "note-required" } | { reason: "merged" } | { reason: "closed" } | { reason: "not-found"; slug: string } | { reason: "credential"; slug: string }`
  - `function collectValues(components: unknown): Record<string, string>`
  - `function parseSubmission(components: unknown, config: Config): { ok: true; pr: ParsedPr; values: SubmittedValues } | { ok: false; values: SubmittedValues; rejection: SubmitRejection }`

The last four rejection reasons are produced by the handler after the GitHub fetch, not by `parseSubmission`; they live in this union so one renderer covers every rejection.

- [ ] **Step 1: Write the failing test**

`tests/core/submit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { config } from "../../config/config.js";
import { collectValues, parseSubmission } from "../../src/core/submit.js";

// The shape Discord sends back for a Label-wrapped modal. The parser walks the
// tree rather than indexing it, so it survives Discord wrapping fields
// differently — which it has already done once, moving from action rows to labels.
function submitted(over: Partial<Record<string, string>> = {}) {
  const values = {
    url: "https://github.com/paranext/paranext-core/pull/9",
    team: "Power",
    urgency: "soon",
    prd: "none",
    note: "",
    ...over,
  };
  return [
    { type: 18, component: { type: 4, custom_id: "url", value: values["url"] } },
    { type: 18, component: { type: 3, custom_id: "team", values: [values["team"]] } },
    { type: 18, component: { type: 3, custom_id: "urgency", values: [values["urgency"]] } },
    { type: 18, component: { type: 3, custom_id: "prd", values: [values["prd"]] } },
    { type: 18, component: { type: 4, custom_id: "note", value: values["note"] } },
  ];
}

describe("collectValues", () => {
  it("walks the tree, reading both text `value` and select `values`", () => {
    expect(collectValues(submitted())).toMatchObject({ url: expect.any(String), team: "Power", urgency: "soon" });
  });

  it("reads an action-row-wrapped payload identically", () => {
    const legacy = [{ type: 1, components: [{ type: 4, custom_id: "url", value: "https://x" }] }];
    expect(collectValues(legacy)["url"]).toBe("https://x");
  });

  it("returns an empty map rather than throwing on junk", () => {
    expect(collectValues(null)).toEqual({});
    expect(collectValues("nonsense")).toEqual({});
  });
});

describe("parseSubmission", () => {
  it("accepts a well-formed submission on an allowlisted repo", () => {
    const result = parseSubmission(submitted(), config);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pr).toEqual({ owner: "paranext", repo: "paranext-core", number: 9 });
  });

  it("maps the None sentinel to a null PRD", () => {
    const result = parseSubmission(submitted(), config);
    expect(result.values.prdThreadId).toBeNull();
  });

  it("keeps a chosen PRD thread id", () => {
    expect(parseSubmission(submitted({ prd: "t-7" }), config).values.prdThreadId).toBe("t-7");
  });

  it("rejects a URL that is not a GitHub PR, carrying the specific parse failure", () => {
    const result = parseSubmission(submitted({ url: "https://github.com/paranext/paranext-core/issues/9" }), config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection).toEqual({ reason: "not-a-pr", detail: "is-issue" });
  });

  it("rejects a repo that is not on the allowlist, naming it", () => {
    const result = parseSubmission(submitted({ url: "https://github.com/someone/else/pull/1" }), config);
    if (!result.ok) expect(result.rejection).toEqual({ reason: "not-allowlisted", slug: "someone/else" });
    else expect.unreachable();
  });

  it("rejects blocking urgency with an empty note", () => {
    const result = parseSubmission(submitted({ urgency: "blocking" }), config);
    if (!result.ok) expect(result.rejection).toEqual({ reason: "note-required" });
    else expect.unreachable();
  });

  it("rejects blocking urgency with a whitespace-only note", () => {
    const result = parseSubmission(submitted({ urgency: "blocking", note: "   \n  " }), config);
    if (!result.ok) expect(result.rejection).toEqual({ reason: "note-required" });
    else expect.unreachable();
  });

  it("accepts blocking urgency with a real note", () => {
    expect(parseSubmission(submitted({ urgency: "blocking", note: "demo Thursday" }), config).ok).toBe(true);
  });

  it("returns the raw submitted values on every rejection, so the prefill hands back what was typed", () => {
    const result = parseSubmission(submitted({ url: "  not a url  ", note: "keep me" }), config);
    expect(result.ok).toBe(false);
    expect(result.values.url).toBe("  not a url  ");
    expect(result.values.note).toBe("keep me");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --project=core tests/core/submit.test.ts`
Expected: FAIL — `collectValues` and `parseSubmission` are not exported.

- [ ] **Step 3: Implement**

Append to `src/core/submit.ts`:

```ts
import type { Config } from "../../config/config.js";
import { FIELD_IDS, PRD_NONE } from "./modal.js";
import { isAllowlisted, parsePrUrl, type ParsedPr, type ParseFailure } from "./urls.js";

/**
 * Every way a submission can be turned down, offline and online alike.
 *
 * The last four are produced by the handler after the GitHub fetch rather than
 * by `parseSubmission`. They live in the same union so ONE renderer covers every
 * rejection — a second rejection renderer is how two rejection paths come to
 * disagree about whether they carry a retry button.
 */
export type SubmitRejection =
  | { reason: "not-a-pr"; detail: ParseFailure }
  | { reason: "not-allowlisted"; slug: string }
  | { reason: "note-required" }
  | { reason: "merged" }
  | { reason: "closed" }
  | { reason: "not-found"; slug: string }
  | { reason: "credential"; slug: string };

export type SubmitParse =
  | { ok: true; pr: ParsedPr; values: SubmittedValues }
  | { ok: false; values: SubmittedValues; rejection: SubmitRejection };

/**
 * Flattens a modal submission into `custom_id -> value`.
 *
 * It WALKS the tree rather than indexing fixed positions, and reads both a text
 * input's `value` and a select's `values[0]`. Discord has already changed this
 * shape once — modals moved from action rows to `Label` wrappers — and a parser
 * that indexes positions breaks silently on the next such change, turning every
 * submission into a validation error nobody can explain.
 */
export function collectValues(components: unknown): Record<string, string> {
  const found: Record<string, string> = {};

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const rec = node as Record<string, unknown>;

    const id = rec["custom_id"];
    if (typeof id === "string") {
      if (typeof rec["value"] === "string") found[id] = rec["value"];
      else if (Array.isArray(rec["values"]) && typeof rec["values"][0] === "string") found[id] = rec["values"][0];
    }

    visit(rec["component"]);
    visit(rec["components"]);
  };

  visit(components);
  return found;
}

export function parseSubmission(components: unknown, config: Config): SubmitParse {
  const raw = collectValues(components);
  const prd = raw[FIELD_IDS.prd] ?? PRD_NONE;

  // Raw, unnormalised: this is what the retry prefill hands back, and a user
  // who typed trailing whitespace should see their own text, not a cleaned copy.
  const values: SubmittedValues = {
    url: raw[FIELD_IDS.url] ?? "",
    team: raw[FIELD_IDS.team] ?? "",
    urgency: raw[FIELD_IDS.urgency] ?? "",
    prdThreadId: prd === PRD_NONE || prd === "" ? null : prd,
    note: raw[FIELD_IDS.note] ?? "",
  };

  const level = config.urgencies.find((u) => u.key === values.urgency);
  if (level?.requiresNote === true && values.note.trim() === "") {
    // Enforced HERE and not in the modal: `required` is static in a payload
    // Discord renders before the user picks an urgency, and a modal has no
    // conditional logic and no re-render.
    return { ok: false, values, rejection: { reason: "note-required" } };
  }

  const parsed = parsePrUrl(values.url);
  if (!parsed.ok) return { ok: false, values, rejection: { reason: "not-a-pr", detail: parsed.reason } };

  if (!isAllowlisted(parsed.pr, config.repoAllowlist)) {
    return {
      ok: false,
      values,
      rejection: { reason: "not-allowlisted", slug: `${parsed.pr.owner}/${parsed.pr.repo}` },
    };
  }

  return { ok: true, pr: parsed.pr, values };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run typecheck && npm run lint && npm test -- --project=core tests/core/submit.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/submit.ts tests/core/submit.test.ts
git commit -m "feat(core): parse and validate a modal submission offline"
```

---

## Task 8: The rejection message and its retry button

**Files:**
- Create: `src/core/render/rejection.ts`
- Modify: `src/discord/components.ts` (add `CUSTOM_IDS.retry`)
- Test: `tests/core/render/rejection.test.ts`

**Interfaces:**
- Consumes: `SubmitRejection`, `SubmittedValues` from Task 7; `Config`.
- Produces:
  - `const RETRY_PREFIX = "request:retry:"`
  - `function retryCustomId(interactionId: string): string`
  - `function renderRejection(input: { rejection: SubmitRejection; values: SubmittedValues; stashKey: string | null; config: Config }): { content: string; components: unknown[] }`

- [ ] **Step 1: Write the failing test**

`tests/core/render/rejection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { config } from "../../../config/config.js";
import { renderRejection, RETRY_PREFIX, retryCustomId } from "../../../src/core/render/rejection.js";
import type { SubmittedValues } from "../../../src/core/submit.js";

const values: SubmittedValues = {
  url: "https://github.com/someone/else/pull/1",
  team: "Power",
  urgency: "blocking",
  prdThreadId: "t-1",
  note: "demo Thursday",
};

function render(rejection: Parameters<typeof renderRejection>[0]["rejection"], stashKey: string | null = "i-1") {
  return renderRejection({ rejection, values, stashKey, config });
}

describe("renderRejection", () => {
  it("names the unlisted repo and points at the file that would allow it", () => {
    const { content } = render({ reason: "not-allowlisted", slug: "someone/else" });
    expect(content).toContain("someone/else");
    expect(content).toContain("config/config.ts");
  });

  it("shows the expected URL shape when the link is not a PR", () => {
    expect(render({ reason: "not-a-pr", detail: "is-issue" }).content).toContain(
      "https://github.com/owner/repo/pull/123",
    );
  });

  it("says which of merged and closed happened", () => {
    expect(render({ reason: "merged" }).content).toContain("merged");
    expect(render({ reason: "closed" }).content).toContain("closed");
    expect(render({ reason: "merged" }).content).not.toContain("closed");
  });

  it("distinguishes a credential failure from a missing PR, since the fixes differ", () => {
    const missing = render({ reason: "not-found", slug: "paranext/paranext-core" }).content;
    const credential = render({ reason: "credential", slug: "paranext/paranext-core" }).content;
    expect(missing).not.toBe(credential);
    expect(credential).toContain("credential");
  });

  it("does not promise to tell apart a private PR from a missing one", () => {
    // GitHub returns NOT_FOUND for both; a message that guessed would be worse
    // than one that names both fixes.
    const { content } = render({ reason: "not-found", slug: "paranext/paranext-core" });
    expect(content).toContain("does not exist");
    expect(content).toContain("cannot see");
  });

  it("says the note is required for blocking, and why the modal could not", () => {
    expect(render({ reason: "note-required" }).content).toContain("🔥");
  });

  it("echoes the submitted values inline so a late-returning user can copy them", () => {
    const { content } = render({ reason: "merged" });
    expect(content).toContain("https://github.com/someone/else/pull/1");
    expect(content).toContain("demo Thursday");
    expect(content).toContain("Power");
  });

  it("carries a Fix and retry button whose custom_id is the stash key", () => {
    const { components } = render({ reason: "merged" }, "abc123");
    const row = components[0] as { components: { custom_id: string; label: string; type: number }[] };
    expect(row.components[0]!.custom_id).toBe(`${RETRY_PREFIX}abc123`);
    expect(row.components[0]!.label).toBe("Fix and retry");
    expect(row.components[0]!.custom_id.length).toBeLessThanOrEqual(100);
  });

  it("omits the button entirely when nothing was stashed", () => {
    expect(render({ reason: "merged" }, null).components).toEqual([]);
  });

  it("stays inside Discord's 2000-character message limit with hostile input", () => {
    const { content } = renderRejection({
      rejection: { reason: "not-allowlisted", slug: "x".repeat(900) },
      values: { url: "u".repeat(900), team: "t".repeat(900), urgency: "soon", prdThreadId: null, note: "n".repeat(900) },
      stashKey: "i-1",
      config,
    });
    expect(content.length).toBeLessThanOrEqual(2000);
  });
});

describe("retryCustomId", () => {
  it("prefixes the interaction id", () => {
    expect(retryCustomId("i-1")).toBe("request:retry:i-1");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --project=core tests/core/render/rejection.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `src/core/render/rejection.ts`:

```ts
import type { Config } from "../../../config/config.js";
import type { SubmitRejection, SubmittedValues } from "../submit.js";

export const RETRY_PREFIX = "request:retry:";

const MESSAGE_LIMIT = 2000;
const FIELD_ECHO_LIMIT = 300;

const COMPONENT_ACTION_ROW = 1;
const COMPONENT_BUTTON = 2;
const BUTTON_STYLE_PRIMARY = 1;

/** The values cannot travel in the button — a PR URL alone is most of the
 *  100-character `custom_id` cap — so the button carries only the stash key. */
export function retryCustomId(interactionId: string): string {
  return `${RETRY_PREFIX}${interactionId}`.slice(0, 100);
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function headline(rejection: SubmitRejection, config: Config): string {
  switch (rejection.reason) {
    case "not-a-pr":
      return "That does not look like a GitHub pull request link. Expected shape: `https://github.com/owner/repo/pull/123`";
    case "not-allowlisted":
      return (
        `**${clamp(rejection.slug, 120)}** is not on the repo allowlist, so the bot will not track it. ` +
        "Add it to `repoAllowlist` in `config/config.ts` — it is a one-line, reviewable change."
      );
    case "note-required": {
      const level = config.urgencies.find((u) => u.requiresNote);
      const name = level === undefined ? "🔥 Blocking" : `${level.emoji} ${level.label}`;
      return (
        `**${name}** needs a note saying what is blocked. ` +
        "The modal cannot ask for it conditionally — it has no re-render — so it is checked here instead."
      );
    }
    case "merged":
      return "That PR is already **merged**, so there is nothing left to review.";
    case "closed":
      return "That PR is **closed**, so there is nothing left to review.";
    case "not-found":
      return (
        `The bot could not read **${clamp(rejection.slug, 120)}**. Either the PR does not exist, or the bot ` +
        "cannot see it — GitHub answers both the same way, so this message cannot tell them apart. " +
        "Check the number first; if it is right, the repo is private to the bot."
      );
    case "credential":
      return (
        `The bot's GitHub **credential** for **${clamp(rejection.slug, 120)}** is failing, so it could not check ` +
        "that PR. This is not something you can fix from here — the request was not recorded. Check `/health`."
      );
  }
}

/**
 * A rejection the requester sees and nobody else.
 *
 * Ephemeral is not silent: every rejection names the specific problem and its
 * fix, and echoes the submitted values inline. The echo is not decoration — the
 * retry button dies with its 15-minute interaction token, and after that the
 * echoed text is the only copy of what the user typed.
 */
export function renderRejection(input: {
  rejection: SubmitRejection;
  values: SubmittedValues;
  stashKey: string | null;
  config: Config;
}): { content: string; components: unknown[] } {
  const { values } = input;
  const echo = [
    `> **Link:** ${clamp(values.url, FIELD_ECHO_LIMIT)}`,
    `> **Team:** ${clamp(values.team, FIELD_ECHO_LIMIT)} · **Urgency:** ${clamp(values.urgency, FIELD_ECHO_LIMIT)}`,
    ...(values.prdThreadId === null ? [] : [`> **PRD:** <#${clamp(values.prdThreadId, 40)}>`]),
    ...(values.note.trim() === "" ? [] : [`> **Note:** ${clamp(values.note, FIELD_ECHO_LIMIT)}`]),
  ].join("\n");

  const content = clamp(
    `${headline(input.rejection, input.config)}\n\nNothing was posted. What you entered:\n${echo}`,
    MESSAGE_LIMIT,
  );

  const components =
    input.stashKey === null
      ? []
      : [
          {
            type: COMPONENT_ACTION_ROW,
            components: [
              {
                type: COMPONENT_BUTTON,
                style: BUTTON_STYLE_PRIMARY,
                label: "Fix and retry",
                custom_id: retryCustomId(input.stashKey),
              },
            ],
          },
        ];

  return { content, components };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run typecheck && npm run lint && npm test -- --project=core tests/core/render/rejection.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/render/rejection.ts tests/core/render/rejection.test.ts
git commit -m "feat(core): rejection messages with an inline echo and a retry button"
```

---

## Task 9: Interaction plumbing — callback types, `ctx`, and the button-routing fix

**Files:**
- Modify: `src/discord/components.ts:12-25`, `src/handlers/interactions.ts:17-24,69-84`, `src/index.ts:76,88-94`
- Test: `tests/workers/interactions.test.ts`, `tests/workers/index.test.ts`

**Interfaces:**
- Produces:
  - `CallbackType.DeferredChannelMessageWithSource = 5`, `CallbackType.Modal = 9`
  - `InteractionResponse.data` widened with `components?: unknown[]`, `custom_id?: string`, `title?: string`
  - `Interaction` gains `id: string`, `token: string`, `data.components?: unknown`
  - `InteractionDeps.waitUntil: (work: Promise<unknown>) => void`
  - `fetch(request, env, ctx)`

This is the task plan 1 said did not exist. **The button-routing fix is a live bug**, not a new feature: `handleComponent` reads `interaction.data?.values?.[0]` and runs `decodeOptionValue` on it before it ever inspects `custom_id`, so any button — which carries no `values` — is answered "Could not read that selection" and never reaches a handler.

- [ ] **Step 1: Write the failing tests**

Add to `tests/workers/interactions.test.ts`:

```ts
it("routes a component by custom_id before it tries to decode a selection value", async () => {
  // A button carries no `values`. Before this fix, the shared decode ran first
  // and swallowed every button with "Could not read that selection".
  const response = await handleInteraction(
    signed({ type: 3, id: "i-1", token: "tok", data: { custom_id: "request:retry:missing" }, member: MEMBER }),
    deps(),
  );
  const body = await response.json();
  expect(body.data.content).not.toContain("Could not read that selection");
});

it("still reports an undecodable value for a SELECT menu", async () => {
  const response = await handleInteraction(
    signed({ type: 3, id: "i-1", token: "tok", data: { custom_id: "digest:claim", values: ["garbage"] }, member: MEMBER }),
    deps(),
  );
  expect((await response.json()).data.content).toContain("Could not read that selection");
});
```

Add to `tests/workers/index.test.ts` — every existing `worker.fetch(...)` call gains a third argument:

```ts
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
// ...each call becomes: await worker.fetch(healthRequest(), healthEnv(), ctx)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=workers tests/workers/interactions.test.ts`
Expected: FAIL — the retry `custom_id` is answered with "Could not read that selection".

- [ ] **Step 3: Widen the component types**

In `src/discord/components.ts`:

```ts
export const CUSTOM_IDS = {
  claim: "digest:claim",
  resolve: "digest:resolve",
} as const;
```

```ts
export const CallbackType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
  /** Answers now, finishes later. The ONLY way the submit path fits Discord's
   *  3-second budget while doing GitHub and Discord I/O. */
  DeferredChannelMessageWithSource: 5,
  DeferredUpdateMessage: 6,
  /** Opens a modal. Not valid in response to a MODAL_SUBMIT or a PING, which is
   *  why a rejected submission gets a button rather than another modal. */
  Modal: 9,
} as const;
```

```ts
export interface InteractionResponse {
  type: number;
  data?: {
    content?: string;
    flags?: number;
    embeds?: { color: number; description: string }[];
    components?: unknown[];
    custom_id?: string;
    title?: string;
  };
}
```

- [ ] **Step 4: Widen the `Interaction` shape and fix the routing order**

In `src/handlers/interactions.ts`:

```ts
interface Interaction {
  type: number;
  /** The interaction's own id. Used as the retry stash key — it is unique per
   *  submission and already inside the 100-character `custom_id` budget. */
  id?: string;
  /** Valid for 15 minutes. The credential for editing the deferred reply. */
  token?: string;
  data?: { custom_id?: string; values?: string[]; name?: string; components?: unknown };
  member?: { user: { id: string; global_name?: string | null; username: string } };
  user?: { id: string; global_name?: string | null; username: string };
  channel_id?: string;
}
```

In `handleComponent`, move the `custom_id` read above the decode and gate the decode on the menus that actually carry a value:

```ts
async function handleComponent(interaction: Interaction, deps: InteractionDeps) {
  const who = actor(interaction);
  if (who === null) return ephemeral("Could not identify who selected that.");

  const customId = interaction.data?.custom_id ?? "";

  // Routing happens on custom_id FIRST. A button carries no `values`, so
  // decoding a selection before checking the id answered every button with
  // "Could not read that selection" and no button could ever reach a handler.
  if (customId.startsWith(RETRY_PREFIX)) return handleRetry(interaction, customId, deps);

  const rawValue = interaction.data?.values?.[0] ?? "";
  const reopen = rawValue.startsWith("reopen:");
  const decoded = decodeOptionValue(reopen ? rawValue.slice("reopen:".length) : rawValue);
  if (decoded === null) {
    return ephemeral("Could not read that selection. The list may have been rewritten — try again.");
  }
  // ...unchanged from here
```

`handleRetry` arrives in Task 11. Until then, stub it in the same file so this task's tests pass on their own:

```ts
async function handleRetry(_i: Interaction, _c: string, _d: InteractionDeps) {
  return ephemeral("That form has expired. Run `/review-request` again.");
}
```

- [ ] **Step 5: Thread `ctx` through**

In `src/handlers/interactions.ts`, add to `InteractionDeps`:

```ts
  /** The worker's `ctx.waitUntil`. The submit path answers Discord inside three
   *  seconds and finishes afterwards; without this there is nowhere for the
   *  "afterwards" to run. Injectable so tests can await the background work
   *  instead of racing it. */
  waitUntil: (work: Promise<unknown>) => void;
```

In `src/index.ts`, change the signature and pass it:

```ts
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
```

```ts
      return handleInteraction(request, {
        store: storeFor(env),
        config,
        publicKey: env.DISCORD_PUBLIC_KEY,
        now: () => Date.now(),
        waitUntil: (work) => ctx.waitUntil(work),
      });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run typecheck && npm run lint && npm test -- --project=workers`
Expected: PASS. Every existing interaction test still passes — the decode path is unchanged for select menus.

- [ ] **Step 7: Commit**

```bash
git add src/discord/components.ts src/handlers/interactions.ts src/index.ts tests/workers/interactions.test.ts tests/workers/index.test.ts
git commit -m "fix(interactions): route components by custom_id before decoding a value

A button carries no `values`, so the shared decode ran first and answered
every button with 'Could not read that selection'. Also adds the callback
types and the ExecutionContext the deferred submit path needs."
```

---

## Task 10: Editing a deferred interaction reply

**Files:**
- Modify: `src/discord/rest.ts`
- Test: `tests/workers/rest.test.ts`

**Interfaces:**
- Produces: `DiscordRest.editInteractionResponse(appId: string, token: string, body: { content?: string; components?: unknown[]; flags?: number }): Promise<RestResult<unknown>>`

- [ ] **Step 1: Write the failing test**

Add to `tests/workers/rest.test.ts`:

```ts
describe("editInteractionResponse", () => {
  it("PATCHes @original on the webhook route", async () => {
    const spy = stubFetch(() => jsonResponse({ id: "m-1" }));
    await new DiscordRest("bot-token").editInteractionResponse("app-1", "tok-1", { content: "done" });

    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe("https://discord.com/api/v10/webhooks/app-1/tok-1/messages/@original");
    expect((init as RequestInit).method).toBe("PATCH");
  });

  it("sends no Authorization header — the interaction token IS the credential", async () => {
    const spy = stubFetch(() => jsonResponse({ id: "m-1" }));
    await new DiscordRest("bot-token").editInteractionResponse("app-1", "tok-1", { content: "done" });

    const headers = new Headers((spy.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get("authorization")).toBeNull();
    // The bot token must not leak onto a route that does not need it.
    expect(JSON.stringify([...headers])).not.toContain("bot-token");
  });

  it("reports a failure status rather than throwing", async () => {
    stubFetch(() => new Response("expired", { status: 404 }));
    const result = await new DiscordRest("t").editInteractionResponse("app-1", "tok-1", { content: "x" });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --project=workers tests/workers/rest.test.ts`
Expected: FAIL — `editInteractionResponse` is not a function.

- [ ] **Step 3: Implement**

In `src/discord/rest.ts`, add a sibling to `call` that omits the bot credential, then the method. `call` hardcodes `Authorization: Bot …` on every request, so this route cannot reuse it:

```ts
  /**
   * Edits the deferred reply to an interaction.
   *
   * Deliberately does NOT go through `call()`: that method sends
   * `Authorization: Bot …` on everything, and this route is authenticated by the
   * interaction token in the PATH. Discord's docs do not say whether a bot
   * header is tolerated here, so this sends none rather than resting on
   * folklore — and it keeps the bot token off a route that has no need of it.
   *
   * The token expires 15 minutes after the interaction; a 404 here is the
   * expected shape of "too late", not an error worth retrying.
   */
  async editInteractionResponse(
    appId: string,
    token: string,
    body: { content?: string; components?: unknown[]; flags?: number },
  ): Promise<RestResult<unknown>> {
    const response = await fetch(`${API}/webhooks/${appId}/${token}/messages/@original`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "pr-review-bot (https://github.com/paranext, 1.0)",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) return { ok: false, status: response.status, body: await response.text() };
    if (response.status === 204) return { ok: true, value: undefined };
    return { ok: true, value: await response.json() };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run typecheck && npm run lint && npm test -- --project=workers tests/workers/rest.test.ts`
Expected: PASS, 3 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/discord/rest.ts tests/workers/rest.test.ts
git commit -m "feat(discord): edit a deferred interaction reply on the webhook route"
```

---

## Task 11: The three entry points and the deferred submit

**Files:**
- Create: `src/handlers/reviewRequest.ts`
- Modify: `src/handlers/interactions.ts`
- Test: `tests/workers/reviewRequest.test.ts`

**Interfaces:**
- Consumes: `buildRequestModal` (Task 6), `parseSubmission` (Task 7), `renderRejection`, `RETRY_PREFIX` (Task 8), `editInteractionResponse` (Task 10), `fetchSnapshots` (plan 1 Task 16), `renderRequestMessage` (plan 1 Task 9), `upsertRequest` / `setRequestMessageId` / `stashSubmission` commands.
- Produces:
  - `interface RequestDeps` — `InteractionDeps` plus `rest: DiscordRest`, `credentials: CredentialProvider`, `appId: string`
  - `function openRequestModal(deps): Promise<InteractionResponse>`
  - `function handleRetryButton(interaction, customId, deps): Promise<InteractionResponse>`
  - `function handleModalSubmit(interaction, deps): InteractionResponse` — returns the deferral synchronously and schedules `finishSubmit`
  - `function finishSubmit(interaction, deps): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`tests/workers/reviewRequest.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../config/config.js";
import { MemoryStore } from "../../src/store/memory.js";
import { finishSubmit, handleModalSubmit, handleRetryButton, openRequestModal } from "../../src/handlers/reviewRequest.js";

const NOW = 1_756_000_000_000;
const URL_OK = "https://github.com/paranext/paranext-core/pull/9";

// ...fake DiscordRest and CredentialProvider built as in tests/workers/scheduled.test.ts;
// `posted` collects postMessage payloads, `edited` collects editInteractionResponse bodies.

function submission(over: Record<string, string> = {}) {
  const v = { url: URL_OK, team: "Power", urgency: "soon", prd: "none", note: "", ...over };
  return {
    id: "i-1",
    token: "tok",
    channel_id: "chan-1",
    member: { user: { id: "u-1", username: "jolie", global_name: "Jolie" } },
    data: {
      custom_id: "request:modal",
      components: Object.entries(v).map(([id, value]) => ({
        type: 18,
        component: { type: 4, custom_id: id, value },
      })),
    },
  };
}

describe("openRequestModal", () => {
  it("answers with a modal from the cache without fetching anything", async () => {
    const store = new MemoryStore(config, publisher());
    await store.apply(
      [{ kind: "setMeta", patch: { prdCache: { options: [{ id: "t-1", name: "Trust" }], truncated: false, refreshedAt: NOW } } }],
      { now: NOW, rerender: false },
    );
    const response = await openRequestModal(deps(store));

    expect(response.type).toBe(9);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still opens on a cold cache", async () => {
    const response = await openRequestModal(deps(new MemoryStore(config, publisher())));
    expect(response.type).toBe(9);
  });
});

describe("handleModalSubmit", () => {
  it("answers synchronously with a deferred ephemeral", () => {
    const response = handleModalSubmit(submission(), deps(new MemoryStore(config, publisher())));
    expect(response.type).toBe(5);
    expect(response.data?.flags).toBe(1 << 6);
  });
});

describe("finishSubmit", () => {
  let store: MemoryStore;
  beforeEach(() => { store = new MemoryStore(config, publisher()); });

  it("does not touch GitHub when offline validation fails", async () => {
    await finishSubmit(submission({ url: "https://github.com/someone/else/pull/1" }), deps(store));
    expect(githubSpy).not.toHaveBeenCalled();
    expect(Object.keys((await store.readState()).records)).toHaveLength(0);
    expect(edited[0]?.content).toContain("not on the repo allowlist");
  });

  it("stashes the values and offers a retry button on rejection", async () => {
    await finishSubmit(submission({ urgency: "blocking" }), deps(store));
    expect((await store.readState()).meta.retryStash["i-1"]?.values.urgency).toBe("blocking");
    expect(JSON.stringify(edited[0]?.components)).toContain("request:retry:i-1");
  });

  it("rejects a merged PR without recording anything", async () => {
    snapshot = { ...OPEN_SNAPSHOT, state: "MERGED", merged: true };
    await finishSubmit(submission(), deps(store));
    expect(edited[0]?.content).toContain("merged");
    expect(Object.keys((await store.readState()).records)).toHaveLength(0);
  });

  it("distinguishes a credential failure from a missing PR", async () => {
    githubResult = { snapshots: new Map(), notFound: [], failedGroups: ["public"], subrequests: 1 };
    await finishSubmit(submission(), deps(store));
    expect(edited[0]?.content).toContain("credential");
  });

  it("records the request, posts the message, and writes the message id back", async () => {
    await finishSubmit(submission(), deps(store));

    const record = (await store.readState()).records["paranext/paranext-core/9"]!;
    expect(record.source).toBe("command");
    expect(record.messageId).toBe("posted-1");
    expect(posted[0]?.content).toContain(URL_OK);
    expect(edited[0]?.content).toContain("on the list");
  });

  it("writing the message id back does not move requestCount or lastRequestedAt", async () => {
    await finishSubmit(submission(), deps(store));
    const record = (await store.readState()).records["paranext/paranext-core/9"]!;
    // The regression a second upsertRequest would cause.
    expect(record.requestCount).toBe(1);
    expect(record.lastRequestedAt).toBe(record.firstRequestedAt);
  });

  it("keeps the record and says the post failed when Discord rejects the message", async () => {
    postFails = true;
    await finishSubmit(submission(), deps(store));

    expect(Object.keys((await store.readState()).records)).toHaveLength(1);
    expect(edited[0]?.content).toContain("could not post");
  });

  it("re-requesting an existing record updates it rather than creating a second", async () => {
    await finishSubmit(submission(), deps(store));
    await finishSubmit({ ...submission({ urgency: "blocking", note: "demo" }), id: "i-2" }, deps(store));

    const state = await store.readState();
    expect(Object.keys(state.records)).toHaveLength(1);
    const record = state.records["paranext/paranext-core/9"]!;
    expect(record.requestCount).toBe(2);
    expect(record.urgency).toBe("blocking");
    expect(record.firstRequestedAt).toBeLessThan(record.lastRequestedAt);
  });
});

describe("handleRetryButton", () => {
  it("reopens the modal prefilled from the stash", async () => {
    const store = new MemoryStore(config, publisher());
    await finishSubmit(submission({ urgency: "blocking" }), deps(store));

    const response = await handleRetryButton({ id: "x", member: { user: { id: "u-1", username: "j" } } }, "request:retry:i-1", deps(store));
    expect(response.type).toBe(9);
    expect(JSON.stringify(response.data)).toContain("blocking");
  });

  it("opens an empty modal and says so when the stash has expired", async () => {
    const store = new MemoryStore(config, publisher());
    await finishSubmit(submission({ urgency: "blocking" }), deps(store));

    const late = deps(store, NOW + config.retryStashMs + 1);
    const response = await handleRetryButton({ id: "x", member: { user: { id: "u-1", username: "j" } } }, "request:retry:i-1", late);
    expect(response.type).toBe(4);
    expect(response.data?.content).toContain("expired");
  });

  it("refuses a stash key belonging to someone else", async () => {
    const store = new MemoryStore(config, publisher());
    await finishSubmit(submission({ urgency: "blocking" }), deps(store));

    const response = await handleRetryButton({ id: "x", member: { user: { id: "someone-else", username: "b" } } }, "request:retry:i-1", deps(store));
    expect(response.type).toBe(4);
    expect(response.data?.content).toContain("your form");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=workers tests/workers/reviewRequest.test.ts`
Expected: FAIL — `src/handlers/reviewRequest.ts` does not exist.

- [ ] **Step 3: Implement the handler**

Create `src/handlers/reviewRequest.ts`:

```ts
import type { Config } from "../../config/config.js";
import { buildRequestModal } from "../core/modal.js";
import type { PrRecord, RequestFields } from "../core/record.js";
import { renderRequestMessage } from "../core/render/request.js";
import { renderRejection, RETRY_PREFIX } from "../core/render/rejection.js";
import { parseSubmission, type SubmitRejection, type SubmittedValues } from "../core/submit.js";
import { prSlug, type ParsedPr } from "../core/urls.js";
import { CallbackType, EPHEMERAL_FLAG, ephemeral, type InteractionResponse } from "../discord/components.js";
import type { DiscordRest } from "../discord/rest.js";
import type { CredentialProvider } from "../github/credentials.js";
import { fetchSnapshots } from "../github/query.js";
import type { Store } from "../store/types.js";

export interface RequestDeps {
  store: Store;
  config: Config;
  rest: DiscordRest;
  credentials: CredentialProvider;
  appId: string;
  now: () => number;
  waitUntil: (work: Promise<unknown>) => void;
}

interface SubmitInteraction {
  id?: string;
  token?: string;
  channel_id?: string;
  member?: { user: { id: string; global_name?: string | null; username: string } };
  user?: { id: string; global_name?: string | null; username: string };
  data?: { components?: unknown };
}

function actorOf(i: SubmitInteraction): { id: string; name: string } | null {
  const user = i.member?.user ?? i.user;
  return user === undefined ? null : { id: user.id, name: user.global_name ?? user.username };
}

/** Built from the cache and nothing else — see `buildRequestModal`. */
export async function openRequestModal(deps: RequestDeps, prefill?: SubmittedValues): Promise<InteractionResponse> {
  const state = await deps.store.readState();
  return buildRequestModal(deps.config, state.meta.prdCache, prefill);
}

export async function handleRetryButton(
  interaction: SubmitInteraction,
  customId: string,
  deps: RequestDeps,
): Promise<InteractionResponse> {
  const who = actorOf(interaction);
  if (who === null) return ephemeral("Could not identify who pressed that.");

  const key = customId.slice(RETRY_PREFIX.length);
  const state = await deps.store.readState();
  const stashed = state.meta.retryStash[key];

  // Defensive, not user-facing: the rejection is ephemeral, so in practice only
  // the submitter can see the button. A stash key is not a capability, and this
  // check is what makes that true.
  if (stashed !== undefined && stashed.userId !== who.id) {
    return ephemeral("That is not your form. Run `/review-request` to start your own.");
  }

  if (stashed === undefined || stashed.expiresAt <= deps.now()) {
    return ephemeral(
      "That form has expired. Run `/review-request` again — the values are still in the message above, ready to copy.",
    );
  }

  return openRequestModal(deps, stashed.values);
}

/**
 * Answers Discord inside its 3-second budget and finishes afterwards.
 *
 * The deferral is returned SYNCHRONOUSLY and the work is scheduled through
 * `waitUntil`. Doing the work first and deferring after would miss the budget on
 * every submission that touches GitHub — which is all of them.
 */
export function handleModalSubmit(interaction: SubmitInteraction, deps: RequestDeps): InteractionResponse {
  deps.waitUntil(finishSubmit(interaction, deps));
  return { type: CallbackType.DeferredChannelMessageWithSource, data: { flags: EPHEMERAL_FLAG } };
}

async function reject(
  interaction: SubmitInteraction,
  rejection: SubmitRejection,
  values: SubmittedValues,
  deps: RequestDeps,
): Promise<void> {
  const now = deps.now();
  const userId = actorOf(interaction)?.id ?? null;
  const key = interaction.id ?? null;

  if (key !== null && userId !== null) {
    await deps.store.apply(
      [{
        kind: "stashSubmission",
        key,
        entry: { userId, values, expiresAt: now + deps.config.retryStashMs },
        now,
      }],
      { now, rerender: false },
    );
  }

  const rendered = renderRejection({ rejection, values, stashKey: key, config: deps.config });
  await deps.rest.editInteractionResponse(deps.appId, interaction.token ?? "", {
    content: rendered.content,
    components: rendered.components,
  });
}

/**
 * The submit path proper, run in the background after the deferral.
 *
 * Order matters and is load-bearing: offline validation first (no network at
 * all on a bad link), then GitHub, then the record, then the channel post. The
 * record is written BEFORE the post because the stored record is what
 * `renderRequestMessage` renders and the record is where the posted message's id
 * has to go — a cycle that the `setRequestMessageId` command breaks. If the post
 * fails the record survives and the digest still shows it.
 */
export async function finishSubmit(interaction: SubmitInteraction, deps: RequestDeps): Promise<void> {
  const now = deps.now();
  const who = actorOf(interaction);
  const parse = parseSubmission(interaction.data?.components, deps.config);

  if (!parse.ok) return reject(interaction, parse.rejection, parse.values, deps);
  if (who === null) return;

  const pr: ParsedPr = parse.pr;
  const slug = prSlug(pr);
  const outcome = await fetchSnapshots(deps.credentials, [slug], now);
  const snapshot = outcome.snapshots.get(slug);

  if (snapshot === undefined) {
    // A credential that failed wholesale is a different problem with a different
    // fix, and it is the ONE case GitHub's NOT_FOUND does not swallow.
    const reason: SubmitRejection =
      outcome.failedGroups.length > 0 ? { reason: "credential", slug } : { reason: "not-found", slug };
    return reject(interaction, reason, parse.values, deps);
  }
  if (snapshot.merged) return reject(interaction, { reason: "merged" }, parse.values, deps);
  if (snapshot.state === "CLOSED") return reject(interaction, { reason: "closed" }, parse.values, deps);

  const fields: RequestFields = {
    team: parse.values.team as RequestFields["team"],
    urgency: parse.values.urgency as RequestFields["urgency"],
    prdThreadId: parse.values.prdThreadId,
    note: parse.values.note.trim() === "" ? null : parse.values.note.trim(),
    requesterId: who.id,
    requesterName: who.name,
    channelId: interaction.channel_id ?? deps.config.digestChannelId,
    messageId: null,
  };

  const applied = await deps.store.apply(
    [{
      kind: "upsertRequest",
      pr,
      at: now,
      fields,
      title: snapshot.title,
      prAuthorLogin: snapshot.authorLogin,
      isDraft: snapshot.isDraft,
    }],
    { now, rerender: deps.config.immediateDigestRewrite },
  );

  const created = applied.results[0]?.kind === "created";
  const state = await deps.store.readState();
  const record: PrRecord | undefined = state.records[slug];

  let postedNote = "";
  if (record !== undefined) {
    const post = await deps.rest.postMessage(fields.channelId, { content: renderRequestMessage(record, deps.config) });
    if (post.ok) {
      await deps.store.apply([{ kind: "setRequestMessageId", id: slug, messageId: post.value.id }], {
        now,
        rerender: false,
      });
    } else {
      // The record is already stored, so the row is on the list either way. Say
      // what failed rather than implying nothing happened.
      postedNote = ` I could not post the request message in the channel (Discord said ${post.status}), so nobody was pinged — but the PR is tracked.`;
    }
  }

  await deps.rest.editInteractionResponse(deps.appId, interaction.token ?? "", {
    content:
      (created
        ? `**${record?.title ?? slug}** is on the list.`
        : `Updated your existing request for **${record?.title ?? slug}** — it is back at the top of its team's section.`) +
      postedNote,
  });
}
```

- [ ] **Step 4: Wire the three entry points into `interactions.ts`**

Replace the `// /review-request belongs to plan 2.` line in `handleInteraction`:

```ts
  if (interaction.type === InteractionType.ApplicationCommand) {
    if (interaction.data?.name === "review-list") {
      const state = await deps.store.readState();
      return json(renderReviewList(state, deps.config, deps.now()));
    }
    if (interaction.data?.name === "review-request") {
      const request = requestDeps(deps);
      if (request === null) return json(ephemeral("That command is not enabled yet."));
      return json(await openRequestModal(request));
    }
    return json(ephemeral("That command is not enabled yet."));
  }

  if (interaction.type === InteractionType.ModalSubmit) {
    const request = requestDeps(deps);
    if (request === null) return json(ephemeral("That command is not enabled yet."));
    return json(handleModalSubmit(interaction, request));
  }
```

Replace the Task 9 stub with the real delegation, and add the deps narrowing:

```ts
async function handleRetry(interaction: Interaction, customId: string, deps: InteractionDeps) {
  const request = requestDeps(deps);
  if (request === null) return ephemeral("That command is not enabled yet.");
  return handleRetryButton(interaction, customId, request);
}

/**
 * `rest`, `credentials` and `appId` are optional on `InteractionDeps` so the
 * digest's claim and resolve menus — which need none of them — keep working in
 * every test and every deployment that has not enabled the command yet. Anything
 * on the request path needs all three, and this is the one place that checks.
 */
function requestDeps(deps: InteractionDeps): RequestDeps | null {
  if (deps.rest === undefined || deps.credentials === undefined || deps.appId === undefined) return null;
  return { ...deps, rest: deps.rest, credentials: deps.credentials, appId: deps.appId };
}
```

Add to `InteractionDeps`:

```ts
  /** Present only once the command is enabled; the digest menus need none of
   *  these. See `requestDeps`. */
  rest?: DiscordRest;
  credentials?: CredentialProvider;
  appId?: string;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run typecheck && npm run lint && npm test -- --project=workers`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/handlers/reviewRequest.ts src/handlers/interactions.ts tests/workers/reviewRequest.test.ts
git commit -m "feat(interactions): /review-request modal, deferred submit, and retry"
```

---

## Task 12: Worker wiring, the app id binding, and command registration

**Files:**
- Modify: `src/index.ts:88-94`, `src/env.d.ts`, `scripts/register-commands.ts`
- Test: `tests/workers/index.test.ts`

**Interfaces:**
- Consumes: `RequestDeps` from Task 11.
- Produces: `Env.DISCORD_APP_ID`; `register-commands --all`.

- [ ] **Step 1: Write the failing test**

Add to `tests/workers/index.test.ts`:

```ts
it("passes the Discord client, credentials and app id to the interactions handler", async () => {
  // Reaching the modal at all proves all three arrived: requestDeps() returns
  // null without them and the command answers "not enabled yet".
  const response = await worker.fetch(signedInteraction({ type: 2, data: { name: "review-request" } }), fullEnv(), ctx);
  expect((await response.json()).type).toBe(9);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --project=workers tests/workers/index.test.ts`
Expected: FAIL — the response is an ephemeral "not enabled yet".

- [ ] **Step 3: Declare the binding**

In `src/env.d.ts`, add beside the other Discord secrets, and correct the file's standing comment about KV:

```ts
      DISCORD_GUILD_ID: string;
      /** The application id, for `PATCH /webhooks/{app_id}/{token}/...`. Kept as
       *  its own secret rather than derived from DISCORD_BOT_USER_ID: the two are
       *  the same snowflake for a bot application in practice, but that equality
       *  is undocumented, and getting it wrong 404s every followup edit on a path
       *  that must not fail. `docs/setup.md` and `scripts/register-commands.ts`
       *  already use this secret. */
      DISCORD_APP_ID: string;
```

Update the "Deliberately absent" note: the KV namespace is still absent, but the cache that would have needed it now lives in the Durable Object — see `adr-no-kv-namespace`.

- [ ] **Step 4: Pass the new dependencies**

In `src/index.ts`:

```ts
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
```

- [ ] **Step 5: Add `--all` to the registration script**

In `scripts/register-commands.ts`, define the second command and gate it:

```ts
const REVIEW_REQUEST = {
  name: "review-request",
  description: "Ask for review on a pull request",
  type: 1,
};

// `/review-list` registers at deploy; `/review-request` only with --all. That is
// rollout stage 3, gated on the shadow-mode threshold in the design spec — the
// read-only command is registered straight away because it is the mitigation for
// a deleted or unpinned digest, which is likeliest during shadow mode.
const commands = process.argv.includes("--all") ? [REVIEW_LIST, REVIEW_REQUEST] : [REVIEW_LIST];
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run typecheck && npm run lint && npm test -- --project=workers`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/env.d.ts scripts/register-commands.ts tests/workers/index.test.ts
git commit -m "feat: wire /review-request into the worker and register it behind --all"
```

---

## Task 13: Fixtures and the preview harness

**Files:**
- Create: `fixtures/responses/threads-active.json`, `fixtures/responses/threads-archived-public.json`
- Modify: `preview/build.ts`, `tests/core/fixtures.test.ts`
- Test: `tests/core/fixtures.test.ts`

**Interfaces:**
- Consumes: `buildPrdCache` (Task 3), `buildRequestModal` (Task 6), `renderRejection` (Task 8).

The archived fixture must be recorded from a **forum** channel. Discord documents `GET /channels/{id}/threads/archived/public` under text-channel parents and does not state forum behaviour, so a text-channel fixture would prove nothing about the channel this actually reads.

- [ ] **Step 1: Write the failing test**

Add to `tests/core/fixtures.test.ts`:

```ts
describe("PRD thread fixtures", () => {
  it("builds a cache from real recorded responses", async () => {
    const active = await readFixture("threads-active.json");
    const archived = await readFixture("threads-archived-public.json");

    const cache = buildPrdCache({
      active: active.threads,
      archived: archived.threads,
      parentId: FORUM_ID,
      refreshedAt: T0,
    });

    expect(cache.options.length).toBeGreaterThan(0);
    expect(cache.options.length).toBeLessThanOrEqual(24);
    expect(cache).toMatchSnapshot();
  });

  it("the guild-wide active listing really does contain other parents", () => {
    // If this ever stops being true the parent_id filter looks like dead code and
    // someone deletes it. This is the fixture that says why it is there.
    expect(active.threads.some((t) => t.parent_id !== FORUM_ID)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --project=core tests/core/fixtures.test.ts`
Expected: FAIL — the fixture files do not exist.

- [ ] **Step 3: Record the fixtures**

Against the scratch server from rollout stage 1, with the bot token exported:

```bash
curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  "https://discord.com/api/v10/guilds/$DISCORD_GUILD_ID/threads/active" \
  > fixtures/responses/threads-active.json

curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  "https://discord.com/api/v10/channels/$PRD_FORUM_ID/threads/archived/public?limit=25" \
  > fixtures/responses/threads-archived-public.json
```

Scrub anything that is not needed to exercise the merge: keep `id`, `name`, `parent_id`, `last_message_id` on each thread, drop the rest. Keep at least one thread from a different `parent_id` in the active listing — that is what the second test asserts.

- [ ] **Step 4: Add the modal and rejections to the preview harness**

In `preview/build.ts`, add a section rendering: the modal on a full cache, on a truncated cache, on a cold cache, and prefilled; and every `SubmitRejection` variant. Render the modal as pretty-printed JSON alongside a plain-text sketch of the five fields — the point is to read the labels and descriptions as a person would, which is what caught the v1 spec's timestamp defect.

- [ ] **Step 5: Run the preview and the tests**

Run: `npm run preview && npm test -- --project=core`
Expected: PASS, and `preview/out` contains the modal and rejection sections. Read them — a label over 45 characters is a 400 from Discord on the primary command, and the preview is where that gets caught.

- [ ] **Step 6: Commit**

```bash
git add fixtures/responses preview/build.ts tests/core/fixtures.test.ts tests/core/__snapshots__
git commit -m "test: recorded thread fixtures and previews for the modal and rejections"
```

---

## Task 14: Documentation and ADRs

**Files:**
- Modify: `README.md`, `docs/setup.md`, `docs/operations.md`, `docs/architecture.md:244-248`, `docs/architecture-decisions.md`

- [ ] **Step 1: Amend `adr-no-kv-namespace`**

That ADR explicitly deferred this decision — "when that plan lands, adding the binding is itself a one-line, reviewable change." Append a dated amendment recording the answer:

```markdown
**Amendment (2026-09-02, plan 2).** The PRD thread cache landed, and the binding
is still not needed. The cache lives in the Durable Object's `Meta` alongside the
scan cursors, for a reason this ADR's original framing did not anticipate: KV is
eventually consistent, and the cache is read *within seconds* of being written —
a list the cron refreshed is read by the very next modal. So is the retry stash,
which the v1 spec had already placed in the store. Both values want the
consistency the Durable Object gives and KV does not, so the ADR's decision
stands unchanged and this is the last thing that was going to challenge it.
```

- [ ] **Step 2: Add the not-found ADR**

Append `adr-not-found-vs-not-visible` to `docs/architecture-decisions.md`, following the file's existing Context / Decision / Alternatives rejected shape. Context: the v1 spec asks rejections to distinguish "does not exist" from "the bot cannot see it". Decision: they are not distinguished per-PR, because GitHub's GraphQL API returns `NOT_FOUND` for both; a wholesale credential failure for the owner's group *is* distinguished, because `failedGroups` reports it. Alternatives rejected: guessing from repo visibility (the bot cannot see a private repo to know it is private, which is the whole problem), and a second unauthenticated probe (an extra subrequest on the slowest path to distinguish two cases with nearly the same fix).

- [ ] **Step 3: Fix `docs/architecture.md`**

Delete the whole "`/review-request`, its modal, and the PRD thread cache are a later plan" bullet at `docs/architecture.md:244-248`. Its final three lines assert the command "is not wired up yet" and that `src/handlers/interactions.ts` answers "That command is not enabled yet", both of which are now false. Add to the architecture body: the three interaction entry points, and refresh-loop step 7. Leave the `:code_review:` reaction bullet alone — that is still plan 3.

- [ ] **Step 4: Update `docs/setup.md`**

`DISCORD_APP_ID` is already documented as a secret; add that it is now also a Worker binding read at request time, and add the bot's read permission on the PRD forum channel to the permissions list. Add the stage-3 registration step:

```markdown
Once shadow mode has met its threshold, register the command:

    npm run register-commands -- --all

Until then `npm run register-commands` registers only `/review-list`.
```

- [ ] **Step 5: Update `docs/operations.md` and `README.md`**

`docs/operations.md`: how to read `[PRD_CACHE_SKIPPED]` in the tick log (the previous list is still being served; check the bot's access to the forum channel), and that a PRD dropdown showing only "None" means the cache has never successfully refreshed rather than that there are no PRDs.

`README.md`: replace the "Later, once `/review-request` is enabled" paragraph with the real flow — run the command, fill in five fields, submit; a rejected submission is private and has a **Fix and retry** button that reopens the form with what you typed; re-running it on a PR already on the list updates that entry instead of adding a second.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/
git commit -m "docs: /review-request runbook, the storage amendment, and a not-found ADR"
```

---

## What this plan deliberately does not build

Named so a reviewer can tell a gap from a decision:

- **The `:code_review:` reaction claim path** and refresh-loop step 8 — plan 3, unchanged.
- **Performing rollout stage 3.** The command is built and registrable; enabling it is an operational step gated on the shadow-mode threshold.
- **`READ_ONLY` on the submit path.** Unreachable by construction: `READ_ONLY` is shadow mode, which is stage 2, and the command is not registered until stage 3. If shadow mode is ever run with the command registered, this is the first thing to revisit.
- **Taking the store lease on the interactive path.** The submit path's three store calls interleave freely with a running tick. Two consequences are accepted with reasons in the spec: a concurrent tick can resolve the record between the write and the read-back, and an immediate digest rewrite can overlap `commitTick`'s PATCH. Both are milliseconds wide and self-correcting on the next tick; closing them means blocking interactive writes on the cron, which the store's design refuses.
- **Validating cached PRD thread ids at submit time.** A thread deleted between refresh and submit renders one dead `<#id>` mention.
- **A second archived-threads page.** `has_more` is ignored deliberately — only the newest 24 survive the cap.

## Plan self-review

Run before executing, recorded here so the reviewer can check the checker.

**Spec coverage.** Every section of the spec maps to a task: Scope → all; "The plumbing plan 1 did not build" → 9, 10, 12 (items 1–5 respectively: `ctx` in 9, client and credentials in 11–12, webhook route in 10, types in 9, button routing in 9); Decisions → 1 (storage), 6 (cold cache), 4 (failed fetch), 8 and 11 (not-found), 11 (write-before-post), 3 (no id validation), 6 (Label); The modal → 6; character budgets → 6; the 24 + None arithmetic → 3 and 6; server-side 🔥 → 7; The submit path → 11; `DISCORD_APP_ID` vs `DISCORD_BOT_USER_ID` → 12; the races → the deliberate-omissions list; Rejections and the stash → 2, 8, 11; `config.retryStashMs` → 1; prune-on-write → 2; The PRD thread cache → 3, 4, 5; Storage → 1, 2; Testing → every task, plus 13; Answered objections → the deliberate-omissions list; Rollout and documentation → 12, 14.

**Two ordering hazards, both called out in place.** Task 6's modal imports `CallbackType.Modal` and a widened `InteractionResponse`, which land in Task 9 — Task 6's Step 3 says so. And Task 9 introduces a `handleRetry` stub that Task 11 replaces; the stub exists so Task 9's own tests pass at its own gate rather than depending on a later task.

**One thing left open on purpose.** The archived-threads fixture must be recorded from a real forum channel, which needs the scratch server from rollout stage 1. Until then Task 13's fixture test cannot run, and no earlier task depends on it. Everything else runs from fakes.

**Type consistency.** `PrdOption`, `PrdCache`, `RawThread`, `PRD_OPTION_CAP`, `SubmittedValues`, `SubmitRejection`, `SubmitParse`, `StashedSubmission`, `RequestDeps`, `MODAL_ID`, `FIELD_IDS`, `PRD_NONE` and `RETRY_PREFIX` are each defined in exactly one task and imported by name thereafter. `PRD_OPTION_CAP` is 24 and the select's total is 25; those two numbers appear together in Task 3's comment and Task 6's test so they cannot drift. `SubmittedValues` is created in Task 1 (as a stub file) and extended in Task 7 — same file, same name, no second definition.
