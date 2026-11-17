# Command-Only Review Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/review-request` the only way a PR reaches the digest, for a PR in any repo. Remove the repo allowlist, the channel scan, read-only mode and the Message Content intent check.

**Architecture:** The plan is mostly removal, in six commits:
- **Task 1** drops the allowlist from the submit path.
- **Task 2** gives the command its own record builder, so nothing outside the scan uses `newScannedRecord`.
- **Task 3** removes read-only mode and the intent check, and registers both commands by default.
- **Task 4** removes the scan (refresh-loop step 6).
- **Task 5** removes the scan's stored state and `PrRecord.source`, with schema migration 5 → 6.
- **Task 6** updates the docs.

Every task leaves `npm test`, `npm run typecheck` and `npm run lint` green.

**Tech Stack:** TypeScript, Cloudflare Workers and Durable Objects, vitest (`@cloudflare/vitest-plugin`), ESLint.

**Spec:** `docs/superpowers/specs/2026-11-03-command-only-requests-design.md`

## Global Constraints

- **No repo or org list anywhere.** `routeOwner` in `src/github/credentials.ts` stays exactly as it is: `paranext` goes to the App, everything else to the public token.
- The submit-time GitHub checks stay: `not-found`, `credential`, `merged`, `closed` (`src/handlers/reviewRequest.ts:250–268`).
- **Refresh-loop steps are NOT renumbered.** Step 6 becomes the one-line comment `// 6. (Retired 2026-11-03 — was the channel scan.)`. Step 7's existing retired comment and steps 8–11 keep their numbers.
- **`docs/setup.md` steps are NOT renumbered.** Code comments and other docs cite them by number (for example "step 6", "step 13"). Retired steps keep their heading number with "(Retired 2026-11-03)" and a one-line pointer.
- `CURRENT_SCHEMA_VERSION` becomes **6**. Earlier migration steps are left exactly as they are.
- Existing ADR text is not rewritten. Only dated **Amendment (2026-11-03)** paragraphs and new ADRs are added.
- Earlier specs and plans under `docs/superpowers/` are not edited.
- Unused bindings use a leading `_`, as ESLint's `varsIgnorePattern: "^_"` allows.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```

## Review Focus

1. **An old-build tick commits into v6 state mid-deploy.** It writes an `upsertScanned` record (`source: "scanned"`) or a `setMeta` with `scanCursors`. The next load must remove the record and reset the cursors to `{}`, and the old build's scan must never see `scanCursors` undefined. *Task 5, re-strip and tombstone tests.*
2. **A PR first scanned and then requested with the command** (`source: "command"` in v5 state, with a claim) must survive migration with every field except `source`. *Task 5.*
3. **A first-time request** must land at `requestCount: 1` with `messageId: null` until `setRequestMessageId` runs. **A re-request of a resolved record** must reopen it and increment `requestCount`. *Task 2.*
4. **A public PR from an owner other than `paranext`** must be accepted and synced through the public token. **A mixed-case `Paranext` owner** must still route to the App. *Task 1.*
5. **Reaction-allowance boundaries** (zero allowance, and the last single unit) must still be hit exactly once the scan's one subrequest is gone. *Task 4, re-derived record counts.*

---

### Task 1: Remove the repo allowlist

**Files:**
- Modify: `config/config.ts` (`repoAllowlist` in `Config` at line 20 and in `config` at lines 80–87, plus any header comment that names it)
- Modify: `src/core/urls.ts:42–45` (delete `isAllowlisted`)
- Modify: `src/core/submit.ts` (`not-allowlisted` variant at line 53; the check at lines 157–163)
- Modify: `src/core/render/rejection.ts:34–38`
- Modify: `src/discord/scan.ts:2,34`. Delete the import and the `isAllowlisted` filter. The scan is deleted in Task 4; until then it would ingest every link, which is acceptable for one commit.
- Modify: `preview/build.ts:70` (delete the `reject-not-allowlisted` entry)
- Test: `tests/core/submit.test.ts`, `tests/core/render/rejection.test.ts`, `tests/core/config.test.ts`, `tests/core/urls.test.ts`, `tests/workers/reviewRequest.test.ts`

