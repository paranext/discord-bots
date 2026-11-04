# PR Review Request Bot — Design

**Date:** 2026-08-26
**Status:** Ready to plan. Three rounds of adversarial review are folded in, and
the nine open questions they raised are all **decided** — see Decision log, which
records each answer and why. Every mechanical correction is applied inline.
A render proof built before any code (see Preview harness) caught one further
defect the prose had hidden: the compact `3d` age form the digest example used is
not producible by `<t:epoch:R>`, so the two rules the spec asserted could not both
hold. Ages are now long form. Scope is v1 as specced — nothing severed. Hosting is
**deliberately deferred** behind the store interface.
**Author:** Jolie Rabideau

## Problem

The team requests dev code review by posting a PR link in a Discord channel. Two
distinct problems come out of that:

1. **Authoring.** Messages are inconsistent. An ad-hoc emoji convention for
   urgency was tried and abandoned because nobody reliably remembers what the
   symbols mean or can skim for them.
2. **Tracking.** There is no way to answer "what is still waiting on review?"
   Old requests scroll out of sight. The current remedy is for the author to
   post a "bump" message, so anything whose author forgets is silently lost.
   Long-lived and low-priority PRs are the ones that suffer.

A better-formatted message solves only the first problem. A message still sinks
in channel history no matter how it is formatted. The tracking half is what
changes behavior.

## Solution summary

A Discord bot with three halves — two mechanisms and a delivery layer:

- `/review-request` opens a modal (dropdowns plus the PR link) and posts a
  consistent, machine-generated request message in the channel.
- The bot maintains **one pinned "Needs review" message**, rewritten every five
  minutes, grouped by dev team. Entries leave the list automatically once the PR
  has actually been reviewed. Re-requesting replaces bumping.
- **One conditional post a day** in the channel — a count, the oldest age, and a
  jump link to the pin — posted only when something is waiting. A pinned message
  that is silently edited reaches nobody; this is the layer that makes the
  tracking half arrive.

## Non-goals

Deliberately excluded from v1:

- DM nudges and per-person reminders. The one daily channel post is neither: it
  names no individual and lands in a channel people already read.
- Per-person views ("PRs you have not reviewed").
- Review-time analytics or reporting.
  - **Amended 2026-11-03:** anonymous, team-wide weekly review-time totals are
    now collected and shown, under strict disclosure rules. Per-person analytics
    and reporting remain a non-goal. See
    [`2026-11-03-review-stats-design.md`](2026-11-03-review-stats-design.md) and
    `adr-anonymous-review-stats`. The original text above is left as written.
- Writing anything to GitHub. All GitHub access is read-only.
- Forum posts per PR (considered and rejected as too heavyweight).
- Per-user GitHub OAuth.

## Key decisions

| Decision | Rationale |
|---|---|
| No repo automation; no GitHub Actions | **Opening a PR must stay separate from requesting review**, and any repo-side trigger collapses the two. (The earlier rationale — "would require a workflow in every repo" — was false: a search-based digest could run from one repo we own, as the Testing section concedes. The separation argument is the one that survives.) A label-based alternative fares no better: labels are a metadata convention with more friction than a dropdown and no generated text, and this team already abandoned one metadata convention. |
| GitHub is read-only, keyed off the pasted URL | Works for any repo with no per-repo setup and no process change. |
| An entry leaves the list on **any** review, derived from review **events** | The list answers "has anyone picked this up yet", not "is this merged". Implemented as `reviews(...)` with `submittedAt` newer than the request — **not** `reviewDecision`, which is null on unprotected branches, never resets after a push, and ignores comment-only reviews. See Exit condition. |
| Records are **resolved, never deleted** | Deletion loses team, urgency, PRD, note and request history, makes re-requesting impossible to detect, and leaves no answer to "why did my row disappear". The corollary is that a resolved record is a tombstone the dedup path matches forever, so every write path must say whether it reopens; see Reopening a resolved record. |
| Re-running `/review-request` re-lists a PR | After changes are requested and addressed, re-requesting is the bump — and it is a real signal rather than a "still needs eyes" message. Works only because exit is event-based; with `reviewDecision` a re-requested PR would be re-dropped within one tick, forever. |
| Grouped by dev team, urgency within | Simple and Power are separate dev teams. Most readers only care about their own team's rows, so team is the primary axis. |
| Urgency is always emoji **plus** words | The bot generates the text, so no one needs to decode a symbol from memory. This was the stated objection to the manual emoji convention. |
| Title, repo, and number come from GitHub | Nobody retypes what the PR already knows. |
| CODEOWNERS is ignored | Auto-assignment does not mean anyone intends to pick a PR up, so showing assignees would imply commitments nobody made. |
| Claiming happens from a **select menu on the digest** | A component cannot be attached to another user's message, so a button on the request message can never work for hand-posted PRs — and during shadow mode every row is hand-posted. A control on the bot's own pinned message works identically for both sources, is instant, and needs no per-message polling. The `:code_review:` reaction remains a best-effort secondary path with a per-tick read budget. |
| Claimed PRs move to a section, not off the list | An abandoned claim stays visible instead of silently vanishing. |
| A stale claim **auto-clears** rather than displaying a warning next to a name | A ⚠️ beside a person in a permanently pinned message is a public lateness board with no context for why they are stuck. The predictable adaptation is that people stop claiming, which destroys the data and makes the section look broken. Auto-clearing returns the PR to its team section where someone else can pick it up — which is the actual goal. |
| Records live in a **serialized store**, not a shared mutable KV value | KV has no compare-and-swap, is eventually consistent, and caps at one write per second per key. One array under one key, written by both the cron and interactive handlers, loses updates by construction: a claim can be silently erased by a concurrent sync, producing exactly the duplicate review the claim feature exists to prevent. |
| Blocking urgency requires a reason, **rendered in the digest** | Nothing otherwise caps 🔥, and the rational move for every requester is 🔥, which returns the urgency axis to carrying no information. The reason is only accountable if it is *read*, so it renders inline beneath 🔥 rows in the digest — not solely in a request message that sinks. A reason collected and never displayed is four seconds of unfalsifiable typing buying permanent top-of-list placement. |
| **Soon carries no icon**; only 🔥 and 🧊 get one | Icons are scanned, not read: their whole job is to split the list into "now" and "can wait" at a glance. A third icon competes with those two for that glance and flattens the only distinction anyone acts on, while the middle level is exactly the one whose icon carries no instruction. Open rows still show the `Soon` label. Claimed rows and claim/resolve menu options show the icon alone, so there Soon looks the same as no urgency — accepted, because by then the PR is claimed or already sorted by rank, and only 🔥 / 🧊 still carry an instruction. |
| 🧊 means **This week**, not "when there's time" | An urgency level that publicly asks people *not* to review your PR is one nobody selects, which collapses the primary sort axis to one bit — and Problem says low-priority PRs are already the ones that rot. A commitment keeps the third level worth choosing. |
| One conditional daily post carries the digest | Discord fires a pin notification once, at the initial hand-pin; every subsequent `PATCH` is silent. Tracking changes behavior only if tracked state reaches a human eye, so without a delivery layer v1's claim shrinks to "the author can check instead of bumping". The post names counts and the oldest age only — no individuals — so it is not the per-person nudge the non-goals exclude. |
| Per-person timing data stays out of the render | `claimedAt` and `requestCount` are needed by auto-clear and dedup, but a claim age beside a name in a permanently pinned message is a lateness board, and `re-asked Nh ago` is a per-author nag counter. Both stay in the store and off the screen. "No review-time analytics" is otherwise a promise about what v1 *builds*, not about what the pin displays. |
| Ages render long form (`3 days ago`) | `<t:epoch:R>` has no compact variant, so the compact `3d` form is only reachable by computing ages — which makes the body a function of wall-clock time and destroys the write-skip. Long form costs ~20–30 characters a row and roughly 20 rows of embed capacity, and keeps an idle team at zero writes. |
| Explicit repo allowlist | A mispasted link fails loudly instead of becoming a permanent row. |
| Two GitHub credentials routed by owner | Private repos exist only in `paranext`, where an App can be installed. Everything else the team reviews is public, so a read-only public token covers other orgs with no admin approval there. |
| Cloudflare Workers | The command endpoint and scheduled refresh need no persistent socket. Free tier, no process to keep alive, no OS to patch. |
| The digest message is pinned once by hand | Editing its own message needs no extra permission, so the bot never needs Manage Messages. |
| The digest is an embed, not plain content | Plain message content caps at 2000 characters; an embed body allows 4096, and 6000 across embeds in one message. At the 150–180 characters a real row costs once titles are markdown links and PRDs are `<#thread>` mentions, that is roughly 25 rows per embed — so an embed roughly doubles plain content's capacity, but truncation stays a real path and needs the explicit rule in Rendering rules. |
| Channel history is scanned for PR links | Required for shadow-mode rollout, and worth keeping permanently: the list stays complete when someone posts a link by hand out of habit instead of using the command. |
| Validation errors carry a "Fix and retry" button | A modal submission cannot be answered with another modal, so without this a rejected link means retyping the whole form. |
| Docs follow the `paranext-core` ADR convention | `.context/standards/Architecture-Decisions.md` — an append-only log of `adr-<slug>` entries. Anyone arriving from the product repos recognises the format immediately. |

