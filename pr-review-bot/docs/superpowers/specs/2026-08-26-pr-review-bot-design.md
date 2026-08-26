# PR Review Request Bot — Design

**Date:** 2026-08-26
**Status:** Approved for implementation planning
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
| An entry leaves the list on **any** review | Approved or changes-requested both mean a human has looked. The list answers "has anyone picked this up yet", not "is this merged". |
| Re-running `/review-request` re-lists a PR | After changes are requested and addressed, re-requesting is the bump — and it is a real signal rather than a "still needs eyes" message. |
| Grouped by dev team, urgency within | Simple and Power are separate dev teams. Most readers only care about their own team's rows, so team is the primary axis. |
| Urgency is always emoji **plus** words | The bot generates the text, so no one needs to decode a symbol from memory. This was the stated objection to the manual emoji convention. |
| Title, repo, and number come from GitHub | Nobody retypes what the PR already knows. |
| CODEOWNERS is ignored | Auto-assignment does not mean anyone intends to pick a PR up, so showing assignees would imply commitments nobody made. |
| Claims tracked from a button **and** the `:code_review:` reaction | The reaction is the team's existing habit and keeps working. The button gives instant feedback, closing the window where two people claim the same PR during the refresh interval. |
| Claimed PRs move to a section, not off the list | An abandoned claim stays visible instead of silently vanishing. |
| Explicit repo allowlist | A mispasted link fails loudly instead of becoming a permanent row. |
| Two GitHub credentials routed by owner | Private repos exist only in `paranext`, where an App can be installed. Everything else the team reviews is public, so a read-only public token covers other orgs with no admin approval there. |
| Cloudflare Workers | The command endpoint and scheduled refresh need no persistent socket. Free tier, no process to keep alive, no OS to patch. |
| The digest message is pinned once by hand | Editing its own message needs no extra permission, so the bot never needs Manage Messages. |
| The digest is an embed, not plain content | Plain message content caps at 2000 characters; an embed body allows 4096, and 6000 across embeds in one message. At roughly 90 characters per row that is ~45 rows before a second embed and ~65 before truncation is even possible, so truncation stops being a practical concern. |
| Channel history is scanned for PR links | Required for shadow-mode rollout, and worth keeping permanently: the list stays complete when someone posts a link by hand out of habit instead of using the command. |
| Validation errors carry a "Fix and retry" button | A modal submission cannot be answered with another modal, so without this a rejected link means retyping the whole form. |
| Docs follow the `paranext-core` ADR convention | `.context/standards/Architecture-Decisions.md` — an append-only log of `adr-<slug>` entries. Anyone arriving from the product repos recognises the format immediately. |

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
2. The bot responds **immediately** with a modal — no GitHub or Discord lookups
   first, so it cannot breach Discord's 3-second initial-response limit. The PRD
   dropdown is built from the forum thread list, which is fetched at this point;
   if that fetch fails or is slow, the modal still opens with PRD options
   omitted rather than failing the command.
3. Modal fields:
   - **PR link** — short text, required.
   - **Team** — select: Power / Simple / General.
   - **Urgency** — select: the three configured levels.
   - **PRD** — select, built from active threads in the PRD forum, plus "None".
     Capped at 25 options (a Discord limit); if there are more active threads,
     the 25 most recently active are shown and the omission is noted in the
     modal's PRD label.
   - **Note** — short text, optional. Preserves the extra context people add
     today ("just the CSS bit", "needs a P10 build").
4. On submit the bot defers with an ephemeral acknowledgement, then:
   - Parses the URL. Rejects anything that is not a GitHub PR URL.
   - Rejects repos not on the allowlist, naming the repo and saying how to add it.
   - Fetches the PR. Rejects if it does not exist or is not visible.
   - If the PR is merged or closed, rejects with that reason.
   - If the PR is a draft, posts anyway but marks the row `draft` — a draft PR
     can legitimately want early feedback, so this is a note, not a block.
   - **If this PR is already tracked, updates the existing record** (new urgency,
     team, PRD, note) rather than creating a second entry, and says so privately.
     Re-requesting **resets the age** and **clears any existing claim** — it is a
     fresh ask, and a claim on the previous round should not silently hide the
     new request in the Being reviewed section.
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
  claimer and claim age, with ⚠️ past the stale-claim threshold.