**Interfaces:**
- Produces: `Config` without `repoAllowlist`; `SubmitRejection` without `not-allowlisted`.

- [ ] **Step 1: Write the failing tests.**
  - In `tests/core/submit.test.ts`, replace "rejects a repo that is not on the allowlist, naming it" with:
    ```ts
    it("accepts a PR from any owner and repo", () => {
      const result = parseSubmission(submitted({ url: "https://github.com/someone/else/pull/1" }), config);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.pr).toEqual({ owner: "someone", repo: "else", number: 1 });
    });
    ```
    Rename "accepts a well-formed submission on an allowlisted repo" to "accepts a well-formed submission".
  - In `tests/workers/reviewRequest.test.ts`, add to `describe("finishSubmit")`:
    ```ts
    it("records a public PR from an owner that was never configured, read through the public token", async () => {
      // `someone/else` was never on the allowlist (eten-tech-foundation was, so it
      // would not prove anything). Stub GitHub as the other tests in this file do,
      // answering for someone/else/1 with an open PR.
      await finishSubmit(submission({ url: "https://github.com/someone/else/pull/1" }), deps(store));
      expect(Object.keys((await store.readState()).records)).toEqual(["someone/else/1"]);
      // Assert the GraphQL call carried the PUBLIC token's Authorization header, not the App's.
    });
    ```
    Use the file's existing GitHub stub and credential fakes for the token assertion.
  - Add to `tests/workers/credentials.test.ts` (or wherever `routeOwner` is tested): `expect(routeOwner("Paranext")).toBe("app")`, if no case-insensitivity test already exists.

- [ ] **Step 2: Run them and confirm they fail.**
  Run: `npx vitest run tests/core/submit.test.ts tests/workers/reviewRequest.test.ts`
  Expected: FAIL, with `not-allowlisted` instead of ok, and no record created.

- [ ] **Step 3: Remove the allowlist.** Delete `repoAllowlist`, `isAllowlisted`, the submit check, the `not-allowlisted` variant, and its rejection copy and preview entry.

- [ ] **Step 4: Repoint the tests that used the allowlist rejection to trigger a rejection.**
  - `tests/workers/reviewRequest.test.ts` (tests at about 208, 221 and 318): use `submission({ url: "https://github.com/paranext/paranext-core/issues/1" })` and expect `toContain("does not look like a GitHub pull request link")`. That is still an offline rejection that never touches GitHub.
  - In the comment at about 224, change the quoted message to "that link is not a pull request".
  - Delete the `not-allowlisted` cases in `tests/core/render/rejection.test.ts`. The over-long-slug test at about 131 moves to `not-found`, which also clamps its slug.
  - Delete "lists every allowlisted repo as owner/repo" in `tests/core/config.test.ts`, and the `isAllowlisted` tests in `tests/core/urls.test.ts`.

- [ ] **Step 5: Run everything.**
  Run: `npm test && npm run typecheck && npm run lint`
  Expected: PASS. `grep -rn "allowlist" src config preview tests` returns nothing.

- [ ] **Step 6: Commit.**
  ```bash
  git add -A config src preview tests
  git commit -m "feat: accept /review-request for a PR in any repo — drop the repo allowlist"
  ```

---

### Task 2: A record builder for the command

**Files:**
- Modify: `src/core/record.ts` (add `newCommandRecord` beside `newScannedRecord`, at about line 180)
- Modify: `src/store/apply.ts:68–97` (`upsertRequest`)
- Modify: `fixtures/records.ts` (`make`, and a new `testRecord`)
- Modify: every test that calls `newScannedRecord` to build a record, except `tests/store/apply.test.ts`'s `describe("upsertScanned")` and `tests/core/record.test.ts`'s scanned-record tests, which Task 4 deletes. The files are: `exit`, `reactions`, `ranking`, `urgency`, `claims`, `render/daily`, `render/request`, `render/digest` (under `tests/core/`); `reviewList`, `interactions`, `reviewRequest`, `do`, `scheduled`, `health` (under `tests/workers/`); and `tests/store/memory.test.ts`.
- Test: `tests/core/record.test.ts`, `tests/store/apply.test.ts`