## Exit condition

This is the single most important rule in the design, and the first version of
this spec got it wrong. Everything the list is worth depends on rows leaving it
correctly.

**A record is resolved when GitHub reports a review event newer than the
record's most recent request**, or when the PR is merged or closed.

Query `reviews(last: 20) { submittedAt, state, author { login, ... on Bot { login } } }`
and compare `submittedAt` against `lastRequestedAt`. **Any** review state counts,
including `COMMENTED` — a reviewer who leaves fifteen line comments has
unambiguously looked.

Three filters apply before the comparison, and each closes a permanent-drop loop:

- **Bot reviews do not count.** Copilot code review, CodeRabbit and every review
  bot submit real `PullRequestReview` objects. Request at 10:00, Copilot at 10:01,
  row gone at 10:05 — and a re-request is re-dropped within one tick. That is the
  same loop this section correctly diagnoses for `reviewDecision`, re-entered by
  another door. Reject an author whose `__typename` is `Bot` or whose login ends
  in `[bot]`.
- **The requester's own reviews do not count.** An author leaving line comments on
  their own PR through the review flow produces the same object, with the same
  effect. This requires the requester's GitHub login, which the bot does not have
  from Discord — so match on `author.login == pr.author.login` (the PR's own
  author, which the query already can select) rather than on the Discord
  requester. That covers the real case without a Discord-to-GitHub identity map.
- **A review with a null `submittedAt` is ignored.** That is a `PENDING` review —
  a reviewer with unsubmitted line comments. Nobody has looked yet on the record.

**Scanned records seed `lastRequestedAt` from the scanned message's timestamp**,
not from the scan time. Scan time is later than every review the PR already has,
so a conversational mention of a PR approved last week would become a permanent
row that only merging clears — tripping shadow mode's own accuracy threshold on
rows whose review landed before the bot existed. With the message timestamp as the
seed, the ingest comparison resolves such a record immediately: **a scanned record
whose review already happened is born resolved.**

Do **not** use `reviewDecision`. Verified against GitHub's documentation and
maintainer discussions, it fails this design three ways:

- It is **null** when the branch is not protected and no review has been
  requested or submitted. Since this design deliberately never writes to GitHub
  and ignores CODEOWNERS, null is the expected value for many tracked PRs — so a
  "keep only `REVIEW_REQUIRED`" rule drops them on the first tick after they are
  created.
- It **never resets** to `REVIEW_REQUIRED` when the author pushes fixes after
  changes were requested. A re-requested PR would therefore be re-dropped within
  five minutes, permanently, breaking the re-request-instead-of-bump workflow
  this design is built around.
- A `COMMENTED` review does not move it at all.

Resolved records are retained for 30 days, then purged. Retention is what makes
"why did my row disappear?" answerable, and turns a lost data store into an
inconvenience rather than an incident.

**Verify this against ~10 real PRs across `paranext-core` and
`scripture-editors` before writing anything else.** Every other behavior is
downstream of this field's semantics.

## Architecture

A single worker process with two entry points. The examples below name Cloudflare
Workers because that is the leading candidate, but the hosting choice is deferred
and reaches only the store adapter and one config flag; see Hosting constraints.

- **`POST /interactions`** — all Discord interactions: the slash command, the
  modal submission, the claim button. Verifies Discord's Ed25519 signature
  against the app public key before doing anything else. No gateway connection.
- **`scheduled()`** — a cron trigger every five minutes: re-sync against GitHub,
  read reactions for unclaimed entries, rewrite the pinned message, and — once a
  day, when something is waiting — post the daily message.

Three modules with deliberate seams:

1. **`core/`** — pure functions, no I/O. PR URL parsing, state transition rules
   (which records survive a sync), digest rendering, claim resolution. This is
   where the logic that can be wrong lives, and it is fully testable without a
   network.
2. **`discord/`** — signature verification, REST calls (post message, edit
   message, read reactions, list forum threads), modal and component payloads.
3. **`github/`** — credential routing and one batched GraphQL query.

Consumers of `core/` pass in plain data and get plain data back. The adapters
are thin enough to be stubbed with a fake `fetch` in tests.

## Configuration

Checked into the repo, so changes are reviewable one-line PRs:

- **Allowed channels** — channel IDs where the command works and the digest lives.
- **PRD forum channel ID** — `teamwide-epic-discussions`.
- **Repo allowlist** — `owner/repo` entries. Initial value:
  `paranext/paranext-core`, `paranext/paratext-10-studio`,
  `paranext/paratext-assistant`, `paranext/paratext-bible-extensions`,
  `paranext/paratext-bible-internal-extensions`,
  `eten-tech-foundation/scripture-editors`.
- **Teams** — `Power`, `Simple`, `General`.
- **Urgency levels** — `🔥 Blocking`, `Soon` (no icon), `🧊 This week`.
- **Claim emoji** — `code_review:1075535230087221248`.
- **Stale-claim threshold** — 2 days.
- **Refresh interval** — 5 minutes.
- **Recently-cleared window** — 1 day (originally 1 hour; widened because an
  hour emptied the section before most of the team had looked). Must be at least
  the reopen window.
- **Daily post time** — 09:00 in the team's working timezone, and the channel it
  posts to (the digest channel).
- **Per-tick budgets** — reaction reads, scan pages, and resolved-record purges.
- **Stale-banner threshold** — 30 minutes since the last successful sync.

Secrets (Worker secrets, never in the repo): Discord bot token, Discord app
public key, GitHub App ID and private key, GitHub public-read token.

## Authoring flow

1. User runs `/review-request` in an allowed channel. The command is registered
   guild-scoped so it exists only in this server and updates take effect
   immediately.
2. The bot responds **immediately** with a modal, built entirely from **cached**
   data. The PRD list is refreshed by the cron and read from the cache here —
   never fetched live. This matters more than it looks: a modal cannot be sent
   after a deferred response (callback type 9 is not valid for a deferred or
   MODAL_SUBMIT interaction), so there is no escape hatch if the 3-second budget
   is missed — the user just sees "The application did not respond" on the
   primary command. Any live fetch in this path is a latent outage.

   The cache also fixes a hole in the live approach: `threads/active` returns
   only *active* threads, and forum posts auto-archive after inactivity, so a
   PRD whose discussion has been quiet for a few days would simply vanish from
   the dropdown. The cache retains it. The cron populates the cache from
   `GET /guilds/{id}/threads/active` — which is **guild-wide, so results must be
   filtered by `parent_id`**, and **ordered by thread id, not recent activity,
   so "most recent" requires sorting by `last_message_id`** — supplemented by
   `/channels/{id}/threads/archived/public`.
3. Modal fields:
   - **PR link** — short text, required.
   - **Team** — select: Power / Simple / General.
   - **Urgency** — select: the three configured levels. Choosing 🔥 Blocking
     makes the note field required — enforced **server-side on submit**, not in
     the modal: `required` is a static field in the payload Discord renders
     before the user picks anything, and a modal has no conditional logic and no
     re-render. An empty note with 🔥 urgency is therefore a rejection carrying
     the existing "Fix and retry" button. Nothing else caps its use.
   - **PRD** — select, built from active threads in the PRD forum, plus "None".
     Capped at 25 options (a Discord limit); if there are more active threads,
     the 25 most recently active are shown and the omission is noted in the
     modal's PRD label.
   - **Note** — short text, optional except for 🔥 Blocking. Preserves the extra
     context people add today ("just the CSS bit", "needs a P10 build").

   This is **exactly five components**, which is Discord's hard per-modal cap. A
   sixth field is not possible without removing one of these.
