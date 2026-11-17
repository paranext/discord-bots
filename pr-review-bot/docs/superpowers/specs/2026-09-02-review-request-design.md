# `/review-request` — Design (plan 2)

**Date:** 2026-09-02
**Status:** Ready to plan. One adversarial review is folded in; every finding is
either applied inline or answered below in *Answered objections*.
**Author:** Jolie Rabideau

Supplements [the v1 design](2026-08-26-pr-review-bot-design.md). That spec
describes the whole bot; this one covers only what plan 2 builds, and records the
decisions the v1 spec deliberately left open. Where the two disagree, this
document wins for plan-2 scope and says so explicitly.

## Scope

Plan 1 shipped rollout stages 1–2: the store, the refresh loop, message scanning,
the pinned digest, the daily post, the claim and resolve menus, and `/review-list`.
It also built `renderRequestMessage` and the `upsertRequest` store command, so
the record transitions this plan needs already exist and are tested.

**In scope:**

- The `/review-request` command handler and its modal.
- `MODAL_SUBMIT` handling: validation, the GitHub fetch, the posted request
  message, the record write, and the digest rewrite.
- The rejection path, its **Fix and retry** button, and the prefill stash.
- The PRD thread cache — refresh-loop step 7.
- **The plumbing all of the above needs and plan 1 did not build** — see below.
  Plan 1 recorded that "plan 2 is the modal plus validation and nothing
  structural"; that is **not correct**, and this plan corrects it rather than
  inheriting it.
- `DISCORD_APP_ID` in `src/env.d.ts`, and the docs for enabling the command.

**Out of scope, deferred by name:**

- The `:code_review:` reaction claim path and refresh-loop step 8 — plan 3.
- Performing rollout stage 3. This plan builds the command; enabling it is an
  operational step gated on the shadow-mode threshold the v1 spec sets.
- Multi-channel, and the same PR needing two teams — unchanged non-goals.

### The plumbing plan 1 did not build

Named here because it is the largest part of this plan and the easiest to
under-scope. None of it is optional.

1. **`ExecutionContext`.** `src/index.ts`'s `fetch` is `(request, env)` — there
   is no `ctx`, so there is no `waitUntil`, and the deferred submit path cannot
   exist without one. The signature gains `ctx`, `InteractionDeps` gains a
   `waitUntil` function (injectable, so tests can run the background work
   synchronously and assert on it), and the existing two-argument
   `worker.fetch(...)` calls in `tests/workers/index.test.ts` are updated.
2. **A Discord client and a credential provider on the interactions path.**
   `DiscordRest` and `credentialsFor(env)` are constructed today only inside
   `scheduled`. The submit path needs both — the first to post the request
   message and edit the deferred reply, the second for `fetchSnapshots`. Both
   join `InteractionDeps`.
3. **A webhook route on `DiscordRest`.** `call()` hardcodes an
   `Authorization: Bot …` header and the class exposes no webhook route.
   `PATCH /webhooks/{app_id}/{token}/messages/@original` needs a new method that
   sends **no** `Authorization` header — the interaction token is the
   credential. Discord's docs do not state whether a bot header is *tolerated*
   there, so the design does not rely on folklore either way: send no header,
   which is the documented shape.
4. **Interaction and response types.** `CallbackType` has only `Pong`,
   `ChannelMessageWithSource` and `DeferredUpdateMessage`; it gains
   `DeferredChannelMessageWithSource: 5` and `Modal: 9`. `InteractionResponse.data`
   gains `components`, `custom_id` and `title`. The `Interaction` interface in
   `src/handlers/interactions.ts` gains `id`, `token`, and `data.components`.
5. **Button routing.** `handleComponent` reads `interaction.data.values[0]` and
   runs `decodeOptionValue` on it **before** it inspects `custom_id`, so a
   button — which carries no `values` — is answered "Could not read that
   selection" and never reaches a handler. The `custom_id` check must move
   first. This is a live bug in the shape of the existing code, not a new
   feature, and it gets its own regression test.

## Decisions

