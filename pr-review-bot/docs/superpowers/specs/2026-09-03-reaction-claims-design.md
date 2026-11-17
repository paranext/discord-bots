# `:code_review:` reaction claims — Design (plan 3)

**Date:** 2026-09-03
**Status:** Ready to plan. One adversarial review is folded in; every finding is
either applied inline or answered below in *Answered objections*.
**Author:** Jolie Rabideau

Supplements [the v1 design](2026-08-26-pr-review-bot-design.md). That spec
describes the whole bot; this one covers only what plan 3 builds. Where the two
disagree, this document wins for plan-3 scope and says so explicitly — and it
does disagree in one place, deliberately: see *Removal releases a claim*.

## Scope

Plans 1 and 2 shipped rollout stages 1–3: the store, the refresh loop, message
scanning, the pinned digest, the daily post, the claim and resolve menus,
`/review-list`, and `/review-request` with its modal and PRD thread cache. The
claim rules this plan needs — `applyClaim`'s first-write-wins arbitration,
`applyUnclaim`, `clearStaleClaim` — already exist and are tested.

**In scope:**

- Refresh-loop step 8: reading `:code_review:` reactions, under a per-tick
  budget, oldest-unchecked-first.
- Claiming by adding the reaction, and **releasing by removing it**.
- Arbitration against a menu claim, and the private notice to the loser.
- Schema version 4: the three new `PrRecord` fields the above needs, and
  `claimSource` plumbed through the existing claim paths.

**Out of scope, deferred by name:**

- Gateway `MESSAGE_REACTION_ADD` / `MESSAGE_REACTION_REMOVE` events. This bot
  has no gateway connection and this plan does not add one; see
  [`docs/architecture.md`](../../architecture.md).
- Reaction handling on the digest message itself.
- Pagination past the first page of reactors on a single message.
- **Claiming by super (burst) reaction.** See *Burst reactions* — the harmful
  half of this is fixed; the benign half is accepted.
- Reaction-driven *resolve*. Resolution stays the exit condition's job and the
  resolve menu's.
- Multi-channel, and the same PR needing two teams — unchanged non-goals.

## Decisions

| Decision | Why |
|---|---|
| The stored state is the **set of reactors seen at the last poll**, diffed on each poll | A presence check can only answer "is someone reacting?", and every hard case here is a *change* question. See `adr-reaction-diff-not-presence`. |
| `lastReactors` is `string[] \| null`, where **null means unprimed** | The diff's licence to read a reaction as intent is that an absence was observed in between. Across a gap where nothing was observed — a record that left the polling set, or a fresh deploy — that licence does not exist, and null is how the record says so. |
| Removing your reaction releases a claim you made by reacting | Observed usage: people pick up a review with the reaction and take it off when they get too busy. A reaction that cannot be taken back is a trap. |
| A release **promotes** a reactor who is still standing on the message | Otherwise the second reactor is stranded: they were told "already claimed", the claim then goes away, and their unchanged reaction can never claim it. |
| Within one sync, **releases apply before claims** | A removes and B adds between polls. Claims-first hands B an "already claimed by A" notice that is false by the time it lands, then releases to nobody. |
| A menu claim is released from the menu, never by a reaction | Requires `claimSource` on the record. Without it, someone who claimed from the digest and separately reacted loses their claim when they tidy the reaction off. |
| Arbitration happens **inside the store**, against committed state | Same reason step 9 re-reads before rendering: a menu claim landing between `beginTick` and `finishTick` must win, and it only does if the diff reads what was committed. |
| Destructive failure handling branches on Discord's **JSON error code**, not the HTTP status | The status-to-code mapping is undocumented, and the one branch that mutates state is the one that must not fire on a guess. |
| The superseded reactor is told by DM, falling back to silence | A reaction carries no interaction token, so there is no ephemeral reply. Silence is worse here than elsewhere: the reactor believes they hold the review, which is the exact duplicate-work case claiming exists to prevent. |

## Removal releases a claim