**Interfaces:**
- Produces:
  - `newCommandRecord(input: NewCommandInput): PrRecord` in `src/core/record.ts`, where
    `interface NewCommandInput { pr: ParsedPr; at: number; fields: RequestFields; title: string; prAuthorLogin: string | null; isDraft: boolean }`.
    The result has `firstRequestedAt = lastRequestedAt = at`, `requestCount: 1`, every `fields` value copied (`messageId` as given, which may be null), `source: "command"`, and every claim, reaction, sync and resolution field null or empty. That's the same defaults `newScannedRecord` uses today.
  - `testRecord(input: TestRecordInput): PrRecord` in `fixtures/records.ts`, where `TestRecordInput` has the same fields as today's `NewScannedInput` (`pr, channelId, messageId: string | null, messageTimestamp, title, prAuthorLogin, isDraft`). It returns a `newCommandRecord` with `team`, `urgency`, `note`, `requesterId` and `requesterName` set to `null`. It keeps old tests' "no team yet" records expressible, so moving tests to it is a rename plus an import. Test files import it from `fixtures/records.js`, as `tests/core/fixtures.test.ts` already does.

- [ ] **Step 1: Write the failing tests.** In `tests/core/record.test.ts`:
  ```ts
  describe("newCommandRecord", () => {
    it("starts a first request at count 1, with both request times at `at`", () => {
      const r = newCommandRecord({ pr, at: T0, fields: { ...fields, messageId: null }, title: "t", prAuthorLogin: "a", isDraft: false });
      expect(r.requestCount).toBe(1);
      expect(r.firstRequestedAt).toBe(T0);
      expect(r.lastRequestedAt).toBe(T0);
      expect(r.messageId).toBeNull();
      expect(r.team).toBe(fields.team);
      expect(r.claimedBy).toBeNull();
      expect(r.lastReactors).toBeNull();
      expect(r.resolvedAt).toBeNull();
    });
  });
  ```
  In `tests/store/apply.test.ts`, in the `upsertRequest` block:
  ```ts
  it("creates a first request with messageId null, not an empty string", () => {
    const out = run(emptyState(), { kind: "upsertRequest", pr, at: T0, fields: { ...fields, messageId: null }, title: "t", prAuthorLogin: "a", isDraft: false });
    expect(out.state.records[ID]?.messageId).toBeNull();
    expect(out.state.records[ID]?.requestCount).toBe(1);
  });
  ```
  Add a test that a resolved record re-requested with `upsertRequest` has `resolvedAt: null`, `requestCount` one higher, and one more `resolutionHistory` entry, if the block doesn't already cover it. Reuse the block's `pr`, `fields` and `ID`.

- [ ] **Step 2: Run them and confirm they fail.**
  Run: `npx vitest run tests/core/record.test.ts tests/store/apply.test.ts`
  Expected: FAIL. `newCommandRecord` is not exported, and `messageId` is `""`.

- [ ] **Step 3: Implement `newCommandRecord`, and make `upsertRequest` use it for a new record.** Delete the `{ ...created, requestCount: 1 }` patch and its comment. The `existing` branch (`markRequested`) is unchanged.

- [ ] **Step 4: Add `testRecord` to `fixtures/records.ts`, and rebuild `make` on it.** `make` keeps its `source` input until Task 5. Move each listed test file from `newScannedRecord(` to `testRecord(` and update its imports. Where a test sets `source: "scanned"` only to get a team-less row, drop the override.