| Decision | Rationale |
|---|---|
| The PRD cache lives in the **Durable Object's `Meta`**, not KV | The v1 spec lists the cached PRD list as *eligible* for KV; eligible is not required. KV is eventually consistent, and the cache is read within seconds of being written — a list refreshed by the tick is read by the very next modal. Using the DO also avoids a second store to bind, fake and test. This settles the question `adr-no-kv-namespace` left open: that ADR deferred the call to "when that plan lands", and the answer is that the binding is still not needed. |
| The prefill stash lives in `Meta` too | Not a new decision: the v1 spec already says the values are stashed "in the store". Recorded here only because this plan is what implements it. |
| The modal renders even when the PRD cache is empty | A cold cache is normal on first deploy and after any reset. Refusing to open the modal turns the cache — which exists to keep the 3-second budget safe — into a visible outage on the primary command. With an empty cache the dropdown offers only **None**, and the field's description says the list is still loading. The worst case is one request with no PRD, which is what every scanned record already looks like. |
| A failed thread fetch leaves the previous cache **untouched** | The cache write is skipped, never applied with an empty list. A week-old PRD list is a working dropdown; an empty one is the failure the cache exists to prevent. |
| "Not found" and "not visible" are **not** distinguished per-PR | The v1 spec asks for this. GitHub's GraphQL API deliberately returns `NOT_FOUND` for a private PR the credential cannot see, so the distinction is not recoverable from the response — `src/github/query.ts` already collapses both into `notFound`. What *is* recoverable is a wholesale credential failure for that owner's group (`failedGroups`), which gets its own message. Everything else gets one honest rejection naming both possibilities and both fixes. This is a softening of the v1 spec, made because the alternative is a message that guesses. |
| The record is written **before** the request message is posted | The stored record is the input to `renderRequestMessage`, and the record stores the posted message's id — a cycle. Committing first with `messageId: null`, rendering from the stored record, posting, then writing the id back costs three store round-trips off the deferred path. The alternative — projecting the record in the handler to render before committing — duplicates `markRequested`'s reopen-and-clear-claim logic in a second place, where it can drift. If the post fails the record still exists and the digest still shows it. |
| Cached thread ids are **not** validated at submit time | A thread deleted between cache refresh and submit renders as a dead `<#id>` mention in one request message. A validating lookup on the submit path buys almost nothing and adds a failure mode to the path that must not fail. |
| String selects sit inside `Label` components (type 18) | Verified against current Discord component documentation: string selects are supported in modals, but must be wrapped in a `Label` rather than an action row, and text inputs should be too. |

## The modal

Opened by responding to the `APPLICATION_COMMAND` interaction with callback type
9, built **entirely from cached data**. No fetch of any kind happens on this
path: a modal cannot be sent after a deferred response, so there is no escape
hatch if the 3-second budget is missed, and any live call here is a latent
outage. The one read is the store snapshot, which `/review-list` already does on
the same budget.

Five top-level components, each a `Label` wrapping one input. Five is the
documented modal cap (1–5 top-level components) as well as the v1 spec's design
ceiling.

| Field | Component | Notes |
|---|---|---|
| PR link | Text input, required | Placeholder shows the expected shape. |
| Team | String select | From `config.teams`. |
| Urgency | String select | From `config.urgencies`, emoji plus words. |
| PRD | String select | **None** first, then up to **24** cached threads. |
| Note | Text input, optional | Required for 🔥, enforced on submit. |

**Character budgets**, which the renderer must clamp to rather than discover at
runtime: `Label.label` 45, `Label.description` 100, select option `label`,
`value` and `description` 100 each, modal `title` 45, `custom_id` 100.

**The two conditional hints have one home each, and they are different
components.** The 🔥-requires-a-note hint is the **urgency option's**
`description`, because it belongs to the choice that triggers the rule. The
truncation note is the **PRD `Label`'s** `description`, because it describes the
whole field. The cold-cache note ("list still loading") occupies that same
`Label.description` when the cache is empty; the two cannot both apply, since an
empty cache is never truncated.

**The PRD select carries at most 25 options in total.** Discord caps a string
select at 25, and **None** is one of them, so the cache contributes 24.
`src/core/render/digest.ts` already does this arithmetic for the resolve menu's
reopen options; the same reservation applies here.

