# Drop the PRD field — Design

**Date:** 2026-10-12
**Status:** Ready for review. One adversarial review is folded in. Every finding
is either applied inline or answered below in *Answered objections*.
**Author:** Jolie Rabideau

## Why

The bot runs on the public Discord server only, and we will not have access to
the private server. The `/review-request` modal's PRD dropdown is fed by
`config.prdForumChannelId`, which points at the private server's
`teamwide-epic-discussions` forum. That fails twice over:

- The bot would have to be installed on, and read threads from, a second server.
- A PRD is stored as a thread id and rendered as a `<#thread>` mention. A
  mention of a thread in another server does not resolve for most viewers, so even
  a static list of private-server thread ids would render as broken links.

We considered other sources — a forum on the public server, a static list in
config, and GitHub labels or milestones (the repos have no PRD-shaped ones:
`paranext-core`'s milestones are quarters, and `paratext-10-studio` has none).
The decision is to **drop the PRD field entirely**. A requester who wants to
point at a PRD can say so in the free-text note.

## Goal

Every part of the bot works with the public server as its only server. After
this change, the only server the bot talks to is the one named by
`DISCORD_GUILD_ID`.

## Public-server audit

What else could have tied the bot to the private server, and its outcome:

| Dependency | Where | Outcome |
|---|---|---|
| PRD forum threads | `config.prdForumChannelId`, refresh-loop step 7 | **Removed** by this change. |
| `DISCORD_GUILD_ID` | `src/store/do.ts:59` (digest and daily-post jump links, via `messageUrl` in `src/discord/rest.ts`), `scripts/register-commands.ts` (guild-scoped command registration) | One guild, set per environment. Set it to the public server. Its third use, `TickDeps.guildId` (`src/index.ts:135`), existed only for step 7 and is removed. |
| `allowedChannelIds`, `digestChannelId` | `config/config.ts` | Still placeholders. Fill them with public-server channels. The `<#channel>` mentions in `src/handlers/interactions.ts` name these channels, so they resolve. |
| `claimEmoji` (`code_review:1075535230087221248`) | `config/config.ts` | Confirmed to be a **public-server** custom emoji. No change. |
| Claim-conflict DMs | `src/handlers/scheduled.ts` | The public server is where the bot and every requester meet. A user whose "DMs from server members" setting is off is already handled: a failed DM is logged and the claim outcome is unaffected. |

`docs/setup.md` gains one sentence at the top saying the bot is installed on the
public server only, so whoever deploys it fills every id above from that server.

## What is removed or changed

### Source

- **Delete** `src/core/prd.ts` and `src/discord/threads.ts`.
- **`src/discord/rest.ts`:** delete `getActiveThreads`, `getArchivedPublicThreads` and the `RawThread` import.
- **`src/handlers/scheduled.ts`:**
  - Delete step 7's body (the fetch, its `setMeta` patch, and the `[PRD_CACHE]` / `[PRD_CACHE_SKIPPED]` logs) and the `fetchPrdThreads` import.
  - Leave a one-line comment, `// 7. (Retired 2026-10-12 — was the PRD thread cache refresh.)`. **Steps are not renumbered** (see *Answered objections*).
  - Delete `guildId` from `TickDeps`. Each tick makes two fewer subrequests.
- **`src/index.ts`:** stop passing `guildId` to the tick.
- **`config/config.ts`:** delete `prdForumChannelId` from `Config` and from `config`.
- **`src/core/submit.ts`:**
  - Delete `FIELD_IDS.prd`, `PRD_NONE`, `SNOWFLAKE` (used only by the PRD parse) and `SubmittedValues.prdThreadId`, along with the comments that explain them.
  - The comment that says "five field custom_ids" becomes "four".
- **`src/handlers/modal.ts`:**
  - Delete the PRD select, its two notes, and the "Previously chosen PRD" carry-over.
  - `buildRequestModal(config, prefill?)` loses its `prd` parameter, and its doc comment about a cold cache goes.
  - The modal has four fields: PR link, Team, Urgency, Note.
- **`src/handlers/reviewRequest.ts`:**
  - `openRequestModal` no longer calls `readState()`, because the modal now needs nothing from the store. Its doc comment ("Built from the cache…") is rewritten.
  - The `upsertRequest` fields lose `prdThreadId`.
- **`src/core/record.ts`:** remove `prdThreadId` from `PrRecord`, `RequestFields` and the scanned-record default.
- **Renderers:** remove the `<#thread>` piece from `src/core/render/request.ts`, `src/core/render/digest.ts` and `src/core/render/rejection.ts`.
- **`src/store/types.ts`:**
  - Delete `Meta.prdCache` and the `PrdCache` import.
  - `CURRENT_SCHEMA_VERSION` becomes 5, and its doc comment adds "version 5 removed `Meta.prdCache` and `PrRecord.prdThreadId`".
- **`src/store/apply.ts`:** remove `prdCache: null` from the empty state.
- **`preview/build.ts`:**
  - Delete `FULL_CACHE`, `TRUNCATED_CACHE` and the `PrdCache` import.
  - Collapse the modal scenarios to two, *fresh* and *prefilled*. The full-cache, truncated-cache and cold-cache scenarios existed only to show PRD-select states.
  - Remove `prdThreadId` from the prefill values.

### Tests

- **Delete** `tests/core/prd.test.ts` and `tests/workers/threads.test.ts`.
- **`tests/core/fixtures.test.ts`:**
  - Delete only the guarded *PRD thread fixtures* block: the `buildPrdCache`/`RawThread` import, `FORUM_ID`, the responses-path constants and their `describe`.
  - **Keep** the *fixture scenarios* block, which is the digest render test.
  - Regenerate `tests/core/__snapshots__/fixtures.test.ts.snap` with `vitest -u`. Review the diff: the only changes allowed are the dropped ` · <#t-trust>` piece and the `bodyHash` values that change as a result.
- **`tests/workers/scheduled.test.ts`:**
  - Delete the *refresh loop step 7 — the PRD cache* `describe`, the thread-route stubs and their 500 toggle, and `guildId` from the test deps.
  - Exact subrequest counts drop by two: 17 → 15 and 7 → 5.
  - **The two budget-boundary tests must be re-derived, not just re-counted.** Their record counts are tuned so step 8's allowance, `min(10, 50 − spent − 5)`, lands on an exact edge. Without the two PRD reads, both fail:
    - *"skips step 8 entirely when the allowance is zero"* needs 46 spent before step 8. Change 1050 records to **1100** (1 + 44 chunks + 1 scan page = 46).
    - *"does not start a two-subrequest read on the last single unit"* needs 44 spent. Change 1000 records to **1050** (1 + 42 + 1 = 44).
    - Rewrite both tests' arithmetic comments, and the comment in the 900-record shedding test. Remove every "PRD threads" term from arithmetic comments in the file.
- **Version pins:**
  - `tests/workers/do.test.ts:731,758` and `tests/store/apply.test.ts:441` assert schema version 4. Change them to `CURRENT_SCHEMA_VERSION`.
  - The `meta.prdCache` null assertions (`apply.test.ts:442`, `do.test.ts:701`) become "property absent" assertions.
- **Delete the PRD-specific tests outright** (not just their fixtures):
  - in `tests/core/modal.test.ts`, the PRD option, note, cap, carry-over and long-name tests;
  - in `tests/core/submit.test.ts`, the snowflake and None tests;
  - in the `render/*` tests, the PRD-mention cases.
- **Remove `prdThreadId` from fixtures and expected values** everywhere else: `tests/core/record.test.ts`, the `render/*` tests, `tests/store/apply.test.ts`, `tests/workers/do.test.ts`, `tests/workers/reviewRequest.test.ts` and `fixtures/records.ts`.
- **`tests/workers/reviewRequest.test.ts`:**
  - Its tests that seed `prdCache` through `setMeta` (around lines 162–180) are rewritten to check that the modal opens without the store.
  - The `submission()` helper's `prd: "none"` entry is **kept on purpose**, as the stray-key case (see *Testing*), with a comment saying so.

## Schema version 4 → 5

The stored shape changes, so under `adr-durable-object-schema-version`
`CURRENT_SCHEMA_VERSION` goes from 4 to 5. `migrateState` gains one step that
deletes these three things:

- `meta.prdCache`,
- `prdThreadId` from every record,
- `prdThreadId` from every `meta.retryStash[*].values`.

Typing in `src/store/schema.ts`:

- **`StoredMeta.prdCache` already exists** (2→3 added it), typed `Meta["prdCache"]`. Both `Meta.prdCache` and `PrdCache` are going away, so it is **retyped `unknown`**. Nothing reads the cache's contents during migration.
- `StoredRecord` adds `prdThreadId?: string | null`.
- Stash entries are read through a local widened type, `SubmittedValues & { prdThreadId?: string | null }`, rather than a new exported alias.

**The 2→3 step is left exactly as it is**, still writing `prdCache: null`. The
chain stays a faithful record of each version's shape, and the 4→5 step deletes
the field. The 2→3 comment is historical and is not edited.

The bot has not had a real deploy, so in practice this migrates scratch-server
state at most. It is still required. If it were skipped, a v4 build rolled back
onto state with no `prdCache` would read `undefined`, which is not `null`, and
`buildRequestModal` would crash on `prd.options`. The version bump is what makes
that rollback refuse cleanly instead.

**Rollback:** a v4 build loading v5 state throws in `migrateState`, so every path
that reads the store fails, not just the tick: `/review-list`, the modal, the
menus and the resolve flow. That is the existing rollback guard working as
designed, and it is acceptable before the first real deploy. Roll forward.

**Amendment (after code review, 2026-10-29).** Two changes to the above:

- **`prdCache` becomes a `null` tombstone, not deleted.** Old-build Worker
  processes keep serving interactions for a few seconds while a deploy rolls
  out, and the old `buildRequestModal` crashes on `undefined` but handles
  `null`. The tombstone is not part of `Meta`; only `StoredMeta` knows it.
  `emptyState()` still has no `prdCache`.
- **The strip also runs on every load (`stripRetiredPrd`), not only in the 4→5
  step.** An old-build tick already in flight at deploy can commit `prdCache`
  through `setMeta`, or `prdThreadId` through `markRequested`, into state already
  stamped 5. Re-stripping on load removes those values.

The stash's old shape is now the `StoredStashedSubmission` type on
`StoredMeta.retryStash`, replacing the local cast. The 2→3 comment now says
explicitly that it describes version 3.

## Edge behaviour

- **A modal opened before the deploy and submitted after it** still carries a
  `prd` value. `collectValues` and `parseSubmission` read fields by key, so an
  unknown key is ignored. A test pins this.
- **A "Fix and retry" stash written before the deploy** loses its `prdThreadId`
  in the migration. The retry modal is rebuilt without a PRD field, and every
  other value comes back unchanged.
- **Request messages already posted** keep their `<#thread>` mention for good.
  `renderRequestMessage` posts once and is never patched. Only **new** request
  messages leave it out.
- **The digest** loses the mention on its next tick. The body hash changes, so
  it causes one ordinary digest edit.
- **The deploy window itself.** The Durable Object runs the new build as soon
  as it deploys, while an old Worker isolate may still be finishing a request.
  For those few seconds an old isolate can read v5 state (its modal throws on
  the missing cache, so that one user sees "did not respond") or write a stray
  `prdThreadId` key that the new code ignores. Benign, seconds long, and moot
  before the first real deploy; not handled.

## Documentation

- **`docs/setup.md`:**
  - Add the public-server-only sentence at the top.
  - Delete the section *Rollout stage 1: record the PRD thread fixtures*. It is the only "rollout stage" section, and the numbered steps 1–16 are a separate series, so **no step numbers move**.
  - In step 5, remove "and the PRD forum (`teamwide-epic-discussions`)" from the intro (line 135) and the PRD-forum permission paragraph (lines 142–145).
  - In step 9, change "Three placeholders" to "Two" and delete the `prdForumChannelId` bullet.
- **`docs/architecture.md`:**
  - Line 19 says the modal is built from `Meta.prdCache`. Change it to say the modal is built from config alone.
  - Replace the step-7 section with one line marking it retired.
  - Remove `Meta.prdCache`.
- **`docs/operations.md`:** delete the section *The `/review-request` PRD dropdown looks empty or stale*, and drop "PRD" from the field lists in the lost-record and shadow-mode passages. Step references stay valid because steps are not renumbered.
- **`README.md`:** five fields → four.
- **`docs/architecture-decisions.md`:** add dated **Amendment (2026-10-12)** paragraphs without rewriting existing text:
  - `adr-embed-rendering`: PRDs are no longer rendered, so `<#thread>` mentions are gone.
  - `adr-no-kv-namespace`: the PRD cache that the 2026-09-02 amendment moved into the store has been removed. Nothing else needs KV.
  - `adr-durable-object-schema-version`: its version text stops at "currently `2`". The amendment says: "Versions 3 and 4 were added by plans 2 and 3. Version 5 (2026-10-12) removed `Meta.prdCache` and `PrRecord.prdThreadId`. The current version is 5."
- Earlier specs and plans under `docs/superpowers/` are historical and are not edited.

## Testing

TDD where there is new behaviour:

- **Migration** (`do.test.ts`, beside the existing migration tests):
  - v4 state with a `prdCache`, a record with `prdThreadId`, and a stash entry whose values include `prdThreadId` migrates to v5 with none of the three. Every other field is untouched, and `schemaVersion` is 5.
  - Unversioned (v1) state still walks the whole chain to v5 and ends with no `prdCache`.
- **Modal:** `buildRequestModal` emits exactly four labelled components, and none has the old `prd` custom id. Checked both with and without a prefill.
- **Submit:** a submission carrying a stray `prd` key parses `ok` with values equal to the same submission without it.
- **Tick:**
  - No request goes to any `/threads/` route.
  - The re-derived boundary tests pass at their new record counts.
  - The exact-count tests read 15 and 5.

**Done** means all of the following:

- `npm test`, typecheck and lint pass.
- The snapshot diff contains only the `<#t-trust>` removal and the hash changes it causes.
- This grep returns nothing but the files allowed below:

```
grep -rniI 'prd' src tests config fixtures scripts preview README.md \
  docs/setup.md docs/architecture.md docs/operations.md
```

Allowed hits:

- `src/store/schema.ts` (the 2→3 and 4→5 steps and `StoredMeta`/`StoredRecord`);
- the `CURRENT_SCHEMA_VERSION` doc comment in `src/store/types.ts`;
- the retired-step comment in `src/handlers/scheduled.ts`;
- the migration tests in `tests/workers/do.test.ts`;
- the stray-key `prd` entry in `tests/workers/reviewRequest.test.ts` and the stray-key submit test;
- the `"prdCache" in …` absence assertions in `tests/store/apply.test.ts` and the "has no PRD field" modal test, which the spec's own tests require;
- the retired-step comment in the step-7 test in `tests/workers/scheduled.test.ts`;
- the retired-step paragraph in `docs/architecture.md`.

Separately, `grep -n guildId src/handlers/scheduled.ts src/index.ts` must return nothing.

## Out of scope

- A replacement PRD source of any kind.
- Any change to the note field's label or placeholder.
- Re-rendering request messages that have already been posted.

## Answered objections

- **"Renumber the refresh-loop steps after removing step 7."** Declined. The step
  numbers appear in 13 source comments, a runtime log tag
  (`[REACTIONS] step 8 aborted`), test `describe` names, three docs and the text
  of an ADR (`adr-reaction-diff-not-presence`). Renumbering would touch all of
  them, rewrite ADR text this spec otherwise leaves alone, and break log searches
  across the deploy boundary. A retired step 7 costs one comment line.
- **"Leave `prdCache`/`prdThreadId` in stored state instead of migrating."**
  Declined. Without the bump, a v4 rollback would crash on `undefined` cache
  contents rather than refuse (see *Schema version 4 → 5*), and the ADR requires a
  bump for any change to the stored shape.
