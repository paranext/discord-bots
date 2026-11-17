# Review Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record anonymous, team-wide review timing as weekly totals. Show them privately through `/review-stats` and to machines through a token-protected `GET /stats`.

**Architecture:**

- Each record gains per-round fields (start, first claim, drops, re-requests, link to a pending entry).
- When a round resolves, `applyCommands` writes an identity-free pending entry into a new top-level `StoreState.stats`.
- A tick command folds each closed week (plus `reopenWindowMs`) into histogram totals and deletes its entries.
- Both outputs read only folded weeks, through one shared `figures()` function that applies the disclosure thresholds.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Object (SQLite-backed, one state blob), Vitest (`core` project in Node, `workers` project in workerd), Discord HTTP interactions, GitHub GraphQL.

**Spec:** `docs/superpowers/specs/2026-11-03-review-stats-design.md`

## Global Constraints

- Schema version becomes **7**. Every persisted shape change goes through `src/store/schema.ts` (`adr-durable-object-schema-version`).
- A pending entry holds only: `id`, `week`, `outcome`, `waitToClaimMs`, `claimToDoneMs`, `totalMs`, `claimed`, `claimsDropped`, `reRequests`.
  - **It never holds** a Discord id, name, GitHub login, repo, PR number, title, note, team, urgency or message id.
- Durations are rounded to the nearest **5 minutes**. Negative durations are clamped to **0**.
- Weeks are ISO weeks in **UTC**, formatted `YYYY-Www` (e.g. `2026-W45`). An entry's week is the week the bot **recorded** the resolution.
- A week is folded when `weekEnd + reopenWindowMs <= now`. Its entries are deleted at the same time.
- Histogram bucket edges (ms), fixed once shipped: 15m, 30m, 1h, 2h, 4h, 8h, 1d, 2d, 3d, 5d, 7d, 14d. That gives 13 buckets; the last is open-ended.
- Histograms count `reviewed` entries only. `waitToClaim` and `claimToDone` also require `claimed`.
- Disclosure thresholds:
  - median needs **≥ 5** rounds
  - 75th percentile needs **≥ 20** rounds
  - counts are shown as-is
  - histograms are never returned
- Outputs read folded weeks only, through `stats.foldedThrough`. Nothing pending is ever shown.
- A release counts as a drop only if the claim was held **≥ 5 minutes**. A stale auto-clear always counts. Resolve and re-request never count.
- `/review-stats` works in any channel and replies ephemerally. `/stats` uses `STATS_TOKEN` and answers 404 when the token is unset (the same rule as `/health`).
- Add no `console.*` line that prints an entry, or an entry id or durations together with a PR id.

## Review Focus

1. **A tick-resolved row is reopened from the menu and re-resolved by the next tick.** There must be exactly one pending entry for the round. Test: Task 5, "reopen then re-resolve leaves one entry".
2. **A reopen command arrives after a re-request has already reopened the record.** It must not withdraw the previous round's entry. Test: Task 5, "reopen of an open record withdraws nothing".
3. **A record that was open at deploy (`roundStartedAt: null`) later resolves.** It writes no entry and must not throw. Test: Task 5, "legacy round writes no entry".
4. **The year boundary and 53-week years.** `isoWeek` and `shiftWeek` must be right across them. Tests: Task 1.
5. **Someone runs `/review-stats` before and after one PR resolves.** The output must be identical. Test: Task 7, "a resolution does not change the summary until its week is folded".

---

### Task 1: Week and histogram helpers

**Files:**
- Create: `src/core/stats/week.ts`, `src/core/stats/histogram.ts`
- Test: `tests/core/stats/week.test.ts`, `tests/core/stats/histogram.test.ts`

**Interfaces:**
- Produces:
  - `isoWeek(epochMs: number): string`
  - `weekStartMs(week: string): number` (Monday 00:00 UTC)
  - `weekEndMs(week: string): number` (= start + 7 days)
  - `shiftWeek(week: string, delta: number): string`
  - `BUCKET_EDGES_MS: readonly number[]` (length 12)
  - `bucketIndex(ms: number): number` (0..12)
  - `emptyHistogram(): number[]` (length 13, zeros)
  - `addHistograms(a: number[], b: number[]): number[]`
  - `histogramCount(h: number[]): number`
  - `quantile(h: number[], p: number): number | null`