**This is new behaviour, not present in the v1 spec.** The v1 spec describes
step 8 as reading reactions "for unclaimed entries" — a one-way path, where a
reaction can only ever add a claim. That is wrong for how the reaction is
actually used: a reviewer picks up a PR with `:code_review:` and takes the
reaction off when they can no longer get to it. Under the v1 rule the row stays
in **Being reviewed** with their name on it until the 48-hour auto-clear, which
is the single most harmful place for the digest to be wrong.

So a poll answers a different question than v1 assumed. Not "who is reacting?"
but "what changed since the last poll?" Per polled record the store holds
`lastReactors`, the reactor ids observed at the previous poll, and each poll
diffs the freshly observed set against it. **When `lastReactors` is null the
record is unprimed: the poll writes the observed set and takes no other action.**
Otherwise:

- **Newly absent** (present last poll, gone now) → release, but only if that
  user currently holds the claim **and** holds it by reaction. Applied first.
- **Newly present** (reacting now, absent last poll) → claim attempt.
- **Unchanged, on a record left unclaimed by the release above** → claim
  attempt (promotion; see below).
- **Unchanged otherwise** → nothing.

The fourth line is load-bearing, and it is why this design needs no separate
rule about re-claiming. Walk the case it exists for: you react, you claim, the
claim auto-clears at 48 hours, and your reaction is still sitting on the
message. No release happened in that sync — the auto-clear is `clearStaleClaims`
at step 5, not a reaction event — so nothing promotes you, and you do not
silently re-claim two days later. Removing and re-adding the reaction next week
does claim, because an absence was actually observed in between.

**Promotion** covers the case the first three lines strand. A and B both react.
The first poll gives A the claim and tells B it was already taken. A later
removes their reaction; the release fires; B is unchanged, and without promotion
B never claims — the row goes back to its team section with a live
`:code_review:` on it from someone who has been told the opposite. So a sync
that releases a claim re-runs the claim attempt across everyone still standing
on the message. Promotion is scoped to a sync that actually released: it cannot
fire on the auto-clear path, which is what keeps the two-day case correct.

A release is **silent and unmarked**: no DM (you meant to do it), and it does
not set `claimClearedAt` or `lastClaimedByName`, so the row returns to its team
section clean rather than tagged `previously claimed`. That tag is for the
48-hour auto-clear, where a row went stale on someone. Handing a review back on
purpose is not the same event and must not read like one.

**Known cost.** A release is only as fast as the polling cycle:
`ceil(eligible / allowance)` ticks, which is 25 minutes at 10 reads per tick
across 45 eligible records — and the eligible set is **not** bounded at 45.
`purgeResolved` (`src/store/apply.ts`) only purges records that are *resolved*,
so an open PR that is never merged, never closed and never reviewed stays
eligible indefinitely, as does a `syncPaused` record. At 120 open records the
release latency is an hour. The menu's unclaim is instant and is the answer for
anyone who needs the row freed now. This is accepted rather than solved — the
reaction path is explicitly best-effort — but it is a property to document
rather than discover, because **Being reviewed** is where a stale row does the
most damage.

## Selection and the budget

`src/core/reactions.ts` is pure — `src/core/`'s no-I/O rule applies, and the
eslint ban on the global `Date` with it, which selection does not need since it
reads stamps rather than comparing against the clock.
`selectReactionTargets(records, allowance)` returns the ids to poll. A record is
eligible when all of the following hold:

- It is open.
- Its `messageId` is non-null and non-empty.
- That `messageId` belongs to **exactly one** record. A message reading "these
  two need eyes: …/pull/177 …/pull/181" produces two records sharing one id, and
  a single reaction on it cannot say which PR the reactor meant. Claiming both
  asserts a commitment nobody made; picking one by iteration order is worse.
  Such records are skipped by this path entirely, as the v1 spec requires — the
  digest menu, which names the row, remains available.
- It is either unclaimed, **or** claimed with `claimSource: "reaction"`. The
  second half is what makes a release detectable at all; a record claimed from
  the menu is not polled, because no reaction on it can change anything.

Eligible records sort by `reactionCheckedAt` ascending with nulls (never
checked) first, tie-broken by `firstRequestedAt`, and the list is truncated to
the allowance. Never-checked-first means a newly ingested row is polled on the
next tick rather than waiting out a cycle.

