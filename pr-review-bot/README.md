# PR Review Bot

A Discord bot that keeps one always-current list of "what still needs review"
at the top of the review channel, so nobody has to scroll history or post a
bump message to find out.

## The pinned list

A single pinned message at the top of the review channel — the **"Needs
review" digest** — shows every PR still waiting, grouped by team, newest
urgency first. It rewrites itself every five minutes. A row leaves the list
automatically once GitHub reports that a real person has actually reviewed
that PR — a comment counts, an approval counts, a request for changes counts.
Merging or closing the PR also clears its row.

## How to get on the list

Run `/review-request` in the review channel and fill in the four fields —
PR link, team, urgency, and a note — then submit. It works for a PR in any
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
moves instantly to the **Being reviewed** section, still showing which team
and urgency it came from, so a lead scanning for what is blocking a team can
still see it once it's claimed.

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

## What this bot stores

For each PR posted to the review channel: the repository, number and title;
who asked and when; which team and urgency they chose; who claimed it and
when; how many times it was re-asked; and how it left the list.

Records are kept for **30 days after they leave the list**, then deleted. The
retention exists so "why did my row disappear?" has an answer.

The pinned list deliberately does **not** show how long someone has held a
claim, or how many times a PR has been re-asked. Those fields exist because
the bot needs them — auto-clearing an abandoned claim needs the timer, and
detecting a re-request needs the count — not because anyone should be reading
them off a public message.

This data will not be used to compare people, and no per-person reporting
will be built from it. If you want your own history removed, ask and it will
be.

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
