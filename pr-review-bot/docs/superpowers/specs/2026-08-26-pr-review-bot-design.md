# PR Review Request Bot — Design

**Date:** 2026-08-26
**Status:** Revised after adversarial review and independent API fact-check.
Hosting decision pending team input.
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

A Discord bot with two halves:

- `/review-request` opens a modal (dropdowns plus the PR link) and posts a
  consistent, machine-generated request message in the channel.
- The bot maintains **one pinned "Needs review" message**, rewritten every five
  minutes, grouped by dev team. Entries leave the list automatically once the PR
  has actually been reviewed. Re-requesting replaces bumping.

## Non-goals

Deliberately excluded from v1:

- DM nudges or reminders.
- Per-person views ("PRs you have not reviewed").
- Review-time analytics or reporting.
- Writing anything to GitHub. All GitHub access is read-only.
- Forum posts per PR (considered and rejected as too heavyweight).
- Per-user GitHub OAuth.

## Key decisions

| Decision | Rationale |
|---|---|
| No repo automation; no GitHub Actions | Would require a workflow in every repo, and would push the team toward "opening a PR means ready for review". Opening a PR must stay separate from requesting review. |
| GitHub is read-only, keyed off the pasted URL | Works for any repo with no per-repo setup and no process change. |
| An entry leaves the list on **any** review, derived from review **events** | The list answers "has anyone picked this up yet", not "is this merged". Implemented as `reviews(...)` with `submittedAt` newer than the request — **not** `reviewDecision`, which is null on unprotected branches, never resets after a push, and ignores comment-only reviews. See Exit condition. |
| Records are **resolved, never deleted** | Deletion loses team, urgency, PRD, note and request history, makes re-requesting impossible to detect, and leaves no answer to "why did my row disappear". |
| Re-running `/review-request` re-lists a PR | After changes are requested and addressed, re-requesting is the bump — and it is a real signal rather than a "still needs eyes" message. Works only because exit is event-based; with `reviewDecision` a re-requested PR would be re-dropped within one tick, forever. |
| Grouped by dev team, urgency within | Simple and Power are separate dev teams. Most readers only care about their own team's rows, so team is the primary axis. |
| Urgency is always emoji **plus** words | The bot generates the text, so no one needs to decode a symbol from memory. This was the stated objection to the manual emoji convention. |
| Title, repo, and number come from GitHub | Nobody retypes what the PR already knows. |
| CODEOWNERS is ignored | Auto-assignment does not mean anyone intends to pick a PR up, so showing assignees would imply commitments nobody made. |
| Claiming happens from a **select menu on the digest** | A component cannot be attached to another user's message, so a button on the request message can never work for hand-posted PRs — and during shadow mode every row is hand-posted. A control on the bot's own pinned message works identically for both sources, is instant, and needs no per-message polling. The `:code_review:` reaction remains a best-effort secondary path with a per-tick read budget. |
| Claimed PRs move to a section, not off the list | An abandoned claim stays visible instead of silently vanishing. |
| A stale claim **auto-clears** rather than displaying a warning next to a name | A ⚠️ beside a person in a permanently pinned message is a public lateness board with no context for why they are stuck. The predictable adaptation is that people stop claiming, which destroys the data and makes the section look broken. Auto-clearing returns the PR to its team section where someone else can pick it up — which is the actual goal. |
| Records live in a **serialized store**, not a shared mutable KV value | KV has no compare-and-swap, is eventually consistent, and caps at one write per second per key. One array under one key, written by both the cron and interactive handlers, loses updates by construction: a claim can be silently erased by a concurrent sync, producing exactly the duplicate review the claim feature exists to prevent. |
| Blocking urgency requires a reason | Nothing otherwise caps 🔥, and the rational move for every requester is 🔥, which returns the urgency axis to carrying no information. A required note makes the claim visible and accountable at no process cost. |
| Explicit repo allowlist | A mispasted link fails loudly instead of becoming a permanent row. |
| Two GitHub credentials routed by owner | Private repos exist only in `paranext`, where an App can be installed. Everything else the team reviews is public, so a read-only public token covers other orgs with no admin approval there. |
| Cloudflare Workers | The command endpoint and scheduled refresh need no persistent socket. Free tier, no process to keep alive, no OS to patch. |
| The digest message is pinned once by hand | Editing its own message needs no extra permission, so the bot never needs Manage Messages. |
| The digest is an embed, not plain content | Plain message content caps at 2000 characters; an embed body allows 4096, and 6000 across embeds in one message. At roughly 90 characters per row that is ~45 rows before a second embed and ~65 before truncation is even possible, so truncation stops being a practical concern. |
| Channel history is scanned for PR links | Required for shadow-mode rollout, and worth keeping permanently: the list stays complete when someone posts a link by hand out of habit instead of using the command. |
| Validation errors carry a "Fix and retry" button | A modal submission cannot be answered with another modal, so without this a rejected link means retyping the whole form. |
| Docs follow the `paranext-core` ADR convention | `.context/standards/Architecture-Decisions.md` — an append-only log of `adr-<slug>` entries. Anyone arriving from the product repos recognises the format immediately. |