4. On submit the bot defers with an ephemeral acknowledgement, then:
   - Parses the URL. Rejects anything that is not a GitHub PR URL.
   - Rejects repos not on the allowlist, naming the repo and saying how to add it.
   - Fetches the PR. Rejects if it does not exist or is not visible.
   - If the PR is merged or closed, rejects with that reason.
   - If the PR is a draft, posts anyway but marks the row `draft` — a draft PR
     can legitimately want early feedback, so this is a note, not a block.
   - **If this PR is already tracked, updates the existing record** (new urgency,
     team, PRD, note) rather than creating a second entry, and says so privately.
     Re-requesting **clears any existing claim** — a claim from the previous round
     must not hide the new request in the Being reviewed section. If the matched
     record is **resolved, re-requesting reopens it** (see Reopening). It updates
     `lastRequestedAt` and increments `requestCount`, but **`firstRequestedAt` is
     never changed**: sorting is oldest-first, so resetting the age would push
     the honest re-requester *down* the list and penalise using the mechanism the
     design nominates as the replacement for bumping. `requestCount` is **not
     rendered** — see the digest's rules on per-person data — but it is what makes
     re-request detection and this sort rule possible.
5. Posts the request message in the channel, stores the record, and rewrites the
   pinned digest immediately rather than waiting for the next cron tick.

   The immediate rewrite is **behind a config flag**, because on a CPU-capped host
   it is the step that breaks the budget: Ed25519 verification, GitHub JSON
   parsing, a full digest render and embed serialization all draw from the same
   allowance, and `waitUntil` work draws from it too. With the flag off, the
   handler writes the record and returns, and the next tick renders — costing up
   to one refresh interval of lag. Which way the flag sits is a hosting
   consequence, not a product decision; see Hosting constraints.

### Reopening a resolved record

Records are resolved, never deleted, and identity is `owner/repo/number`. Those
two rules together mean a resolved record is a **tombstone that the dedup path
will match forever**, so every write path that matches an existing record must
state what it does when that record is resolved. Without this, the design's
headline workflow fails in exactly the case it exists for: a PR is reviewed,
changes are requested, the author pushes fixes and re-requests — and the
re-request updates a resolved record that the refresh loop never loads, so the
PR silently never returns to the digest.

**Clearing `resolvedAt` and `resolvedBy` is what returns a record to the open
set.** Three paths do it:

- **Re-request** (`/review-request` on a resolved PR) — reopens, and is the
  normal second-round case.
- **`Resolve ▾` on a row resolved by mistake** — the same select menu offers
  resolved rows from the last 24 hours as `Reopen ▾`, since a mis-resolve is
  otherwise unrecoverable.
- **Message scanning** — a later mention of a resolved PR does **not** reopen it.
  A resolved PR being discussed conversationally is the common case, and
  resurrecting rows from chatter is how a list becomes untrustworthy. Scanning
  skips resolved records rather than silently swallowing or silently resurrecting
  them; this asymmetry with re-request is deliberate, because one is an explicit
  request and the other is not.

Reopening **appends** the cleared `{resolvedAt, resolvedBy}` pair to
`resolutionHistory` rather than discarding it, so "why did my row disappear, and
why is it back" stays answerable. `firstRequestedAt` is untouched, for the same
reason a re-request does not reset it.

### Validation feedback

Rejections are **ephemeral** — shown immediately to the requester only, so a
typo leaves no noise in the channel. Ephemeral is not silent: every rejection
must be actionable on its own, naming the specific problem and its fix.

- Unlisted repo: names the repo, states that it is not on the allowlist, and
  links the config file to add it.
- Not a PR URL: shows the expected shape.
- PR not found or not visible: distinguishes "does not exist" from "the bot
  cannot see it", since the second is a credential problem with a different fix.
- Already merged or closed: says which.

Every rejection includes a **"Fix and retry"** button that reopens the modal
pre-filled with the values already entered. A modal submission cannot be
answered with another modal, but a button can open one — without this, a
mistyped link costs the requester the whole form.

The prefill cannot travel in the button's `custom_id`, which caps at 100
characters — a PR URL alone is most of that. The submitted values are stashed in
the store under the interaction id with a short TTL, and the `custom_id` carries
only that key. Note also that the ephemeral interaction token expires after 15
minutes, after which the button fails with a bare "This interaction failed"; the
rejection text therefore echoes the submitted values inline as well, so a
late-returning user can still copy them into a fresh command.

## The posted request message

```
🔥 Blocking · power · PT-4398 P10 backend sync-activity signal
Trust PRD · requested by @Jolie
https://github.com/paranext/paratext-10-studio/pull/177
[ 👀 Reviewing this ]
```

The bare URL is kept on its own line deliberately, so GitHub's link unfurl still
renders. The PRD renders as `<#threadId>`, which Discord displays as a clickable
link into that PRD's discussion thread and which follows thread renames
automatically.

## The pinned digest

One message per configured channel, pinned by hand once at setup.

```
**Needs review** · 4 open · updated 2 minutes ago

__Power__
🔥 Blocking · PT-4398 P10 backend sync-activity signal · 3 days ago
     paratext-10-studio#177 · Trust PRD
     needs a P10 build before Thursday's demo

Soon · PT-4401 Sync activity indicator · 6 hours ago
     paranext-core#2701

__Simple__
🧊 This week · PT-4363 Internet Settings UI Enhancements · 8 days ago
     paranext-core#2695

**Being reviewed** (2)
👀 PT-3408 Collapse extra spaces in Find queries · Katherine · 🔥 Power
👀 PT-4325 Registration Needed Dot · Ira · Simple

Recently cleared
paranext-core#2688 — reviewed by Katherine
paratext-assistant#88 — cleared by @Jolie
```

Rendering rules:

- Team sections in a fixed order: Power, Simple, General. A team with no open
  rows is omitted entirely.
- Urgency renders as **emoji plus words** here, not emoji alone. The digest is
  the permanent surface, so it is the one place that must not require decoding a
  symbol from memory — which was the stated objection to the manual convention.
  🧊 against 🧀 at mobile emoji size is two coloured blobs.
- Within a team: urgency descending, then age descending (oldest first).
- Age is time since the request was posted, not since the PR was opened.
- Claimed entries move out of their team section into **Being reviewed**, showing
  the claimer and **the urgency and team they came from** — a lead scanning for
  what is blocking Power must still see it once it is claimed. The **claim age is
  not rendered.** `Ira · 4d` beside a name in a permanently pinned message *is* a
  lateness warning; the ⚠️ an earlier draft removed was only its label. The timer
  stays in the record, where stale auto-clear needs it, and off the screen, which
  is the part that changes behavior.
- A 🔥 Blocking row renders its **reason inline**, indented beneath the row. This
  is the only place the required note is visible to anyone deciding what to pick
  up, and therefore the only version in which the gate is accountable rather than
  ceremonial. It costs roughly 40–60 characters on the highest-priority rows.
- `requestCount` is **never rendered.** Re-request detection and the sort rule
  need the field; publishing `re-asked Nh ago` turns the pin into a per-author nag
  counter, and combined with `claimedAt` makes the store a per-person latency
  dataset one query from a leaderboard.
- **Recently cleared** — every row resolved within the configured window (1 day;
  originally 1 hour) renders, with no row cap, as a trailing list showing when
  each was cleared, distinguishing a review from a manual clear:
  `#2688 — reviewed by Katherine` against `#177 — cleared by @Jolie`. Without it a
  row vanishes with no explanation to its author, and a handful of those is what
  makes people stop trusting a list. An hour rather than a single tick, because
  five minutes is missed by anyone who was in a meeting.
- The **stale banner** replaces the `updated` relative timestamp rather than
  sitting beside it, so a reader never has to do the subtraction. It renders
  whenever `now - lastSync` exceeds the stale threshold — a property of the
  arguments, not of whether this tick's sync succeeded; see Refresh loop step 9.
- The "updated" footer uses a Discord relative timestamp, so it stays accurate
  between edits without the bot rewriting the message.
- The header count is **open rows**, not rendered rows: `31 open` always means the
  true size of the queue, and `…and N more` explains any gap. Under-reporting the
  backlog is the direction the list must never lie in. The two figures can differ
  legitimately, because **Being reviewed** may sit in a second embed with its own
  budget, so the count needs this definition rather than falling out of the render.
- Empty state: `**Needs review** · nothing waiting 🎉`, and **no components at
  all**: a String Select requires 1–25 options, so a menu rendered with an empty
  option list is a 400 and the `PATCH` fails outright. Since a failed edit is
  retried on the next tick, that would freeze the digest displaying PRs that are
  already done — the list lying in the trust-critical direction. `Resolve ▾` is
  omitted when there are no open rows; `Claim a PR ▾` when there are no
  *unclaimed* rows.
- Each title links to its PR.
- A draft PR renders with a `draft` marker after its age.
- Rendered as an embed **description** (4096 characters). Past that, **Being
  reviewed** moves to a second embed in the same message (6000 total across all
  embeds). The "updated" timestamp goes in the description, **not**
  `footer.text`, where `<t:…:R>` renders as literal text rather than a time.
