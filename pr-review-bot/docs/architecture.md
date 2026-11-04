# Architecture

For the full rationale behind every decision here, see
[the design spec](superpowers/specs/2026-08-26-pr-review-bot-design.md) and
[`docs/architecture-decisions.md`](architecture-decisions.md). This document
is the map: where a given behavior lives, so you don't have to read every
file to find it.

## The two entry points

`src/index.ts` is the whole worker. It exposes exactly two entry points and
nothing else:

- **`POST /interactions`** (`src/handlers/interactions.ts`) — every Discord
  interaction. Verifies Discord's Ed25519 signature (`src/discord/verify.ts`)
  against the app's public key before doing anything else with the body, then
  routes on interaction type: `ApplicationCommand` for `/review-list` and
  `/review-request` (the latter opens the modal, built from config alone — no
  fetch and no store read), `ModalSubmit` for the submitted `/review-request`
  form (deferred with callback type 5, then finished in `waitUntil`), and
  `MessageComponent` for the `Claim a PR ▾` and `Resolve ▾` select menus plus
  the **Fix and retry** button a rejected submission carries (routed by its
  `custom_id` prefix, ahead of the select menus, since a button carries no
  `values`). Also handles Discord's PING
  (interaction type 1) so the endpoint URL can be registered in the
  Developer Portal. `/review-request`, its modal submit, and its retry button
  are all further gated on `interaction.channel_id` being in
  `config.allowedChannelIds` (`src/handlers/interactions.ts`).

  The spec asks a stash-expired retry to reopen an empty modal "with a note
  saying so"; `handleRetryButton` (`src/handlers/reviewRequest.ts`) instead
  answers with an ephemeral message pointing back at the rejection's echoed
  values. Deliberate, accepted deviation: a blank form the user has to retype
  from scratch is worse than being told their old values are still readable
  in the message above and to run `/review-request` again.
