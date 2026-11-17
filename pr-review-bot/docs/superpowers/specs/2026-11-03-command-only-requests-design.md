# Command-only review requests — Design

**Date:** 2026-11-03
**Status:** Ready for review. A builder check and one adversarial review are
folded in (see *Review notes*).
**Author:** Jolie Rabideau

## Why

The team should be able to send a PR from **any** repo to the review channel.
Most come from the `paranext` org, but some won't (an upstream library,
`eten-tech-foundation`, a contributor's fork), and those shouldn't be turned
away. Nobody should have to edit code or redeploy when the org adds a repo.
The hand-kept `repoAllowlist` in `config/config.ts` gets in the way of both.

The allowlist did one useful thing: it kept the **channel scan** from turning
every PR link mentioned in conversation into a digest row. People do talk about
PRs in the review channel without asking for a review, so removing the
allowlist and keeping the scan would fill the digest with rows nobody asked
for. The decision is to **remove the scan as well**. `/review-request` becomes
the only way a PR gets onto the digest. A pasted link is just a message.

Without the scan, the read-only "shadow mode" rollout has nothing left to do,
so it goes too. The bot isn't live yet, so this is the right time to change how
requests come in.

## Goals

- `/review-request` accepts a PR from any GitHub owner or repo. There is no
  repo or org check. The command's other checks are unchanged: the form checks
  (team, urgency, note, URL length, valid PR link) and the GitHub lookup at
  submit time (`not-found`, `credential`, `merged`, `closed`).
- A PR link posted in the channel without the command never creates or changes
  a record.
- No per-repo or per-org configuration anywhere.
- The bot needs less Discord access than it does today: the Message Content
  privileged intent goes away.
- `/review-request` is available from the first deploy.

## Non-goals

- **Tracking PRs the bot can't read.** The submit path already fetches the PR
  before writing anything (`src/handlers/reviewRequest.ts:250–268`). A PR it
  can't see is refused as `not-found` with a "Fix and retry" button. This covers
  typos and private repos outside `paranext`, which the public token can't read.
  **Unchanged, by decision:** a typo gets a retry prompt instead of becoming a
  row that never updates.
- **Telling someone that a link they pasted wasn't tracked.** Discord only
  allows a private ("only you can see this") reply to an interaction, not to a
  normal message. Any notice would need message reading again, the access this
  change removes. People are told to use the command instead (see *Rollout*).
- Changing claims, the digest layout, the daily post, or the GitHub sync.

## Anti-goals

- **Any repo list or org list.** An "allowed orgs" setting brings back the
  thing that slows the team down.
- **Pasted links quietly being tracked again** through any side path.
- **Breaking `:code_review:` reaction claims** on command-made requests.

## What changes

### 1. The repo allowlist is removed

- `config/config.ts`: delete `repoAllowlist` from `Config` and `config`, and the
  comment near the top of the file that refers to it.
- `src/core/urls.ts`: delete `isAllowlisted`.
- `src/core/submit.ts`: delete the allowlist check and the `not-allowlisted`
  rejection variant.
- `src/core/render/rejection.ts`: delete the `not-allowlisted` case and its text.
- Credential routing (`routeOwner` in `src/github/credentials.ts`) is
  unchanged: `paranext` goes through the GitHub App, everything else through the
  public token. The installation token is minted without a `repositories` list
  (`credentials.ts:141`), so an App installed on "All repositories" works with
  no code change.

### 2. The channel scan is removed

- Delete `src/discord/scan.ts` and `tests/workers/scan.test.ts`.
- `src/discord/rest.ts`: delete `getMessages`, which only the scan uses.
- `src/core/urls.ts`: delete `extractPrUrls`. `parsePrUrl` stays because the
  command uses it.
- `src/handlers/scheduled.ts`: delete the scan step's body and the `scanned` /
  `scanHitPageCap` fields of `TickReport` (they appear in the tick log, not in
  `/health`), along with anything that only fed them. Leave a one-line
  `// 6. (Retired 2026-11-03 — was the channel scan.)` comment and **do not
  renumber the steps**, the same convention used for step 7 in the PRD removal.
- `config/config.ts`: delete `scanLookbackMs` and `budgets.scanPagesPerTick`.
- `src/store/types.ts` / `src/store/apply.ts`: delete the `upsertScanned`
  command, `NewScannedInput`, `Meta.scanCursors` and `Meta.scanBackfill`.