- [ ] **Step 1: Write the failing tests**

```ts
// week.test.ts
expect(isoWeek(Date.UTC(2026, 10, 3, 12))).toBe("2026-W45");      // Tue
expect(isoWeek(Date.UTC(2026, 10, 2, 0))).toBe("2026-W45");       // Mon 00:00 starts it
expect(isoWeek(Date.UTC(2026, 10, 1, 23, 59))).toBe("2026-W44");  // Sun
expect(isoWeek(Date.UTC(2024, 11, 31))).toBe("2025-W01");
expect(isoWeek(Date.UTC(2027, 0, 1))).toBe("2026-W53");           // 2026 has 53 weeks
expect(weekStartMs("2026-W45")).toBe(Date.UTC(2026, 10, 2));
expect(weekEndMs("2026-W45")).toBe(Date.UTC(2026, 10, 9));
expect(shiftWeek("2026-W53", 1)).toBe("2027-W01");
expect(shiftWeek("2025-W01", -1)).toBe("2024-W52");
// string order is chronological order
expect(shiftWeek("2026-W09", 1) > "2026-W09").toBe(true);

// histogram.test.ts
const H = 3_600_000;
expect(bucketIndex(0)).toBe(0);
expect(bucketIndex(15 * 60_000)).toBe(1);        // edges are lower-inclusive
expect(bucketIndex(20 * 24 * H)).toBe(12);
const h = emptyHistogram(); h[bucketIndex(H)] = 10;        // all in [1h, 2h)
expect(quantile(h, 0.5)).toBe(1.5 * H);                     // linear interpolation
expect(quantile(emptyHistogram(), 0.5)).toBeNull();
const open = emptyHistogram(); open[12] = 3;
expect(quantile(open, 0.5)).toBe(14 * 24 * H);              // open bucket → its lower edge
expect(histogramCount(addHistograms(h, open))).toBe(13);
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `npx vitest run --project=core tests/core/stats`. Expected: FAIL, because the modules don't exist yet.
- [ ] **Step 3: Implement both modules.**
  - `quantile`: walk the buckets until the cumulative count reaches `p * n`, then interpolate linearly within that bucket: `lower + (target − before) / count × width`.
- [ ] **Step 4: Run the tests and confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat: ISO week and duration histogram helpers for review stats`

---

### Task 2: Schema version 7 (shapes only, no behaviour)

**Files:**
- Create: `src/core/stats/types.ts`
- Modify:
  - `src/core/record.ts` (`PrRecord`, `newCommandRecord`)
  - `src/store/types.ts` (`StoreState`, `CURRENT_SCHEMA_VERSION`, version doc comment)
  - `src/store/apply.ts` (`emptyState`)
  - `src/store/schema.ts` (widen `StoredRecord`/`StoredState`, add the 6 → 7 step)
  - `src/core/submit.ts:37` and `src/handlers/reviewRequest.ts:274`: correct the stale "128 KiB" comments to the SQLite backend's 2 MB
- Test: `tests/workers/do.test.ts` (migration block near line 810), `tests/store/apply.test.ts`

**Interfaces:**
- Produces in `src/core/stats/types.ts`:

```ts
export type RoundOutcome = "reviewed" | "merged-unreviewed" | "closed-unreviewed" | "cleared";
export interface PendingEntry {
  id: number; week: string; outcome: RoundOutcome;
  waitToClaimMs: number | null; claimToDoneMs: number | null; totalMs: number;
  claimed: boolean; claimsDropped: number; reRequests: number;
}
export interface WeekTotals {
  outcomes: Record<RoundOutcome, number>;
  claimsDropped: number; roundsWithDrop: number; reRequests: number;
  histograms: { waitToClaim: number[]; claimToDone: number[]; total: number[] };
}
export interface StatsState {
  nextEntryId: number;
  pending: PendingEntry[];
  weeks: Record<string, WeekTotals>;
  /** Latest week folded; outputs never read past it. */
  foldedThrough: string | null;
}
export function emptyStats(): StatsState;
export function emptyWeek(): WeekTotals;
```