**Leaving the polling set resets `lastReactors` to null.** A menu claim, a
resolve, and anything else that makes a record ineligible must null it, because
the diff is only meaningful across an unbroken sequence of observations. Without
this: a record is menu-claimed, someone reacts during the weeks it is not being
polled — to bookmark it, or out of habit, with the digest plainly showing
somebody else's name — the claim is later released from the menu, and the very
next poll reads that reaction as newly present and claims on their behalf for
something they did nothing about that day. Nulling on exit means the first poll
after re-entry primes instead.

The allowance is computed in `src/handlers/scheduled.ts`:

```
min(config.budgets.reactionReadsPerTick, SUBREQUEST_CEILING - spent - RESERVE)
```

`SUBREQUEST_CEILING` is 50, the free plan's per-invocation limit. It goes in
`config/config.ts` beside `budgets`, commented as a platform bound rather than a
tuning knob. (`LEASE_TIMEOUT_MS` makes the same distinction but lives in
`src/store/types.ts`, because both `Store` implementations import it; nothing
outside the handler needs the ceiling.) `RESERVE` is **5**: one for
`finishTick`, plus four for the DM allowance — the cap is **2 DMs per tick** and
each costs two subrequests (open the channel, post). A third superseded reactor
in one tick is logged rather than DM'd, which is why the cap can be reserved for
up front even though the DM count is not known until `finishTick` returns.

An allowance of zero or less skips the step entirely and is reported.

Because selection is a pure function of the record set, the ordering, the
shared-message skip and the truncation are all testable without a network.

**This guard is a safety net, not a routine mechanism, and the spec should not
pretend otherwise.** A realistic tick today spends about 7 subrequests
(`tests/workers/scheduled.test.ts` pins that at 40 tracked PRs), so
`50 - 7 - 5` is far above 10 and the allowance equals
`reactionReadsPerTick` in every tick this codebase currently produces. It earns
its place against a future where the record set or the chunk count grows, and
its test needs a synthetic high-subrequest fixture to reach the branch at all.

**CPU, which is the other half of the v1 spec's reason for this budget.** The v1
spec names the 10 ms per-invocation CPU limit and calls out "reaction payloads"
by name as one of the three things competing for it, alongside parsing the
chunked GraphQL response and rendering the digest. Nothing here can measure CPU
mid-tick, so this plan bounds the *input* instead: reads use `limit=25` rather
than 100. A review request draws a handful of reactors, 25 is far past the real
distribution, and it cuts the worst-case parse from 1,000 user objects per tick
to 250. Reads are issued **sequentially**, not fanned out: the platform
serialises past six connections anyway, and a wave of parallel parses is exactly
the CPU spike this is avoiding.

## The read

`src/discord/reactions.ts` adds one route to `DiscordRest`:

```
GET /channels/{channelId}/messages/{messageId}/reactions/{emoji}?limit=25
```

`{emoji}` is the custom emoji in Discord's required `name:id` form, and Discord
requires the literal colon in the path — `encodeURIComponent` does **not**
leave `:` alone (`encodeURIComponent(":")` is `"%3A"`; only `encodeURI` spares
it), so it cannot be applied to the joined string. `src/discord/rest.ts`
instead splits on the last colon and runs `encodeURIComponent` on the name and
id segments separately, then rejoins them with a literal colon. For today's
value, `code_review:1075535230087221248`, both segments are all unreserved
characters, so the encoding is a no-op either way — the split exists for a
future emoji whose *name* contains something that needs escaping. Any
implementation that percent-encodes the colon itself produces `10014 Unknown
Emoji` on every read, so the test asserts the colon survives rather than
asserting escaping happened.

`limit` defaults to 25 on Discord's side, so passing it explicitly is
documentation rather than behaviour — but it is passed, because the value is
load-bearing for the CPU bound above and must not silently follow a default that
changes.

The response is an array of user objects: identity is `id`, display name is
`global_name ?? username` (`global_name` is nullable), so no second request is
needed to render a claimer's name. The bot's own id is filtered out of the
result.