**🔥 requires a note, enforced server-side.** `required` is a static field in the
payload Discord renders before the user picks anything, and a modal has neither
conditional logic nor a re-render. An empty note with 🔥 urgency is therefore a
rejection like any other, carrying the same **Fix and retry** button.

## The submit path

`MODAL_SUBMIT` answers immediately with a deferred ephemeral response (type 5 —
only type 9 is forbidden for a modal submit) and finishes the work in
`waitUntil`, editing that reply through
`PATCH /webhooks/{app_id}/{token}/messages/@original`. The application id is
needed at request time, so `DISCORD_APP_ID` joins `src/env.d.ts`; the
registration script and `docs/setup.md` already use the secret.

It stays a **separate secret from `DISCORD_BOT_USER_ID`** even though for a bot
application the two snowflakes are in practice the same value. The equality is
not documented, and an operator who sets them differently would get a 404 on
every followup edit, on the path that must not fail. One explicit secret with one
documented purpose beats a derived value resting on an undocumented identity.

In order:

1. **Pure validation** — URL shape (`core/urls.ts`), repo allowlist, and the 🔥
   note rule. No network. On failure the values are stashed and the rejection is
   patched in. Nothing reaches the record set.
2. **Fetch the PR** — `fetchSnapshots` on a one-slug batch, which already
   returns title, state, merged, draft and author. Merged or closed rejects,
   naming which. A draft proceeds and is marked `draft`, since a draft PR can
   legitimately want early feedback.
3. **Write, post, backfill** — `upsertRequest` with `messageId: null`; read the
   stored record back; render and post; write the message id with a **new
   `setRequestMessageId` command** (see Storage). Re-issuing `upsertRequest` is
   not an acceptable substitute for that third command: it routes through
   `markRequested`, which advances `lastRequestedAt` and increments
   `requestCount`, so a single first-time request would land at `requestCount: 2`
   and move the field the digest's staleness fence compares against — making a
   claim on the digest that was just rendered fail as `stale`.
4. **Digest** — the `upsertRequest` apply passes
   `rerender: config.immediateDigestRewrite`, the same path claim and resolve
   already use.
5. **Confirm** — the deferred ephemeral is edited to say whether a record was
   created, updated, or reopened, and to report a failed channel post if one
   happened.

Re-request semantics are already implemented in `markRequested` and unchanged
here: `lastRequestedAt` advances, `requestCount` increments, any claim is
cleared, a resolved record is reopened with its `{resolvedAt, resolvedBy}` pair
appended to `resolutionHistory`, and `firstRequestedAt` never moves.

### What the submit path races against, and what it does about it

`RecordsObject.apply` does not consult `syncLease` — the lease gates `beginTick`
only. So the submit path's three store calls interleave freely with a running
tick, including during `finishTick`'s deliberately un-blocked Discord I/O window.
Two consequences, both accepted with a stated reason:

- **A concurrent tick can resolve the record between the write and the
  read-back**, so the message posted describes a row that is already off the
  list. Accepted: the window is milliseconds, the outcome is one message with no
  matching digest row, and the requester can re-request. Closing it would mean
  taking the lease on the interactive path, which is exactly what the store's
  design refuses to do.
- **With `immediateDigestRewrite: true` the rerender's PATCH can overlap
  `commitTick`'s.** The `digestBodyVersion` compare-and-set keeps the stored hash
  honest — it cannot record a hash for a body the message is not showing — but it
  does not order the two PATCHes, so the digest can briefly show the older body.
  The next tick corrects it. This is pre-existing for claim and resolve; what is
  new is that the submit path is a third writer, and the slowest one. Noted so a
  reviewer sees a known cost rather than an oversight.

## Rejections and the prefill stash

Every rejection is ephemeral, names the specific problem and its fix, **echoes
the submitted values inline**, and carries a **Fix and retry** button whose
`custom_id` is `request:retry:<interactionId>` — well inside the 100-character
cap that rules out carrying the values themselves.

The submitted values are stashed in `Meta.retryStash` under the interaction id
with a TTL of `config.retryStashMs`, and the entry records the submitting user
id.

