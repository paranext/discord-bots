# Architecture Decisions

Append-only. Each entry is `adr-<slug>` with Context / Decision / Alternatives
rejected, matching the convention used in `paranext-core`'s
`.context/standards/Architecture-Decisions.md`. Do not edit or delete past
entries — if a decision changes, add a new entry that supersedes it and says
so.

## adr-no-repo-automation

**Context.** The team requests code review today by posting a PR link in
Discord. The obvious "modernize this" move is repo-side automation — a
GitHub Action or workflow that fires on PR open and posts to Discord
automatically, removing the manual posting step entirely.

An earlier draft of this design rejected that on the grounds that it "would
require a workflow in every repo." **That rationale is false**, and is
recorded here explicitly so nobody re-derives it and reintroduces the idea on
the strength of a refutation that doesn't hold: a search-based digest
(exactly what this bot's message-scanning fallback already is) could in
principle run from a single repo the team owns, watching all the others via
the GitHub API, with zero workflow files added to any product repo. The
"per-repo maintenance burden" argument does not actually block this.

**Decision.** Keep opening a PR and requesting review as two separate,
independent actions. No GitHub Actions, no repo-side webhook, no automatic
posting on PR open — the bot only reacts to a human choosing to post a link
or run `/review-request`.

The real argument: collapsing "PR opened" and "review requested" into one
event is wrong on its own terms, independent of implementation cost. A PR
can be opened long before it's ready for review (see the `isDraft` handling
throughout this codebase — a draft renders with a `draft` marker rather than
being excluded, precisely because "opened" and "wants eyes on it" are
different moments). Auto-posting on open would either spam the channel with
premature requests or require guessing at draft-vs-ready heuristics that
GitHub's own API doesn't reliably encode as "this is the review-request
moment."

**Alternatives rejected.**
- *A GitHub Action that posts on PR open, in every product repo* — rejected
  both because it collapses two distinct events (opening, requesting review)
  into one, and because a search-based alternative already removes the
  "one workflow per repo" cost that was the original stated reason.
- *A label-based trigger* (e.g., adding a `ready-for-review` label posts to
  Discord) — a metadata convention with more friction than a dropdown and no
  generated message text, and this exact team already tried and abandoned
  one metadata convention (an ad-hoc emoji urgency scheme) for the same
  reason: nobody reliably remembers to apply it, or what it means.

## adr-exit-condition

**Context.** The single most important rule in this design: a row must leave
the digest exactly when — and only when — a human has actually looked at the
PR. Get this wrong in either direction and the whole tool loses trust: too
eager, and reviewed PRs vanish before anyone reviewed them (or, worse,
unreviewed PRs vanish); too conservative, and reviewed PRs sit on the list
forever, training people to ignore it.

GitHub's `reviewDecision` field looks like the obvious signal and is wrong
for this design in three independent ways: it is `null` whenever the branch
isn't protected and nothing has explicitly requested review — which,
because this design deliberately never writes to GitHub and ignores
CODEOWNERS, is the *common* case, not an edge case; it never resets to
`REVIEW_REQUIRED` after the author pushes fixes following a changes-requested
review, so a re-requested PR (this design's replacement for "bumping") would
be re-dropped within one tick, permanently; and it ignores `COMMENTED`
reviews entirely, even though a reviewer leaving fifteen line comments has
unambiguously looked at the code.

**Decision.** Query `reviews(last: 20) { submittedAt, state, author { login,
__typename } }` directly and compare each review's `submittedAt` against the
record's `lastRequestedAt` (`src/core/exit.ts`, `countsAsReview` /
`exitVerdict`). **Any** review state counts, including `COMMENTED` — a
reviewer who commented has looked, full stop. Three filters apply before the
comparison, each closing a distinct permanent-drop loop that a naive "any
review counts" rule would otherwise reopen:

1. **Bot reviews do not count** (`authorIsBot`, or a login ending in
   `[bot]`). Copilot code review and CodeRabbit submit real
   `PullRequestReview` objects; without this filter, a request at 10:00
   followed by an automated review at 10:01 clears the row at 10:05, and a
   re-request is re-dropped within one tick — the same failure mode this ADR
   opens with, re-entered through a different door.