Reading reactions needs no permission the bot does not already hold. Discord's
Get Reactions documentation states no permission requirement of its own —
unlike its neighbours on that page, which name `READ_MESSAGE_HISTORY` and
`MANAGE_MESSAGES` explicitly — so access follows ordinary channel visibility,
which the bot has for the review channels. No `docs/setup.md` change; a 403 here
would mean the channel overwrites are wrong, and is handled as such.

### Burst reactions

Discord's Get Reactions takes a `type` parameter — `0` NORMAL, `1` BURST (super
reactions) — defaulting to `0`. Reading only type 0 has two consequences, and
they are not equally acceptable:

- **A super-only reactor never claims.** Accepted. It is a silent no-op for a
  Nitro-only interaction, the digest menu still works, and paying a second
  subrequest per record per tick to catch it would halve the budget.
- **Someone switching a normal reaction to a super one would read as newly
  absent** — and, if they hold the claim, be released out from under an active
  reviewer. Not accepted: that is the "a release that shouldn't happen and does"
  case landing in **Being reviewed**.

So the release path, and only the release path, confirms: before acting on a
newly-absent user who holds the claim, step 8 issues one `type=1` read for that
record and drops the release if the user is present there. This is a rare path —
it costs nothing in the steady state — and it is charged against the same
allowance, so a confirming read cannot push a tick past its ceiling.

## The diff, as a command

Step 8 does not diff. It emits one command per polled record carrying the
**observed** reactor list:

```ts
| { kind: "reactionSync"; id: string; reactors: { id: string; name: string }[]; now: number }
```

The store diffs it against the committed `lastReactors` and, in one atomic step,
applies releases, then claims, then promotions, and writes `lastReactors` and
`reactionCheckedAt`. An unprimed record (`lastReactors === null`) writes both
fields and applies nothing.

Ordering inside the command is specified, not incidental:

1. **Releases first**, through `applyUnclaim`, guarded on the leaver both
   holding the claim and holding it by reaction.
2. **Claims** for newly-present users, through `applyClaim`, which is where
   first-write-wins is inherited rather than re-implemented.
3. **Promotion** — if step 1 released, the still-standing reactors are run
   through the same claim attempt.

Within steps 2 and 3, candidates are taken in the order Discord returned them.
That is arbitrary but deterministic, and it is the only ordering available: the
reactions endpoint carries no per-reaction timestamp, which is the same fact
that makes first-write-wins the strongest rule this API supports.

There is **no `expectLastRequestedAt` staleness check** on this command, unlike
`claim` and `resolve`. That check exists because a select menu's options are
only as fresh as the reader's Discord client; a reaction is read live from the
message and has no rendered option to go stale against.

Command order within the tick already works out: `clearStaleClaims` is step 5,
so a claim this same tick auto-cleared is followed by a `reactionSync` that sees
an unchanged reaction, no release, therefore no promotion, and correctly does
not re-claim it.

A new `CommandResult` variant reports the outcome:

```ts
| {
    kind: "reaction-sync";
    id: string;
    claimed: string[];
    released: string[];
    superseded: { userId: string; byName: string }[];
  }
```

The `id` is carried explicitly rather than recovered by index from the command
list: the DM names the PR, and `resultCounters` already demonstrates how easy
index-alignment is to get subtly wrong.

`runTick` reads these off `finishTick`'s results and sends the DMs. A DM is
therefore only ever sent for a claim that actually lost, decided by the store,
not predicted by the handler from a snapshot it read earlier.

## The private notice

For each superseded reactor, up to the per-tick cap: `POST /users/@me/channels`
to open a DM, then post "`owner/repo#177` is already claimed by *name*." Two
subrequests each, both counted into `TickReport.subrequests` — they are outbound
worker fetches and do charge against the ceiling, and a report that omits them
is dishonest in exactly the tick where the number matters.

A 403 (DMs from server members disabled) is logged and ignored. It is not
retried: it is a stable property of the recipient's settings, and a hot retry
against a stable 4xx is what the abuse ceiling punishes.

**The DM loop carries its own guard.** It runs after `finishTick`, which is
after `leaseReleased = true`, so `runTick`'s existing `finally` does nothing for
it: an unguarded rejected fetch here would propagate out of a tick whose work is
already fully committed and whose digest is already patched, losing the entire
`TickReport` and logging a failed tick. The loop is wrapped so a DM failure can
never do more than cost a DM.