- Real rows run 150–180 characters once titles are markdown links and PRDs are
  `<#thread>` mentions, so practical capacity is roughly 25 rows per embed —
  materially lower than a naive character estimate suggests. Truncation is a
  real path, not a theoretical one.
- Truncation ranks **null urgency below 🧊**. Every scanned row has no urgency, so
  during shadow mode this rule decides the entire list; leaving it unstated left
  the majority case undefined.
- When capacity is exhausted, rows are dropped lowest-urgency and most-recently
  requested first, with `…and N more` appended. Truncation must never be silent:
  a list that looks complete when it is not is worse than no list. A row dropped
  by truncation is **also absent from the select menus** — see Claiming and
  removal, which populates them from this same ranking.
- All ages render as Discord relative timestamps (`<t:epoch:R>`) rather than
  strings the bot computes — and therefore in **long form** (`3 days ago`, not
  `3d`). Discord offers no compact variant, so the compact form an earlier draft
  showed was unreachable: the two rules could not both hold. Long form is the one
  that keeps the write-skip, at a cost of ~20–30 characters a row, which lowers
  practical capacity from roughly 25 rows to nearer 20.
  Computed ages would make the rendered body a function of wall-clock time as
  well as record state, so a row crossing an hour or day boundary
  (`2h`→`3h`, `47h`→`2d`) would change the body on its own. With a dozen open
  rows that happens on nearly every tick, which would defeat step 9's
  write-skip and turn "an idle team costs no writes" into 288 no-op `PATCH`es a
  day — the figure the KV write budget and the Discord rate-limit analysis both
  depend on. Relative timestamps make the body a pure function of record state.
- Section order is fixed: team sections, then **Needs triage** (entries with no
  team, see Message scanning), then **Being reviewed**, then
  **Recently cleared**.

## Refresh loop

Every five minutes:

1. Load unresolved records from the store.
2. Query GitHub per credential group, **chunked to 25 PRs per query** — requests
   running longer than 10 seconds are terminated by GitHub with a 502/504.
   Request `state`, `isDraft`, `merged`, `title`, `number`, and
   `reviews(last: 20) { submittedAt, state, author { login } }`.
3. Read the `errors` array even on HTTP 200: a batch containing one inaccessible
   PR returns partial data plus a `NOT_FOUND` error for that alias. Map that
   alias to `sync paused`, never to "resolved" — treating a null as "gone" would
   delete good records, and treating the whole response as failed would freeze
   all syncing.
4. Apply the exit condition. Set `resolvedAt` and `resolvedBy`; do not delete.
5. Clear any claim older than the stale threshold, returning that row to its team
   section marked `previously claimed`.
6. Scan configured channels for new PR links (see Message scanning), **paging
   until fewer than 100 messages return or the per-tick page cap is hit**.
   `GET /channels/{id}/messages` caps at 100 per call, so a single call per
   channel silently drops messages on a busy interval and then advances the cursor
   past them. On hitting the cap, never advance the cursor past a message that
   was not examined — but what that means differs by direction. A steady-state
   forward walk (`after=<cursor>`) reads contiguous, ascending pages, so the
   cursor advances to the **newest** id of the last fully processed page:
   nothing in between was skipped, and advancing to the *oldest* processed
   message instead would re-scan the pages just read on the next tick, wasting
   its page budget for no benefit. A first-run backward walk (`before=`, used
   only because there is no stored cursor yet) instead fixes the cursor at the
   newest message of the very first page fetched, so the following tick can
   switch to paging forward from it rather than repeating the backward walk.
7. Refresh the cached PRD thread list.
8. Read `:code_review:` reactions for unclaimed records, **up to a fixed
   per-tick budget**, oldest-unchecked first. This is a secondary path; the
   digest select menu is primary. Records whose `messageId` is shared with
   another record are **skipped by this path entirely** — see Claiming and
   removal.
9. **Re-read records from the store, then** render the digest and `PATCH` it —
   only if the rendered body has changed, so an idle team costs no writes. The
   re-read is not optional: see Rendering reads the committed state.

   **This step runs even when step 2 failed.** The digest is a pure function of
   `(records, lastSync, now)`, so the stale banner is a rendering consequence
   rather than a sync side effect. Otherwise the banner can never appear: a tick
   that dies at the GitHub step never reaches the renderer, and readers keep
   seeing a normally formatted list — which is precisely the failure Monitoring
   names as the one it most needs to avoid. A failed sync aborts *record
   mutation*, not rendering.
10. Purge resolved records older than the 30-day retention window, capped at a
    fixed number per tick so a backlog cannot blow the tick's budget. Without
    this step the retention rule has no execution site and resolved records
    accumulate forever, growing step 1's cost on every tick.
11. If the configured daily-post time has passed and no post has been made for
    today, and at least one row is open, post the daily message and record the
    date. A clear queue posts nothing, so the message never becomes wallpaper.

Before step 2, the `paranext` credential is minted if needed: a locally signed
RS256 JWT, then `POST /app/installations/{id}/access_tokens`. **Installation
tokens expire hourly**, so this is a recurring cost against the tick's subrequest
budget, not a startup step — one extra subrequest at most once an hour, cached
between ticks. A **401 is not a transient error**: it fails closed for that
credential group and stops retrying, because 10,000 invalid responses in ten
minutes risks a temporary IP ban, and an expired-credential bug otherwise retries
hot every five minutes on every tracked PR.

The whole loop runs under a **lease** held in the serialized store — the same
Durable Object that holds the records, **not KV** — taken at tick start and
released at the end. A tick that finds a live lease younger than the 15-minute
scheduled wall-clock limit exits immediately without writing. Cron gives no
overlap prevention and no exactly-once guarantee, so without the lease a slow
tick and its successor can both `PATCH` the digest — leaving the older render in
place while the change-detection hash records the newer one, which then
suppresses the correction on every subsequent tick.

A lease is the one value in this design that **requires compare-and-swap**, and
KV has none: it is eventually consistent, with a write taking up to 60 seconds to
become visible in other locations. Two overlapping ticks reading a KV lease from
different points of presence would both see it absent or stale and both proceed,
producing precisely the poisoned-hash outcome the lease exists to prevent. This
is the same argument the Key decisions table uses to keep records out of KV; it
applies with more force here, because a lost record update is recoverable on the
next tick and a poisoned hash is not. Keeping the lease in the store also avoids
a mandatory take-and-release KV write on every tick (~576/day) that the
write-skip cannot elide — on its own most of the free-plan daily write budget.

### Rendering reads the committed state

The serialized store keeps concurrent writes from losing each other, but that
protects the *record*, not the *render*. Step 1 reads records and step 9 `PATCH`es
a body built from that snapshot, tens of seconds of network I/O later, so a
render built at step 1 would overwrite any interactive write that landed in
between:

> A tick starts at 10:05:00 and reads records. At 10:05:02 Katherine claims
> `#177` from the digest menu; her handler writes the claim and `PATCH`es, and
> the row moves to **Being reviewed**. At 10:05:20 the tick `PATCH`es its stale
> render: `#177` is unclaimed again in its team section and stays that way until
> 10:10. A second reviewer sees an unclaimed 🔥 row and starts the duplicate
> review that claiming exists to prevent.

So step 9 **re-reads the records inside the store immediately before rendering**,
and the read, the render and the hash comparison happen in the same store call
that commits the tick's own mutations. The record is never stale-written and
neither is the message.

Claims made through the digest select menu are applied at interaction time and
appear immediately. Reaction claims carry up to one refresh interval of lag, and
apply **only to messages that produced exactly one record** — a message reading
"these two need eyes: …/pull/177 …/pull/181" yields two records sharing one
`messageId`, and a single reaction on it cannot say which PR the reactor meant.
Claiming both would assert a commitment nobody made, and picking one by
iteration order is worse. Such messages are skipped by the reaction path; the
digest menu, which names the row, remains available.
Where a reaction and a menu claim conflict, **the first claim the store sees
wins** and a reaction never supersedes an existing claim; the superseded claimer
is told privately. This is deliberately not "the earlier timestamp wins": the
reactions endpoint returns a user list with **no per-reaction timestamp**, so a
reaction can only ever be stamped at detection time, and ordering by that stamp
would systematically rank a 10:01 reaction behind a 10:03 menu claim — inverting
the real order in exactly the cases the rule exists to protect. First-write-wins
is the strongest rule the API can actually support.

## Data model

All mutable record state lives in a **single serialized store** so that
concurrent writes cannot lose each other. On Cloudflare that is one Durable
Object; on a conventional host it is one table with per-row writes. The store is
an adapter behind an interface — `core/` never sees it — so the hosting decision
does not reach the logic.