2. **The PR author's own reviews do not count.** Matched via
   `record.prAuthorLogin` (cached from GitHub, not the Discord requester —
   there is no Discord-to-GitHub identity map, and this doesn't need one).
   An author leaving line comments on their own PR through the review flow
   produces the same object type as a real review and would clear the row
   the same way.
3. **A review with a null `submittedAt` is ignored.** That's a `PENDING`
   review — unsubmitted line comments visible only to their own author.
   Nobody has looked yet, from the outside.

**Verification against real data.** Task 4's implementation was checked
against GitHub's own documentation and against ~30 real PRs each in
`paranext/paranext-core` and `eten-tech-foundation/scripture-editors` before
this rule was trusted. Findings:

- `submittedAt` is present and ISO-8601 on every submitted review;
  `author.__typename` is `"User"` for humans.
- A PR with zero reviews returns `reviews.nodes: []` (empty array, never
  `null`) — no special-casing needed for "no reviews yet."
- A merged PR always carries `state: "MERGED"` alongside `merged: true`.
- `scripture-editors` (public, outside `paranext`) is fully readable with no
  special credential, confirming the public-token routing assumption below.
- **`COMMENTED` is the single most common review state in real activity** —
  48 of 68 review events in `paranext-core`, 42 of 81 in `scripture-editors`.
  This is direct evidence, not just theory, that `reviewDecision` (which
  ignores `COMMENTED`) would have silently discarded the majority of real
  review activity.
- No bot review and no null-`submittedAt` review turned up in either
  sample's last 30 PRs — filters 1 and 3 above are exercised only by unit
  tests, not by this live sample; they remain necessary (bot reviewers are
  in active use on both repos generally) but weren't caught in the act
  during this particular verification window.
- **New finding, not anticipated by the original test plan:** a `DISMISSED`
  review state appears in real data (4 events in `scripture-editors`).
  `countsAsReview` ignores `state` entirely by construction — it only looks
  at `submittedAt`, bot-ness, and authorship — so `DISMISSED` already counted
  correctly with no code change. A regression test was added asserting this,
  so a future change that starts switching on `state` cannot silently break
  it without a failing test.

**Alternatives rejected.**
- *`reviewDecision`* — see above; three independent, confirmed failure modes.
- *Filtering by CODEOWNERS-assigned reviewers only* — rejected at the design
  level (see the design spec's Key decisions table): auto-assignment doesn't
  mean anyone intends to pick a PR up, so showing that as "assigned" would
  imply commitments nobody made.
- *A Discord-to-GitHub identity map*, to filter self-reviews by the actual
  Discord requester rather than the PR's GitHub author — rejected as
  unnecessary complexity; matching on the PR's own author (which the query
  already returns) covers the real case (an author reviewing their own PR)
  without needing to solve identity linking at all.

## adr-two-github-credentials

**Context.** This bot needs read access to PRs across two categories of
repo: private repos that exist only under the `paranext` GitHub org, and
public repos elsewhere (currently `eten-tech-foundation/scripture-editors`).
A single credential covering both would either need broad org-level access
outside `paranext` (unnecessary and a bigger blast radius than the read-only
need justifies) or would have to be a personal access token tied to one
person's GitHub account for everything.

**Decision.** Two credentials, routed by owner (`src/github/credentials.ts`,
`routeOwner`): a **GitHub App** installed on the `paranext` org with
"Pull requests: read" only, scoped to the allowlisted repos, used for
anything under `paranext`; a **public-read token**, on a shared machine
account rather than a personal one, for everything else. GraphQL requires
authentication even for fully public repositories (there's no
unauthenticated GraphQL path), and an authenticated token gets the full
5,000 requests/hour rate limit even when scoped to public data only — so
this can't be simplified to unauthenticated requests for the public side.

**Alternatives rejected.**
- *One GitHub App covering everything* — an App can only be installed by an
  org or user that owns the repos in question; it cannot cover repos outside
  `paranext` without asking every other org/owner to install it, which is
  exactly the "per-repo setup and process change" this design otherwise
  avoids.
- *A personal access token for the `paranext` side too* — rejected because
  it's tied to one person's account and access; org-owned App installs
  don't have that single point of failure, and `paranext` is exactly where
  the private-repo access lives, so it's the side where this matters most.
- *A personal access token for the public side* — explicitly rejected (see
  `docs/setup.md` step 8 and `docs/operations.md`): pairing the org-owned App
  with a personally-owned token elsewhere reintroduces the same dependency
  the App was chosen to avoid, just on the other credential.

**Amendment (2026-11-03).** The App is installed on **all** `paranext`
repositories, not an allowlisted subset: there is no repo allowlist any more
(see `adr-command-only-requests`). The routing is unchanged — `routeOwner`
sends `paranext` to the App and every other owner to the public token — and the
installation token is minted without a `repositories` list, so the wider
install needed no code change.

## adr-embed-rendering

**Context.** The digest needs to fit as many rows as practically possible in
one Discord message, since a truncated digest that silently drops rows is
the direction this design must never lie in.

**Decision.** Render the digest as an embed **description**, not plain
message content. Plain content caps at 2000 characters; a single embed
description allows 4096, and Discord allows up to 6000 characters total
across all embeds in one message — so the digest spills into a second embed
(`src/core/render/digest.ts`, `fitSecondEmbed`) when the first fills up,
rather than truncating immediately at 4096.

The capacity numbers, worked through in the design spec and confirmed by the
renderer's actual output: a real row costs roughly 150–180 characters once
titles are rendered as markdown links and PRDs as `<#thread>` mentions — so
naive character-budget math (`4096 / ~30 chars per row ≈ 130 rows`) is wildly
optimistic. Practical capacity is closer to **20–25 rows per embed**
(`DEFAULT_MAX_ROWS = 20` in `src/core/render/digest.ts`), and truncation past
that is a real path the renderer actively handles (dropping lowest-urgency,
most-recently-requested rows first, and always appending an explicit
"…and N more" notice — see `overflowNotice`), not a theoretical one that
never fires.

**The long-form-timestamp consequence.** Ages render as Discord relative
timestamps (`<t:epoch:R>` → "3 days ago"), which Discord renders itself and
keeps accurate without the bot re-editing the message. Discord offers no
compact variant of this — no way to get `3d` instead of `3 days ago` through
the timestamp markup — so the long form costs an extra 20–30 characters per
row versus the compact form an earlier draft assumed was achievable. That
extra cost is what lowers practical embed capacity from a hoped-for ~25 rows
to the actual ~20 configured as `DEFAULT_MAX_ROWS`. See `adr-long-form-
timestamps` below for why the long form was chosen anyway despite this cost.

**Alternatives rejected.**
- *Plain message content, truncated hard at 2000 characters* — roughly
  halves available capacity for no benefit; embeds cost nothing extra to
  send and are what Discord expects a bot's structured content to look like.
- *Multiple messages instead of a second embed* — a second message can't be
  pinned alongside the first in any way that reads as "one list," and
  doubles the edit surface (two messages to keep in sync, two places a
  `PATCH` can fail independently).

**Amendment (2026-10-12).** PRDs are no longer rendered — the field was removed
when the bot moved to the public server only — so rows no longer carry
`<#thread>` mentions. The per-row cost above is now an upper estimate; the
decision and `DEFAULT_MAX_ROWS` are unchanged.

## adr-scanning-as-permanent-fallback

**Context.** Channel scanning — reading recent messages for GitHub PR links
and creating records from them (`src/discord/scan.ts`) — exists in the first
place to make shadow-mode rollout possible: it lets the digest reflect
reality with zero change to how anyone works, before `/review-request` is
enabled or even built.

**Decision.** Scanning does not turn off once `/review-request` ships. It
stays on permanently, alongside the command, indefinitely.

The reasoning holds independent of rollout: someone will always occasionally
paste a PR link out of habit instead of running the command — muscle memory,
a quick "hey can someone glance at this," a message composed on mobile where
a slash command is more friction than typing a URL. Without permanent
scanning, those PRs would silently never appear on the list, which is
exactly the kind of gap that erodes trust in a tracking tool: it looks
complete but sometimes isn't, and nothing tells you which case you're in.
Running `/review-request` on an already-scanned PR upgrades the record in
place (`source` becomes `"command"`) rather than creating a duplicate, so the
two paths coexist cleanly on the same identity (`owner/repo/number`).

**Alternatives rejected.**
- *Scanning only during shadow mode, disabled once the command ships* —
  rejected because it reintroduces exactly the silent-gap failure mode
  described above the moment anyone forgets to use the command, which will
  happen regularly in any team of nontrivial size.
- *Scanning as the only mechanism, no command at all* — rejected because
  scanning alone provides no way to specify team, urgency, PRD, or a
  blocking reason; those need an explicit form. Scanned rows deliberately
  render into their own **Needs triage** section for exactly this reason.

**Amendment (2026-11-03).** Superseded by `adr-command-only-requests`. The
scan, the allowlist it relied on, and shadow mode are gone, and the scanned
records were deleted in schema version 6.

## adr-command-only-requests

**Context.** The team wants to send a PR from any repo to the review channel,
not only `paranext` ones (an upstream library, `eten-tech-foundation`, a
contributor's fork), without anyone editing code or redeploying when a repo is
added. The hand-kept `repoAllowlist` blocked that. It also did one useful job:
it kept the channel scan from turning every PR link mentioned in conversation
into a digest row. People do talk about PRs in the review channel without
asking for a review, so dropping the allowlist while keeping the scan would
fill the digest with rows nobody asked for.

**Decision.** No repo or org allowlist, no channel scan, no read-only (shadow)
mode. `/review-request` is the only way a PR gets onto the digest, and it
accepts a PR from any owner. Its other checks stay: the form checks and, at
submit, the GitHub lookup (`not-found`, `credential`, `merged`, `closed`). A
side effect is that the bot never reads message content, so the Message
Content privileged intent and its runtime check are removed. Read Message
History stays, because the pin check gets no pins without it. Without a scan
there is nothing for shadow mode to trial, so it goes too and both commands
register from the first deploy.

**Consequence.** A link pasted out of habit is silently not tracked. That is
handled by telling people, not by code: the channel topic or a pinned message
says "Use `/review-request` to ask for a review. Pasted links aren't tracked."
(`docs/setup.md` step 15). A PR the bot can't read, such as a typo or a private
repo outside `paranext`, is refused at submit rather than becoming a row that
never updates.

Any member of the Discord server can put any `paranext` PR on the digest,
private repos included, because the App can read every repo in the org. The
title, author login and draft state then show in the channel. A user can also
tell from the rejection (`merged`/`closed` versus `not-found`) whether a
private repo or PR exists. This is accepted because the server's members are
the team that already works in those repos. The old allowlist let private repos
such as `paranext-core` through as well, so the exposure is not new. **If the
server ever admits people outside the org, this decision has to be revisited**:
refusing private repos at submit (`repository.isPrivate`) is the smallest fix.

**Upgrading a running deployment** is one-way. See `docs/operations.md`,
*Upgrading to schema version 6*.

**Alternatives rejected.**
- *An org allowlist* — brings back the per-org configuration and redeploy this
  change exists to remove.
- *Scanning only the team's own orgs* — the same list under another name, and
  it still turns conversation about those PRs into rows.
- *A skip marker in the message for "don't track this"* — it makes the scan
  opt-out, so every unmarked mention is tracked, and people would have to learn
  a syntax that is harder than the command.
- *A public reply or DM to people who paste a link* — needs message reading
  again, the access this change removes, and Discord can't reply privately to a
  plain message (only to an interaction).
- *A Discord AutoMod rule blocking PR links* — blocks links people post to
  discuss a PR as well. It stays available as a server setting if habit-pasting
  becomes a real problem (`docs/operations.md`).

## adr-store-command-interface

**Context.** The store holds all mutable record state and must serialize
concurrent writes from two independent callers: the five-minute cron tick,
and interactive Discord handlers (claims, resolves) that can fire at any
moment, including mid-tick.

**Decision.** The store's interface (`src/store/types.ts`, `Store`) takes a
list of plain-data `Command` values and returns `CommandResult` values — not
a callback that receives and mutates internal state.

**Why commands, not a callback.** The production store is a Cloudflare
Durable Object, and every call to it from the worker crosses an RPC
boundary (`env.RECORDS.get(id)` returns a stub; each method call is a
message send to a separate execution context, not a local function call). A
closure — "here is a function, run it against your current state and give
me the result" — cannot be serialized across that boundary; only plain data
can. A `Command` is exactly that: a tagged union of plain objects
(`{ kind: "claim", id, userId, ... }`) that survives serialization intact. A
callback-based interface has no working RPC-safe implementation; a
command-based one does, and it's the same shape whether the underlying store
is a Durable Object (`src/store/do.ts`) or an in-memory object used in tests
(`src/store/memory.ts`).

**Why the digest `PATCH` happens inside the store**, rather than the caller
reading records, calling the store, then separately rendering and patching:
the record write, the re-read, the digest render, and the body-hash decision
all need to see the *same* committed snapshot, taken *after* this tick's own
mutations landed. If rendering happened outside the store as a second,
separate operation, an interactive claim could land in the gap between "the
tick's `finishTick` call returns" and "the caller renders and patches,"
and get silently overwritten by a render built from stale data — the exact
"lost update" scenario the design spec's "Rendering reads the committed
state" section works through in detail. Keeping the mutation, the re-read,
and the render+patch inside one store call (`finishTick` for the cron path,
`apply(..., { rerender: true })` for the interactive path) is what makes that
guarantee actually hold, rather than merely being intended.

**Alternatives rejected.**
- *A callback-based store API* (`store.mutate(state => newState)`) — no
  working implementation over a Durable Object RPC boundary; a closure can't
  cross it.
- *Rendering and patching as a step the caller performs after the store call
  returns* — reopens the lost-update window described above; tested
  explicitly in `tests/store/*` by interleaving a claim against a store call
  mid-tick, not by mocking the store away (a mock would remove exactly the
  seam the bug lives in).

## adr-long-form-timestamps

**Context.** The digest example in early drafts of the design spec showed
compact relative ages (`3d`) while a separate rule required using Discord's
own relative-timestamp markup (`<t:epoch:R>`) rather than the bot computing
and re-rendering age strings itself, so the digest body would stay a pure
function of record state and Discord's client would keep it accurate between
edits with no further writes.

**Decision.** `3d` turned out to be a shape `<t:epoch:R>` cannot produce —
Discord's relative-timestamp markup has no compact variant; it only renders
long form ("3 days ago"). This was found by the preview harness's render
proof, built and checked before any adapter code existed, not by review of
the prose — the two rules (compact display, Discord-rendered relative
timestamps) simply could not both hold, and nobody had noticed until seeing
the actual rendered output.

Long form was chosen, not a bot-computed compact string, because computing
ages would make the rendered body a function of wall-clock time as well as
record state — a row crossing an hour or day boundary (`2h`→`3h`, `47h`→`2d`)
would change the body on its own, with no underlying state change. With even
a dozen open rows, some row crosses such a boundary on nearly every tick,
which would defeat the change-detection write-skip that the whole design
relies on to keep an idle team's digest at zero edits — turning "an idle
list costs no writes" into up to 288 no-op `PATCH`es a day. **The write-skip
is what the long form buys**: relative timestamps computed by Discord's own
client, not the bot, make the body a pure function of record state alone,
so `stableHash` (`src/core/hash.ts`) only changes when something real
changed.

The accepted cost: long form runs ~20–30 characters longer per row than the
compact form would have, which is what pushes practical embed capacity down
from a hoped-for ~25 rows to the ~20 actually configured
(`DEFAULT_MAX_ROWS`) — see `adr-embed-rendering`.

**Alternatives rejected.**
- *Bot-computed compact ages (`3d`), re-rendered fresh on every access* —
  rejected: defeats the write-skip, as described above, and was the option
  the render proof revealed was internally inconsistent with the
  Discord-relative-timestamp requirement in the first place.
- *Bot-computed compact ages, cached and only updated once per day* —
  rejected as needless complexity solving a problem (matching a display
  format Discord doesn't natively support) that accepting the long form
  solves for free.

## adr-per-person-data-off-the-render

**Context.** Two fields the store genuinely needs for correct behavior —
`claimedAt` (when did someone claim this) and `requestCount` (how many times
has this been re-requested) — would, if rendered onto the permanently pinned
digest, read very differently to the people named on it than the mechanism
they serve internally.

**Decision.** Both stay in the store and off the screen.

- `claimedAt` exists so a stale claim can auto-clear after the configured
  threshold (`config.staleClaimMs`) and return the row to its team section.
  Rendering it as `Ira · 4d` beside a claimer's name in a message that never
  scrolls away turns it into a public lateness board — and the earlier
  design this replaced put a ⚠️ next to a stuck claim, which is the same
  thing with a different label. The predictable response to a public
  lateness indicator is that people stop claiming PRs at all, which destroys
  the very data the claim feature exists to collect and defeats its purpose
  entirely.
- `requestCount` exists so re-request detection works (a re-request updates
  an existing record rather than creating a duplicate) and so the sort rule
  can distinguish "genuinely new" from "asked again." Rendering it as
  `re-asked 3×` turns it into a per-author nag counter with no context for
  *why* someone re-asked (a legitimate second round after fixing review
  comments looks identical to nagging).

Both are needed by the mechanism; neither should be legible off the public
message. The README's data policy section exists specifically because the
underlying store — which does retain both fields — is one query away from a
per-person latency leaderboard whether or not this plan ever builds one; the
promise "no review-time analytics" has to be about the data, not just about
what v1 happens to render.

**Alternatives rejected.**
- *Render `claimedAt` as a relative age next to the claimer's name* —
  rejected for the lateness-board reasoning above.
- *Render `requestCount` as a small badge ("re-asked ×3")* — rejected for the
  nag-counter reasoning above; the mechanism (dedup, sort) doesn't need it
  displayed to function.
- *Drop the fields from the store entirely, since they're not rendered* —
  rejected: they're not decorative, they're the mechanism. Auto-clear
  literally cannot know a claim is stale without `claimedAt`; dedup and the
  age-based sort cannot distinguish a re-request from a brand-new one
  without `requestCount`.

*Amended 2026-11-03:* anonymous, team-wide review-time totals now exist; this
decision still excludes anything per person. See `adr-anonymous-review-stats`.

## adr-daily-post

**Context.** Discord fires a pin notification exactly once, at the moment a
message is first pinned. Every subsequent edit (the five-minute `PATCH` that
keeps the digest current) is silent — nobody is notified, and nothing
appears in anyone's unread-messages indicator. A tracking mechanism that
never reaches a human's attention doesn't change anyone's behavior; it just
sits there being accurate to nobody.

**Decision.** One conditional post per day, in the review channel, only when
at least one row is open (`src/core/render/daily.ts`, `renderDailyPost`
returns `null` on an empty queue — a clear queue is silent, so the post
never becomes wallpaper that people learn to ignore). The content is a count
of open rows, the oldest row's age, and a jump link to the pinned digest —
nothing more.

**Why this is not the per-person nudge the design's non-goals explicitly
exclude:** it names no individual, targets no one's inbox, and lands in a
channel people already read as part of their normal day, rather than a DM.
The non-goals rule out reminders that single someone out ("you haven't
reviewed PR #177") or that reach people outside channels they've already
opted into by being in the server. A once-a-day, no-names, channel-only post
is a different thing in kind, not just in frequency.

**Alternatives rejected.**
- *No delivery layer at all — rely on the pin alone* — this is what an
  earlier draft assumed would be sufficient, and it's wrong: since the pin's
  own edits are silent after the first, "no DM nudges" would have quietly
  removed the *only* mechanism that ever reaches a human, not merely
  declined to add a nicety on top of one that already worked.
- *Per-person DMs listing what that person is assigned or hasn't reviewed* —
  explicitly excluded by the design's non-goals; this is the "PRs you have
  not reviewed" per-person view the spec rules out.
- *A post every time the digest changes* — would spam the channel on every
  claim or new request; once a day, gated on "something is actually
  waiting," is the minimum frequency that still reaches someone without
  becoming noise.

## adr-vitest-package-name-vs-api

**Context.** The design spec's Testing section stated that
`@cloudflare/vitest-pool-workers` was "renamed" to
`@cloudflare/vitest-plugin`. That is true of the package name and false of
what the package actually exports. `@cloudflare/vitest-plugin@1.1.2` exports
only `.` and `./types`, and its actual API surface is `cloudflareTest` /
`cloudflarePool` (see `vitest.config.ts`) — **`defineWorkersProject`, the
function the old package's docs and the spec's own phrasing implied would
carry over, does not exist** in the new package at all.

A task during this implementation lost real time to exactly this assumption
— importing `defineWorkersProject` from the renamed package on the strength
of the name-change note, before discovering the function simply isn't there.

**Decision.** Use `cloudflareTest` from `@cloudflare/vitest-plugin` as a
Vitest plugin, configured via `cloudflareTest({ wrangler: { configPath:
"./wrangler.jsonc" } })` inside a `projects` entry in `vitest.config.ts`
(see the `"workers"` project there). This is the shape that actually works
against `@cloudflare/vitest-plugin@1.1.2`.

**The lesson to record, independent of this specific package:** verifying
that a package's *name* changed — via a changelog note, a migration guide's
headline, or a search result confirming the rename happened — is not the
same thing as verifying its *API surface* stayed compatible. A rename is
exactly the kind of change that invites skipping the "did the actual exports
change too" check, because the framing ("renamed from X") implies continuity
that a real API diff may not honor.

**Alternatives rejected.**
- *Pin to an older, pre-rename version of the package (`@cloudflare/vitest-
  pool-workers`)* — not evaluated as a serious option; the renamed package is
  the maintained one, and pinning to a deprecated name trades one problem
  for a worse one (falling behind on Workers runtime compatibility fixes).

## adr-typescript-pinned-below-7

**Context.** `typescript-eslint@8.69.0` — the parser and rule set that makes
ESLint able to understand `.ts` files at all in this repo — declares a peer
dependency range of `>=4.8.4 <6.1.0` on `typescript`. Installing
`typescript@7.x` against that range is not a warning; `npm install` fails
outright with `ERESOLVE`.

**Decision.** Pin `typescript` to `6.0.3` (see `package.json`) rather than
upgrading to 7.x or dropping `typescript-eslint` to unblock the upgrade.

**Why keeping the linter mattered enough to hold TypeScript back:** ESLint
cannot parse TypeScript syntax at all without `typescript-eslint`'s parser —
there's no fallback "plain ESLint on `.ts` files" mode that still works.
More specifically, this repo's `no-restricted-globals` rule banning the
global `Date` inside `src/core/**` (see `eslint.config.js`) is what
*mechanically* enforces the "`core/` has no I/O, no ambient time" boundary
described in `docs/architecture.md` — it's not just a documented convention
that relies on every future contributor remembering it and reviewers
catching violations by eye. Losing `typescript-eslint` to chase a newer
TypeScript version would turn that enforced architectural boundary back into
an unenforced one, silently, the moment anyone next touches `src/core/`.

**Alternatives rejected.**
- *Upgrade to TypeScript 7.x, drop `typescript-eslint`* — rejected for the
  reason above: it trades a real, currently-enforced architectural
  constraint for a newer compiler version, with no compensating enforcement
  mechanism put in its place.
- *Upgrade to TypeScript 7.x, keep `typescript-eslint` pinned to an older,
  compatible major version* — not pursued; the goal was a working, current
  toolchain, and pinning two interdependent tools to mismatched majors
  trades one version problem for two.

## adr-no-kv-namespace

**Context.** The design spec allows small, genuinely independent values
(scan cursors, a cached PRD thread list, a `meta:lastSync` timestamp) to live
in Cloudflare KV rather than the Durable Object, since KV is cheaper and
simpler for values nothing needs read-modify-write consistency on. This plan
does not build the PRD thread cache — it belongs to a later plan (see
`docs/architecture.md`, "What's deliberately not here") — and everything
else that spec section names (`syncLease`, `digestBodyHash`) is explicitly
required to live in the Durable Object instead, not KV, because both need
atomic read-modify-write semantics KV doesn't offer.

**Decision.** No `kv_namespaces` binding in `wrangler.jsonc`, no `META`
binding in `Env` (`src/env.d.ts` notes this explicitly), and no "create the
KV namespace" step in `docs/setup.md`. Scan cursors — the one KV-eligible
value this plan does use — live inside the Durable Object's own state
(`Meta.scanCursors` in `src/store/types.ts`) alongside everything else,
rather than in a separate KV namespace.

An unused binding is both YAGNI and a standing review target: every future
reviewer of this codebase would have to re-confirm, on every review, that
the KV namespace really is unused and isn't secretly load-bearing for
something — cost paid repeatedly for a binding that does nothing. Not
provisioning it at all removes that cost entirely rather than asking anyone
to keep re-verifying it.

**Alternatives rejected.**
- *Provision the KV namespace now, in anticipation of the later PRD cache
  plan* — rejected: the cache and the plan that needs it don't exist yet,
  and provisioning infrastructure for a not-yet-designed feature is the
  textbook case YAGNI exists to prevent. When that plan lands, adding the
  binding is itself a one-line, reviewable change.
- *Put scan cursors in KV as the spec's general guidance suggests* — not
  worth a whole namespace binding for one small piece of state that fits
  comfortably alongside everything else already living in the Durable
  Object's `Meta`.

**Amendment (2026-09-02, plan 2).** The PRD thread cache landed, and the binding
is still not needed. The cache lives in the Durable Object's `Meta` alongside the
scan cursors, for a reason this ADR's original framing did not anticipate: KV is
eventually consistent, and the cache is read *within seconds* of being written —
a list the cron refreshed is read by the very next modal. So is the retry stash,
which the v1 spec had already placed in the store. Both values want the
consistency the Durable Object gives and KV does not, so the ADR's decision
stands unchanged and this is the last thing that was going to challenge it.

**Amendment (2026-10-12).** The PRD thread cache the previous amendment
describes has been removed, along with refresh-loop step 7 that filled it: the
PRD forum lived on a server the bot no longer reaches. The retry stash is the
only one of the two left, and it still wants the Durable Object's consistency,
so the decision stands.

**Amendment (2026-11-03).** The scan cursors this ADR discusses were retired
with the channel scan (see `adr-command-only-requests`); schema v6 keeps only
`{}` tombstones for them.

## adr-durable-object-schema-version

**Context.** All persisted state lives in one serialized object under the
single `"state"` key of the `RecordsObject` Durable Object
(`src/store/do.ts`) — records and `Meta` together. `Meta.scanBackfill` was
the first field ever added to that shape, and it was handled with a `?? {}`
default at the read site. That works, and it is exactly the pattern that
does not scale: it is per-field, it is invisible until you go looking for it,
and it only covers *additions*. A change of shape rather than an addition —
splitting a field, renaming one, changing a map's value type — has no
defined path at all, and the person who needs one will be inventing it while
holding a shape that is already in production storage.

The window to fix this cheaply is narrow and closes on first deploy.
Nothing has been deployed, so there is no stored state anywhere: adding a
version field today is a code change with no data consequences. The moment
the Worker runs once against a real Durable Object, the same change becomes
a migration of live state.

**Decision.** `StoreState` carries a top-level `schemaVersion: number`
(`src/store/types.ts`), and `CURRENT_SCHEMA_VERSION` — currently `2` — lives
beside `LEASE_TIMEOUT_MS` in the same file, for the same reason: both `Store`
implementations import it so they cannot drift apart. `emptyState()` stamps
it.

Migrations go in exactly one function: `migrateState` in
`src/store/schema.ts`. `RecordsObject.load()` is the only place persisted
state is read, and it routes every read through `migrateState`, so no caller
can ever observe a shape an older deploy wrote. Steps inside it are written
as a chain — each upgrades exactly one version and falls through to the next
— so state written three versions ago walks forward through every step
instead of needing one conversion per (from, to) pair.

**What the seam does and does not buy, stated exactly.** It is a *location*: one
function, on the one read path, with the write-back proven by test. That is the
part that was worth having early. It is not a scheme that makes every future
migration a one-line addition, and the doc comment in `src/store/schema.ts`
originally implied otherwise by prescribing a chain the file could not compile —
`state` was `const`, and the local was typed as the *current* `StoreState`, so no
intermediate carrying a field the current shape lacks could be expressed. Both
are fixed: `state` is a `let` typed as `MigratingState`, the stored shapes are
widened by field (`StoredMeta`, `StoredState`), and one narrowing cast at the
`return` is where the chain asserts it finished. A shape-changing migration —
a rename, a removal — still means widening those stored types at that point
rather than only adding an `if`, and the comment now says so. A comment
promising a pattern that does not compile is worse than no comment: the next
person follows it under pressure and works around a type error badly.

**Version 1 is the pre-deploy baseline.** It is the shape frozen before the
first deploy, which is why "unversioned" and "version 1" are the same shape:
no other unversioned shape was ever written anywhere. `migrateState` first
stamps `schemaVersion: 1` onto state whose field is absent, then walks it
forward. It is covered by a test in `tests/workers/do.test.ts` that writes an
unversioned object straight into `ctx.storage`, loads it back through
`readState()`, and asserts that nothing was dropped, that every field a later
version added arrives initialised, and that the migrated version is what gets
written back on the next save.

**Version 2 added `Meta.digestBodyVersion`** — the monotonic counter the digest
compare-and-set compares on (see `digestHashWriteBack` and "Two writers, one
message" in `docs/architecture.md`). Its 1 → 2 step initialises the counter to
`0`. That is what the seam was built for, and it cost one `if`.

**A version HIGHER than `CURRENT_SCHEMA_VERSION` is a rollback, and
`migrateState` throws.** A Cloudflare rollback is one click and is the standard
response to a bad release, so the case is not hypothetical: version N+1 ships,
writes state this build cannot parse, and gets rolled back. Treating an
unrecognised-but-higher version as current would hand the unknown shape to every
caller and then write it back on the first `save()`, still labelled N+1, with
whatever this build put on top of it — silently, and leaving corrupted state for
the roll-forward to deal with. Refusing to serve is the correct response: cron
retries in five minutes and the state is intact when the newer version returns.

**The standing rule: any change to the persisted state shape must bump
`CURRENT_SCHEMA_VERSION` and add a step to `migrateState`.** Adding a field
with a read-site default does not count as an exception — that is how
`scanBackfill` got in without one.

**One half of that rule is mechanically enforced; the other half is a
convention.** Stated plainly because the difference matters when the rule is
under pressure, and because both halves were measured:

- **"bump ⇒ add a step" is enforced.** Setting `CURRENT_SCHEMA_VERSION` one
  higher with no matching step turns the migration test in
  `tests/workers/do.test.ts` red, because that test asserts against the
  constant rather than against a literal.
- **"shape change ⇒ bump" rests on review.** Adding a required `Meta` field
  with a default in `emptyState()` and no version bump typechecks and leaves
  the whole suite green. The `?? {}` read-site default that
  `src/handlers/scheduled.ts` still uses for `scanBackfill` is exactly the habit
  that makes skipping the bump feel harmless — and it is the habit this entry
  exists to replace.

Enforcing the second half would take a snapshot test over
`Object.keys(emptyState())` and `Object.keys(emptyState().meta)` keyed to the
current version, so any shape change fails until the snapshot and the version
move together. Not built: the failure it would catch is a code mistake caught in
review of a diff that is, by definition, changing the state shape — a place
reviewers are already looking — and a keys snapshot has its own cost, going red
on renames and reorderings that are not shape changes at all.

**Alternatives rejected.**
- *A general migration framework* — a registry of numbered migration
  functions, a runner, replay of a chain read from a manifest. There is one
  key, one object, and one migration step; a framework for that is
  scaffolding whose only user is itself, and it would need its own tests and
  its own review. A chain of `if (state.schemaVersion === N)` blocks in one
  named function is the whole mechanism, and it is legible at a glance.
- *Keep using per-field `??` defaults* — rejected: it cannot express a shape
  *change*, only an addition, and it leaves no single place to look. It is
  the status quo this entry exists to replace.
- *Put `schemaVersion` inside `Meta`* — would have been a smaller diff
  (test fixtures build `meta` by spreading `emptyState().meta`, so they would
  have compiled unchanged). Rejected because `Meta` is domain state that
  `setMeta` patches freely, and the version of the persisted envelope is not
  domain state — a `setMeta` patch must not be able to rewrite it. It
  versions the whole stored object, so it sits on the whole stored object.
  (`Meta.digestBodyVersion`, added in version 2, is not a counter-example: it
  describes the digest rather than the envelope, it must move in the same atomic
  write as the `digestBodyHash` it guards, and it is protected the other
  available way — `MetaPatch` excludes it from the patch type and `applyOne`
  derives it, so no patch can set it and none can move it backwards.)
- *Version each record instead of the whole object* — records are already
  written and read as one blob under one key; per-record versions would add
  N version fields to serialize and still leave `Meta` unversioned.

**Amendment (2026-10-12).** The "currently `2`" above is historical. Versions 3
and 4 were added by plans 2 and 3. Version 5 (2026-10-12) removed
`PrRecord.prdThreadId` and the `prdThreadId` in every stashed retry's values,
and reduced `Meta.prdCache` to a `null` tombstone — the first step to *delete*
fields, which `StoredMeta`/`StoredRecord` admit as optional so older state
stays typeable. The tombstone stays because old-build Worker processes still
serve interactions while a deploy rolls out, and the old modal builder crashes
on an absent cache but handles `null`. Version 5 is also the first step whose
cleanup runs on every load, not only on the version bump: an old-build tick
already in flight at deploy can commit PRD values into state stamped 5, and
re-stripping on load removes them. The current version is 5.

## adr-403-throttle-vs-revocation

**Context.** The fail-closed rule — "a 401 from any credential fails closed
for that credential group and stops retrying" — exists because 10,000 invalid
responses in 10 minutes risks a temporary IP ban. It was implemented by
latching on 401 **and** 403, in both `reportStatus` and the App token mint.

That is right for 401 and wrong for 403, because GitHub overloads 403. It is
the status for a revoked or under-privileged token, and it is *also* the
status for a secondary rate limit and abuse throttling — transient conditions
that carry `Retry-After` and clear in minutes. The latch is per-isolate and
nothing clears it, so a single throttled response stopped all syncing for that
credential group until the isolate was recycled, with `docs/operations.md`
naming a redeploy as the only reset. The digest would go stale and the
operator would be sent to rotate a credential that was never broken.

**Decision.** Keep the latch, and decide 403 by headers
(`src/github/credentials.ts`, `throttleDelayMs`). A 403 or 429 carrying
`Retry-After`, or `x-ratelimit-remaining: 0` with an `x-ratelimit-reset`, sets
`throttledUntil` — the group is skipped until the clock passes it and then
resumes with no intervention. A 403 with no such signal is read as revoked and
latches exactly as before. A 429 never latches: it is a rate limit by
definition, so an unsignalled one gets the floor delay rather than a
revocation. Backoff is clamped to [1 minute, 1 hour]: shorter buys nothing
against a five-minute tick, and longer outlives the isolate holding it.

`/health` reports the two states separately (`throttledForMs` beside
`failedClosed`) because they are different jobs — "wait" and "rotate the
credential" — and an operator who cannot tell them apart will do the second
when the first was correct.

**Alternatives rejected.**
- *Treat every 403 as transient* — the mirror defect. A revoked token would
  be retried every five minutes forever, which is the ban risk the fail-closed
  rule exists to prevent, and nothing would ever surface it as broken.
- *Retry with exponential backoff instead of a fixed window* — GitHub states
  the wait explicitly in the response. Ignoring a number the server gave us in
  favour of a guessed curve is strictly worse, and the state to carry it is the
  same either way.
- *Persist the throttle in the Durable Object so it survives isolate recycling*
  — rejected as scope. The window is minutes, an isolate outlives it comfortably
  in the common case, and a fresh isolate re-learning the throttle costs exactly
  one request. `failedClosed` already accepts the same per-isolate lifetime for
  the same reason.

## adr-health-behind-a-shared-secret

**Context.** `GET /health` is the endpoint `docs/operations.md` routes every
investigation through, and it is deliberately detailed: it names the GitHub App
installation id, each credential's failure reason and token expiry, the digest
message id, the record census and the lease state. It was served
unauthenticated, on any HTTP method, to anyone who knew the worker's hostname —
and `*.workers.dev` hostnames are guessable and enumerable. That is a map of
the deployment, and the installation id in particular is a real identifier of
an org's App install rather than a bot-internal number.

**Decision.** Require a `HEALTH_TOKEN` shared secret, presented as
`Authorization: Bearer`, and restrict the route to `GET`/`HEAD`
(`src/handlers/health.ts`, `src/index.ts`). **With no `HEALTH_TOKEN`
configured the endpoint answers 404**, not the body: an operator who has not
set the secret yet gets no endpoint rather than an open one, and 404 does not
confirm to a scanner that a health endpoint is there to find. The comparison
does not return early on the first differing byte — the timing signal over the
internet is thin, but the whole check is three lines either way.

The cost is one more line in `docs/setup.md` step 11 and a header on the curls
in `docs/operations.md`. Both were updated in the same change; a secret the
runbook does not mention is a secret that ends up unset, which under this
decision means an endpoint that is silently 404 when someone needs it most.

**Alternatives rejected.**
- *Leave it open and strip the sensitive fields* — the fields are what make
  the endpoint useful. `credentials.*.failedClosed` and `installationId` are
  the two the runbook diagnoses from; an endpoint that omits them is one
  nobody can act on, and the record census and lease state are still a
  deployment map.
- *Cloudflare Access in front of the route* — a better answer for a human
  browsing it, and worth doing later. Rejected as the first step because it is
  configured outside this repo, cannot be asserted by a test here, and does not
  help the `curl` in a runbook or an uptime check.
- *Serve the body when no token is configured, to stay backward compatible* —
  there is nothing to be compatible with: this is pre-first-deploy. An
  "optional" secret means the insecure path is the default and stays the
  default for anyone who skips the step.

## adr-not-found-vs-not-visible

**Context.** The v1 spec asks a rejected `/review-request` submission to
distinguish "this PR does not exist" from "this bot cannot see it" — two
different problems with two different fixes, one for the requester (fix the
link) and one for whoever owns the credential (fix access).

**Decision.** Not distinguished per-PR. GitHub's GraphQL API returns the same
`NOT_FOUND` error type for a PR that genuinely doesn't exist and for one the
querying credential simply cannot see — `src/github/query.ts` reads both into
the same `notFound` list, with no field anywhere in the response that says
which case it was. `src/core/submit.ts`'s `SubmitRejection` reflects that
honestly: a `"not-found"` reason names the PR, not a cause.

A *wholesale* credential failure for the owner's group — the App key
rejected, the public token revoked — **is** distinguished, as
`"credential"`, because `src/github/query.ts`'s `failedGroups` already
reports it separately from `notFound`, and its fix is not the requester's to
make at all: no PR link they could paste would help, and telling them "try a
different link" would be actively wrong.

**Alternatives rejected.**
- *Guess from the repo's visibility* — asking GitHub whether a repo is
  public would need working access to that repo to answer, which is exactly
  what's missing in the case this is trying to detect. The bot cannot see a
  private repo well enough to report that it's private; that inability *is*
  the problem, not a side channel around it.
- *A second, unauthenticated probe* — issue a plain unauthenticated request
  for the same PR and infer "genuinely doesn't exist" from a 404 there too.
  Rejected as an extra subrequest on the submit path, which is already the
  slowest one in the bot (a live GitHub fetch inside a deferred interaction),
  spent to separate two cases whose fix is nearly identical either way: check
  the link, or ask whoever owns the credential.

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

**The notice's real coverage: reaction-versus-reaction only.** The spec's
"the superseded claimer is told privately" reads as covering every loss, but
`notifySuperseded` can only ever see a loss recorded in a `reaction-sync`
result's `superseded` list, and `syncReactions` only populates that list when
an *arriving* reactor loses to whoever `applyClaim` finds already holding the
record — and by the time `syncReactions` runs, that holder is always a
reaction claim, because a menu-claimed record never reaches it. The gap is
upstream of `syncReactions` entirely: a menu claim (`applyClaim(..., "menu")`)
nulls `lastReactors`, and
`selectReactionTargets` excludes any record whose `claimedBy` is set by
something other than a reaction. So the moment a menu claim lands, the record
leaves the polling set — no future poll ever runs `syncReactions` against it,
and a reaction that was already standing there, or one added afterward, is
never diffed, never recorded as superseded, and never DM'd about. It is
absorbed silently the next time the record re-enters the polling set (release,
resolve-then-reopen, or a fresh migration) and gets primed from scratch.

This was reviewed and accepted rather than fixed. The alternative — running
`syncReactions`-style superseded reporting from the unprimed branch, against a
menu-claimed record's standing reactions — would fan a DM out to every reactor
on every menu-claimed record carrying a reaction on the very first deploy,
which is exactly the burst that priming exists to prevent. A reactor whose
reaction loses to a menu claim gets no notice and must re-add the reaction (or
use the menu) to find out the row moved on without them.

## adr-anonymous-review-stats

**Status.** Accepted 2026-11-03. Schema version 7. Design:
`docs/superpowers/specs/2026-11-03-review-stats-design.md`.

**Context.** The bot shipped with "no review-time analytics" as a promise, for
the reason in `adr-per-person-data-off-the-render`. The maintainer and a
manager now need two answers the data can't give: is the bot helping or
hurting review, and how does responsiveness change over time. Answering needs
timings, which the promise ruled out. The promise worth keeping was never
"nothing is timed"; it was "nobody is measured".

**Decision.** Collect anonymous, team-wide weekly totals and nothing per
person.

- **Per-person data stays excluded.** No requester, claimer, reviewer or
  author appears in any stored, shown or returned figure, and none is planned.
  A pending entry holds only `id`, `week`, `outcome`, three durations rounded
  to 5 minutes, `claimed`, `claimsDropped` and `reRequests`.
- **No repo or urgency is stored**, not even on the pending entry. Entry plus
  GitHub's public review and merge times would identify the PR and the
  reviewer. The cost, accepted by the maintainer, is that a per-repo or
  per-urgency view can never be built from this data.
- **Weekly totals only.** When a week has closed and `reopenWindowMs` (24 h)
  has passed, its entries are folded into that week's totals (counts by
  outcome, summed drops and re-requests, and histograms over fixed buckets for
  `reviewed` rounds) and deleted. Nothing finer than a weekly total outlives
  about 8 days. Totals are kept indefinitely and can't be removed per person.
- **Round timing is scrubbed off the record after the reopen window.** The
  per-round fields (`roundStartedAt`, `roundFirstClaimedAt`, the two counters
  and `roundPendingEntryId`) sit beside the PR's identity and `resolvedBy`,
  which can name the reviewer, so left until the 30-day purge they would make
  exact per-PR, per-person claim timing recoverable for a month. The
  `foldStats` tick wipes them once a resolved record is past
  `reopenWindowMs`; `reopen` is refused past that window, and a re-request
  starts a fresh round, so nothing reads them again. A request to remove one
  round goes to the maintainer, who can delete the pending entry and its
  record while the link still exists (about a day).
- **Collection starts on a full week.** The first fold sets `stats.sinceWeek`
  to the week after it ran. Entries from before it are dropped unfolded,
  `foldedThrough` stays null until `sinceWeek` closes, and outputs never read
  an earlier week, so a week the bot only partly watched (or not at all) never
  reads as a quiet one. `/review-stats` omits the previous-4-weeks comparison
  until all four of those weeks were collected.
  Histogram edges (15m, 30m, 1h, 2h, 4h, 8h, 1d, 2d, 3d, 5d, 7d, 14d, plus an
  open last bucket) are fixed once shipped, because changing them breaks
  comparisons across weeks. Medians and percentiles are interpolated within a
  bucket, so they are approximate.
- **Five disclosure rules, for every output** (`/review-stats` and `/stats`):
  1. Complete, folded weeks only; nothing pending or current is shown, so
     running the command before and after one PR resolves shows nothing.
  2. A median needs at least 5 rounds.
  3. The 75th percentile ("slowest 1 in 4") needs at least 20 rounds, so at
     least 5 rounds sit above it. No other percentile is shown.
  4. Counts are shown as they are.
  5. Histograms and buckets are never returned.
- **`STATS_TOKEN`** protects `GET /stats`. It is separate from `HEALTH_TOKEN`
  so a manager can be given it without exposing the health body, and like
  `/health` the endpoint answers 404 when it is unset
  (`adr-health-behind-a-shared-secret`).
- **Recording-week bucketing.** An entry belongs to the ISO week (UTC) in which
  the bot *recorded* the resolution, not the week GitHub says it was done. A
  sync-paused PR can resolve weeks after its GitHub done time, and adding it to
  an already-folded week would change published history.

**Known biases (documented, not corrected).**
- Reaction claims are timestamped when a tick detects them (round-robin, 10
  reads per tick, first poll only primes), so wait-to-claim is inflated for
  them, more when the backlog is larger. A shift in how many people claim by
  reaction can move the trend.
- Draft time counts as waiting; drafts can be requested.
- `reviews(last: 20)` can miss the earliest review on a very busy PR, making
  its done time later than it was.
- Totals are written when a round ends, so very long-open PRs are
  under-represented until they resolve.
- Rounds already open at the v7 deploy write no entry (their first-claim time
  is unknown).
- A release within 5 minutes of the claim is not a drop; stale auto-clears
  are. Resolve and re-request never count.

**Consequences.**
- Schema v7. Rolling back to a v6 build after v7 has run refuses to load
  state and takes the whole bot down (`adr-durable-object-schema-version`).
  Roll forward.
- README's "What this bot stores" says so plainly, including that weekly
  totals can't be removed per person. The maintainer announces the change to
  the team before deploying.
- Pending entries and totals live in `StoreState.stats`, atomic with the
  resolution that writes them.

**Alternatives rejected.**
- *Keep each finished review so filters can be added later* — each entry plus
  GitHub's public times identifies the PR and the reviewer.
- *Show the slowest 1 in 10* — with 5-9 rounds that is a single remembered PR.
- *Per-person or per-repo breakdowns* — see above; this decision exists to
  keep them out.