- [ ] **Step 5: Run everything.**
  Run: `npm test && npm run typecheck && npm run lint`
  Expected: PASS, with fixture snapshots unchanged (`npx vitest run tests/core/fixtures.test.ts` shows no snapshot diff). `grep -rln newScannedRecord src tests fixtures` lists only `src/core/record.ts`, `src/store/apply.ts` (the `upsertScanned` case), `tests/core/record.test.ts` and `tests/store/apply.test.ts`.

- [ ] **Step 6: Commit.**
  ```bash
  git add -A src fixtures tests
  git commit -m "refactor: build command records with newCommandRecord, not the scanned-record factory"
  ```

---

### Task 3: Remove read-only mode and the intent check; register both commands

**Files:**
- Delete: `src/handlers/startup.ts`, `tests/workers/startup.test.ts`
- Modify: `src/index.ts` (the `isReadOnly` doc comment and function at lines 52–66; the intent block and `readOnly:` in `scheduled`, lines 106–136)
- Modify: `src/env.d.ts:36` (delete `READ_ONLY`)
- Modify: `src/handlers/scheduled.ts`:
  - delete `TickDeps.readOnly` (lines 20–22) and the `readOnly` local
  - delete the read-only branch (lines 374–421)
  - delete the `applyCommands` import if it's now unused
  - in `resultCounters`' doc comment, drop the read-only/shadow paragraph
- Modify: `src/discord/rest.ts`: delete `DiscordApplication` (line 14), `FLAG_MESSAGE_CONTENT` and `FLAG_MESSAGE_CONTENT_LIMITED` (lines 44–45) with their doc comment (lines 27–43), and `getApplication` (lines 189–190)
- Modify: `src/store/types.ts:59` (drop ", nor under READ_ONLY")
- Modify: `scripts/register-commands.ts` (header comment lines 5–6; line 33 becomes `const commands = [REVIEW_LIST, REVIEW_REQUEST];`)
- Test: `tests/workers/index.test.ts`, `tests/workers/scheduled.test.ts`, `tests/workers/rest.test.ts`, `tests/store/memory.test.ts:629`

**Interfaces:**
- Produces: `TickDeps` without `readOnly`. `runTick` has one path, which ends in `finishTick`.

- [ ] **Step 1: Write the failing tests.** In `tests/workers/index.test.ts`, replace `describe("the READ_ONLY gate, wired up")` and the intent tests (about 155–330) with:
  ```ts
  describe("scheduled", () => {
    it("never calls GET /applications/@me", async () => {
      // Same fetch stub the replaced tests used, minus the /applications/@me branch.
      await worker.scheduled(createScheduledController(), env, ctx);
      expect(calls.filter((c) => c.includes("/applications/@me"))).toHaveLength(0);
    });

    it("writes even when a READ_ONLY variable is still set from an old deploy", async () => {
      await worker.scheduled(createScheduledController(), { ...env, READ_ONLY: "true" } as typeof env, ctx);
      // Assert the tick reached finishTick: the digest was posted or patched (a POST/PATCH to /channels/.../messages).
    });
  });
  ```
  Keep the remaining `index.test.ts` tests (around 340–420) but drop their `/applications/@me` stub branches.

- [ ] **Step 2: Run them and confirm they fail.**
  Run: `npx vitest run tests/workers/index.test.ts`
  Expected: FAIL. `/applications/@me` is called once, and the `READ_ONLY` tick doesn't write.

- [ ] **Step 3: Delete read-only mode, the intent check and the `getApplication` plumbing listed above,** and make `register-commands` register both commands.

- [ ] **Step 4: Remove the read-only tests from `tests/workers/scheduled.test.ts`.**
  - Delete every test that passes `readOnly: true` (about 535–700, and 1153).
  - Where one of them also checks something that still applies on the live path, move that assertion to a live-path test instead of losing it. For example, "counts the lease-releasing apply as a subrequest (R46b)" at 684 is a read-only-only behaviour, so delete it; "finding 10"'s counters are covered live by the existing `resultCounters` tests.
  - Delete the `FLAG_*` pins in `tests/workers/rest.test.ts:48–49`.
  - In `tests/store/memory.test.ts:629`, reword the comment: the first live deploy has `digestMessageId` null.