## Exit condition

This is the single most important rule in the design, and the first version of
this spec got it wrong. Everything the list is worth depends on rows leaving it
correctly.

**A record is resolved when GitHub reports a review event newer than the
record's most recent request**, or when the PR is merged or closed.

Query `reviews(last: 20) { submittedAt, state, author { login } }` and compare
`submittedAt` against `lastRequestedAt`. **Any** review state counts, including
`COMMENTED` — a reviewer who leaves fifteen line comments has unambiguously
looked.

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

A single Cloudflare Worker with two entry points:

- **`POST /interactions`** — all Discord interactions: the slash command, the
  modal submission, the claim button. Verifies Discord's Ed25519 signature
  against the app public key before doing anything else. No gateway connection.
- **`scheduled()`** — a cron trigger every five minutes: re-sync against GitHub,
  read reactions for unclaimed entries, rewrite the pinned message.

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
- **Urgency levels** — `🔥 Blocking`, `🫕 Soon`, `🧊 When there's time`.
- **Claim emoji** — `code_review:1075535230087221248`.
- **Stale-claim threshold** — 2 days.
- **Refresh interval** — 5 minutes.

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
     makes the note field required; nothing else caps its use.
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
     must not hide the new request in the Being reviewed section. It updates
     `lastRequestedAt` and increments `requestCount`, but **`firstRequestedAt` is
     never changed**: sorting is oldest-first, so resetting the age would push
     the honest re-requester *down* the list and penalise using the mechanism the
     design nominates as the replacement for bumping. The row renders both:
     `8d · re-asked 2h ago`.
5. Posts the request message in the channel, stores the record, and rewrites the
   pinned digest immediately rather than waiting for the next cron tick.

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
**Needs review** · 4 open · updated <relative timestamp>

__Power__
🔥 PT-4398 P10 backend sync-activity signal · 3d
     paratext-10-studio#177 · Trust PRD

__Simple__
🧊 PT-4363 Internet Settings UI Enhancements · 8d
     paranext-core#2695