What must never happen: a read-modify-write of a shared value from both the cron
and an interactive handler. A claim applied at 10:04:50 must not be erased by a
sync that read a stale copy at 10:05:00 — and, because the digest is the only
place anyone sees that claim, the same holds for the rendered message body, which
is why refresh step 9 re-reads before rendering.

Small immutable-ish values (the digest message ID, scan cursors, the cached PRD
list, `meta:lastSync`) may live in KV, coalesced into as few keys as possible.

Records:

```
{
  owner, repo, number,          // identity, from the URL
  channelId, messageId,         // the request message
  team, urgency, prdThreadId, note,
  requesterId,
  firstRequestedAt,             // sort key — never changes
  lastRequestedAt,              // freshness; updated on re-request
  requestCount,
  claimedBy, claimedAt,         // null when unclaimed
  lastClaimedBy, claimClearedAt, // survives a stale auto-clear; renders `previously claimed`
  syncPausedSince,              // set on NOT_FOUND / 401 for this record's repo
  resolvedAt, resolvedBy,       // null while open; retained 30 days
  resolutionHistory,            // prior {resolvedAt, resolvedBy} pairs, appended on reopen
  title,                        // cached from GitHub for rendering
  prAuthorLogin,                // GitHub login; self-reviews are not reviews
  isDraft,
  source,                       // "command" | "scanned"
  lastSyncedAt
}
```

`owner/repo/number` is the identity used for deduplication.

`lastClaimedBy`/`claimClearedAt` and `syncPausedSince` exist because refresh
steps 3 and 5 both demand a marker the record had nowhere to store: nulling
`claimedBy` on a stale auto-clear erases the only evidence that the row was ever
claimed, which is what `previously claimed` renders from. **A new claim clears
both**, so a re-claimed row does not render `previously claimed` for the rest of
its life. `resolutionHistory` is what makes reopening non-destructive; see
Reopening a resolved record.

Every one of these fields is a latch, and **a latch with no reset is a
once-per-lifetime latch**. Each therefore names the transition that clears it:
`claimedBy`/`claimedAt` on resolve or stale-clear; `lastClaimedBy`/
`claimClearedAt` on a new claim; `syncPausedSince` on the first successful sync
of that record; `resolvedAt`/`resolvedBy` on reopen.

For a scanned record, `lastRequestedAt` is the **scanned message's** timestamp;
for a commanded one it is the submission time. `prAuthorLogin` exists so the exit
condition can discard a PR author's reviews of their own PR without needing a
Discord-to-GitHub identity map.

Meta state, alongside the digest message ID: `digestBodyHash` (what step 9's
write-skip compares against), `lastDailyPostDate` (so the daily post fires once a
day rather than every tick), and `unpinnedReportedAt` (so the unpinned warning is
reported once rather than every tick, as Failure modes requires).
`unpinnedReportedAt` is **cleared by any tick that observes the digest pinned** —
without that reset, a digest unpinned in week 1, reported, and re-pinned would be
unpinned again in week 6 to total silence, the list invisible while every tick
reports success.

`syncLease` and `digestBodyHash` live in the **same Durable Object as the
records**, not in KV: the lease needs an atomic take, and the hash must be
written by the same tick that wrote the message it describes. Only genuinely
independent values — the digest message ID, scan cursors, the cached PRD list,
`meta:lastSync` — are eligible for KV.

## Claiming and removal

Both live on the digest, because the digest is the one message the bot owns.

- **`Claim a PR ▾`** — a select menu listing open rows. Selecting one records the
  claim instantly and moves the row to **Being reviewed**. Selecting an already
  claimed row reports who holds it.
- **`Resolve ▾`** — removes a row without reviewing it: withdrawn, superseded,
  reviewed in a call, or a link someone pasted conversationally that was never a
  review request at all. Sets `resolvedAt` with the actor recorded. The same
  menu offers rows resolved within the last 24 hours as **`Reopen ▾`**, which
  clears `resolvedAt` (see Reopening a resolved record) — a row resolved by
  mistake is otherwise unrecoverable.
- **Unclaim** — selecting a row you already hold releases it.

Every selection is **revalidated against the store before it is applied**.
Components persist across message edits, so an option list is only as fresh as the
reader's client: selecting `Resolve` on a row the tick resolved 60 seconds ago
would overwrite `resolvedBy: "review by Katherine"` with a manual actor,
destroying the audit trail retention exists to provide. Each option value encodes
the record's `lastRequestedAt` so staleness is detectable; when the record's state
no longer matches what the option implied, the handler no-ops and explains why
ephemerally.

Without `Resolve`, casual links become permanent false rows: someone writing
"this regressed in #2695" would create an entry nobody can remove until that PR
merges. False rows are precisely what makes people stop reading a list, so a
removal path is a requirement, not a convenience.

A claim older than the stale threshold is cleared automatically by the refresh
loop and the row returns to its team section marked `previously claimed`. The
earlier design displayed ⚠️ beside the claimer's name in a permanently pinned
message; that is a public lateness board, and the rational response to it is to
stop claiming.

Select menus cap at 25 options. Past that, both menus are populated from **the
top 25 rows as the digest ranks them** — team, then urgency — and say so. They
must not be populated by oldest-first independently of the digest: with 30 open
rows the two orderings diverge, and they diverge in the worst direction. A 🔥
Blocking PR requested 90 minutes ago renders first in its team section but is one
of the newest rows, so an oldest-first menu would omit the single most urgent row
on the list, leaving it claimable only through the best-effort, budget-shed
reaction path — while a truncated 🧊 row that nobody can even see still occupies
a menu slot. The rule is that the visible set and the actionable set are the same
set: a row dropped by truncation is absent from the menus, and every rendered row
is actionable.

## Message scanning

The bot scans configured channels for GitHub PR links so the list reflects
reality even when nobody uses the command. This is what makes shadow-mode
rollout possible, and it stays enabled afterwards.

On each refresh, for each configured channel: read messages newer than
`scan:<channelId>`, extract allowlisted PR URLs, and create records with
`source: "scanned"`. On first run, look back 7 days rather than the whole
channel history. Reads are **paginated** — see Refresh loop step 6.

A scanned record's `lastRequestedAt` is **the scanned message's timestamp**, not
the time of the scan. This is what lets a scanned record ever satisfy the exit
condition: scan time is later than every review the PR already has, so seeding
from it would make each conversational mention inside the 7-day lookback a
permanent row that only merging clears. With the message timestamp, the exit
comparison runs at ingest and a scanned record whose review already happened is
**born resolved** — it never reaches the digest at all.

Scanned records have no team, urgency, PRD, or note, because nobody supplied
them. They render in a **Needs triage** section and are otherwise treated
identically — they expire on review, can be claimed from the digest menu, and
age the same way. (`General` is a team someone chose; `Needs triage` is the
absence of a choice. Two catch-alls with similar names would be read as the
same thing, so they are named differently on purpose.)

Known limits, accepted rather than solved:

- `GET /channels/{id}/messages` does not return messages inside threads, so a
  link posted in a thread under another message is not picked up.
- A message edited to add a link after the cursor has passed it is not picked up.
- The cursor advances only after records are durably written, so a tick that
  dies mid-run re-scans rather than skipping. Re-scanning is safe because
  identity is `owner/repo/number`.

The lookback on first run is **7 days**, not longer: shadow mode's first digest
sets the team's impression of whether this list is trustworthy, and a wall of
resurrected month-old PRs and conversational mentions would set it badly.

A scanned link matching a **resolved** record is ignored rather than reopening
it — conversational mentions of finished PRs are the common case, and see
Reopening a resolved record for why the explicit and implicit paths differ here.

Running `/review-request` on an already-scanned PR **upgrades the record in
place** rather than creating a duplicate: `source` becomes `"command"` and the
supplied fields are filled in. Identity is `owner/repo/number`, so the bot's own
request messages are skipped during scanning to avoid double-counting.

## Failure modes

- **GitHub unreachable or rate-limited.** Keep the last known state and change
  the footer to `last synced 40m ago`. A stale list must look stale; silently
  presenting old data as current is the one failure that would destroy trust in
  the list.
- **A repo becomes unreadable** (visibility change, revoked install). Its rows
  remain listed but stop auto-expiring, and are marked `sync paused`. An
  unreadable link is never a hard failure.
- **Digest message deleted.** Recreate it, post a short note asking someone to
  re-pin, and continue. Only the lease-holding tick may recreate it; an
  interactive handler that gets a 404 skips its immediate rewrite rather than
  posting a second digest.
- **Store data lost.** Rebuild by reading the bot's own past request messages in
  the configured channels, and by re-scanning the lookback window. This is a
  documented recovery path, not a normal one — and it is why records are retained
  for 30 days rather than deleted on resolve.
