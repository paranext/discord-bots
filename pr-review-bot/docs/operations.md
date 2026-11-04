# Operations

What to do when something breaks. Each section names the actual commands.
For what each piece of state means, see `docs/architecture.md`.

Every `/health` command below needs the shared secret set in `docs/setup.md`
step 11 — export it first:

```bash
export HEALTH_TOKEN=<the value you set with `wrangler secret put HEALTH_TOKEN`>
```

A 404 from `/health` means the Worker has no `HEALTH_TOKEN` set at all; a 401
means yours does not match it.

## The digest was deleted

**Signature:** the pinned "Needs review" message is gone from the channel;
`/health`'s `digestMessageId` still points at a message id that 404s if you
look it up.

The next tick notices the delete when its `PATCH` comes back 404, recreates
the message, and posts it fresh (`src/store/memory.ts`, `commitTick`: a
patch that 404s falls through to `createDigest`). **Someone must re-pin it
by hand.** The bot cannot pin messages itself — it deliberately has no
`PIN_MESSAGES` permission (see `docs/setup.md` step 5) — so a recreated
digest sits unpinned in the channel until a human pins it.

## The digest was unpinned

**Signature:** the message is still in the channel and still updating, but
it's no longer pinned, and it stops being easy to find.

Every tick lists the channel's pins and checks whether the digest message id
is among them. The first tick that finds it missing sets
`unpinnedReportedAt` and reports the problem once — not every five minutes.
Re-pin it by hand. The latch (`unpinnedReportedAt`) is cleared automatically
by the next tick that sees the digest pinned again, so if it gets unpinned a
second time weeks later, that's reported too, exactly like the first time.

## Rows are not leaving the list

**Signature:** a PR you know has been reviewed is still showing on the
digest after more than one refresh interval (5+ minutes).

Check:

```bash
curl -s -H "Authorization: Bearer $HEALTH_TOKEN" https://<worker>/health | jq '{syncPaused, credentials}'
```

- If `syncPaused` is nonzero, at least one record's repo returned `NOT_FOUND`
  from GitHub (visibility changed, or the install was revoked for that repo)
  and that record has stopped auto-expiring by design — it needs a human to
  either fix access or `Resolve ▾` it manually.
- If `credentials.app.throttledForMs` or `credentials.public.throttledForMs` is
  a number, that credential group is **backed off, not broken**. GitHub answered
  a secondary rate limit (403 or 429 carrying `Retry-After`, or a spent budget
  signalled by `x-ratelimit-remaining: 0`), and the group is skipped until the
  countdown reaches zero, then resumes by itself. **Do nothing.** This is
  deliberately distinct from `failedClosed`: a throttle that latched the
  credential would stop all syncing for the isolate's life over a limit that
  clears in minutes.
- If `credentials.app.failedClosed` or `credentials.public.failedClosed` is
  `true`, that credential group saw a 401 — or a 403 with no throttle signal,
  which is read as a revoked token — and **retrying has stopped on
  purpose** — repeatedly retrying a bad credential risks a temporary IP ban
  from GitHub. Fix the credential (rotate the token or App key, per below),
  then redeploy: `failedClosed` lives on a credential provider held at module
  scope, so it survives from the tick that saw the 401 to the `/health` request
  you just ran, and on to later ticks — but only within one isolate. A fresh
  deploy starts fresh isolates with the latch cleared, and rotating the secret
  itself also retires the latched provider (the provider is keyed on the
  secrets, so a changed secret gets a new one). There is no in-place "unstick"
  command; redeploying is the reset.
- `credentials.app.tokenExpiresInMs` is `null` until this isolate has actually
  minted an installation token — a worker that has only served `/health` and
  never run a tick against a `paranext` repo has nothing to report yet. That is
  not a fault. Once a tick has minted one, it counts down from about an hour and
  is reused rather than re-minted until it is within five minutes of expiring.
  It says nothing about the App **private key's** age — see the "Ongoing"
  section of `docs/setup.md`.

## The list has gone stale

**Signature:** `/health` returns HTTP 503.

```bash
curl -s -H "Authorization: Bearer $HEALTH_TOKEN" https://<worker>/health | jq '{status, lastSyncAgeMs, leaseHeld}'
```

`status: "stale"` means `lastSyncAgeMs` has exceeded the configured stale
threshold (`config.staleBannerMs`, 30 minutes by default) — the digest itself
will also be showing the "Not syncing" banner in the channel by this point,
in place of its usual "updated" timestamp.

Check `wrangler tail` for what the last few ticks actually did. If
`leaseHeld` is `true` and stays `true` across several tick intervals, a tick
is stuck holding the lease — **a lease older than 15 minutes
(`LEASE_TIMEOUT_MS` in `src/store/types.ts`) is treated as broken and the
next tick takes it anyway**, so this self-heals within 15 minutes without
intervention. If it's still stale after that, look for a tick that's
throwing before it reaches the lease-release path — `wrangler tail` will show
the error.