- `PrRecord` gains:
  - `roundStartedAt: number | null`
  - `roundFirstClaimedAt: number | null`
  - `roundClaimsDropped: number`
  - `roundReRequests: number`
  - `roundPendingEntryId: number | null`

  Each gets a doc comment. `null` start means "open at deploy; this round writes no entry".
- `StoreState` gains `stats: StatsState`.

- [ ] **Step 1: Write the failing tests**
  - In `do.test.ts`'s migration block, following the v5 test's pattern: a v6 state with one open claimed record migrates to `CURRENT_SCHEMA_VERSION` (7). The migrated record must have `roundStartedAt: null`, `roundFirstClaimedAt: null`, `roundClaimsDropped: 0`, `roundReRequests: 0` and `roundPendingEntryId: null`, and the state must have `stats` equal to `emptyStats()`.
  - In `apply.test.ts`: `emptyState().stats` equals `emptyStats()`. Also, `newCommandRecord` with `at: T0` gives `roundStartedAt: T0` and zeroed counters.
- [ ] **Step 2: Run the tests and confirm they fail.** Run `npx vitest run tests/workers/do.test.ts tests/store/apply.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Widen `StoredRecord` so the five new fields are optional, and `StoredState` so `stats` is optional.
  - Add `if (state.schemaVersion === 6) { … schemaVersion: 7 }` with a comment explaining why null means "skip this round".
  - Update the `CURRENT_SCHEMA_VERSION` doc comment.
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: PASS.
  - Snapshot tests that serialise whole records may need `-u`. Accept the update **only** if the diff is the five new fields.
- [ ] **Step 5: Commit.** Message: `feat: schema version 7 — per-round record fields and StoreState.stats`

---

### Task 3: Round tracking on claims, releases and requests

**Files:**
- Modify:
  - `src/core/claims.ts`: `applyClaim`, `applyUnclaim(r, userId, at)` (new `at` parameter), `clearStaleClaim`
  - `src/core/record.ts`: `markRequested`
  - `src/core/reactions.ts`: pass `now` to `applyUnclaim`
  - `src/store/types.ts`: the `unclaim` command gains `at: number`
  - `src/store/apply.ts`: pass `command.at`
  - `src/handlers/interactions.ts`: put `at: now` on the unclaim command
- Create: the `MISTAKEN_RELEASE_MS = 5 * 60_000` constant, exported from `src/core/claims.ts`
- Test: `tests/core/claims.test.ts`, `tests/core/record.test.ts`, `tests/core/reactions.test.ts`

**Interfaces:**
- Consumes: the `PrRecord` round fields from Task 2.
- Produces: `applyUnclaim(r: PrRecord, userId: string, at: number): ClaimOutcome`, plus the round-field semantics below, which Task 5 relies on.

- [ ] **Step 1: Write the failing tests**
  - `applyClaim` on an unclaimed record at `T0+H` sets `roundFirstClaimedAt: T0+H`. A second claim after a release keeps the first value.
  - `applyUnclaim` behaviour:
    - With a claim held 2 h, `roundClaimsDropped` goes 0 → 1.
    - With a claim held 4 min, it stays 0 (`MISTAKEN_RELEASE_MS`).
    - **On a record with no claim, it stays 0 and the record is returned unchanged (`toBe`).**
  - `clearStaleClaim` past the threshold increments `roundClaimsDropped`.
  - `resolveRecord` leaves `roundClaimsDropped` and `roundFirstClaimedAt` unchanged.
  - `markRequested` on an **open** record:
    - `roundReRequests` +1
    - `roundStartedAt`, `roundFirstClaimedAt` and `roundClaimsDropped` unchanged, even though the claim is cleared
  - `markRequested` on an open record with `roundStartedAt: null`: `roundStartedAt` stays null.
  - `markRequested` on a **resolved** record at `T1`:
    - `roundStartedAt: T1`
    - `roundFirstClaimedAt: null`, `roundClaimsDropped: 0`, `roundReRequests: 0`, `roundPendingEntryId: null`
  - Reactions: a reaction release of a claim held 1 h increments `roundClaimsDropped`.
- [ ] **Step 2: Run the tests and confirm they fail.** Run `npx vitest run --project=core`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Decide "resolved vs open" in `markRequested` from `r.resolvedAt !== null` **before** calling `reopenRecord`.
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat: track first claim, drops and re-requests per review round`