- **Request message deleted.** The record survives; the digest row stays but
  loses its link to a message. Claiming is unaffected, because the primary claim
  path is the select menu on the bot's own digest; only the best-effort reaction
  path depends on the request message existing.
- **Discord edit fails.** Log and retry on the next tick. Never crash the cron.
- **The digest is unpinned.** Detected by listing pins each tick. The bot cannot
  re-pin itself, so it reports the problem once — not every tick — and
  `/review-list` remains available meanwhile. "Once" means once *per unpinning*:
  `unpinnedReportedAt` is cleared by any tick that sees the digest pinned again,
  so a second unpinning weeks later is reported like the first.
- **A tick exceeds its subrequest or CPU budget.** Fail before writing partial
  state, leave `meta:lastSync` untouched so the stale banner appears, and shed
  the reaction-read budget first since it is the only optional work.
- **A requester or claimer leaves the server.** Render the stored display name
  rather than a mention that resolves to a raw ID.
- **Duplicate submissions / double-clicked button.** Idempotent by
  `owner/repo/number` and by claimer identity.

## Permissions and security

Discord bot permissions, restricted by channel overwrite to the review channels
plus read access to the PRD forum:

- Send Messages, Embed Links, Read Message History, View Channel.
- The **Message Content privileged intent**, enabled in the Developer Portal.
  This is not optional and not a gateway-only concern: without it
  `GET /channels/{id}/messages` returns `content: ""` for every message the bot
  did not author, so Message scanning silently extracts zero links and the whole
  of shadow mode reports an empty list. Self-serve below 100 guilds.

  Startup must assert it, and the assertion must be **falsifiable**. Checking for
  messages with non-empty `embeds` or `attachments` but empty `content` does not
  work: the intent gates `content`, `embeds`, `attachments`, `components` and
  `poll` by the *same* rule, so an ungated fetch returns `content: ""`,
  `embeds: []` and `attachments: []` together and the precondition never fires.
  The bot would report "no links found" and run a full sprint of shadow mode on
  an empty list — the exact indistinguishability the assertion was added to
  remove. Instead, read the application's own `flags` from
  `GET /applications/@me` and require `GATEWAY_MESSAGE_CONTENT` (or
  `GATEWAY_MESSAGE_CONTENT_LIMITED`), failing startup with `INTENT_MISSING` if
  neither is present. A message the **bot itself authored** is exempt from
  gating, so it also serves as a positive control alongside a non-self message if
  a runtime check is wanted.
- **Not** `PIN_MESSAGES` — the digest is pinned once by hand and thereafter only
  edited, and a bot editing its own message needs no additional permission.
  (Pinning was split out of Manage Messages into its own `PIN_MESSAGES`
  permission — announced in 2025 but **effective 12 January 2026** — with the
  routes moved to `PUT /channels/{id}/messages/pins/{message.id}` for pinning and
  `GET /channels/{id}/messages/pins` for listing. The older
  `GET /channels/{id}/pins` is deprecated, so the unpinned check must use the new
  route.)

The bot must be able to **list pins** (Read Message History) so it can detect
that its digest has been unpinned rather than editing an invisible message.

GitHub access is read-only in both credentials:

- **GitHub App** installed on the `paranext` org, "Pull requests: read", scoped
  to the allowlisted repos. Org-owned rather than tied to an individual account.
- **Public-read token** for public repos in other orgs. An authenticated token
  gets the full 5,000 requests/hour even limited to public data, and GraphQL
  requires authentication even for public repositories — so this cannot be
  replaced by unauthenticated requests.

Routing: owner is `paranext` → App installation token; otherwise → public token.

The bot posts titles of private-repo PRs into Discord. This is not new exposure —
it is exactly what team members paste by hand today — but it is a deliberate
choice worth recording.

## Hosting constraints

The hosting decision is **deliberately deferred**: the store sits behind an
interface `core/` never sees, so the choice reaches one adapter and nothing else.
It is not deferred out of indecision — it is deferred because the plan can be
built and most of it verified without knowing the answer.

What the deferral does *not* cover: two of the free plan's ceilings force
architectural choices rather than configuration, so the plan builds both to the
stricter shape, which is sound on any host.

- **One store entrypoint call per tick.** Cloudflare counts KV, D1 and Durable
  Object stub calls against the same 50-per-invocation subrequest ceiling as
  outbound `fetch`, so per-row store writes both blow the budget and let a tick
  die *mid-write* — contradicting "fail before writing partial state". The tick
  therefore does all reads and writes inside one object call (DO-internal
  `storage` operations do not count), with a stated invariant of **at most two
  store subrequests per tick regardless of record count**. This is better design
  on a conventional host too.
- **The immediate digest rewrite is flagged.** The 10 ms CPU limit applies to
  `/interactions`, not only to `scheduled()`, and the modal-submit path does
  signature verification, JSON parsing, a full render and an embed
  serialization — with `waitUntil` work drawing from the same budget. Exceeding it
  shows the user a spinner that never resolves and surfaces no error. With the
  flag off the handler writes and returns; the next tick renders.

The earlier estimate of ~45 tracked PRs per tick counted only GitHub and Discord
calls and is therefore optimistic; with the single-store-call invariant it is
roughly recovered. These constraints were measured against Cloudflare's free
plan:

- **CPU per scheduled invocation: 10 ms on the free plan** (30 s on paid).
  Network waiting does not count, but parsing a chunked GraphQL response,
  reaction payloads, and rendering the digest inside 10 ms is genuinely tight.
- **Subrequests per invocation: 50 on the free plan** (10,000 on paid), with no
  cron exemption. Every outbound call counts. This ceilings the refresh loop at
  roughly 45 tracked PRs per tick — and it fails exactly when the tool becomes
  popular. The reaction-read budget in refresh step 8 exists for this reason.
- **KV: 1,000 writes/day on the free plan**, each key counted separately, and one
  write per second per key. 288 cron ticks plus per-channel cursors leaves little
  headroom, which is why writes are skipped when nothing changed — and why the
  sync lease lives in the Durable Object rather than KV, since a lease is taken
  and released every tick regardless of whether anything changed and the
  write-skip cannot elide it. Durable Object writes are billed separately and are
  not charged against this ceiling.
- **KV is eventually consistent** — up to 60 seconds for a write to be visible
  in other locations — and offers no atomic operations. Nothing that requires
  read-modify-write or mutual exclusion may live there; see Data model.
- **Six simultaneous outbound connections**, so parallel fan-out serialises into
  waves of six. Harmless against a 15-minute wall clock, but do not expect
  parallelism to help.
- Discord's own rate limits are not the binding constraint: reaction reads for
  one channel share a bucket and the global bot allowance is 50 requests/second.
  The real hazard is the abuse ceiling — 10,000 invalid (401/403/429) responses
  in 10 minutes risks a temporary IP ban, so a bug that 403s on every tracked PR
  must fail closed rather than retry hot.
- GitHub is not a constraint: the batched GraphQL query costs 1 point against
  5,000 points/hour.

If the answer is a conventional container host, the CPU and subrequest ceilings
disappear and the store becomes an ordinary table; the module seams are drawn so
that this changes one adapter, and the immediate-rewrite flag turns on. If the
answer is Cloudflare, the **paid plan** is the recommendation — CPU 10 ms → 30 s
and subrequests 50 → 10,000 for $5/month lifts both ceilings above anything this
design approaches, and is cheaper than engineering around them.

## Monitoring

The list going quietly stale is the failure this design most needs to avoid, and
nothing so far detects it.

- `meta:lastSync` records the last successful tick. If it is older than 30
  minutes, the digest renders an explicit **stale** banner rather than a
  relative timestamp a reader has to interpret.
- A health endpoint reports last sync, open record count, and per-credential
  health (below), so a silent cron failure is discoverable without reading the
  channel.
- Credential health is reported per credential, because the two age differently.
  For the **GitHub App**: private key age and installation status — an installation
  token expires hourly and is minted on demand, so its expiry is not the signal
  that matters. For the **machine token**: an expiry date. A fine-grained token
  expiring mid-sprint with no warning is a predictable outage.
- A 401 from either credential is reported and **fails closed** for that
  credential group rather than retrying. See Refresh loop.

## `/review-list`

A read-only command rendering the same content ephemerally. Cheap, and it
decouples the tool's value from a pin the bot cannot restore itself.

## Testing

The pure core carries the test weight, since it holds everything that can be
subtly wrong:

- **Digest rendering** — snapshot tests: each team section, empty state, stale
  claims, character-limit truncation, omitted empty teams. Snapshots must be
  **time-independent**: a suite whose snapshots churn when the clock crosses an
  hour boundary is the same defect as a body that churns, and would hide it.