- **Record creation for the command.** `upsertRequest` currently builds a new
  record by calling `newScannedRecord` and then `markRequested`, and patches
  `requestCount` back to 1 (`src/store/apply.ts:68–97`). Replace that with a
  `newCommandRecord` in `src/core/record.ts` that builds a command record
  directly: `requestCount: 1`, `messageId` taken from the fields (null until the
  request message is posted, not `""`), `firstRequestedAt` and `lastRequestedAt`
  set to the request time. Then delete `newScannedRecord` and the
  `requestCount` patch.
- `PrRecord.source` loses `"scanned"`. Nothing outside fixtures and tests reads
  `source`, so whether the field stays as a single value or is removed is the
  builder's call.
- **Test fixtures.** `newScannedRecord` is the base factory in
  `fixtures/records.ts` and about 15 test files. Give `fixtures/records.ts` a
  factory built on `newCommandRecord` (or a plain record literal) and move the
  tests to it. Remove the fixtures' "shadow" scenario and update
  `fixtures.test.ts.snap` to match.
- Comments that justify code by the scan (for example `src/core/ranking.ts:27`
  on null urgency, and `src/handlers/interactions.ts:50–53`) are rewritten or
  removed so they don't point at a file that no longer exists.

### 3. Discord access is reduced

- Delete `assertMessageContentIntent` (`src/handlers/startup.ts`), its
  `INTENT_MISSING` / `INTENT_LIMITED` handling where it's called
  (`src/index.ts`), `getApplication` and `DiscordApplication` in
  `src/discord/rest.ts`, and the `FLAG_MESSAGE_CONTENT*` constants, if nothing
  else uses them.
- `docs/setup.md`: delete the "enable Message Content Intent" step.
- **Read Message History stays**, because the bot checks whether the digest is
  pinned. Discord returns no pins to a bot without that permission
  (`listPinnedMessageIds`, `src/discord/rest.ts:185,201`). Without it, the
  digest would always look unpinned. Discord's docs don't list a permission for
  reading reactions; check reaction claims against the live server once.

### 4. Read-only mode is removed, and both commands are registered

- Delete the `READ_ONLY` env var (`src/env.d.ts`), `isReadOnly` and its use in
  `src/index.ts`, `TickDeps.readOnly`, and the read-only branch of `runTick`
  (`src/handlers/scheduled.ts`, around 374–421). Rewrite or delete the tests that
  pass `readOnly: true`, and update the `src/store/types.ts:59` comment.
- `scripts/register-commands.ts` registers `/review-list` **and**
  `/review-request` by default. The `--all` flag goes.

### 5. Stored state: schema version 6

Follow the 4 → 5 step in `src/store/schema.ts` in full, not just the version
bump:

- `CURRENT_SCHEMA_VERSION` becomes 6. Its doc comment adds "version 6 removed
  the channel scan's state and scanned records".
- A `stripRetiredScan(state)` deletes every record whose `source` is
  `"scanned"` (records a command upgraded already have `source: "command"` and
  are kept). It also resets `Meta.scanCursors` and `Meta.scanBackfill` to `{}`.
  The 5 → 6 step runs it.
- **Run the strip again on every load**, as the PRD strip is. During a deploy,
  a tick from the old build can still commit `upsertScanned` records or a
  `setMeta` with scan cursors into state already marked version 6.
- **Keep `scanCursors: {}` and `scanBackfill: {}` as tombstones**, not deleted.
  The old build's scan reads `cursors[channelId]` without a fallback
  (`scheduled.ts:242`, `scan.ts:220`) and would throw on state without them.
  The new build's `Meta` type doesn't declare them. They live only in the stored
  shape.
- Widen `StoredMeta` and `StoredRecord.source` so stored state from older
  versions (with `"scanned"` and the scan fields) still typechecks.
- Update the migration tests in `tests/workers/do.test.ts` (about 625–706),
  which currently check that `scanCursors` survives.

Deleting scanned records is otherwise safe. Nothing else is keyed by record id:
the retry stash is keyed by interaction id, and resolution history lives inside
the record.

### 6. Behaviour that stays the same, on purpose

- **Reaction claims.** They read the `:code_review:` reaction on the record's
  `messageId`, which for command records is the request message the bot posts
  (`setRequestMessageId`, `reviewRequest.ts:306–311`). If that post fails,
  `messageId` stays null and the record isn't polled. The scan never repaired
  that case either, so nothing regresses. A re-request resets `lastReactors`.
- **The "one record per message" guard** in `src/core/reactions.ts:19–27`. With
  one PR per request message it never triggers, but it stays as a safety check.
  *My call.*
- **The "Needs triage" section.** It still holds rows whose team was removed
  from config (`src/core/ranking.ts`). Its comments and the docs should stop
  saying it exists for scanned rows.