---

### Task 4: Exit outcome and GitHub done times

**Files:**
- Modify:
  - `src/core/exit.ts`: `PrSnapshot`, `ExitVerdict`, `exitVerdict`; add `applySnapshotWithExit`
  - `src/github/query.ts`: query fields, `RawPr`, `toSnapshot`
  - every test helper that builds a `PrSnapshot` literal. Find them with `grep -rln "reviews: \[\]" tests fixtures`, then add `mergedAt: null, closedAt: null`.
  - `fixtures/responses/github-batch.json`: add `mergedAt`/`closedAt` to the PR nodes
- Test: `tests/core/exit.test.ts`, `tests/workers/query.test.ts`

**Interfaces:**
- Consumes: `RoundOutcome` (Task 2).
- Produces:
  - `PrSnapshot` gains `mergedAt: number | null` and `closedAt: number | null` (epoch ms).
  - `export interface RoundExit { outcome: RoundOutcome; doneAt: number | null }`, where null means "use the recording time".
  - `ExitVerdict` becomes `{ resolve: false } | { resolve: true; resolvedBy: string; exit: RoundExit }`.
  - `applySnapshotWithExit(record, snapshot, now): { record: PrRecord; exit: RoundExit | null }`. `exit` is non-null only when this call resolved an open record.
  - `applySnapshot` stays as `applySnapshotWithExit(...).record`.

- [ ] **Step 1: Write the failing tests.** All cases use `exitVerdict(record, snapshot)`.

| Snapshot | `resolvedBy` | `exit` |
|---|---|---|
| merged, `mergedAt: T0+3H`, qualifying review at `T0+H` | `"merged"` (unchanged) | `{ outcome: "reviewed", doneAt: T0+H }` |
| merged, no qualifying review | `"merged"` | `{ outcome: "merged-unreviewed", doneAt: T0+3H }` |
| merged, `mergedAt: null` | `"merged"` | `doneAt: null` |
| `CLOSED`, `closedAt: T0+2H`, no review | `"closed"` | `{ outcome: "closed-unreviewed", doneAt: T0+2H }` |
| open, reviews at `T0+2H` and `T0+H` | `"review by …"` | `{ outcome: "reviewed", doneAt: T0+H }` (earliest) |

  Also:
  - `applySnapshotWithExit` on an already-resolved record returns `exit: null`.
  - In `query.test.ts`, `buildQuery` output contains `mergedAt` and `closedAt`, and `toSnapshot` parses the ISO strings to epoch ms, or to null.