- **Reopening** — a re-request on a resolved record clears `resolvedAt` and the
  row reappears in the next digest; the prior resolution is preserved in
  `resolutionHistory`; `firstRequestedAt` is unchanged; a `Reopen ▾` selection
  does the same; a **scanned** link matching a resolved record does *not* reopen
  it. This is the regression test for the tombstone defect: reviewed →
  re-requested → listed is the design's primary workflow and must be asserted
  end to end, not per-step.
- **Latch resets** — for each of `resolvedAt`, `unpinnedReportedAt`,
  `lastClaimedBy`/`claimClearedAt` and `syncPausedSince`, assert both the set and
  the clear. A latch tested only in the set direction is how a once-only warning
  becomes once-per-lifetime.
- **Lost-update ordering** — a claim committed after a tick reads records but
  before it `PATCH`es must survive the tick's write. Drive it by interleaving the
  handler and the tick against the store, not by mocking the store away; the bug
  this catches lives precisely in the seam a mock would remove.
- **Menu population** — with more than 25 open rows, the menus contain exactly
  the rows the digest rendered, highest-urgency included, and no truncated row.
- **State transitions** — table-driven: for each combination of `state`,
  `merged`, newest-review-`submittedAt` relative to `lastRequestedAt`, and claim
  status, assert whether the record survives and which section it renders into.
  **Not** `reviewDecision` — the Exit condition forbids it and the refresh loop
  never requests it, so including it doubles the matrix with an input that has no
  code path.
- **URL parsing** — valid PR URLs, `/files` and `#discussion` suffixes, issue
  URLs, non-GitHub URLs, allowlist rejection.
- **Claim resolution** — menu and reaction producing identical state; the first
  claim the store sees wins and a reaction never supersedes an existing claim;
  unclaim; stale auto-clear returning a row to its team section marked
  `previously claimed`; a re-claim clearing `previously claimed`; and a reaction
  on a message that produced two records claiming **neither**.
- **Exit condition** — a `COMMENTED` review resolves a record; a review older
  than `lastRequestedAt` does not; a PR whose `reviewDecision` is null is
  unaffected (regression test for the original defect — the field is not read at
  all); merged and closed both resolve.
- **Partial GraphQL failures** — a batch with one `NOT_FOUND` alias marks that
  one `sync paused` and leaves every other record untouched.
- **Credential routing** — owner maps to the expected credential.
- **Review author filtering** — a bot review (both `[bot]` login and `Bot`
  `__typename`) does not resolve a record; a review by the PR's own author does
  not; a review with a null `submittedAt` does not; a review by anyone else does.
  Each needs its own row, because each closes a distinct permanent-drop loop.
- **Scanned-record seeding** — a scanned message about a PR reviewed last week
  produces a record that is born resolved and never renders; a scanned message
  about an unreviewed PR renders in **Needs triage**.
- **Stale banner renders on sync failure** — with step 2 failing, step 9 still
  produces a body, and that body carries the banner. This is the regression test
  for a banner that could previously never fire.
- **Scan pagination** — a channel with 250 new messages yields every link, and a
  tick that hits the page cap advances the cursor only to the oldest fully
  processed message.
- **Menu revalidation** — a `Resolve` selection against a record the tick already
  resolved no-ops and preserves the original `resolvedBy`.
- **Truncation with null urgency** — scanned rows rank below 🧊, and a
  shadow-mode list of 40 scanned rows truncates deterministically.
- **Daily post** — fires once per day when rows are open, not at all when none
  are, and not twice if two ticks straddle the configured time.
- **Recently cleared** — a row resolved within the window renders with the right
  actor and verb; one resolved outside it does not render.

Adapters are exercised against a stubbed `fetch`, asserting request shape rather
than live behavior. Vitest with **`@cloudflare/vitest-plugin`** (renamed from
`@cloudflare/vitest-pool-workers` in August 2026; `scheduled()` is directly
testable via `createScheduledController()`). Two known limitations to design
around: fake timers do not apply to the KV simulator, so stale-claim tests must
inject a clock rather than advance fake time; and coverage is Istanbul-only,
which the `core/` coverage gate must be configured for.

Continuous integration on every PR to this repo: typecheck, lint, unit tests, and
a **coverage gate on `core/`**. The pure core holds everything that can be
subtly wrong, so it carries a high bar; the thin adapters carry a lower one.
Unlike the product repos, this repo is ours, so CI here raises none of the
objections that ruled out per-repo automation.

Two additions that catch the failures unit tests cannot:

- **Recorded fixtures** of real GitHub and Discord responses, so an upstream
  payload change fails in CI rather than in the channel.
- **Read-only mode**, which runs the full refresh loop against live data and
  logs the message it would post without writing anything. This allows
  end-to-end exercise against real PRs with zero channel side effects.

The state-transition table test is exhaustive rather than representative: every
combination of open/merged/closed, newest review newer/older/absent relative to
`lastRequestedAt`, claimed/unclaimed, draft status, and **resolved/open** — the
last dimension being the one whose omission hid the tombstone defect — asserting
both survival and rendered section. That matrix is the product.

Manual smoke test before rollout: a scratch Discord server with
`wrangler dev --remote`, covering the full path — command, modal, post, button
claim, reaction claim, and auto-removal after a real review, followed by a
re-request on that same now-resolved PR to confirm it returns to the digest.
Startup must also be exercised **once with the Message Content intent disabled**,
asserting that it fails with `INTENT_MISSING` rather than reporting an empty
scan.

## Preview harness

Every render decision in this document was settled against a picture before any
credential existed, and one of them — the compact `3d` age form — turned out to be
impossible. That is the argument for building the harness early rather than after
the adapters.

It is nearly free, because the seams are already drawn: `core/` is pure, and the
digest is a pure function of `(records, lastSync, now)`. The harness is simply a
second consumer of that function, alongside the snapshot tests, and shares their
fixtures — so a render change that looks right in the preview and breaks a
snapshot fails in the same commit.

Three tiers, each answering a different question:

1. **Local HTML harness** (`npm run preview`) — imports `core/render`, feeds it
   the fixture record sets, and paints the output in Discord-accurate CSS.
   Fixtures are the Testing section's scenarios, which have to exist anyway:
   every team section populated, empty state, **Needs triage** as shadow mode
   actually looks, truncation past capacity, a stale claim, the stale banner, a
   🔥 row with its reason, **Recently cleared**, and the daily post. Also static
   mocks of the modal and the request message for label and hierarchy review.
   Zero Discord setup, zero credentials. This is where layout is iterated.
2. **Embed JSON dump** — the same command writes the raw embed payload. Pasted
   into a third-party embed renderer it is drawn by Discord's own rules, which
   catches what a CSS mock gets wrong: real wrapping, the real character budget,
   timestamp substitution. Still no bot and no server.
3. **Scratch server** — rollout stage 1. The only tier that can answer behavior:
   modal submission, menu selection, `<t:…:R>` resolving to a real relative time,
   `<#threadId>` resolving to a thread name, emoji size on a phone.

The split matters because tier 1 is persuasive and partial. It settles layout and
information hierarchy; it cannot settle anything about how Discord renders. Treat
every character count it produces as an estimate until tier 2 confirms it.

## Rollout

Staged, so the list has to earn trust before anyone is asked to change habits.

1. **Scratch server.** Full manual pass: command, modal, post, button claim,
   reaction claim, every rejection path, auto-removal after a real review.
2. **Shadow mode, one sprint.** The bot runs in the real review channel,
   scanning messages and maintaining the pinned list. The command stays
   disabled. Nobody changes anything about how they work.

   Be honest about what this does and does not validate. Every row is scanned,
   so every row lands in **Needs triage**: team grouping, urgency ordering and
   PRD rendering get **no** real-world exercise here, and team grouping is the
   primary design axis. Shadow mode validates the sync loop — the half that
   silently corrupts trust — and that is worth a sprint on its own. Grouping and
   the modal are validated in stage 1 on the scratch server.

   The question is narrow and falsifiable, with a threshold agreed in advance:
   *does the list stay accurate on its own?* Measured by logging every row still
   listed 30 minutes after a review landed, and every hand-posted PR that never
   appeared. **Two or more of either means fix before proceeding.** Jolie checks
   the log daily; without a named observer this stage measures nothing.

   That question is an engineering question, so every answer to it is actionable
   as a bug fix and none is "stop". One cheap addition makes the stage able to
   fail in a way that matters: **at sprint end, ask two teammates cold what the
   oldest thing waiting for review is.** If neither can answer, the delivery
   problem is real and the daily post must be working before the command is
   enabled. (A pre-code round of interviews was considered and deliberately
   skipped — the team's stated frustration is taken as sufficient evidence that
   the problem exists.)
