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

## The `/review-request` PRD dropdown looks empty or stale

**Signature 1:** `wrangler tail` shows `[PRD_CACHE_SKIPPED]` on a tick.

Refresh-loop step 7 (`src/handlers/scheduled.ts`) fetches the guild's active
threads plus one page of the PRD forum's archived threads and writes the
result to `Meta.prdCache`. A failed fetch logs `[PRD_CACHE_SKIPPED]` and
writes nothing — the cache from the last successful refresh is still served,
deliberately, because a stale list is a working dropdown and an empty one is
not. Check the bot's channel permissions on the PRD forum
(`docs/setup.md` step 5) first; a revoked or never-granted `View Channel` /
`Read Message History` there is the most likely cause.

**Signature 2:** the `/review-request` modal's PRD dropdown offers only
**None**, with a description saying the list is still loading.

This is the cold-cache case, not "there are no PRDs": the cache has never
refreshed successfully since this Durable Object was created (or since a
schema migration reset it). It self-heals on the next successful tick with
no operator action, unless ticks are also logging `[PRD_CACHE_SKIPPED]`
(signature 1 above), in which case fix that first.

## Rotating credentials

| Secret | Blast radius if rotated wrong | What to watch |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Bot goes fully offline: no message posts, no reads, no interaction responses | Immediate — you'll notice on the next tick |
| `DISCORD_PUBLIC_KEY` | `/interactions` starts rejecting every request with 401 | Immediate |
| `GITHUB_APP_PRIVATE_KEY` | `paranext`-owned repos stop syncing (`credentials.app.failedClosed`) | **Key age, tracked by hand below — not by `/health`** |
| `GITHUB_PUBLIC_TOKEN` | Non-`paranext` repos (e.g. `scripture-editors`) stop syncing | Token expiry date, tracked by hand below |

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

## Adding a repo, adding a team

Both are one-line PRs to `config/config.ts`:

- **Repo:** add `"owner/repo"` to `repoAllowlist`. If it's under `paranext`,
  confirm the GitHub App install covers it (step 6 of setup); otherwise the
  public token already covers any public repo with no further setup.
- **Team:** add the name to the `teams` array (order there is the order
  sections render in on the digest).

Both changes take effect on the next deploy. No data migration is needed —
`teams` and `repoAllowlist` are read fresh from config on every tick.

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

1. The next tick's scan step re-reads the configured lookback window
   (`config.scanLookbackMs`, 7 days) and reconstructs scanned records from
   any PR links still visible in the channel's recent history.
2. For anything requested via `/review-request` outside that window, re-read
   the bot's own past request messages in the channel (they carry the same
   team/urgency/PRD/note information that was in the lost record) and
   re-run `/review-request` on each one to recreate it.

This is why records are retained for 30 days after resolution instead of
deleted immediately — the same mechanism that answers "why did my row
disappear" also gives a longer window to notice and recover from data loss.

## The named second owner

Secrets, the Cloudflare account, and Discord's admin permissions for this
bot must be held by **at least two people.** Without a second owner, the
tool dies the first time its author is unreachable — nobody else can rotate
a credential, redeploy, or re-pin the digest after a Cloudflare account
change locks everyone else out, and it degrades silently rather than loudly.

- **Primary owner:** Jolie Rabideau (jolie_rabideau@sil.org)
- **Second owner:** _(name here before shadow mode ends — this is a real gap
  until someone is named)_

## Shadow-mode measurement log

While shadow mode is running, log daily:

- every row still listed 30 minutes after a review landed (target: zero;
  **two or more means fix before proceeding**)
- every hand-posted PR that never appeared on the digest (same threshold)

**Honest limits of this measurement, so they aren't forgotten mid-sprint:**
every row scanned during shadow mode lands in **Needs triage** — team
grouping, urgency ordering, and PRD rendering get **no** real-world exercise
here, and team grouping is the primary design axis of the whole digest.
Shadow mode validates only the sync loop: whether rows appear and disappear
correctly on their own. That is deliberately the half being tested here,
because it's the half that silently corrupts trust if it's wrong — but it is
not a test of the digest's layout or grouping.

It is also not a test of full 7-day coverage. Shadow mode persists no
records, so it never persists `scanCursors` or `scanBackfill` either — every
tick re-samples the newest pages of each channel instead of backfilling the
whole lookback window, and a busy channel's per-tick page budget can cut that
sample short. Check the tick log for `scanHitPageCap: true`; that is the only
signal that a shadow tick's window was truncated rather than genuinely empty.
This is intentional, not a bug to chase: advancing the scan cursor without
recording the PRs it walked past would make the live run skip them
permanently once shadow mode ends — a far worse outcome than a shadow window
that only samples recent activity.

At sprint end: ask two teammates cold what the oldest thing waiting for
review is. If neither can answer, the delivery problem this bot exists to
solve is still real, and the daily post (`src/core/render/daily.ts`) must be
confirmed working before `/review-request` is enabled.