**Being reviewed** (2)
👀 PT-3408 Collapse extra spaces in Find queries · Katherine · 2h
👀 PT-4325 Registration Needed Dot · Ira · 4d ⚠️
```

Rendering rules:

- Team sections in a fixed order: Power, Simple, General. A team with no open
  rows is omitted entirely.
- Within a team: urgency descending, then age descending (oldest first).
- Age is time since the request was posted, not since the PR was opened.
- Claimed entries move out of their team section into **Being reviewed**, showing
  claimer, claim age, and **the urgency and team they came from** — a lead
  scanning for what is blocking Power must still see it once it is claimed.
- The "updated" footer uses a Discord relative timestamp, so it stays accurate
  between edits without the bot rewriting the message.
- Empty state: `**Needs review** · nothing waiting 🎉`.
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
- When capacity is exhausted, rows are dropped lowest-urgency and most-recently
  requested first, with `…and N more` appended. Truncation must never be silent:
  a list that looks complete when it is not is worse than no list.
- Section order is fixed: team sections, then **Needs triage** (entries with no
  team, see Message scanning), then **Being reviewed**.
- A row shows `re-asked Nh ago` when `requestCount > 1`.

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
6. Scan configured channels for new PR links (see Message scanning).
7. Refresh the cached PRD thread list.
8. Read `:code_review:` reactions for unclaimed records, **up to a fixed
   per-tick budget**, oldest-unchecked first. This is a secondary path; the
   digest select menu is primary.
9. Render the digest and `PATCH` it — only if the rendered body excluding the
   timestamp line has changed, so an idle team costs no writes.

Claims made through the digest select menu are applied at interaction time and
appear immediately. Reaction claims carry up to one refresh interval of lag.
Where a reaction and a menu claim conflict, the **earlier** timestamp wins and
the superseded claimer is told privately — the person who acted first must not
lose silently, which was a defect in the first version of this design.

## Data model

All mutable record state lives in a **single serialized store** so that
concurrent writes cannot lose each other. On Cloudflare that is one Durable
Object; on a conventional host it is one table with per-row writes. The store is
an adapter behind an interface — `core/` never sees it — so the hosting decision
does not reach the logic.

What must never happen: a read-modify-write of a shared value from both the cron
and an interactive handler. A claim applied at 10:04:50 must not be erased by a
sync that read a stale copy at 10:05:00.

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
  resolvedAt, resolvedBy,       // null while open; retained 30 days
  title,                        // cached from GitHub for rendering
  isDraft,
  source,                       // "command" | "scanned"
  lastSyncedAt
}
```

`owner/repo/number` is the identity used for deduplication.

## Claiming and removal

Both live on the digest, because the digest is the one message the bot owns.

- **`Claim a PR ▾`** — a select menu listing open rows. Selecting one records the
  claim instantly and moves the row to **Being reviewed**. Selecting an already
  claimed row reports who holds it.
- **`Resolve ▾`** — removes a row without reviewing it: withdrawn, superseded,
  reviewed in a call, or a link someone pasted conversationally that was never a
  review request at all. Sets `resolvedAt` with the actor recorded.
- **Unclaim** — selecting a row you already hold releases it.

Without `Resolve`, casual links become permanent false rows: someone writing
"this regressed in #2695" would create an entry nobody can remove until that PR
merges. False rows are precisely what makes people stop reading a list, so a
removal path is a requirement, not a convenience.

A claim older than the stale threshold is cleared automatically by the refresh
loop and the row returns to its team section marked `previously claimed`. The
earlier design displayed ⚠️ beside the claimer's name in a permanently pinned
message; that is a public lateness board, and the rational response to it is to
stop claiming.

Select menus cap at 25 options. Past that, the menus list the oldest 25 open
rows and say so.

## Message scanning

The bot scans configured channels for GitHub PR links so the list reflects
reality even when nobody uses the command. This is what makes shadow-mode
rollout possible, and it stays enabled afterwards.

On each refresh, for each configured channel: read messages newer than
`scan:<channelId>`, extract allowlisted PR URLs, and create records with
`source: "scanned"`. On first run, look back 14 days rather than the whole
channel history.

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
  re-pin, and continue.
- **KV data lost.** Rebuild by reading the bot's own past request messages in the
  configured channels. This is a documented recovery path, not a normal one.
- **Request message deleted.** The record survives; the digest row stays but
  loses its link to a message, and claims for it can only come from the button.