## Storage

Schema version **4**. `PrRecord` gains three fields:

| Field | Type | Meaning |
|---|---|---|
| `claimSource` | `"menu" \| "reaction" \| null` | How the current claim was made. Null whenever `claimedBy` is null. |
| `reactionCheckedAt` | `number \| null` | When step 8 last polled this record. The sort key for oldest-unchecked-first. |
| `lastReactors` | `string[] \| null` | Reactor ids observed at that poll; **null means unprimed** — nothing observed since the record entered (or re-entered) the polling set, so no diff is meaningful yet. |

`claimSource` is not free, and the plan must treat it as a change to the claim
core rather than a new field sitting quietly beside the others:

- `applyClaim` (`src/core/claims.ts`) takes no source today. Its signature
  gains one, and **both** existing call sites are updated — the reaction path
  passes `"reaction"`, and the menu path from `src/handlers/interactions.ts`
  passes `"menu"`. The 3 → 4 migration mapping every pre-existing claim to
  `"menu"` is only coherent if the menu path actually writes it going forward.
- `applyClaim` returns the record untouched when the same user re-claims, so an
  idempotent re-claim cannot repair a wrong source. Nothing should depend on it
  doing so.
- **Every path that clears `claimedBy` clears `claimSource` too**, or the
  field's stated meaning is a lie the first time a claim is cleared:
  `applyUnclaim`, `clearStaleClaim` (`src/core/claims.ts`), `resolveRecord` and
  `markRequested` (`src/core/record.ts`). Readers must still test `claimedBy`
  rather than inferring occupancy from `claimSource`; the invariant makes the
  field safe to read, not a substitute for the claim itself.

Beyond the type declaration, three construction and typing sites need the
fields, and the first two are easy to miss until the plan is being executed:

- `newScannedRecord` (`src/core/record.ts`) is a full `PrRecord` literal and is
  the production construction site for every scanned and every requested record.
- `MigratingState` (`src/store/schema.ts`) inherits `records` at the *current*
  record shape, so widening only `StoredState` leaves the 3 → 4 step's
  intermediate value untypeable. This is the first migration to touch `records`
  at all, and it is exactly the trap that file's own doc comment warns about.
- One test builds a bare `PrRecord` literal (`tests/core/record.test.ts`); the
  other factories spread `newScannedRecord` and need nothing.

The 3 → 4 step maps every record: `claimSource: claimedBy !== null ? "menu" :
null`, `reactionCheckedAt: null`, and **`lastReactors: null`**.

That last value is the deploy behaviour, chosen deliberately. Null means
unprimed, so the first poll of each record records who is standing on it and
claims for nobody; only reactions added after the deploy count. The alternative
— seeding `[]`, so every standing reaction reads as newly present and claims
retroactively — was considered and rejected. Its appeal is that a
`:code_review:` on an open, unreviewed PR is real signal. Its cost is that the
reactions which have *survived* to deploy day are disproportionately the ones
nobody acted on, and a retroactive claim stamps `claimedAt: now`, parking each
such row in **Being reviewed** under a name that is wrong for a fresh 48 hours —
the worst failure this document names, applied to the whole list at once. It
would also fan new DM channels out to many distinct users inside a few minutes,
which is the precise pattern Discord's Create DM documentation warns can get a
bot blocked from opening DMs, and it is the largest 403 burst this feature will
ever generate against the 10,000-invalid-in-10-minutes abuse ceiling. One
re-reaction from anyone who still wants the row is a much cheaper price.

`lastReactors` is bounded by the number of people reacting to one message,
capped by the read's own `limit=25`, and emptied by the same poll that observes
them leaving.

## Failure modes

Step 8 is wrapped so nothing in it can end the tick. It is optional work sitting
between the scan and the render, and the render must always happen — a tick that
dies here would suppress the stale banner, which is precisely the failure
Monitoring names as the one it most needs to avoid.

**Failure handling branches on Discord's JSON error code, not on the HTTP
status.** `DiscordRest.call` already returns the raw body on failure, so the
code is available. This matters because exactly one branch mutates state, and
Discord's documentation does not state which status wraps which code:

- **`10008 Unknown Message`** — the request message is gone. Emit a command
  nulling `messageId`, which is the v1 spec's documented "Request message
  deleted" behaviour (the record survives; the digest row stays but loses its
  link) and has the side effect of permanently removing the record from the
  polling set.
- **`10014 Unknown Emoji`** — `claimEmoji` is a hardcoded snowflake, so a
  deleted or re-uploaded emoji fails on *every* eligible record in the same
  tick. Its own log line, `[REACTION_EMOJI_INVALID]`, and **no state change** —
  had this been keyed on a status that happened to be 404, the branch above
  would have nulled every message link on the list, permanently and
  irrecoverably (nothing re-derives `messageId`: the scan cursor is long past
  those messages, and only a fresh `/review-request` sets it).
- **Any other 4xx, including 403** — no access, or channel overwrites wrong.
  Log, and **still stamp `reactionCheckedAt`**, so the record rotates to the
  back of the queue rather than being retried every tick. A systematic 4xx must
  fail cold: 10,000 invalid responses in 10 minutes risks a temporary IP ban.
- **429** — abandon the remainder of step 8 for this tick, keeping the commands
  already collected.
- **A rejected fetch** (DNS, connection refused) — caught by the step's own
  guard. The existing `finally` in `runTick` covers the lease for anything that
  throws before `finishTick`; the DM loop, which runs after it, has its own
  guard as described above.
- **A full page of reactors** — `length === limit` is indistinguishable from
  "exactly 25 reactors" without another request, so that condition is what
  detects the possible truncation. Beyond the plausible range for a review
  request, but silently dropping reactors would make claims non-deterministic.
  Logging it and using the page anyway is not enough, and the first
  whole-branch review said so: Discord orders reactors by user id rather than
  by reaction time, so the claim holder can sort past the end of the page, and
  the diff would read every reactor beyond it as having un-reacted — releasing
  an active review to whoever landed inside the first 25. A full page is
  therefore reported as a **failed read** (`kind: "truncated"`), which stamps
  `reactionCheckedAt` and leaves `lastReactors` untouched.

A poll that finds nobody reacting is **not** a no-op: it writes
`lastReactors: []` — the empty *set*, which is not null and does license a diff —
and the timestamp. That write is what makes the next removal detectable.

## Observability

`TickReport` gains:

- `reactionsRead` — records actually polled.
- `reactionClaims`, `reactionReleases` — **summed across every `reactionSync`
  result in the tick.** `resultCounters` currently uses `results.find(...)`,
  which returns the first match; there are up to `allowance` of these commands
  per tick, so reusing that shape would report at most one. The shared
  live/read-only helper is the thing that changes, and it must stay shared —
  its own comment records that two hand-written copies of this arithmetic is
  how shadow mode came to report zeroes.
- `reactionsBudgetShed` — `reactionReadsPerTick - allowance`, how much of the
  configured budget the subrequest guard took away. **Not** `eligible -
  allowance`: with 45 records and an allowance of 10 that number is 35 on every
  healthy tick, which is ordinary round-robin rotation and not shedding at all,
  and a counter that is always nonzero cannot signal anything.
- `reactionsEligible` — the size of the eligible set, which is the number that
  actually tells an operator the cycle time (and, per *Known cost*, is not
  bounded).

Plus a `[REACTIONS]` log line every tick — the same argument as `[PRD_CACHE]`:
`read=0` on every tick is the exact shape of this path silently dying, and
without the line it takes a fixture to notice.

Step 8 runs under `readOnly` as well. It is a pure read; its counters project
through `applyCommands` like every other step's, and no DM is sent. Shadow mode
can therefore prove the reaction path selects the right rows before it is ever
allowed to write. The read-only branch returns a hand-built report from its own
`return` site, so every new counter is added in **both** places and
`[REACTIONS]` logs in both.

## Testing

- **Selection** — null-`reactionCheckedAt` first; the shared-`messageId` skip
  claiming neither record; claimed-by-menu excluded and claimed-by-reaction
  included; truncation at the allowance; zero allowance skipping the step.