## Rotating credentials

| Secret | Blast radius if rotated wrong | What to watch |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Bot goes fully offline: no message posts, no reads, no interaction responses | Immediate — you'll notice on the next tick |
| `DISCORD_PUBLIC_KEY` | `/interactions` starts rejecting every request with 401 | Immediate |
| `GITHUB_APP_PRIVATE_KEY` | `paranext`-owned repos stop syncing (`credentials.app.failedClosed`) | **Key age, tracked by hand below — not by `/health`** |
| `GITHUB_PUBLIC_TOKEN` | Non-`paranext` repos (any other owner) stop syncing | Token expiry date, tracked by hand below |

To rotate any secret: `wrangler secret put <NAME>`, then redeploy
(`npm run deploy`) so the running instance picks it up.

**The number to watch for the GitHub App is the private key's age, not any
token expiry `/health` reports.** `/health`'s
`credentials.app.tokenExpiresInMs` is the *installation token's* expiry — that
token is minted fresh from the key roughly once an hour and its expiry tells
you nothing about whether the underlying key itself is stale or about to be
rotated by policy. A PEM file carries no creation timestamp, so there is no
way for `/health` to derive the key's age from the key material itself —
reporting it would mean inventing an entirely new secret purely to hold that
one date. **This is why it must be tracked here, by hand, and why a key
rotated late is caught by whoever reads this document — not by any
endpoint.**

- **GitHub App private key created/last rotated:** _(fill in on first
  deploy — see `docs/setup.md` step 6)_
- **`GITHUB_PUBLIC_TOKEN` expiry date:** _(fill in on first deploy — see
  `docs/setup.md` step 8)_

## Adding a team

Any repo is accepted by `/review-request`; there is nothing to add. A
`paranext` repo is covered because the GitHub App is installed on all
`paranext` repositories (setup step 6), and every other owner goes through the
public token. A PR the bot can't read (a typo, or a private repo outside
`paranext`) is refused at submit as `not-found`.

A team is a one-line PR to `config/config.ts`: add the name to the `teams`
array (order there is the order sections render in on the digest). It takes
effect on the next deploy. No data migration is needed — `teams` is read fresh
from config on every tick.

**Removing a team** needs no migration either, but say what happens to the rows
that were already filed under it: they render in **Triage** from the next tick,
because `ranking.ts` treats a team that is no longer in config as no team at
all. Nobody has to clean the store — re-request the rows that still matter with
a team that exists, and the rest age out on their own. (`/review-request`
already refuses to create a record for a team not in config, so this only ever
applies to rows that predate the removal.)

## Store data lost

**Signature:** `/health`'s `totalRecords` drops to zero (or the Durable
Object is genuinely gone — a new one starts from an empty state).

There is no backup to restore from; recovery is a documented rebuild, not a
restore:

Re-read the bot's own past request messages in the channel (they carry the
same team/urgency/note information that was in the lost record) and re-run
`/review-request` on each one to recreate it. Nothing rebuilds records on its
own: there is no channel scan.

This is why records are retained for 30 days after resolution instead of
deleted immediately — the same mechanism that answers "why did my row
disappear" also gives a longer window to notice and recover from data loss.

## Upgrading to schema version 6

The release that removed the channel scan (`adr-command-only-requests`) is the
first to write schema version 6, and **it cannot be rolled back.** Its first
load of the store permanently deletes every record the scan created, claimed
ones included, and saves the state as version 6. Any earlier build refuses
version 6 (`migrateState` throws), so rolling back stops every tick and
interaction until a build at version 6 or later is deployed again. If something
goes wrong, roll forward.

Before deploying it to a deployment that ran an earlier build:

1. **Note what will be dropped.** Scanned rows are the ones in the digest's
   Needs triage section. Anyone who still wants a review for one of them
   re-requests it with `/review-request` after the deploy.
2. **If the deployment is still in shadow mode** (`READ_ONLY` set to `true`),
   don't deploy until you're ready to go live. Shadow mode is gone and the
   setting is ignored, so the first tick after the deploy posts the digest to
   the real channel and can send claim DMs.
3. **Remove the leftover settings** once the deploy is out:

   ```bash
   wrangler secret delete READ_ONLY
   ```

   In the Discord Developer Portal (Bot → Privileged Gateway Intents), turn
   **Message Content** off. The bot no longer reads messages.
4. **Register the commands again** (`docs/setup.md` step 15), so both commands
   exist even if only `/review-list` was registered for shadow mode, and set
   the channel topic note that step describes.

## The named second owner

Secrets, the Cloudflare account, and Discord's admin permissions for this
bot must be held by **at least two people.** Without a second owner, the
tool dies the first time its author is unreachable — nobody else can rotate
a credential, redeploy, or re-pin the digest after a Cloudflare account
change locks everyone else out, and it degrades silently rather than loudly.