**`config.retryStashMs` is set longer than Discord's 15-minute interaction token
lifetime** — 30 minutes — and this is deliberate. At exactly 15 minutes the
expiry branch is unreachable: the button lives on a message created by that same
token, so it dies at the instant the stash does, and the user sees Discord's bare
"This interaction failed" instead of anything this design wrote. A longer TTL
makes the button's own window the binding constraint and the expiry branch a real
path a user can reach. It is a config field, not a literal, for the same reason
`reopenWindowMs` is one: two places read a window and must not drift.

- **Stash expired** — the modal opens empty with a note saying so. Nothing is
  lost: the rejection text echoed the values, which is exactly why it does.
- **Wrong user** — refused. This branch is **defensive**, not user-facing: the
  rejection is ephemeral, so only the submitter can see the button. It is tested
  because a stash key is not a capability, and the check is what makes that true.
- **Expiry is enforced on write, not by the tick.** `stashSubmission` prunes
  entries past their TTL and caps the map at 50 entries, dropping oldest-first,
  inside the same atomic apply. The existing `purgeResolved` command cannot do
  this — it filters `state.records` and never reads `state.meta` — and a
  tick-driven sweep would not run at all when a tick is turned away with
  `lease-held`, nor in `READ_ONLY` mode, where nothing but the lease release
  commits. Pruning on write also bounds the map structurally: all state lives
  under one Durable Object key, so an unbounded map on a path with no cap is a
  storage-size problem, not just untidiness.

## The PRD thread cache

Refresh-loop step 7, currently a comment in `src/handlers/scheduled.ts`:

- `GET /guilds/{id}/threads/active` — guild-wide, so results are filtered by
  `parent_id === config.prdForumChannelId`. Ordered by thread id, not activity,
  so re-sorted.
- `GET /channels/{prdForumChannelId}/threads/archived/public?limit=25` — **one
  page per tick, by choice.** The endpoint is ordered by `archive_timestamp`
  descending and reports `has_more`, and its `before` parameter is an ISO8601
  timestamp rather than a snowflake, so pagination is available; it is declined
  because only the newest slice can survive the 24-option cap anyway. `has_more`
  is ignored deliberately, not overlooked.

`core/prd.ts` merges the two by thread id, sorts by `last_message_id`
descending, clamps names to 100 characters, caps at 24, and reports `truncated`
when more existed.

`last_message_id` is optional **and** nullable, and Discord states it "may not
point to an existing or valid message" — so the sort treats absent, null and
unparseable alike, falling back to the thread id. Both are snowflakes and
therefore time-ordered, but they encode different clocks: a thread id is
creation time, `last_message_id` is last activity. The mixed sort is
consequently an approximation of "most recently active", not a total order on
it. That is acceptable for a 24-entry dropdown and is stated so nobody later
reads the sort as exact.

The result becomes a `setMeta` patch in the tick's existing command list,
committed in the same atomic write as everything else that tick — the tick
already emits `setMeta` patches this way, so no new command is needed. In
`READ_ONLY` mode it is fetched, logged, and not committed, like every other
command. The two fetches are added to `TickReport.subrequests`, which the tick
maintains by hand.

## Storage

`Meta` gains two fields, and `CURRENT_SCHEMA_VERSION` moves to 3:

```
prdCache: { options: { id, name }[]; truncated: boolean; refreshedAt: number } | null
retryStash: Record<string, { userId, values, expiresAt }>
```

Three things change together, per `src/store/schema.ts`'s own instructions and
`adr-durable-object-schema-version`:

1. A migration step in `migrateState` upgrading version 2 to 3, defaulting
   `prdCache` to `null` and `retryStash` to `{}`.
2. **`StoredMeta` widened** so the *old* shape stays expressible. Without this
   the version-2 state is untypeable and the step has nothing to read.
3. **`emptyState()`** gains both fields, since that is where a fresh deploy's
   shape comes from.

**One new command: `setRequestMessageId`.** It writes `messageId` onto an
existing record and nothing else — no `lastRequestedAt`, no `requestCount` — for
the reason the submit path's step 3 gives. It returns `not-found` if the record
is gone.