- [ ] **Step 5: Run everything.**
  Run: `npm test && npm run typecheck && npm run lint`
  Expected: PASS. `grep -rn "READ_ONLY\|readOnly\|isReadOnly\|applications/@me\|INTENT_" src scripts tests` returns nothing.

- [ ] **Step 6: Commit.**
  ```bash
  git add -A src scripts tests
  git commit -m "feat: remove read-only mode and the Message Content check; register both commands"
  ```

---

### Task 4: Remove the channel scan (refresh-loop step 6)

**Files:**
- Delete: `src/discord/scan.ts`, `tests/workers/scan.test.ts`
- Modify: `src/handlers/scheduled.ts`:
  - remove the `scanChannels` import (line 7)
  - remove `scanned` and `scanHitPageCap` from `TickReport` and from the `empty` literal
  - remove the `scanned` entry from `resultCounters`, plus the doc paragraph on it
  - replace step 6 (lines 239–260) with the retired comment
  - remove `scanHitPageCap: scan.hitPageCap` from the returned report
  - in the step 9 + 11 comment, drop "scan ingests"
- Modify: `src/discord/rest.ts:107–115` (delete `getMessages`)
- Modify: `src/core/urls.ts` (delete `extractPrUrls`)
- Modify: `src/core/record.ts` (delete `NewScannedInput` and `newScannedRecord`; the `lastRequestedAt` comment at line 34 loses its scanned sentence)
- Modify: `src/store/types.ts` (delete the `upsertScanned` command variant and its `NewScannedInput` import) and `src/store/apply.ts` (delete the `upsertScanned` case and the `newScannedRecord` import)
- Modify: `config/config.ts` (delete `scanLookbackMs` at lines 47 and 102, and `budgets.scanPagesPerTick` at lines 51 and 105)
- Modify: comments that cite the scan:
  - `src/core/ranking.ts:27–28` becomes "Null urgency ranks below every level."
  - `src/handlers/interactions.ts:50–53`: drop the reference to `scan.ts`
- Test: `tests/workers/scheduled.test.ts`, `tests/workers/rest.test.ts:56–83`, `tests/core/urls.test.ts` (the `extractPrUrls` block from about line 69), `tests/core/record.test.ts:154–200`, `tests/store/apply.test.ts:57–100,126`, `tests/workers/do.test.ts:44`, `tests/workers/index.test.ts:83`

**Interfaces:**
- Consumes: `newCommandRecord`, `testRecord` (Task 2).
- Produces: `TickReport` without `scanned` and `scanHitPageCap`; `Command` without `upsertScanned`. `Meta.scanCursors` and `Meta.scanBackfill` still exist but nothing writes them. Task 5 removes them.

- [ ] **Step 1: Write the failing test.** In `tests/workers/scheduled.test.ts`, replace "ingests a scanned link and advances the cursor" (about 405) and the page-cap test (about 510) with:
  ```ts
  describe("refresh loop step 6 — retired", () => {
    it("never lists channel messages, even with a PR link sitting in the channel", async () => {
      // The fake rest's message-list route returns a message containing
      // https://github.com/paranext/paranext-core/pull/2695; assert it is never requested.
      const store = memoryStoreWith([]);
      await runTick(deps(store));
      expect(calls.some((c) => /\/channels\/[^/]+\/messages\?/.test(c))).toBe(false);
      expect(Object.keys((await store.readState()).records)).toHaveLength(0);
    });
  });
  ```
  Re-derive the step-8 allowance tests, now that the scan's one subrequest is gone:
  - "sheds allowance…": 900 records gives 1 + 36 = 37 spent, so allowance = min(10, 50 − 37 − 5) = 8. The assertions hold; update the comment.
  - "skips step 8 entirely…": 1100 records gives 1 + 44 = 45 spent, so allowance = 0. The assertions hold; update the comment.
  - "does not start a two-subrequest read on the last single unit": **change 1050 to 1075**. That gives ceil(1075/25) = 43 chunks, so 1 + 43 = 44 spent and allowance = 1. With 1050 the allowance would be 2 and one read would start. Update the comment.