- [ ] **Step 2: Run the tests and confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Compute qualifying reviews once, with the existing `countsAsReview(r, author, record.lastRequestedAt)`.
  - Keep the `resolvedBy` precedence (merged, then closed, then review) exactly as it is.
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat: exit verdict carries outcome and GitHub done time`

---

### Task 5: Write and withdraw pending entries

**Files:**
- Create: `src/core/stats/entry.ts`
- Modify: `src/store/apply.ts` (the `applySnapshot`, `resolve` and `reopen` cases, plus a local helper)
- Test: `tests/core/stats/entry.test.ts`, `tests/store/apply.test.ts`

**Interfaces:**
- Consumes:
  - `RoundExit` and `applySnapshotWithExit` (Task 4)
  - `isoWeek` (Task 1)
  - `StatsState` and `PendingEntry` (Task 2)
- Produces: `buildEntry(record: PrRecord, exit: RoundExit, id: number, recordedAt: number): PendingEntry | null`. Its rules:
  - null when `record.roundStartedAt === null`
  - `doneAt ?? recordedAt` is the done time
  - `week = isoWeek(recordedAt)`
  - rounding and clamping as in Global Constraints
  - `claimed = roundFirstClaimedAt !== null`

- [ ] **Step 1: Write the failing tests**
  - `entry.test.ts`:
    - A round started `T0`, first claimed `T0+62min`, reviewed `T0+3H+1min` gives `waitToClaimMs: 60min` and `claimToDoneMs: 120min` (both rounded), `totalMs: 180min` and `claimed: true`.
    - An unclaimed round gives `waitToClaimMs: null` and `claimToDoneMs: null`.
    - `doneAt` before the first claim gives `claimToDoneMs: 0`.
    - `roundStartedAt: null` returns null.
    - **`Object.keys(entry).sort()` equals exactly the nine Global Constraints fields.**
  - `apply.test.ts` (new `describe("review stats entries")`):
    - An `applySnapshot` that resolves an open record:
      - `stats.pending` has length 1
      - `stats.nextEntryId` is 1
      - the record's `roundPendingEntryId` is 0
    - An `applySnapshot` on an already-resolved record writes nothing.
    - `resolve` gives one entry with `outcome: "cleared"` and `claimToDone` measured to `command.at`.
    - **reopen then re-resolve leaves one entry:** resolve via snapshot, `reopen`, then the same snapshot again. `stats.pending` has length 1 and holds the second id.
    - **reopen of an open record withdraws nothing:** resolve, then `upsertRequest` (new round), then `reopen`. The pending entry from the first round is still present.
    - **legacy round writes no entry:** a record with `roundStartedAt: null` resolved by snapshot leaves `stats.pending` empty and `nextEntryId` at 0.
- [ ] **Step 2: Run the tests and confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement in `apply.ts`.**
  - Add a helper `endRound(state, resolved: PrRecord, exit: RoundExit, at: number): StoreState`. It builds the entry, appends it, bumps `nextEntryId`, sets `roundPendingEntryId`, and `put`s the record.
  - `reopen` withdraws only when the existing record was resolved and `reopenRecord`'s result is open. It then filters `pending` by id and nulls the link.
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat: write an anonymous pending entry when a review round ends`

---

### Task 6: Fold closed weeks in the tick

**Files:**
- Create: `src/core/stats/fold.ts`
- Modify:
  - `src/store/types.ts`: add the `{ kind: "foldStats"; now: number }` command
  - `src/store/apply.ts`: the new case returns `{ kind: "count", count }`
  - `src/handlers/scheduled.ts`: push `foldStats` before `purgeResolved`; add `statsFolded` to `TickReport`, `empty` and `resultCounters`
- Test: `tests/core/stats/fold.test.ts`, `tests/store/apply.test.ts`, `tests/workers/scheduled.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 5.
- Produces: `foldStats(stats: StatsState, now: number, reopenWindowMs: number): { stats: StatsState; foldedIds: number[] }`. Its rules:
  - `foldedThrough` becomes `shiftWeek(isoWeek(now − reopenWindowMs), −1)`. It never moves backwards.
  - Every pending entry with `week <= foldedThrough` is added to `weeks[week]` and removed from `pending`.
  - `apply.ts` nulls `roundPendingEntryId` on any record whose link is in `foldedIds`.

- [ ] **Step 1: Write the failing tests**
  - `fold.test.ts`, with `reopenWindowMs = 24h`:
    - An entry in `2026-W44` at `now = Mon 2026-11-02 12:00Z` is still pending, because W44 ended only 12 h ago.
    - At `Tue 2026-11-03 00:00Z` it is folded:
      - `weeks["2026-W44"].outcomes.reviewed === 1`
      - its `total` histogram count is 1
      - `pending` is empty
      - `foldedThrough === "2026-W44"`
    - A `cleared` entry adds to `outcomes.cleared` and to no histogram.
    - An unclaimed `reviewed` entry adds only to `total`.
    - `claimsDropped: 2` adds 2 to `claimsDropped` and 1 to `roundsWithDrop`.
    - Running it a second time changes nothing.
  - In `apply.test.ts`: after `foldStats`, the linked record's `roundPendingEntryId` is null.
  - In `scheduled.test.ts`: the tick's command list contains `foldStats` before `purgeResolved`, and `report.statsFolded` reflects the count.
- [ ] **Step 2: Run the tests and confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat: fold closed weeks into weekly totals and delete their entries`