**No `setPrdCache` command.** `prdCache` is an ordinary `Meta` field, so
`MetaPatch` covers it and `setMeta` writes it.

**`stashSubmission` is a command rather than a `setMeta` patch**, and this is the
one place the distinction is load-bearing: it must read the existing map, prune
it, add an entry and cap it — a read-modify-write that has to happen *inside*
the atomic apply. Building the new map in the handler and shipping it as a
`setMeta` patch would lose any entry a concurrent tick wrote in between.

The prefill is read straight off `readState()` rather than through an atomic
take: reading a prefill twice is harmless. (An atomic take would be possible —
`CommandResult` already has a value-bearing variant in `{ kind: "count" }` — it
is simply not needed.)

## Testing

Following the split the repo already uses.

**`tests/core/` — pure, snapshotted:**

- The modal payload: default, prefilled, empty PRD cache, truncated PRD cache,
  and a cache of exactly 24 and 25 threads to pin the option-count arithmetic.
- Every rendered string clamped to its documented cap.
- `core/submit.ts` across every rejection reason, including 🔥 with a
  whitespace-only note.
- The rejection renderer: echoed values, retry button, each reason's text.
- `core/prd.ts`: merge, dedupe, sort with a missing and a null
  `last_message_id`, the 24 cap and the `truncated` flag, name clamping.

**`tests/workers/` — against fakes:**

- The submit sequence in order, asserting no network call precedes validation.
- The write/post/backfill steps with the post failing: the record survives and
  the ephemeral says the post failed.
- **`setRequestMessageId` leaves `lastRequestedAt` and `requestCount` alone** —
  the regression that a re-issued `upsertRequest` would cause.
- The retry button reaching its handler at all — the `custom_id`-before-`values`
  ordering in `handleComponent`.
- A stash that has expired, a stash claimed by a different user, and
  `stashSubmission` pruning and capping the map.
- Step 7 leaving the previous cache in place when either thread fetch fails.
- `READ_ONLY` committing nothing on the **cache** path.
- A version-2 state migrating forward with sane defaults for both new fields.

**Fixtures and preview:** recorded responses for both thread endpoints under
`fixtures/responses/` — including a forum-channel archived-threads response,
since Discord documents that route under text-channel parents and forum
behaviour is not stated there — and the modal plus each rejection added to
`preview/build.ts`. The v1 spec's own render proof caught a defect the prose had
hidden; a modal is exactly the kind of artifact prose gets wrong.

## Answered objections

Raised by review and deliberately **not** acted on:

- **"`READ_ONLY` should apply to the submit path too."** It cannot be reached:
  `READ_ONLY` is shadow mode, which is rollout stage 2, and `/review-request` is
  not registered until stage 3. The requirement is dropped rather than
  implemented, and the inconsistency it would otherwise create — one interactive
  path honouring the flag and the claim/resolve paths not — never arises. If
  shadow mode is ever run with the command registered, this is the first thing
  to revisit.
- **"The submit path should take the lease."** No. The store's whole design is
  that interactive writes never block on a tick; the races this creates are
  enumerated above and are individually cheap.

## Rollout and documentation

This plan **builds** stage 3 and does not perform it. `npm run register-commands`
keeps registering only `/review-list`; `--all` adds `/review-request` when the
shadow-mode threshold in the v1 spec has actually been met. Scanning stays on
permanently, per `adr-scanning-as-permanent-fallback`.

- `src/env.d.ts` — `DISCORD_APP_ID`. `docs/setup.md` already documents the
  secret; only the binding declaration is missing. The setup doc still gains the
  PRD forum read permission.
- `docs/operations.md` and `README.md` — the enable step, and what a requester
  sees when the PRD list is still warming.
- `docs/architecture-decisions.md` — amend `adr-no-kv-namespace`, which
  explicitly deferred this decision to this plan, to record that the PRD cache
  landed in the Durable Object and the binding is still not needed. Add one new
  ADR for the not-found/not-visible softening.
- `docs/architecture.md` — its "what's deliberately not here" bullet covers the
  command, the modal *and* the cache in one entry, and asserts the command "is
  not wired up yet". The whole bullet goes, not just its PRD clause.