- **Priming** — an unprimed record (`lastReactors: null`) writes the observed
  set and claims nothing; the *following* poll with the same reactors also
  claims nothing; a reactor added after priming claims.
- **The diff** — newly present claims; **unchanged after a 48-hour auto-clear
  does not re-claim** (its own test: it is the case the diff model exists to get
  right); newly absent releases; a newly absent user who does not hold the claim
  releases nothing; a newly absent user holding a `menu` claim releases nothing;
  a release leaves `claimClearedAt` and `lastClaimedByName` untouched.
- **Promotion and ordering** — A and B both react, A claims, A leaves: B holds
  the claim afterwards; A leaves and B arrives in the same sync: B claims and no
  "already claimed by A" DM is produced (this is the test that pins
  releases-before-claims — it fails under the natural claims-first
  implementation); a promotion does not fire on the auto-clear path.
- **Eligibility gaps** — a menu claim nulls `lastReactors`; a reaction added
  while the record was menu-claimed does not claim on the tick after the menu
  unclaim; resolve then reopen behaves the same way.
- **Arbitration** — a menu claim landing between `beginTick` and `finishTick`
  beats the reaction, and the reactor comes back as `superseded`; a reaction and
  a menu claim produce identical record state otherwise.
- **`claimSource`** — every clearing path (`applyUnclaim`, `clearStaleClaim`,
  `resolveRecord`, `markRequested`) leaves it null; the menu path writes
  `"menu"`.
- **The adapter** — request shape, asserting the colon survives unescaped and
  `limit=25` is present; `10008`, `10014`, a generic 403, and 429 each handled
  as above, including that `10014` changes no state.
- **Burst confirmation** — a holder absent from the type-0 read but present in
  the type-1 read is not released.
- **The handler** — shedding when the subrequest count is already high (needs a
  synthetic fixture; see the note in *Selection and the budget*); step 8
  throwing without taking the digest down; a rejected DM fetch not failing the
  tick or losing the report; DM subrequests counted; DMs sent only for
  `superseded`; a 403 DM tolerated.
- **Migration** — 3 → 4 across records, added to the existing chain test,
  asserting `lastReactors: null` (priming, not `[]`) and `claimSource` derived
  from `claimedBy`.

## Answered objections

**"Promotion re-introduces the silent re-claim the diff model was built to
prevent."** It does not, because it is scoped to a sync that released. The
two-day auto-clear happens in `clearStaleClaims` at step 5 and produces no
release inside any `reactionSync`, so a standing reaction is never promoted onto
a row that went stale on someone. The distinction the design actually cares
about is *did a human take an action* — and a release is one, where a timeout is
not.

**"Confirming burst reads make the budget unpredictable."** They are drawn from
the same allowance, so the ceiling holds regardless; the worst case is that a
tick full of simultaneous releases polls fewer records. Simultaneous releases
across an entire budget's worth of records is not a real load shape.

**"`SUBREQUEST_CEILING` duplicates a limit Cloudflare already enforces."** It
does, and the enforcement is the problem: hitting the real ceiling kills the
tick mid-write, which is the failure the two-store-subrequest invariant exists
to prevent. A number we can shed against is worth carrying even though the
guard rarely binds today.

## Documentation

- `docs/architecture.md` — remove both "plan 3" placeholders (the step 7 comment
  and the `:code_review:` bullet under *What's deliberately not here*); add step
  8 to the refresh loop, the removal-and-promotion semantics to the claiming
  section, and `claimSource` to the data-model notes.
- `docs/architecture-decisions.md` — add `adr-reaction-diff-not-presence`: why
  the stored state is a reactor set diffed per poll rather than a presence check
  plus a re-claim suppression rule; why null-means-unprimed exists and what goes
  wrong across an eligibility gap without it; why a release is silent and
  unmarked; and why destructive handling keys on error code rather than status.
- `docs/operations.md` — the `[REACTIONS]` and `[REACTION_EMOJI_INVALID]` log
  lines, the release latency and how it scales with the open-record count, and
  the note that reactions standing before the deploy do not claim.
- No `docs/setup.md` change: reading reactions needs no permission the bot does
  not already hold.