---

### Task 7: Figures, the `/review-stats` command and its registration

**Files:**
- Create:
  - `src/core/stats/figures.ts`
  - `src/core/render/stats.ts`
  - `src/handlers/reviewStats.ts`
- Modify:
  - `src/handlers/interactions.ts`: route `review-stats` next to `review-list`, with no channel gate
  - `scripts/register-commands.ts`: add `REVIEW_STATS` (`name: "review-stats"`, `description: "Show anonymous team review stats, privately"`, `type: 1`) to `commands`
- Test: `tests/core/stats/figures.test.ts`, `tests/core/render/stats.test.ts`, `tests/workers/interactions.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 6.
- Produces:

```ts
export const MIN_ROUNDS_FOR_MEDIAN = 5;
export const MIN_ROUNDS_FOR_P75 = 20;
export interface DurationFigures { waitToClaim: number | null; claimToDone: number | null; total: number | null }
export interface Figures {
  outcomes: Record<RoundOutcome, number>;
  claimsDropped: number; roundsWithDrop: number; reRequests: number;
  medianMs: DurationFigures; p75Ms: DurationFigures;
}
export function mergeWeeks(stats: StatsState, endWeek: string, count: number): WeekTotals; // missing weeks = empty
export function figures(t: WeekTotals): Figures;
export function reviewStatsSummary(stats: StatsState):
  { through: string; current: Figures; previous: Figures } | null; // null when foldedThrough is null
// render/stats.ts
export function renderReviewStats(summary: ReturnType<typeof reviewStatsSummary>): { color: number; description: string }[];
// handlers/reviewStats.ts
export function reviewStatsResponse(state: StoreState): InteractionResponse; // ephemeralEmbeds(renderReviewStats(...))
```

- The windows: `current` is `mergeWeeks(stats, through, 4)` and `previous` is `mergeWeeks(stats, shiftWeek(through, −4), 4)`.
- The reply follows option A:
  - "Review stats: 4 weeks through `<week>`"
  - 📥 reviews completed `N` (prev 4 wks: `M`)
  - ⏱ typical wait until claimed
  - 🔍 claimed → done
  - 🐢 slowest 1 in 4 took over X end to end. This line is **omitted** when the p75 is null.
  - ↩️ `N` claims dropped or auto-cleared
  - the footer: "Typical = median. Complete weeks only; a figure needs at least 5 reviews."
- A null median renders "not enough reviews yet".
- The direction text (`▼ from X` / `▲ from X`) appears only when both medians are non-null.
- Durations are formatted as minutes under 1 h, hours with one decimal under 2 days, and days with one decimal above that.
- When the summary is null, the reply says that stats start after the first full week.

- [ ] **Step 1: Write the failing tests**
  - `figures.test.ts`:
    - With 4 reviewed rounds in the window, `medianMs.total` is null. With 5 it isn't.
    - With 19 rounds, `p75Ms.total` is null. With 20 it isn't.
    - Counts pass through unchanged at n=1.
    - `mergeWeeks` over a gap week gives the sum of the others.
  - **"a resolution does not change the summary until its week is folded":**
    1. Build a state with folded weeks.
    2. Compute `reviewStatsSummary`.
    3. Run `applyCommands` with a resolving `applySnapshot`.
    4. Recompute. The result must equal (`toEqual`) the first.
  - `render/stats.test.ts`:
    - Null medians render "not enough reviews yet".
    - The p75 line is absent below 20.
    - Arrows appear only when both periods have medians.
    - The null summary renders the "after the first full week" message.
  - `interactions.test.ts`:
    - An application command `review-stats` from a channel **not** in `allowedChannelIds` returns 200.
    - `data.flags & EPHEMERAL_FLAG` is set.
    - It has one embed.
- [ ] **Step 2: Run the tests and confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test && npm run typecheck && npm run lint`.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat: /review-stats — private 4-week summary from folded weekly totals`

---

### Task 8: `GET /stats` endpoint

**Files:**
- Create: `src/handlers/stats.ts`
- Modify:
  - `src/index.ts`: add a `/stats` route, GET/HEAD only, 405 otherwise, mirroring `/health`
  - `src/env.d.ts`: `STATS_TOKEN?: string`
- Test: `tests/workers/stats.test.ts` (follow `tests/workers/health.test.ts`'s structure), `tests/workers/index.test.ts`

**Interfaces:**
- Consumes:
  - `healthAuthFailure(token, authorization)` from `src/handlers/health.ts`
  - `figures`, `mergeWeeks` (Task 7)
  - `shiftWeek` (Task 1)
- Produces: `handleStats(deps: { store: Store; token?: string | undefined; authorization?: string | null | undefined; url: URL }): Promise<Response>`.

  The response body is `{ foldedThrough: string | null, weeks: Array<{ week: string } & Figures & { rolling4: Figures }> }`:
  - The rows are oldest first, ending at `foldedThrough`.
  - The row count comes from `?weeks=N`: an integer clamped to 1..104, defaulting to 26 when missing or invalid.
  - `rolling4` is `figures(mergeWeeks(stats, row.week, 4))`.
  - With `foldedThrough: null`, `weeks` is `[]`.

- [ ] **Step 1: Write the failing tests**
  - Auth:
    - unset token → 404
    - wrong bearer → 401
    - correct bearer → 200 `application/json`
  - `?weeks=3` returns 3 rows ending at `foldedThrough`. `?weeks=abc` returns 26. `?weeks=500` returns 104.
  - Suppression: a week with 2 reviewed rounds has `medianMs.total: null` but `outcomes.reviewed: 2`.
  - **The serialised body contains no histogram:** `JSON.stringify(body)` doesn't contain `"histograms"`.
  - Pending entries are invisible: state with one pending entry and no folded weeks returns `weeks: []`.
  - `index.test.ts`: `POST /stats` returns 405.
- [ ] **Step 2: Run the tests and confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat: token-protected GET /stats with weekly and rolling figures`