3. **Command enabled.** Manual posting keeps working via scanning, so adoption
   can be gradual and nothing breaks for anyone who forgets.
4. **Command becomes the norm.** Scanning remains as the safety net.

Shadow mode is the important stage: it validates the tracking half — the half
that actually changes behavior — without requiring a single person to learn
anything.

## Documentation

Docs live in the repo and follow the conventions the team already uses.

- **README.md** — usable in 30 seconds: what the pinned list is, the command,
  the claim button, the `:code_review:` reaction. Written for a teammate, not a
  maintainer. It also carries a short **data policy**: what the store retains
  (request and claim timestamps, request counts, resolution history), for how long
  (30 days after resolution), and what it will not be used for. The store is one
  query from a per-person latency leaderboard whether or not v1 builds one, so
  saying so in writing is what makes "no review-time analytics" a promise about
  the data rather than about the roadmap.
- **docs/architecture.md** — the two entry points, the three module seams, and
  the data flow from command through the store to the digest. Enough that a
  newcomer can find
  where a given behavior lives.
- **docs/setup.md** — the runbook below, kept current with the real deployment.
- **docs/operations.md** — what to do when something breaks: digest message
  deleted, credential rotation, adding a repo, adding a team, restoring lost KV.
- **docs/architecture-decisions.md** — append-only `adr-<slug>` entries matching
  the format of `paranext-core`'s `.context/standards/Architecture-Decisions.md`,
  including a Context / Decision / alternatives-rejected template. The decisions
  in this spec are its first entries: no repo automation, any review removes an
  entry, two credentials routed by owner, embed rendering, scanning as a
  permanent fallback.

Comments in `core/` explain *why*, not *what* — the rendering and expiry rules
encode team decisions that are not self-evident from the code.

## Setup runbook

1. Create the Discord application; record app ID, public key, bot token.
2. Install to the server with scopes `bot` and `applications.commands`.
3. Apply channel permission overwrites limiting the bot to the review channels
   and the PRD forum.
4. Create and install the GitHub App on `paranext` for the allowlisted repos.
5. Create the public-read token.
6. Set Worker secrets; deploy; set the cron trigger.
7. Deploy in shadow mode, with the command not yet registered. Wait for the first
   refresh to post the digest, then pin that message by hand.
8. Register `/review-list` at deploy. Register `/review-request` only when
   moving past shadow mode. Registering the read-only command straight away is
   what makes it a real mitigation for a deleted or unpinned digest — during
   shadow mode the hand-pin is newest and most likely to be lost, and that is
   precisely when Failure modes claims `/review-list` is available.

## Decision log

Three rounds of independent adversarial review (platform correctness, product
behavior, scope and internal consistency) raised nine questions that changed the
design. All nine are decided. Corrections with one obviously right answer are
applied inline throughout; this section records the answers that were judgement
calls, and why — so a reader who disagrees knows what to argue with.

**1. Nothing delivered the digest.** Discord fires a pin notification once, at the
hand-pin; every later `PATCH` is silent. Meanwhile v1 retires the bump message,
the only part of the current process that *arrives*. Since tracking changes
behavior only if tracked state reaches a human eye, "no DM nudges" was removing
the delivery layer, not deferring a nicety. **Decided: one conditional daily
channel post** — counts, oldest age, jump link, only when something is waiting.
It names no individual, so it is not the per-person nudge the non-goals exclude.

**2. A scanned record could never satisfy the exit condition.** Seeding
`lastRequestedAt` from scan time made it later than every review the PR already
had. **Decided: seed from the scanned message's timestamp**, and resolve at
ingest — a scanned record whose review already happened is born resolved. See
Exit condition.

**3. Any bot review resolved the row before a human looked.** "Any review state
counts" carried no author filter, so Copilot at 10:01 cleared a 10:00 request, and
a re-request was re-dropped within one tick. **Decided: filter bot authors and the
PR's own author, and ignore null `submittedAt`.** Matching on the PR author rather
than the Discord requester avoids needing a Discord-to-GitHub identity map. See
Exit condition.

**4. The free plan was not viable as counted.** Store calls are subrequests, and
the 10 ms CPU limit applies to `/interactions` too. **Decided: defer the hosting
choice, and build to the stricter shape regardless** — one store entrypoint call
per tick with a stated two-subrequest invariant, and the immediate digest rewrite
behind a flag. Both are better design on any host. If the answer is Cloudflare,
the paid plan is the recommendation. See Hosting constraints.

**5. The stale banner could never render.** The `PATCH` was downstream of the
GitHub sync, so a tick that failed at sync never reached the renderer and readers
kept seeing a normal-looking list — the one failure Monitoring names as most
important to avoid. **Decided: the digest is a pure function of
`(records, lastSync, now)`**, and step 9 runs even when step 2 failed. A sync
failure aborts record mutation, not rendering.

**6. Mechanisms with no stated mechanism.** All five now have one: scan
pagination; hourly App-token minting, budgeted and failing closed on 401; menu
selections revalidated against the store with `lastRequestedAt` encoded in the
option value; null urgency ranked below 🧊 for truncation; PENDING reviews
ignored.

**7. The mechanisms that had to survive contact with people.** Five findings,
five decisions. The 🔥 reason **renders inline in the digest** — collected and
never displayed, it was ceremonial. 🧊 becomes **This week**, a commitment rather
than a request not to be reviewed. The **claim age comes off the render**, since
`Ira · 4d` beside a name in a permanent message was the lateness board the ⚠️ fix
had only relabelled. **`re-asked` comes off** too, and the README gains a data
policy. `Resolve` gains a **Recently cleared** line lasting an hour (later widened to a
day, see Configuration). The fifth
finding — that claiming is private cost for public benefit, so **Being reviewed**
may sit near-empty — is **accepted as a risk rather than fixed.** It is a
prediction about people, and shadow mode plus stage 3 will show whether it holds;
if the section is empty after a sprint of the command being live, claiming is the
first thing to cut.

**8. Scope.** Two reviewers independently found claiming, the PRD dropdown and
its thread cache, `note`, and `Resolve ▾` severable, and noted that duplicate
review is not among the problems Problem names. **Decided: build v1 as specced,
nothing severed** — with the honest note that each severable piece is now carrying
a risk rather than a requirement, and #7's prediction is the leading indicator for
the largest of them. The related finding *was* acted on: the rationale rejecting
GitHub Actions has been rewritten, because "a workflow in every repo" was false
and the separation of opening from requesting is the argument that survives.

**9. Shadow mode could not fail in a way that stopped the project.** **Decided:
add the cold-read test at sprint end** — ask two teammates what the oldest thing
waiting is; if neither can answer, the daily post must be working before the
command is enabled. The proposed pre-code interview round was **deliberately
skipped**: the team's stated frustration is taken as sufficient evidence that the
problem is real. This is a recorded risk, not an oversight — if the cold-read test
fails, this decision is the first place to look.

**10. `3d` was not a shape `<t:epoch:R>` can produce.** Found by the render proof
described under Preview harness, not by review. The digest example used compact
ages while a separate rule required relative timestamps; Discord has no compact
variant, so the two could not both hold. **Decided: long form**, keeping the
write-skip and accepting ~20–30 characters a row and roughly 20 rows of capacity.
The same exercise settled the **open-row count** definition and the
**Recently cleared** window.

## Open operational items

- **Hosting** — deferred by decision, not pending. The plan builds to the
  stricter of the candidate shapes, so this no longer blocks implementation; it
  affects one adapter and one config flag. See Hosting constraints.
- **A second owner.** Secrets, the Cloudflare (or equivalent) account, and
  `PIN_MESSAGES` in Discord must be held by at least two people, named in
  `docs/operations.md`. Otherwise the tool dies the first time its author is on
  leave and the digest gets deleted.
- **The public-read token must not be a personal PAT.** The GitHub App is
  org-owned; pairing it with a token on one person's account reintroduces exactly
  the dependency the App was chosen to avoid. Use a shared machine account, and
  record the expiry date in `docs/operations.md`.
- `scripture-utilities` needs its actual `owner/repo` confirmed before it can be
  added to the allowlist. If it is public, no new credential is needed.
- **One channel in v1.** Multi-channel is deferred: with a global record set and
  a per-channel digest it is undefined whether channel B shows channel A's rows,
  and either answer creates a problem (a PR claimable from two menus, or a PR
  invisible to its reviewers). Deciding this later costs nothing; guessing now
  costs a render signature and a dedup key.
- **The same PR needing two teams' review** currently collapses to one row,
  since identity is `owner/repo/number`. `General` is the workaround. Revisit
  only if it actually happens.