- [ ] **Step 2: Run it and confirm it fails.**
  Run: `npx vitest run tests/workers/scheduled.test.ts`
  Expected: FAIL. The message list is requested and a record is created.

- [ ] **Step 3: Delete the scan and everything listed above.**

- [ ] **Step 4: Fix the remaining tests.**
  - Delete the `upsertScanned` tests (`tests/store/apply.test.ts:57–100`). "upgrades a scanned record in place" (about 126) and `tests/core/record.test.ts`'s scanned tests (154–200) become a re-request of an existing command record, or are deleted if that's already covered.
  - `tests/workers/do.test.ts:44` and `tests/workers/index.test.ts:83` seed state with `upsertScanned`. Switch them to `upsertRequest`, using the same `pr` and the fields the file already has.
  - Delete `getMessages` and `extractPrUrls` tests. Remove `scanned` and `scanHitPageCap` from any `toEqual` on a full `TickReport`.

- [ ] **Step 5: Run everything.**
  Run: `npm test && npm run typecheck && npm run lint`
  Expected: PASS. `grep -rn "scanChannels\|upsertScanned\|newScannedRecord\|extractPrUrls\|getMessages\|scanLookbackMs\|scanPagesPerTick\|scanHitPageCap" src config tests fixtures preview` returns nothing.

- [ ] **Step 6: Commit.**
  ```bash
  git add -A src config tests
  git commit -m "feat: retire refresh-loop step 6 — /review-request is the only way onto the digest"
  ```

---

### Task 5: Schema version 6 — drop the scan's stored state and `PrRecord.source`

**Files:**
- Modify: `src/store/types.ts`:
  - delete `Meta.scanCursors` and `Meta.scanBackfill` (lines 45–52)
  - set `CURRENT_SCHEMA_VERSION = 6`, and extend its doc comment with "version 6 removed the channel scan: every record with `source: "scanned"` is deleted, `PrRecord.source` is removed, and `Meta.scanCursors` / `Meta.scanBackfill` are reduced to `{}` tombstones (not in `Meta`; kept only for old-build processes mid-deploy)"
- Modify: `src/store/apply.ts:28–29` (remove from `emptyState`)
- Modify: `src/core/record.ts`: delete `source` from `PrRecord` (line 78), `newCommandRecord` and `markRequested`
- Modify: `src/store/schema.ts`:
  - widen `StoredMeta` with `scanCursors?: Record<string, string>; scanBackfill?: Record<string, string>`
  - widen `StoredRecord` with `source?: "command" | "scanned"`
  - update both doc comments
  - add `stripRetiredScan` and the 5 → 6 step after the 4 → 5 step
  - call `stripRetiredScan` again on every load, next to the existing `stripRetiredPrd` re-run
- Modify: `fixtures/records.ts` (drop `MakeInput.source`; replace the `shadow` scenario, see Step 4) and `tests/core/fixtures.test.ts:8–9`
- Test: `tests/workers/do.test.ts` (migration tests at about 625–706), plus every test that sets or reads `source`: `tests/workers/reviewRequest.test.ts:294`, `tests/core/record.test.ts:45`, `tests/store/apply.test.ts`, and any `scanCursors` in `tests/workers/scheduled.test.ts:63`

**Interfaces:**
- Consumes: Task 4 (nothing writes the scan fields).
- Produces: `stripRetiredScan(state: MigratingState): MigratingState`, which is module-private in `schema.ts`. It:
  - removes every record whose `source === "scanned"`
  - deletes `source` from every remaining record
  - sets `meta.scanCursors = {}` and `meta.scanBackfill = {}`

  These tombstones are always written, never deleted. Old `scanChannels` reads `cursors[channelId]` with no fallback (old `scan.ts:220`).