- **Discord edit fails.** Log and retry on the next tick. Never crash the cron.
- **The digest is unpinned.** Detected by listing pins each tick. The bot cannot
  re-pin itself, so it reports the problem once — not every tick — and
  `/review-list` remains available meanwhile.
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
- **Not** `PIN_MESSAGES` — the digest is pinned once by hand and thereafter only
  edited, and a bot editing its own message needs no additional permission.
  (Pinning was split out of Manage Messages into its own `PIN_MESSAGES`
  permission in August 2025, with the route moved to
  `PUT /channels/{id}/messages/pins/{message.id}`.)

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

The hosting decision is open pending team input. These constraints apply
wherever it lands, and were measured against Cloudflare's free plan:

- **CPU per scheduled invocation: 10 ms on the free plan** (30 s on paid).
  Network waiting does not count, but parsing a chunked GraphQL response,
  reaction payloads, and rendering the digest inside 10 ms is genuinely tight.
- **Subrequests per invocation: 50 on the free plan** (10,000 on paid), with no
  cron exemption. Every outbound call counts. This ceilings the refresh loop at
  roughly 45 tracked PRs per tick — and it fails exactly when the tool becomes
  popular. The reaction-read budget in refresh step 8 exists for this reason.
- **KV: 1,000 writes/day on the free plan**, each key counted separately, and one
  write per second per key. 288 cron ticks plus per-channel cursors leaves little
  headroom, which is why writes are skipped when nothing changed.
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
that this changes one adapter.

## Monitoring

The list going quietly stale is the failure this design most needs to avoid, and
nothing so far detects it.

- `meta:lastSync` records the last successful tick. If it is older than 30
  minutes, the digest renders an explicit **stale** banner rather than a
  relative timestamp a reader has to interpret.
- A health endpoint reports last sync, open record count, and credential expiry
  dates, so a silent cron failure is discoverable without reading the channel.
- Credential expiry is logged at startup. A fine-grained token expiring
  mid-sprint with no warning is a predictable outage.

## `/review-list`

A read-only command rendering the same content ephemerally. Cheap, and it
decouples the tool's value from a pin the bot cannot restore itself.

## Testing

The pure core carries the test weight, since it holds everything that can be
subtly wrong:

- **Digest rendering** — snapshot tests: each team section, empty state, stale
  claims, character-limit truncation, omitted empty teams.
- **State transitions** — table-driven: for each combination of `state`,
  `merged`, `reviewDecision`, and claim status, assert whether the record
  survives and which section it renders into.
- **URL parsing** — valid PR URLs, `/files` and `#discussion` suffixes, issue
  URLs, non-GitHub URLs, allowlist rejection.
- **Claim resolution** — menu and reaction producing identical state; the
  earlier timestamp wins across both paths; unclaim; stale auto-clear returning a
  row to its team section.
- **Exit condition** — a `COMMENTED` review resolves a record; a review older
  than `lastRequestedAt` does not; a null-`reviewDecision` PR is unaffected
  (regression test for the original defect); merged and closed both resolve.
- **Partial GraphQL failures** — a batch with one `NOT_FOUND` alias marks that
  one `sync paused` and leaves every other record untouched.
- **Credential routing** — owner maps to the expected credential.

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
combination of open/merged/closed, review decision, claimed/unclaimed, and draft
status, asserting both survival and rendered section. That matrix is the product.

Manual smoke test before rollout: a scratch Discord server with
`wrangler dev --remote`, covering the full path — command, modal, post, button
claim, reaction claim, and auto-removal after a real review.

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
  maintainer.
- **docs/architecture.md** — the two entry points, the three module seams, and
  the data flow from command to KV to digest. Enough that a newcomer can find
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
8. Register the guild-scoped command only when moving past shadow mode.

## Open operational items

- **Hosting** — pending team input. See Hosting constraints. This is the only
  open item that blocks implementation, and it affects one adapter.
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
