# PR Review Bot

A Discord bot that keeps one always-current list of "what still needs review"
at the top of the review channel, so nobody has to scroll history or post a
bump message to find out.

## The pinned list

A single pinned message at the top of the review channel — the **"Needs
review" digest** — shows every PR still waiting in one list, most urgent
first, then oldest first. It rewrites itself every five minutes. A row leaves the list
automatically once GitHub reports that a real person has actually reviewed
that PR — a comment counts, an approval counts, a request for changes counts.
Merging or closing the PR also clears its row.

## How to get on the list

Run `/review-request` in the review channel and fill in the three fields —
PR link, urgency, and a note — then submit. It works for a PR in any
repo the bot can read. The bot posts a consistent request message and adds
the PR to the list right away. Running the command again on a PR already on
the list updates that entry instead of adding a second one.

**A pasted link on its own is not tracked.** The bot doesn't read channel
messages, so a PR link posted without the command never reaches the list.

If something's wrong with the submission, the rejection is private (only you
see it), names the problem and how to fix it, and carries a **Fix and
retry** button that reopens the form pre-filled with what you typed, so
fixing one field doesn't mean retyping the rest.

## How to say you are reviewing something

Open the pinned message and pick the PR from the **`Claim a PR ▾`** menu. It
moves instantly to the **Being reviewed** section, still showing its urgency,
so anyone scanning for what is blocking can still see it once it's claimed.

## How to get something off the list

Most rows leave on their own: once anyone reviews the PR, or it's merged or
closed, the row disappears within one refresh (up to five minutes).

If a link was never really a review request — a conversational mention, a
link posted by mistake, something resolved out of band — open the pinned
message and use **`Resolve ▾`** to remove it. A row resolved by mistake in the
last 24 hours can be put back with the same menu, now showing as
**`Reopen ▾`**.

## `/review-list`

If the pin is missing, deleted, or you just want to check privately, run
`/review-list`. It shows the same content, ephemerally, to only you.

## `/review-stats`

Run `/review-stats` in any channel to see, privately, how review is going:
the last four complete weeks compared with the four before. It shows how many
reviews were completed, the typical wait until someone claimed a PR, the
typical time from claim to done, the "slowest 1 in 4" time end to end, and how
many claims were dropped or auto-cleared. Only complete weeks are counted,
and a figure is left out ("not enough reviews yet") until there are enough
reviews behind it that it can't point at one PR. Nothing is ever posted to
the channel.

## What this bot stores

For each PR posted to the review channel: the repository, number and title;
who asked and when; which urgency they chose; who claimed it and
when; how many times it was re-asked; and how it left the list.

Records are kept for **30 days after they leave the list**, then deleted. The
retention exists so "why did my row disappear?" has an answer.

**Anonymous review-time figures.** The bot does record how long reviews take,
as team-wide totals that name nobody. When a review round ends, the bot writes
one small **pending entry**: the ISO week it was recorded in, how the round
ended (reviewed, merged or closed without a review, or cleared by hand), how
long it waited before being claimed, how long it was held before it was done
and the total (each rounded to the nearest 5 minutes), whether it was claimed
at all, how many claims were dropped, and how many times it was re-requested.
A pending entry **never contains** a name, a Discord or GitHub id, the
repository, the PR number or title, the note or the urgency.

- **A record's round timing is scrubbed about a day after it leaves the
  list.** While a round is open the record keeps when it started, when it was
  first claimed, and how many claims were dropped and re-requests made, so the
  pending entry can be written when it ends. Once the 24-hour reopen window
  after it resolves has passed, those fields and the record's link to its
  pending entry are wiped, so the 30-day record no longer says how long that
  PR waited or when anyone claimed it.
- **Removing a pending entry.** If you want a round removed, ask the
  maintainer: they can remove the pending entry and its record. The record's
  link is what finds the entry, so ask within about a day of the round
  ending. After the scrub nothing ties the entry to the PR, and once its week
  is folded it is part of an anonymous weekly total.
- **After the week closes (plus 24 hours), the entries are added up into a
  weekly total and deleted.** A weekly total holds counts and a histogram of
  times, nothing about any single PR. **Weekly totals are kept
  indefinitely, and they cannot be removed per person**, because they can't be
  traced to a person or a PR in the first place. Nothing finer than a weekly
  total survives past about 8 days.
- What the figures can't show: the repository and urgency are not stored, so
  there is no per-repo or per-urgency view. A figure is only shown when
  enough reviews stand behind it, and `/review-stats` and the maintainers'
  stats endpoint show complete weeks only. Figures start with the first full
  week after the feature was deployed; earlier weeks are left out rather than
  shown as zeros.

The pinned list deliberately does **not** show how long someone has held a
claim, or how many times a PR has been re-asked. Those fields exist because
the bot needs them — auto-clearing an abandoned claim needs the timer, and
detecting a re-request needs the count — not because anyone should be reading
them off a public message.

This data will not be used to compare people, and no per-person reporting
will be built from it. The weekly figures measure the review process, not
anyone in it. If you want your own history removed, ask and it will be, apart
from the anonymous weekly totals described above.

It records PR authorship and review activity as GitHub reports it; it does
**not** retain a rendered claim-age or re-request counter on the public list
for the same reason — the digest exists to route review attention, not to
measure individuals. If someone proposes adding either back to the pin later,
this is why they were left off in the first place.

## For maintainers

- [`docs/architecture.md`](docs/architecture.md) — how the code is organized
  and where each behavior lives.
- [`docs/setup.md`](docs/setup.md) — the deployment runbook, in the order that
  actually works.
- [`docs/operations.md`](docs/operations.md) — what to do when something
  breaks.
- [`docs/architecture-decisions.md`](docs/architecture-decisions.md) — why the
  design is the way it is.
- The full design spec:
  [`docs/superpowers/specs/2026-08-26-pr-review-bot-design.md`](docs/superpowers/specs/2026-08-26-pr-review-bot-design.md).

## Deploying

The bot deploys from GitHub Actions, with every value held as a GitHub secret.
See [`docs/setup.md`](docs/setup.md), steps 11 and 12, for the secrets to
create and how to run the first deploy.

## Test keys

`tests/workers/*.test.ts` contain RSA private keys generated only for these
tests. They sign nothing real and are allowlisted in the repository root's
`.gitleaks.toml` and `.github/secret_scanning.yml`.