- [ ] **Step 1: Write the failing tests.** In `tests/workers/do.test.ts`, replace the assertions that `scanCursors` survives (about 662–663 and 706) and add:
  ```ts
  it("5 → 6 drops scanned records, strips source, and tombstones the scan fields", () => {
    const v5 = { schemaVersion: 5, records: {
      "paranext/paranext-core/1": { ...stored(1), source: "scanned" },
      "paranext/paranext-core/2": { ...stored(2), source: "command", team: "Power", claimedBy: "u9", claimedByName: "Ira", claimedAt: T0, claimSource: "menu" },
    }, meta: { ...storedMeta(), scanCursors: { chan: "500" }, scanBackfill: { chan: "400" } } };
    const s = migrateState(v5 as StoredState);
    expect(s.schemaVersion).toBe(6);
    expect(Object.keys(s.records)).toEqual(["paranext/paranext-core/2"]);
    expect(s.records["paranext/paranext-core/2"]).not.toHaveProperty("source");
    expect(s.records["paranext/paranext-core/2"]?.claimedBy).toBe("u9");
    expect((s.meta as Record<string, unknown>)["scanCursors"]).toEqual({});
    expect((s.meta as Record<string, unknown>)["scanBackfill"]).toEqual({});
  });

  it("re-strips a scanned record and cursors an old-build tick wrote into v6 state", () => {
    const v6 = { schemaVersion: 6, records: { "paranext/paranext-core/1": { ...stored(1), source: "scanned" } },
      meta: { ...storedMeta(), scanCursors: { chan: "900" }, scanBackfill: {} } };
    const s = migrateState(v6 as StoredState);
    expect(s.records).toEqual({});
    expect((s.meta as Record<string, unknown>)["scanCursors"]).toEqual({});
  });

  it("walks unversioned state all the way to 6", () => { /* existing v1 fixture; expect schemaVersion 6, scanCursors {} */ });
  ```
  `stored` and `storedMeta` stand for whatever helpers the file's existing migration tests use to build stored records and meta; use those. Also check that `emptyState()` has no `scanCursors` key.

- [ ] **Step 2: Run them and confirm they fail.**
  Run: `npx vitest run tests/workers/do.test.ts`
  Expected: FAIL, because the schema version is still 5 and the scanned record is kept.

- [ ] **Step 3: Implement the type changes, `stripRetiredScan`, the 5 → 6 step and the per-load re-run.** Comment the step the way 4 → 5 is commented (why the tombstones exist, and why the strip re-runs).