- **Primary owner:** Jolie Rabideau (jolie_rabideau@sil.org)
- **Second owner:** _(name here before go-live — this is a real gap
  until someone is named)_

## Someone pasted a link instead of using the command

It isn't tracked, by design: the bot doesn't read channel messages. Point them
at `/review-request`. If it becomes a habit, a Discord AutoMod rule (a server
setting, not bot code) can block PR links in the channel and show the sender a
private note pointing at the command. The cost is that it also blocks links
people post to discuss a PR, which is why it isn't on by default.

### Reaction claims (refresh-loop step 8)

- `[REACTIONS] eligible=N read=M allowance=A` on every tick. `read=0` every tick
  with `eligible` above zero means the path has stopped working; `eligible`
  climbing means the polling cycle is getting longer.
- `[REACTION_EMOJI_INVALID]` means Discord rejected `config.claimEmoji` — it has
  been deleted or re-uploaded with a new id. The reaction path is disabled until
  the snowflake in `config/config.ts` is updated. Nothing else is affected and
  no state is damaged.
- **`[REACTIONS] full page on <messageId>` means that record's reactions have
  stopped being readable.** `readReactors` asks for 25 (`REACTION_READ_LIMIT`),
  and a page that comes back full may have been cut short. Discord orders
  reactors by user id rather than by reaction time, so the claim holder can
  simply sort past the end of it — and treating a partial page as an
  observation would read everyone beyond it as having un-reacted and hand an
  active review to whoever landed inside the first 25. It is therefore
  discarded as a failed read: the record's `reactionCheckedAt` advances so it
  rotates to the back of the queue, `lastReactors` is left untouched, and no
  claim changes hands. The record cannot be claimed or released by reaction
  until the message drops below 25 reactors; the digest menu still works on it.
  Repeated on the same message, this is someone using the request message as a
  reaction thread, not a bug in the bot.
- **Release latency.** Removing a reaction releases the claim on the record's
  next poll, not immediately: `ceil(eligible / allowance)` ticks, which is 25
  minutes at 10 reads per tick across 45 eligible records and an hour at 120.
  The eligible set is not bounded — resolved records are purged at 30 days but
  open ones never are — so it grows with the number of long-lived open PRs.
  Anyone who needs a row freed immediately should use the digest's claim menu,
  which is instant.
- **Reactions that predate the deploy do not claim.** Schema v4 migrates every
  record to `lastReactors: null`, so the first poll records who is standing on
  each message and claims for nobody. Anyone who wants a row they already
  reacted to must remove and re-add the reaction, or use the menu.
- **A reaction that loses to a menu claim gets no DM.** The private notice
  (`notifySuperseded`) only ever fires out of a `reaction-sync` result, and a
  menu-claimed record never produces one: `applyClaim(..., "menu")` nulls
  `lastReactors`, and `selectReactionTargets` excludes it from the polling set
  the moment the claim source stops being `"reaction"`. A reactor who loses to
  a menu claim is simply never told — the reaction is absorbed silently the
  next time the record re-enters the polling set. If someone reports their
  reaction "didn't work" and no DM ever arrived, check who holds the claim on
  the digest; if it's a menu claim, that's this case, not a bug. They must
  remove and re-add the reaction (or use the menu) to act on the row.
- **`budgets.reactionReadsPerTick` is a subrequest budget, not a record count
  — redo this arithmetic before raising it.** A burst confirmation read (the
  `type=1` check on the release path, in `readReactors`) makes one polled
  record cost two subrequests rather than one, and step 8 charges that second
  request against the same allowance: it decrements a *remaining budget* by
  each read's actual cost, and refuses to start a read that might cost two on
  the last single unit. A full allowance therefore spends at most
  `reactionReadsPerTick`, whatever the mix of one- and two-request reads —
  fewer records get polled when confirmations are common, which is the
  intended trade. At the current default of 10, with a worst realistic
  pre-step-8 spend of about 9 (it was 11 while the retired step 7 spent two
  PRD thread reads), that is
  `9 + 10 + 1 (finishTick) + 4 (superseded DMs) = 24` against the ceiling of
  50 (`SUBREQUEST_CEILING` in `config/config.ts`). The margin is real but not
  unlimited, and `RESERVE = 5` is what holds the last two terms back: redo
  this sum with the tick's actual pre-step-8 count — not the 9 above — before
  raising the budget.
- **The superseded-DM budget is four subrequests, spent or not
  (`DM_SUBREQUEST_CAP`).** Two subrequests buy one delivered DM, so a healthy
  tick sends two; a tick where recipients have "DMs from server members"
  disabled spends its four on failed channel-opens and sends none, logging
  `superseded notice … not sent — per-tick DM budget spent` for the rest. That
  log line means the budget ran out, not that anything broke. The cap is on
  requests issued rather than DMs delivered on purpose: Discord's Create-DM
  abuse ceiling counts attempts, and a blocked recipient is a stable property
  of *their* settings that no number of retries will change.
