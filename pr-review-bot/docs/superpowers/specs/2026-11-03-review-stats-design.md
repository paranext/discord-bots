# Review stats: design

Date: 2026-11-03
Status: draft, awaiting approval
Builds on: `feat/command-only-requests` (schema version 6). This design is schema version 7.

## Intent

The bot was built with no analytics, on purpose. The v1 design lists "Review-time analytics or reporting" as a non-goal (`docs/superpowers/specs/2026-08-26-pr-review-bot-design.md:52`). `adr-per-person-data-off-the-render` explains the reason: if claim lateness appears next to a name, people stop claiming. The README promises the team: "This data will not be used to compare people, and no per-person reporting will be built from it."

We now want two answers that the current data can't give:

1. **Is the bot helping or hurting our review process?**
2. **How does PR responsiveness change over time?**

The audience is the maintainer and a manager, sometimes shared with the team. The answers come from **anonymous, team-wide weekly totals only**. We still promise not to measure people. We no longer promise not to collect review timing.

## Goals

- Measure, for each review round:
  - how long it waited before it was claimed
  - how long it was claimed before it was done
  - the total time
- Measure the signals that the bot may be hurting:
  - claims that were dropped or auto-cleared
  - re-requests
  - rounds that ended without a review
- Keep **weekly team-wide totals** for the long term, so trends across months stay visible after the 30-day record purge.
- Add a `/review-stats` slash command that anyone can use. It replies privately to the person who ran it.
- Add a token-protected endpoint that a machine can poll, so a spreadsheet, script or local page can use the numbers later.

## Non-goals

- Any per-person view, filter, breakdown or field: requester, claimer, reviewer or PR author.
- Posting stats to the channel, scheduled reports, DMs or reminders. In the maintainer's words: "We don't want messages to the whole team."
- A "before the bot" baseline from GitHub history. The maintainer left this out.
- **Per-repo or per-urgency figures, ever.** The repo isn't stored at all. The maintainer chose this, knowing it rules out a repo filter later.
- A time-range option or a breakdown by how rounds ended in `/review-stats`. These are deferred, not rejected. They could be built from the weekly totals.
- A web dashboard. The endpoint makes one possible later, but none is built now.
- A live "open rounds older than X" figure. Totals are written only when a round ends, so very long-open PRs are under-represented. The daily post already shows the oldest open row's age. This is deferred.

## Anti-goals (failure even if it works)

- **Anything that lets someone work out who was slow**, including indirectly. Examples:
  - matching a stored figure to a PR through GitHub's public review and merge times
  - running the command before and after one PR resolves and comparing the results
  - a "slowest" figure that is really one remembered PR
- **Stats that appear unasked** in the channel, the pinned digest or the daily post.
- **Shipping before the team is told.** The README and the design docs are updated honestly in the same change. The maintainer will announce the change to the team before deploying. That announcement is part of rollout, not code.

## Data lifecycle in one picture

```
round ends ──► pending entry (no ids, no repo) ──► week closes + 24 h ──► folded into that week's totals, entry deleted
                    ▲      │
       reopen menu ─┘      └─ linked from the record only while pending (≤ ~8 days)
       withdraws it
```

Nothing finer than a weekly total outlives about 8 days.

## What is measured

### A review round

A **round** runs from a request until the record resolves.

- Re-requesting an **open** record continues the same round and increments the round's re-request count.
- Re-requesting a **resolved** record starts a new round. That path is `markRequested` → `reopenRecord`, at `src/core/record.ts:138`.
- When a round resolves, it writes **one pending entry**.

**The reopen menu withdraws the entry.** The reopen menu reopens *any* row within `reopenWindowMs`, whatever resolved it (`src/core/render/digest.ts:272-279`, `src/handlers/interactions.ts:182-189`). `reopenRecord` leaves `lastRequestedAt` alone, so for a row that was merged, closed or reviewed, the next tick resolves it again and writes a fresh entry. The rules:

- The record holds `roundPendingEntryId` while its entry is pending.
- Every reopen-menu reopen withdraws that entry. The resolution that follows writes a fresh one: same round, same `roundFirstClaimedAt`.
- Withdraw **only when `reopenRecord` actually changes the record from resolved to open**. The `reopen` command doesn't re-check state (`src/store/apply.ts:191-198`), so a re-request landing between the handler's read and the apply must not delete the previous round's entry.
- `markRequested` clears `roundPendingEntryId` whenever it starts a new round.
- Folding an entry into the weekly totals also clears the link. A withdraw against a folded or missing entry is a no-op.