- [ ] **Step 4: Replace the fixture's `shadow` scenario.** It modelled an all-scanned digest. Replace it with:
  ```ts
  { key: "triage", label: "A team removed from config", tests: "Needs triage · rows whose team is gone", records: triage, ... }
  ```
  Build `triage` from three `make(...)` rows with `team: "Retired" as TeamName` (cast, because the team isn't in config) plus one ordinary `Power` row. Update the key list in `tests/core/fixtures.test.ts:8–9` (`"shadow"` becomes `"triage"`) and regenerate the snapshot:
  ```
  npx vitest run tests/core/fixtures.test.ts -u
  ```
  Check the new snapshot shows the three rows under **Needs triage**.

- [ ] **Step 5: Remove `source` from the remaining tests**, and `scanCursors` from `tests/workers/scheduled.test.ts:63`.

- [ ] **Step 6: Run everything.**
  Run: `npm test && npm run typecheck && npm run lint && npm run preview`
  Expected: PASS. `grep -rn "scanCursors\|scanBackfill\|\"scanned\"" src` lists only `src/store/schema.ts`.

- [ ] **Step 7: Commit.**
  ```bash
  git add -A src fixtures tests
  git commit -m "feat: schema version 6 — remove scanned records, PrRecord.source and the scan's Meta"
  ```

---

### Task 6: Docs

**Files:**
- Modify: `README.md` ("How to get on the list", lines 16–31)
- Modify: `docs/setup.md` (steps 2, 3, 5, 6, 12, 13, 15)
- Modify: `docs/operations.md` ("Adding a repo, adding a team", lines 135–154; "Shadow-mode measurement log" from line 188; the second-owner note at 185; every other `READ_ONLY`/shadow mention)
- Modify: `docs/architecture.md` (the step list, "Data flow: a link becomes a digest row" at 183–230, and any read-only mention)
- Modify: `docs/architecture-decisions.md` (`adr-scanning-as-permanent-fallback` at 220, `adr-two-github-credentials` at 137, and a new ADR)

- [ ] **Step 1: README.** "How to get on the list" says: run `/review-request` in the review channel. It works for a PR in any repo the bot can read; a pasted link on its own is **not** tracked. Remove "During shadow mode".

- [ ] **Step 2: `docs/setup.md`.**
  - **Steps 2 and 3** become "(Retired 2026-11-03)". The bot no longer reads message content, so the Message Content intent stays **off**.
  - **Step 5:** Read Message History stays. Give the reason: the pin check (`listPinnedMessageIds`) sees no pins without it.
  - **Step 6:** install the App on **All repositories** in `paranext`.
  - **Step 12** becomes "Deploy and watch three ticks". Remove the `READ_ONLY` secret, and delete the instructions to check the read-only log.
  - **Step 13** becomes "Pin the digest and post the channel note". Set the channel topic, or pin a message: "Use `/review-request` to ask for a review. Pasted links aren't tracked."
  - **Step 15** becomes "Register both commands" (`npm run register-commands`, no flag).
  - Add one line under step 16: try a `:code_review:` reaction claim once on the live server. Discord's docs don't say whether reading reactions needs Read Message History.

- [ ] **Step 3: `docs/operations.md`.**
  - The section becomes "Adding a team". Any repo is accepted, and the App covers all `paranext` repos.
  - Delete the shadow-mode measurement log, and remove the `READ_ONLY` and shadow references elsewhere in the file.
  - Add a short "Someone pasted a link instead of using the command" entry: it isn't tracked by design. Point them at the command. If it becomes a habit, a Discord AutoMod rule can block PR links in the channel with a private note, at the cost of blocking discussion links too.

- [ ] **Step 4: `docs/architecture.md`.**
  - Rewrite "Data flow" to start at `/review-request`: parse, GitHub check, `upsertRequest`, post the request message, `setRequestMessageId`. Then sync and exit as now.
  - Mark step 6 retired, and remove read-only mode.

- [ ] **Step 5: `docs/architecture-decisions.md`.**
  - Add an **Amendment (2026-11-03)** to `adr-scanning-as-permanent-fallback` marking it superseded by the new ADR.
  - Add an amendment to `adr-two-github-credentials`: the App is installed on all `paranext` repositories, not an allowlisted subset.
  - Add a new ADR, `adr-command-only-requests`. Context: requests from any repo, plus channel conversation about PRs. Decision: no allowlist, no scan, no read-only mode. Consequence: a habit-pasted link is silently untracked, which is handled by the channel note, not code. Alternatives rejected: an org allowlist, scanning own orgs only, a skip marker, a public reply or DM to pasters (needs message reading; Discord can't reply privately to a plain message), AutoMod (blocks discussion links).

- [ ] **Step 6: Check.**
  Run: `grep -rn "allowlist\|shadow mode\|READ_ONLY\|Message Content\|MESSAGE CONTENT" README.md docs --include=*.md | grep -v docs/superpowers`
  Expected: only the amended ADR text and retired-step headings.

- [ ] **Step 7: Commit.**
  ```bash
  git add README.md docs/setup.md docs/operations.md docs/architecture.md docs/architecture-decisions.md
  git commit -m "docs: /review-request is the only way in; allowlist, scan and shadow mode retired"
  ```