- **`scheduled()`** (`src/handlers/scheduled.ts`, `runTick`) — a cron trigger
  every five minutes (`wrangler.jsonc`'s `triggers.crons`). Re-syncs against
  GitHub, reads reactions for claims, clears stale claims, purges
  expired records, and rewrites the pinned digest.

There is no gateway connection anywhere in this codebase. A gateway
connection needs a persistent WebSocket and a process that stays alive to
hold it; Cloudflare Workers don't have a "stays alive" concept, and the two
things this bot needs from Discord — receiving interactions and reading
pins and reactions — are both available over plain HTTP (`POST /interactions`
is pushed to the worker by Discord itself; pins and reactions are pulled by
the cron tick). The bot never reads message content, so it needs no
privileged intent. A gateway would buy nothing
here and cost a component this design doesn't need to run.

`GET /health` (`src/handlers/health.ts`) is a third, minor route — see
Monitoring below. It is behind the `HEALTH_TOKEN` shared secret and answers
404 when that secret is unset: the body names the App installation id,
credential failure reasons, the digest message id and the lease state. See
`adr-health-behind-a-shared-secret`.

## The three module seams

```
src/core/      pure functions, no I/O
src/discord/   Discord REST calls, signature verification, component payloads
src/github/    credential routing, one batched GraphQL query
src/store/     the serialized store (Durable Object + in-memory test double)
src/handlers/  wires the above together for each entry point
```

**`src/core/` has no I/O, by rule.** Everything that decides "is this record
still open," "which section does this row render into," "has the digest body
actually changed" lives here as pure functions of their arguments — plain
data in, plain data out. This is where the logic that can be *subtly* wrong
lives (an off-by-one in the exit condition silently drops or resurrects
rows), so it's the part fully testable without a network, without Discord,
without GitHub, and without a clock.

That last part is enforced mechanically, not just by convention:
`eslint.config.js` bans the global `Date` for everything under `src/core/**`
via `no-restricted-globals` (adapters — `src/handlers/**`, `src/discord/**`,
`src/github/**`, `src/store/**` — get it turned back on, since something has
to call `Date.now()` eventually). Every core function takes `now` as an
explicit argument instead. This is what makes the digest renderer a pure
function of `(records, lastSync, now)` and is why the snapshot tests can
assert on it without their expectations rotting every time the clock ticks
past an hour boundary.

`src/discord/` and `src/github/` are the adapters: thin enough to be stubbed
with a fake `fetch` in tests, and that's exactly how they're tested (see
`tests/workers/rest.test.ts`, `tests/workers/query.test.ts`) — asserting
request shape, not live behavior.

## The store's command interface

The store (`src/store/types.ts`'s `Store` interface, implemented by
`src/store/do.ts`'s `RecordsObject` for production and
`src/store/memory.ts`'s `MemoryStore` for tests) is not called with a
callback. It's called with a list of `Command` values — `claim`, `resolve`,
`upsertRequest`, `setMeta`, and so on — and returns `CommandResult` values.

**Why commands rather than a callback:** the production store is a Cloudflare
Durable Object, invoked over an RPC boundary (`env.RECORDS.get(id)` returns a
stub; every method call on it is a message send, not a local function call).
A closure captured in the caller cannot be serialized across that boundary —
you can't hand a Durable Object "here's a function, call it with your
internal state." A command is plain, serializable data, so it crosses the RPC
boundary the same way any other argument does. The `Store` interface has
exactly one implementation shape that works over RPC and one that doesn't;
commands are the one that does.

**Why the digest `PATCH` happens inside the store**, not in the caller after
`apply()`/`finishTick()` returns: the record write, the digest render, and
the body-hash comparison all need to happen against the *same* committed
snapshot (see "Rendering reads the committed state" below). If the caller
read records, then separately called the store to render-and-patch, an
interactive write (a claim from the digest menu) could land in the gap
between those two calls and get silently overwritten by a stale render. Doing
it all inside one store call — `finishTick` for the cron tick, `apply` with
`rerender: true` for an interactive command — means the record, the message,
and the hash are written by one operation rather than by a caller working from
a snapshot it read earlier.

**But that is not mutual exclusion, and the refresh lease does not provide it
either.** The lease serialises ticks against ticks; `apply()` deliberately
bypasses it so an interactive claim is not queued behind a GitHub call. So a
tick and an interaction are always two concurrent writers to the same Discord
message and the same `digestBodyHash`. Which body the message ends up showing
is decided by the order **Discord** processes the two `PATCH`es; which hash ends
up stored is decided by the order the two **responses** come back, and those
orders are independent. A blind hash write can therefore leave the stored hash
matching a body the message is not displaying — after which every later tick
renders that same body, matches the hash, reports `skipped-unchanged`, and never
repaints.

Both write paths therefore **compare-and-set** the hash
(`digestHashWriteBack` in `src/store/memory.ts`): a writer stores its hash only
if nothing else has written the hash since it read. If something has, the two
`PATCH`es crossed and neither writer can know whose body Discord kept, so the
hash is set to `null` and the next tick repaints unconditionally. One redundant
`PATCH` is the only safe direction to err in; the opposite error is permanent.

**The compare is on a counter, not on the hash value.** `Meta.digestBodyVersion`
counts how many times `digestBodyHash` has ever been written; `applyOne` derives
it from the patch (`MetaPatch` excludes it, so no call site can forget), and the
compare-and-set compares that. Comparing the *value* is not enough, because the
value can leave and come back inside one writer's `PATCH` round-trip: the digest
renders a coarse projection of each record — `renderDigest` never reads
`resolvedAt`, `resolutionHistory` or `claimedAt` — so claiming a row, reopening
the row the tick just cleared, and unclaiming the first row returns the rendered
body, and with it the stored hash, to exactly what the tick read. A value
compare passes there and stores a body nobody is looking at; and the next tick
re-derives that same body from unchanged GitHub data, matches the stored hash,
and skips the `PATCH` — so there is never another compare to fail into `null`.
That is ABA, and it is why the counter is the compared quantity: a monotonic
counter cannot return to a previous value, so the failure is structurally
impossible rather than merely unlikely.

## The two-store-subrequest invariant

Cloudflare counts Durable Object stub calls against the same 50-subrequest
ceiling as outbound `fetch` (on the free plan). Per-row store writes would
both blow that budget on a large record set and let a tick die mid-write. So
the tick makes **at most two store subrequests regardless of record count**:

1. `beginTick(now)` — takes the lease atomically and returns a snapshot. One
   subrequest.
2. `finishTick({ commands, now })` — applies every command from this tick,
   re-reads, renders the digest, `PATCH`es it if changed, posts the daily
   message if due, and releases the lease. One subrequest.

Everything the Durable Object does internally between those two calls —
`ctx.storage.get`/`put` — is DO-internal storage and does **not** count
against the invoking worker's subrequest ceiling (see the comment at the top
of `src/store/do.ts`). Only calls *into* the DO from outside it count. The
Discord `PATCH` inside `finishTick` is an outbound `fetch` from inside the DO
itself, which is also not charged to the calling worker's ceiling — it's
counted, if at all, against the DO's own limits, which are far higher.

An interactive handler (a claim from the digest menu) makes **two** additional
subrequests, independent of the tick's two: `store.readState()` first, to find
the record the selected option names and decide which command to build (claim
vs. unclaim, resolve vs. already-cleared, reopen-in-window vs. not), and then
`store.apply(...)`. Both are per-interaction, not per-record, so the count does
not grow with the list.

## Data flow: a link becomes a digest row

1. Someone runs `/review-request` in the review channel
   (`src/handlers/reviewRequest.ts`). Any owner and repo is accepted; there is
   no repo list. The submit parses the PR link (`parsePrUrl`,
   `src/core/urls.ts`), checks the form fields, and looks the PR up on GitHub
   with the credential `routeOwner` picks. A PR that is not found (a typo, or a
   private repo the bot can't see), whose credential fails, or that is already
   merged or closed is refused with a private message and a **Fix and retry**
   button; nothing is written.
2. On success the handler issues `upsertRequest` (a new record is built by
   `newCommandRecord`, `requestCount: 1`, `lastRequestedAt` set to the request
   time), posts the request message, then `setRequestMessageId` stores that
   message's id (null until the post succeeds). A pasted link without the
   command never reaches this path: nothing reads channel messages, so it is
   not tracked.
3. GitHub is queried per credential group (`src/github/credentials.ts` routes
   `paranext` to the GitHub App, everything else to the public token), in
   chunks of 25 PRs per GraphQL request (`src/github/query.ts` — GitHub
   terminates requests running over 10 seconds with a 502/504, which bounds
   the safe chunk size).
4. The exit condition (`src/core/exit.ts`) runs against each snapshot: merged
   or closed resolves immediately; otherwise, any review event newer than
   `lastRequestedAt` resolves it, filtering out bot reviews, the PR author's
   own reviews, and `PENDING` reviews with no `submittedAt`.
5. `finishTick` re-reads the store's current state (picking up anything an
   interactive claim wrote while GitHub was being queried), renders the
   digest from that committed state (`src/core/render/digest.ts`), and
   `PATCH`es the pinned message only if the rendered body's hash
   (`src/core/hash.ts`) differs from the last one written — and stores that new
   hash only if no other writer has stored one in the meantime (see the
   compare-and-set above). A digest message it had to **create** is persisted
   immediately, before the daily post is attempted, so a rejected daily post
   cannot lose the id and cause the next tick to post a second digest.

Refresh-loop step 6 is retired. It was the channel scan, which turned PR links
found in channel history into records; `/review-request` is now the only way a
PR gets onto the digest (see `adr-command-only-requests`). Schema version 6
deleted the scanned records it had made.

Refresh-loop step 7 is retired. It used to refresh a cached list of PRD forum
threads for the `/review-request` modal, but that forum lived on a server the
bot no longer reaches, so the PRD field was removed (schema version 5). The
later steps keep their numbers so log tags and references stay stable.

Step 8 reads `:code_review:` reactions for eligible records — open, with a
`messageId` no other record shares, and either unclaimed or claimed by a
reaction — oldest-unchecked first, under a per-tick allowance that sheds first
when the tick nears its subrequest ceiling. It does not ask "who is reacting?"
but "what changed since the last poll?": each record stores the reactor ids seen
at its previous poll (`PrRecord.lastReactors`), and the store diffs the observed
set against it. Adding the reaction claims; removing it releases a claim that
was made by reacting (`PrRecord.claimSource` is what keeps a menu claim out of
the reaction path's reach); a release promotes anyone still standing on the
message. A null `lastReactors` means unprimed — the record has entered or
re-entered the polling set and nothing has been observed yet — so that poll
records the set and acts on nothing. See
`adr-reaction-diff-not-presence`.

## Spec section → implementation file

| Spec section | Where it lives |
|---|---|
| Exit condition | `src/core/exit.ts` |
| Configuration | `config/config.ts` |
| Authoring flow (request message) | `src/core/render/request.ts` (modal + validation are plan 2) |
| Reopening a resolved record | `src/core/record.ts` (`reopenRecord`), `src/handlers/interactions.ts` |
| The posted request message | `src/core/render/request.ts` |
| The pinned digest | `src/core/render/digest.ts` |
| Refresh loop | `src/handlers/scheduled.ts` (`runTick`) |
| Rendering reads the committed state | `src/store/memory.ts` (`commitTick`), `src/store/do.ts` |
| Data model | `src/core/record.ts`, `src/store/types.ts` |
| Claiming and removal | `src/core/claims.ts`, `src/handlers/interactions.ts`, `src/core/ranking.ts` (menu population), `src/core/reactions.ts` (reaction claim/release path) |
| Failure modes | `src/store/memory.ts` (`commitTick`), `src/github/credentials.ts`, `src/handlers/health.ts` |
| Permissions and security | `src/discord/verify.ts`, `docs/setup.md` |
| Hosting constraints | `wrangler.jsonc`, `src/store/do.ts`, `config/config.ts` (`immediateDigestRewrite`) |
| Monitoring | `src/handlers/health.ts` |
| `/review-list` | `src/handlers/reviewList.ts` |
| Preview harness | `preview/build.ts`, `npm run preview` |

## Testing notes

`wrangler.jsonc` deliberately carries no `vars` block with placeholder secret
values — secrets never appear in the repo, full stop, not even as obviously-
fake test placeholders. Under `@cloudflare/vitest-plugin`'s `cloudflareTest`
environment (the `"workers"` project in `vitest.config.ts`), this means
`env.GITHUB_APP_PRIVATE_KEY` and the other secret bindings are `undefined` in
tests, not strings — there is nothing in config for the test runtime to read.

Every test path as of this writing tolerates that: `CredentialProvider
.health()` and the paths `tests/workers/index.test.ts` exercises never touch
the raw `GITHUB_APP_PRIVATE_KEY` value, only whether a credential group has
failed closed. **A future test that exercises RS256 JWT signing, or any code
path that actually parses `GITHUB_APP_PRIVATE_KEY` as PEM, must inject a
throwaway test key explicitly inside that test** — generate or hardcode a
PEM in the test file itself, clearly labeled as a throwaway that is not a
real credential — rather than expecting one to be present in `env`. Without
this note, the failure that shows up is a confusing `undefined` deep inside
a Web Crypto call (`crypto.subtle.importKey`), far removed from its actual
cause.

## What's deliberately not here

- No KV namespace, no `META` binding. See `adr-no-kv-namespace` in
  `docs/architecture-decisions.md`.
- No gateway connection (see above).
