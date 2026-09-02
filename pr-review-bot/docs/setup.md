# Setup runbook

Follow this in order. The order is load-bearing — several steps fail
confusingly, not loudly, if done out of sequence, and step 3 exists precisely
because a wrong answer here produces silence rather than an error.

Deployment target throughout is Cloudflare Workers (`wrangler deploy`). The
refresh tick runs on a cron trigger every 5 minutes (`wrangler.jsonc`'s
`triggers.crons`).

## 1. Create the Discord application

In the [Discord Developer Portal](https://discord.com/developers/applications),
create a new application. Record:

- the **application (app) ID**
- the **public key** (Bot → General Information)
- the **bot token** (Bot → Reset Token — shown once)

## 2. Enable the MESSAGE CONTENT privileged intent

Bot → Privileged Gateway Intents → **Message Content Intent**. This is
self-serve below 100 guilds; no Discord approval needed.

Without this, `GET /channels/{id}/messages` returns `content: ""` for every
message the bot did not author. Message scanning (the mechanism that finds
PR links posted by hand) then silently extracts zero links. The bot starts
normally, ticks normally, and reports an empty list — nothing crashes, no
error appears in the logs beyond what step 3 below adds. This deploy refuses
to tick at all once the runtime check (`src/handlers/startup.ts`,
`assertMessageContentIntent`) is wired in: it logs `INTENT_MISSING` and the
`scheduled()` handler returns before doing any work.

## 3. Verify the intent actually took, against the real application

**This is the most important step in this document. Do it now, before
wiring anything else to the intent check, and do not skip it because step 2
"looked like it worked" in the portal UI.**

The two constants this bot's intent check compares against —
`FLAG_MESSAGE_CONTENT = 1 << 18` (262144) and
`FLAG_MESSAGE_CONTENT_LIMITED = 1 << 19` (524288), in
`src/discord/rest.ts` — **are confirmed against Discord's documented
application-flags table.** They are not what this step verifies.

What this step verifies is that the intent from step 2 is **actually enabled
on this application**, read back from Discord rather than from the portal UI
you just clicked through. That is a different claim, and it has the identical
silent-failure signature described at the bottom of this step.

Keep one distinction in mind while reading `flags`: **application flags are
not gateway intents.** The gateway intents bitfield also has a
`MESSAGE_CONTENT`, at `1 << 15`, and the application-flags table separately
has a `GATEWAY_GUILD_MEMBERS_LIMITED` at `1 << 15` — the same number in two
unrelated fields, which is exactly how the wrong table gets used. This bot
opens no gateway connection at all; it reads `flags` from
`GET /applications/@me`, so only the application-flags table applies (see
`docs/architecture.md`).

Run this now that the app exists and the intent from step 2 is enabled:

```bash
curl -s https://discord.com/api/v10/applications/@me \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" | jq .flags
```

Confirm bit 18 (value `262144`, i.e. `flags & 262144 !== 0`) is set. If your
portal enabled the *limited* variant instead, confirm bit 19 (`524288`)
instead.

**If neither bit is set, the intent is not enabled on this application** —
whatever the portal appeared to show. Go back to step 2, enable Message
Content, save, and re-run the `curl` until one of the two bits is set. **Do
not proceed to shadow mode** until it is. This is an operator fix in the
Developer Portal, not a code fix: the constants are confirmed values, and
editing them to match a `flags` that is missing the bit would only teach the
runtime check to accept a misconfigured app.

If bit 19 is the one set, the app has the *limited* variant. Scanning still
works; the tick logs `[INTENT_LIMITED]` once per tick so the distinction is
visible in `wrangler tail`.

**Why this matters more than a typical config-value bug:** a missing bit here
does not fail loudly. `assertMessageContentIntent` reads `flags`, finds
neither bit set, and reports `INTENT_MISSING` — so `scheduled()` aborts
*every single tick* before touching GitHub, the store, or Discord's message
history. The digest simply never updates. There is no exception, no crash,
no obviously-related log line beyond `[INTENT_MISSING] ...` scrolling past in
`wrangler tail` alongside everything else. From the outside, this is
**indistinguishable from a cron trigger that isn't firing, a deploy that
didn't take, or a Durable Object binding that's misconfigured** — all of
which look like "the channel stopped updating and nothing obviously
crashed." An operator debugging this at 2am with no memory of this paragraph
will spend hours checking wrangler deploys and DO bindings before thinking to
check an intent bit that "was already verified once." It wasn't — not
against live data, until this step runs.

## 4. Install to the server

Generate an OAuth2 install URL (Developer Portal → OAuth2 → URL Generator)
with scopes **`bot`** and **`applications.commands`**, and install it to the
target server.

## 5. Apply channel permission overwrites

Restrict the bot, via channel-level permission overwrites, to the review
channel and the PRD forum (`teamwide-epic-discussions`). Grant only:

- Send Messages
- Embed Links
- Read Message History
- View Channel

**Do not grant** Manage Messages, and **do not grant** `PIN_MESSAGES`. The
digest is pinned once by hand (step 13) and thereafter only edited; a bot
editing its own message needs no pinning permission at all. Granting either
is a standing over-permission with no feature that needs it.

## 6. Create the GitHub App on the `paranext` org

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App, owned
by the `paranext` org. Permissions: **Pull requests: read** only. Repository
access: scoped to the repos in `config/config.ts`'s `repoAllowlist` that live
under `paranext`.

Install the App on those repos. Record the **App ID** and the
**installation ID** (visible in the install URL,
`.../installations/<id>`).

## 7. Convert the App private key to PKCS#8

GitHub issues the App's private key in PKCS#1 format. Web Crypto
(`crypto.subtle.importKey`, used by `src/github/credentials.ts` to sign the
installation-token JWT) cannot import PKCS#1 directly — it needs PKCS#8.
Convert it once, locally, before it ever becomes a Worker secret:

```bash
openssl pkcs8 -topk8 -nocrypt -in github-app.private-key.pem \
  -out github-app.pkcs8.pem
```

Use the resulting `github-app.pkcs8.pem` contents for the
`GITHUB_APP_PRIVATE_KEY` secret in step 11. Do not commit either PEM file to
the repo.

## 8. Create the public-read token

For repos outside `paranext` (currently
`eten-tech-foundation/scripture-editors`), create a GitHub personal access
token with read-only access to public repositories, **on a shared machine
account — not a personal PAT.** A token tied to one person's account
reintroduces exactly the single-point-of-failure dependency the org-owned
GitHub App was chosen to avoid for `paranext`.

Record the token's **expiry date** in `docs/operations.md`'s credential
rotation section (there is a line reserved for it) before moving on — a
fine-grained token expiring mid-sprint with no warning is a predictable,
avoidable outage.

## 9. Fill in `config/config.ts` and open a PR

Three placeholders need real values before this deploys against a real
server:

- `allowedChannelIds` / `digestChannelId` — the real review channel ID
- `prdForumChannelId` — the real PRD forum channel ID

Config is checked into the repo specifically so this is a reviewable
one-line PR rather than a manual step someone has to remember to redo on
every redeploy.

### Decide `immediateDigestRewrite` before you deploy

`config.immediateDigestRewrite` ships as `true`. **Whoever deploys must
decide it** — the right value depends on the host, and this runbook cannot
know which one you are on:

- **Paid Cloudflare plan, or a container host: leave it `true`.** A claim from
  the digest menu rewrites the pinned message immediately, which is what makes
  the menus feel like buttons rather than a form.
- **Cloudflare free plan: set it to `false`.** The free plan's per-invocation
  CPU budget is about 10 ms, and an interaction that does Ed25519 verification,
  a full render and an embed serialise inside that budget will exceed it. The
  symptom is not an error message: the person who used the menu sees a spinner
  that never resolves, and nothing in the channel explains why. With `false`,
  the interaction writes and returns, and the next tick (within 5 minutes)
  repaints the digest.

Change it in the same PR as the channel IDs above.

## 10. Deploy the Durable Object

The store is a single Cloudflare Durable Object (`RecordsObject`, bound as
`RECORDS` in `wrangler.jsonc`). It is created automatically on first deploy
via the `migrations` entry in `wrangler.jsonc` — there is no separate
provisioning step and, deliberately, **no KV namespace to create**: this
plan does not use KV at all (see `adr-no-kv-namespace` in
`docs/architecture-decisions.md`). Running `wrangler deploy` (step 12) is
sufficient.

## 11. Set the Worker secrets

Never put these in the repo — Worker secrets only:

```bash
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put DISCORD_APP_ID
wrangler secret put DISCORD_GUILD_ID
wrangler secret put DISCORD_BOT_USER_ID
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_INSTALLATION_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY   # the PKCS#8 pem from step 7
wrangler secret put GITHUB_PUBLIC_TOKEN
wrangler secret put HEALTH_TOKEN              # any long random string, e.g. `openssl rand -hex 32`
```

`HEALTH_TOKEN` is the shared secret for `GET /health`. That endpoint reports
the GitHub App installation id, each credential's failure reason, the digest
message id, the record census and the lease state — a useful map of this
deployment to anyone who guesses the `*.workers.dev` hostname. **Until this
secret is set, `/health` answers 404** (not 401: an unset secret should not
advertise that there is an endpoint here to guess at). Set it before step 12,
or step 16 has nothing to read.

## 12. Deploy read-only and watch three ticks

```bash
wrangler secret put READ_ONLY   # value: true
npm run deploy
wrangler tail --format pretty
```

In this mode the tick runs the full refresh loop against live data —
querying GitHub, scanning the real channel — and **posts nothing to Discord
and writes no records**. It is not a total no-write: the tick releases the
refresh lease it took, which is one `setMeta` write to the Durable Object and
nothing else. (Without that release the first shadow tick would hold the lease
and every tick for the next 15 minutes would be turned away.) So if you inspect
the store to verify this step, expect `syncLease: null` and an otherwise
untouched object — no records, no `digestMessageId`, no `lastDailyPostDate`.

Each tick logs `[read-only] would render:` followed by the digest body it would
have posted.

Because this mode writes no records, it also never persists `scanCursors` or
`scanBackfill` — there is nothing safe to advance them against. So every
shadow tick samples the newest pages of each channel rather than backfilling
the whole 7-day lookback window, and on a busy channel the per-tick page
budget can truncate that sample before it reaches every message. `tick.json`
in the log carries `scanHitPageCap: true` whenever that happened on that
tick — that is how you see the window was truncated, since a page cap and "no
links in this channel" otherwise look identical. This is deliberate, not a
gap to fix: advancing the scan cursor past messages whose PRs were never
recorded would make the live run in step 13 skip those messages entirely,
which is a permanent loss, not a short shadow window. A page-capped shadow
tick still proves the digest renders correctly for the rows it did see; it
does not prove every PR in the lookback window would be caught.

`READ_ONLY` is normalised before it is read, so `true`, `True`, `TRUE` and a
value with stray whitespace all mean read-only — and so does any value that is
not a recognised way of writing "false". Only `false` / `0` / `no` / `off` (or
removing the secret) turns writing on. If you are unsure whether the value took,
the tick log is the answer: shadow mode prints `[read-only] would render:` on
every tick.

**Expected:** three consecutive ticks logging `[read-only] would render:`
with a body that matches what `npm run preview` showed for the same
fixtures, `syncOk: true` in the tick summary, and a subrequest count well
under 50.

**Do not proceed past this step until a tick has run clean.** This is the
last checkpoint before the bot writes anything to a real channel.

## 13. Go live in shadow mode and pin the digest

```bash
wrangler secret put READ_ONLY   # value: false
npm run deploy
```

Wait for the next tick (up to 5 minutes) to post the first real digest
message, then **pin that message by hand** in Discord. The bot cannot pin it
itself (see step 5 — no `PIN_MESSAGES` permission, by design) and will not
attempt to.

## 14. Set the Discord interactions endpoint URL

Developer Portal → General Information → Interactions Endpoint URL:
`https://<your-worker-subdomain>.workers.dev/interactions`.

Discord sends an unsigned probe first and expects a `401` (this bot's
signature verification, `src/discord/verify.ts`, correctly rejects it), then
a signed `PING`, which the endpoint must answer with a `PONG` before Discord
will accept the URL.

## 15. Register `/review-list` only

```bash
DISCORD_APP_ID=... DISCORD_GUILD_ID=... DISCORD_BOT_TOKEN=... \
  npm run register-commands
```

The npm script compiles with the repo's own `tsc` and runs the emitted JS —
the same shape as `npm run preview`. (It used to be documented as
`npx tsx …`; `tsx` is not a dependency of this repo, so that line asked npm
to fetch a package nothing here declares.)

This registers only `/review-list`. `/review-request` is registered with
`npm run register-commands -- --all` only when moving past shadow mode — it is not built yet (see
`docs/architecture.md`, "What's deliberately not here").

## 16. Confirm health

```bash
curl -s -H "Authorization: Bearer $HEALTH_TOKEN" \
  https://<your-worker-subdomain>.workers.dev/health | jq .
```

Expect HTTP 200 and a `lastSync` timestamp within the last few minutes. A
**404** means `HEALTH_TOKEN` was never set (step 11); a **401** means the
token you sent does not match the one the Worker holds; a **405** means the
request was not a `GET`. See
`docs/operations.md` for what each field means and what to do if this
returns 503 instead.

## Ongoing: track the App private key's age by hand

The health endpoint reports the GitHub App's **installation token** expiry
(`credentials.app.tokenExpiresInMs`) — but that token is minted fresh every
hour from the App's private key, so its expiry says nothing about the key
itself. **The health endpoint cannot report the private key's age**, because
a PEM file carries no creation timestamp — there is nothing to derive it
from short of inventing a new secret solely to hold that date.

Record the date you created or last rotated the App's private key (step 6)
in `docs/operations.md`'s credential-rotation section now, and check that
date against your own rotation policy periodically. **This is a real,
accepted monitoring gap, not an oversight**: a key rotated late is caught
only by whoever reads `docs/operations.md`, never by `/health`.