- The "updated" footer uses a Discord relative timestamp, so it stays accurate
  between edits without the bot rewriting the message.
- Empty state: `**Needs review** · nothing waiting 🎉`.
- Each title links to its PR.
- A draft PR renders with a `draft` marker after its age.
- Rendered as an embed body (4096 characters). Past that, **Being reviewed**
  moves to a second embed in the same message (6000 characters total).
- Only if both are exhausted — roughly 65 rows — are rows dropped: lowest
  urgency and most recently requested first, with `…and N more` appended.
  Truncation must never be silent, because a list that looks complete when it
  is not is worse than no list.
- Section order is fixed: team sections, then **Unsorted** (entries with no team,
  see Message scanning), then **Being reviewed**.

## Refresh loop

Every five minutes:

1. Load all records from KV.
2. One batched GraphQL query per credential group, requesting `state`,
   `isDraft`, `merged`, `reviewDecision`, `title`, and `number` for every
   tracked PR.
3. Drop records where the PR is merged, closed, `APPROVED`, or
   `CHANGES_REQUESTED`. Keep only `REVIEW_REQUIRED`.
4. For records still unclaimed, read reactions on the request message and
   resolve any `:code_review:` reaction into a claim (earliest reactor wins).
   Claimed records skip this call.
5. Render and `PATCH` the digest message. Skip the edit entirely if the rendered
   text is unchanged, to avoid needless API calls.

Button claims write to KV directly at interaction time, so they appear
immediately rather than at the next tick. Reaction-based claims carry up to one
refresh interval of lag; this is the accepted cost of preserving the existing
habit.

## Data model

KV keys:

- `digest:<channelId>` → the digest message ID.
- `scan:<channelId>` → the last message ID scanned in that channel.
- `requests` → array of records:

```
{
  owner, repo, number,          // identity, from the URL
  channelId, messageId,         // the request message
  team, urgency, prdThreadId, note,
  requesterId, requestedAt,
  claimedBy, claimedAt,         // null when unclaimed
  title,                        // cached from GitHub for rendering
  isDraft,
  source,                       // "command" | "scanned"
  lastSyncedAt
}
```

`owner/repo/number` is the identity used for deduplication.

## Message scanning

The bot scans configured channels for GitHub PR links so the list reflects
reality even when nobody uses the command. This is what makes shadow-mode
rollout possible, and it stays enabled afterwards.

On each refresh, for each configured channel: read messages newer than
`scan:<channelId>`, extract allowlisted PR URLs, and create records with
`source: "scanned"`. On first run, look back 14 days rather than the whole
channel history.

Scanned records have no team, urgency, PRD, or note, because nobody supplied
them. They render in an **Unsorted** section and are otherwise treated
identically — they expire on review, can be claimed, and age the same way.

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
- **Duplicate submissions / double-clicked button.** Idempotent by
  `owner/repo/number` and by claimer identity.

## Permissions and security

Discord bot permissions, restricted by channel overwrite to the review channels
plus read access to the PRD forum:

- Send Messages, Embed Links, Read Message History, View Channel.
- **Not** Manage Messages — the digest is pinned once by hand and thereafter only
  edited, which needs no extra permission.

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
- **Claim resolution** — button and reaction producing identical state; earliest
  reactor wins; unclaim.
- **Credential routing** — owner maps to the expected credential.

Adapters are exercised against a stubbed `fetch`, asserting request shape rather
than live behavior. Vitest with `@cloudflare/vitest-pool-workers`.

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
   disabled. Nobody changes anything about how they work. The question being
   answered is narrow and falsifiable: *does the list stay accurate on its own?*
   Rows that linger after review, or PRs that never appear, are bugs to fix
   before proceeding.
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

Neither blocks implementation:

- `scripture-utilities` needs its actual `owner/repo` confirmed before it can be
  added to the allowlist. If it is public, no new credential is needed.
- Whether the digest also belongs in a second channel, or only the one.