---

### Task 9: Docs

**Files:**
- Modify:
  - `README.md`
  - `docs/architecture-decisions.md`
  - `docs/superpowers/specs/2026-08-26-pr-review-bot-design.md`
  - `docs/operations.md`
  - `docs/setup.md`
  - `docs/architecture.md`

Make each change as listed in the spec's "Docs to change in the same work":

- [ ] **Step 1: README.** Rewrite "What this bot stores" to cover:
  - pending entries: their fields and what they never contain
  - the link from a record to its pending entry, which lasts about 8 days and is removable on request
  - weekly totals, kept indefinitely and not removable per person
  - "no per-person reporting" kept as it is

  Delete any wording that says no review-time analytics exist.
- [ ] **Step 2: ADR.** Add `## adr-anonymous-review-stats` (Status / Context / Decision / Consequences, matching the existing ADRs). It must cover:
  - per-person data still excluded
  - no repo or urgency stored
  - weekly totals only
  - the five disclosure rules
  - `STATS_TOKEN`
  - recording-week bucketing
  - the documented biases

  Add a one-line cross-reference from `adr-per-person-data-off-the-render`.
- [ ] **Step 3: v1 design.** Add a dated (2026-11-03) amendment under the "Review-time analytics" non-goal pointing to the new spec. Leave the original text in place.
- [ ] **Step 4: Ops docs.**
  - setup and operations:
    - `wrangler secret put STATS_TOKEN`
    - a `curl -H "Authorization: Bearer …" …/stats?weeks=12` example
    - re-running `npm run register-commands`
    - **the rollback warning:** after v7 ships, rolling back to a v6 build refuses to load state and takes the whole bot down, so roll forward
  - architecture: the new command, the endpoint, the `foldStats` tick step, and `StoreState.stats`
- [ ] **Step 5: Run `npm run lint`, then commit.** Message: `docs: anonymous review stats — README, ADR, setup and operations`