- Claim menu, claim-conflict DMs, stale-claim clearing, the GitHub sync, the
  exit condition, the digest, the daily post, and `/health`.

### 7. Other leftovers to remove

These don't break the build, but they'd be dead code or tests:

- Tests: `isAllowlisted` and `extractPrUrls` (`tests/core/urls.test.ts`), the
  allowlist check in `tests/core/config.test.ts`, `getMessages` and the
  `FLAG_*` constants (`tests/discord/rest.test.ts` or wherever they live),
  `tests/workers/startup.test.ts`, the intent tests in
  `tests/workers/index.test.ts` (about 203–260), and the `not-allowlisted` cases
  in the rejection and reviewRequest tests.
- `preview/build.ts`: any scanned-row, shadow or allowlist-rejection scenarios
  (around line 70).

Remove or rewrite these, don't skip them.

## Docs

- `README.md`: remove the "During shadow mode … post a PR link" usage. The way
  to ask for a review is `/review-request`, and a pasted link isn't tracked.
- `docs/architecture.md`: rewrite "Data flow: a link becomes a digest row" so it
  starts at `/review-request`. Mark step 6 as retired the same way step 7 is,
  and remove read-only mode from the refresh-loop description.
- `docs/architecture-decisions.md`:
  - Mark `adr-scanning-as-permanent-fallback` as **superseded**, and add a new
    ADR explaining why: once any repo is accepted, scanning turns conversation
    into rows. The team chose an explicit command over catching habit-pasted
    links, and the cost (a pasted link is silently not tracked) is handled by
    telling people, not by code.
  - Update the credentials ADR, which says the App is "scoped to the
    allowlisted repos".
- `docs/setup.md`:
  - Step 6: install the GitHub App on **all repositories** in `paranext`, so new
    private repos sync with no further step.
  - Remove the Message Content intent step.
  - Rewrite the go-live steps (currently 12–15: deploy read-only, watch ticks,
    go live in shadow mode, register `/review-request` after a threshold) as:
    deploy, register commands, pin the digest, post the "use the command"
    note (see *Rollout*), announce.
- `docs/operations.md`: delete "Adding a repo" (adding a team stays). Delete
  the shadow-mode measurement log and the other shadow-mode and `READ_ONLY`
  notes.

## Rollout

There is no quiet trial run any more; the first use is people running the
command. Before go-live, the channel topic or a pinned message should say:
"Use `/review-request` to ask for a review. Pasted links aren't tracked." That
is a manual Discord step, not bot code, and goes in the rewritten go-live steps.

If habit-pasting turns out to be a real problem, a Discord **AutoMod** rule
(a server setting) can block PR links in the channel and show the sender a
private note pointing at the command. It isn't part of this change, because
people do discuss PRs with links in that channel and AutoMod would block those
messages outright. `docs/operations.md` can mention it as an option.

## Testing

- `/review-request` with a public PR from an org other than `paranext` is
  accepted and synced through the public token.
- `/review-request` with a `paranext` PR is accepted (App path). A non-PR URL is
  still refused as `not-a-pr`, and an unreadable PR as `not-found`.
- A new request creates a record with `requestCount: 1`, `source: "command"`
  (if the field stays), and the posted `messageId`.
- A tick makes no message-list call to Discord.
- Schema 5 → 6: scanned records are dropped, command records come through
  unchanged, and the scan fields are `{}` tombstones. A version-6 state with a
  scanned record written into it is cleaned on the next load.
- Reaction claims on a command record still claim and release.
- `npm test`, lint and typecheck pass.

## Left to the builder

- Exact order of commits, and whether the allowlist, scan and read-only removals
  land as one PR or several.
- Whether `PrRecord.source` is kept as a single-value field or removed.
- Wording of the new ADR, the README usage section, and the channel-topic text,
  within what's described above.

## Review notes

**Decided with Jolie after review:**
- A PR the bot can't read at submit time is still refused (`not-found`), not
  tracked as "sync paused". An earlier draft said the opposite, which didn't
  match the code.
- `READ_ONLY` is removed completely, and `/review-request` is registered from
  the first deploy.

**Calls made while folding in the review** (check these):
- Scanned records are deleted in the migration, not kept until they age out.
- The scan fields are kept as `{}` tombstones and the strip runs on every load,
  matching the PRD removal, so a mid-deploy old-build tick neither crashes nor
  writes scanned rows that survive.
- The one-record-per-message reaction guard stays as a harmless safety check.

**Corrected from the first draft:**
- `upsertRequest` depends on `newScannedRecord`, so the command needs its own
  record builder (section 2).
- The reason for keeping Read Message History is the pin check, not reactions.
- The scan's counts live in the tick log, not `/health`.