### Times

All times are epoch ms. The new record fields are reset at the start of each round.

| Moment | Source |
|---|---|
| Round start | **New field** `roundStartedAt`. Set from the `/review-request` that began the round. `null` marks a round that was already open at deploy; those rounds write no entry. That's my call, because their first-claim time is unknown. |
| First claim | **New field** `roundFirstClaimedAt`. The first claim in the round, made by menu or by reaction. A later release does **not** clear it. Today `claimedAt` is overwritten on release, so this claim history doesn't exist yet. |
| Claim dropped | **New field** `roundClaimsDropped` (count). See "Dropped claims" below. |
| Re-requests | **New field** `roundReRequests` (count). |
| Done | See "Outcome and done time" below. |

**Outcome and done time.** `exitVerdict` (`src/core/exit.ts:51-63`) returns only a `resolvedBy` string today, and that string embeds a login or a name. It must also return a **kind** and a **time**. The entry is built from those, never from the string.

- **`reviewed`**: there is a qualifying review (`countsAsReview`) submitted after the round started. This applies even if the PR was also merged or closed in the same tick. Done is the `submittedAt` of the earliest such review. This keeps merge latency and author fix-up time out of review timing. Merged is checked before reviews today (`exit.ts:52`), so a review and a merge that land in the same tick would otherwise read as "merged".
- **`merged-unreviewed`**: the PR merged with no qualifying review in the round. Done is GitHub `mergedAt`.
- **`closed-unreviewed`**: the PR closed with no qualifying review. Done is GitHub `closedAt`.
- **`cleared`**: someone cleared it with the resolve menu. Done is the time of the click.

`mergedAt` and `closedAt` must be added to:

- the GraphQL query (`src/github/query.ts:27-41`)
- `RawPr` and `toSnapshot` (`query.ts:74-84`)
- `PrSnapshot` (`exit.ts:12-20`)

`PrSnapshot` is also built on the submit path (`src/handlers/reviewRequest.ts:250`). Both fields are nullable `DateTime` (https://docs.github.com/en/graphql/reference/pulls). When one is null, fall back to the tick time.

Durations stored on the entry:

- `waitToClaimMs` = first claim − round start. Null when the round was never claimed.
- `claimToDoneMs` = done − first claim. Null when the round was never claimed.
- `totalMs` = done − round start.

Clamp a negative value to 0. A negative can happen when a GitHub time falls just before a claim that was recorded on the next tick.

**Dropped claims.** Increment `roundClaimsDropped` only when `claimedBy` goes from set to null through one of these:

- a menu or reaction **release**, or
- a **stale auto-clear** (`clearStaleClaims`, `src/core/claims.ts:67-77`).

These do **not** count:

- an unclaim on a record that has no claim. `applyUnclaim` returns `released` without changing anything (`claims.ts:51`; `apply.ts:170-171`). Test this case.
- the claim cleared by `resolveRecord` (`record.ts:114-118`).
- the claim cleared by a re-request (`record.ts:145-149`). That's my call: `roundReRequests` already counts it, and a drop should mean a reviewer let go.
- a release within 5 minutes of the claim. That's my call. Choosing your own row in the menu releases it (`interactions.ts:157-159`), so a mis-click and its quick undo shouldn't read as the bot hurting.

**Known biases.** These are documented, not corrected.

- **Reaction claims are timestamped when a tick detects them.** Polling is round-robin, 10 reads per tick (`config/config.ts:93`), and a new message's first poll only primes. So `waitToClaimMs` is inflated for reaction claims, by more when the backlog is larger. A change in how many people claim by reaction can therefore move the trend.
- **Draft time counts as waiting.** Drafts can be requested.
- **Late reviews may be missed.** `reviews(last: 20)` can miss the earliest review on a very busy PR, which makes its `reviewed` done time later than it was.

### Pending entry

A pending entry is written when a round resolves. It contains only:

- `id`
- `week`: the ISO week, in UTC, in which **the bot recorded** the resolution
- `outcome`
- the three rounded durations: `waitToClaimMs`, `claimToDoneMs`, `totalMs`
- `claimed`
- `claimsDropped`
- `reRequests`

**It has no Discord id, name, GitHub login, repo, PR number, title, note, team, urgency or message id.**

Durations are rounded to the nearest 5 minutes.

The week is the week the bot recorded the resolution, not the done week. That's my call. A sync-paused PR can resolve weeks after its GitHub done time, and adding it to a week that was already folded would change published history after one known PR resolved.

### Weekly totals

**Folding.** A week is folded once it has closed *and* `reopenWindowMs` (24 h) has passed. Every entry in that week is then past its reopen window. The tick folds closed weeks in an idle step, then deletes their entries.

**A week's totals hold:**

- the number of entries for each `outcome`
- the summed `claimsDropped` and `reRequests`, and the number of rounds that had at least one drop
- for each of the three durations, a **histogram** over fixed buckets, counting only `reviewed` entries

The suggested bucket edges are 15 m, 30 m, 1 h, 2 h, 4 h, 8 h, 1 d, 2 d, 3 d, 5 d, 7 d and 14 d, with a final open-ended bucket. The builder may adjust them. They are documented, and they're fixed once shipped, because changing them breaks comparisons across weeks.

Histograms are used so that 4-week figures can be combined from weekly totals without keeping per-round values. Medians and percentiles come from merged histograms by interpolating within a bucket. They're approximate, and the docs say so.

**Weekly totals are kept indefinitely.** That's my call. They can't be linked to a person or a PR.

**Per-person removal.** The README's "If you want your own history removed, ask and it will be" can't apply to weekly totals. The README must say that plainly. It must also say that for up to about 8 days, a pending entry is linked from its PR's record and can be removed on request.

## What is shown

### Disclosure rules (these apply to every output)

1. **Complete, folded weeks only.** Nothing pending or current is ever shown. Figures change at most once a week, so running the command before and after one PR resolves tells you nothing.
2. **A median needs at least 5 rounds** in the group.
3. **"Slowest 1 in 4" (the 75th percentile) needs at least 20 rounds.** This keeps at least 5 rounds above the figure, so it is never one remembered PR. No other percentile is shown.
4. **Counts are shown as they are.** These are team-wide counts of completed, closed, cleared or dropped rounds in a week. Merged and closed counts are public on GitHub anyway, and with no repo or urgency split they don't single out a PR. That's my call.
5. **Histograms and buckets are never returned**, only figures derived from them.

### `/review-stats` (option A, chosen by the maintainer)

Anyone can run the command, in any channel, like `/review-list`, which isn't channel-gated. Only `/review-request` is gated (`src/handlers/interactions.ts:96-105`). The reply is **ephemeral** (flag `1<<6`) and goes only to the person who ran it.

It compares the **last 4 complete weeks** with the **4 weeks before** and shows:

- 📥 reviews completed: the count of `reviewed`, with the previous period's count
- ⏱ typical wait until claimed: the median, with an arrow showing which way it moved
- 🔍 typical time from claim to done: the median, with an arrow
- 🐢 slowest 1 in 4 took over X end to end: the 75th percentile of `totalMs`. This line appears only when there are at least 20 rounds. Otherwise it is left out.
- ↩️ claims dropped or auto-cleared: a count
- a footer explaining that "typical" means the median, that the figures cover complete weeks only, and that a figure needs at least 5 reviews to appear

A figure below its threshold shows "not enough reviews yet". An arrow appears only when both periods meet the threshold. The mockup the maintainer chose (option A) is at `.superpowers/brainstorm/*/content/review-stats-reply.html`, a gitignored directory. Its "slowest 1 in 10" line is replaced by "slowest 1 in 4", following the maintainer's answer.

Unknown commands currently fall through to "That command is not enabled yet." (`interactions.ts:112`). The new command needs a route there, plus an entry in the `commands` array in `scripts/register-commands.ts`.

### `GET /stats` endpoint

- **Auth** works the same way as `/health` (`src/handlers/health.ts`): a bearer token compared in constant time, and 404 when no token is set.
- **It uses its own secret, `STATS_TOKEN`**, so it can be given to a manager without exposing the health body. That's my call.
- **It returns exactly this and nothing more.** This boundary is a privacy line, not a detail to change freely. There is one row per complete, folded ISO week, by default the last 26. Each row has:
  - counts by outcome
  - summed drops and re-requests
  - the median of each duration (rule 2)
  - the 75th percentile of each duration (rule 3)

  Each row also carries a 4-week rolling version of the same figures. At about 5 rounds a week, most weekly medians will be suppressed, so the rolling figures are where the trend actually shows.
- **A suppressed figure is `null`**, with the reason stated in the response's documentation.

## Constraints

- **The store is one blob.** `StoreState` is read and written whole (`src/store/do.ts:75,80`), and `applyCommands` is pure over it (`apply.ts:259-273`).
  - Pending entries and weekly totals go **in `StoreState`**. That's my call: it keeps them atomic with the resolution that writes them, and it needs no new effects plumbing.
  - The size fits. Pending entries are bounded by about 8 days of rounds. Totals are about 1 KB per week, roughly 50 KB a year. The DO is SQLite-backed (`new_sqlite_classes`), so the limit is 2 MB per value (https://developers.cloudflare.com/durable-objects/platform/limits/).
  - Code comments that say "128 KiB" (`src/core/submit.ts:37`, `src/handlers/reviewRequest.ts:274`) describe the KV backend and are stale. Correct them when touching the store.
- **Schema version 7.** Follow `adr-durable-object-schema-version`:
  - bump `CURRENT_SCHEMA_VERSION`
  - add a step to `src/store/schema.ts`
  - give existing records new fields with `roundStartedAt: null`, so their rounds are skipped
  - add empty pending entries and empty totals
  - keep `do.ts` and `memory.ts` in step
- **Rolling back to v6 after v7 ships takes the whole bot down.** By design, an old build throws on a newer schema (`schema.ts:115-121`). The rollout notes must say this.
- **GraphQL cost.** Adding `mergedAt` and `closedAt` costs almost nothing, because scalar fields don't add to node cost.
- **Logs.** Add no `console.*` line that prints an entry, a pending-entry id together with a PR id, or durations together with a PR id. Counts in the tick report are fine.
- **Week boundaries** are ISO weeks in UTC, not the team's configured timezone. That's harmless, but document it.

## Docs to change in the same work

- **`README.md`**, under "What this bot stores": describe pending entries and weekly totals, what they contain and what they don't, the roughly 8-day link, indefinite retention of totals, and why totals can't be removed per person. Keep "no per-person reporting". Remove any wording that says no review-time analytics exist.
- **`docs/superpowers/specs/2026-08-26-pr-review-bot-design.md`**: add a dated amendment to the "Review-time analytics" non-goal that points to this design.
- **`docs/architecture-decisions.md`**:
  - Add a new ADR for anonymous review stats. It should record:
    - why per-person stats are still excluded
    - why the repo isn't stored
    - why only weekly totals are kept
    - the disclosure rules
    - the separate token
  - Add a cross-reference from `adr-per-person-data-off-the-render`.
- **`docs/operations.md` and `docs/setup.md`**: how to set `STATS_TOKEN`, how to call `/stats`, re-running command registration, and the rollback warning.
- **`docs/architecture.md`**: the new command, the endpoint, the fold step, and where pending entries and totals are stored.

## Left to the builder

- The entry id scheme.
- The exact histogram bucket edges, documented and then fixed.
- How to interpolate within a bucket.
- The exact wording and layout of the reply, as long as it shows option A's content under the disclosure rules.
- The exact `/stats` JSON shape and its query parameters, within the fields listed above.
- Where the fold step sits in the tick, and how it is bounded per tick.

## Answered objections

- **"Keep each finished review so filters can be added later."** Rejected by the maintainer. Each entry plus GitHub's public review times identifies the PR and the reviewer.
- **"Show the slowest 1 in 10."** Replaced by "slowest 1 in 4", shown only with at least 20 rounds, as the maintainer chose. With 5–9 rounds, the 90th percentile is just the slowest single PR.
- **"Use GitHub's merge time for merged PRs."** Only when there was no review. Otherwise review timing would include merge and fix-up time and self-merges.

## Calls I made (for the maintainer to check)

1. `STATS_TOKEN` is separate from `HEALTH_TOKEN`.
2. The minimum is 5 rounds for a median and 20 for "slowest 1 in 4". Counts are shown as they are.
3. Urgency isn't stored either, not just the repo.
4. Timings count `reviewed` rounds only. "Reviews completed" counts `reviewed` only.
5. A re-request doesn't count as a dropped claim, and a release within 5 minutes of the claim doesn't count either.
6. Rounds that are open at deploy are skipped.
7. An entry belongs to the week the bot recorded it, not the GitHub done week.
8. `/review-stats` works in any channel, like `/review-list`. The reply is private, so the channel doesn't matter.
9. Pending entries and totals live in `StoreState`.
10. Reaction-claim lag, draft time and the 20-review window are documented, not corrected.
