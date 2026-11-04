# Setup runbook

Follow this in order. The order is load-bearing — several steps fail
confusingly, not loudly, if done out of sequence.

Deployment target throughout is Cloudflare Workers (`wrangler deploy`). The
refresh tick runs on a cron trigger every 5 minutes (`wrangler.jsonc`'s
`triggers.crons`).

The bot is installed on **one Discord server: the public one**. Every id in
this runbook — `DISCORD_GUILD_ID`, the review and digest channel ids, and the
`:code_review:` claim emoji — comes from that server. Nothing reads from any
other server.

## 1. Create the Discord application

In the [Discord Developer Portal](https://discord.com/developers/applications),
create a new application. Record:

- the **application (app) ID**
- the **public key** (Bot → General Information)
- the **bot token** (Bot → Reset Token — shown once)

## 2. (Retired 2026-11-03) Message Content intent

The bot no longer reads message content, so the Message Content privileged
intent stays **off**. If you're upgrading an app that has it on, turn it off
(`docs/operations.md`, *Upgrading to schema version 6*). Step numbers below
are not renumbered.

## 3. (Retired 2026-11-03) Verify the intent

There is no intent to verify. Skip.

## 4. Install to the server

Generate an OAuth2 install URL (Developer Portal → OAuth2 → URL Generator)
with scopes **`bot`** and **`applications.commands`**, and install it to the
target server.

## 5. Apply channel permission overwrites

Restrict the bot, via channel-level permission overwrites, to the review
channel. Grant only:

- Send Messages
- Embed Links
- Read Message History
- View Channel

Read Message History is still needed: the pin check
(`listPinnedMessageIds`) gets no pins from Discord without it, so the digest
would always look unpinned.

**Do not grant** Manage Messages, and **do not grant** `PIN_MESSAGES`. The
digest is pinned once by hand (step 13) and thereafter only edited; a bot
editing its own message needs no pinning permission at all. Granting either
is a standing over-permission with no feature that needs it.

## 6. Create the GitHub App on the `paranext` org

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App, owned
by the `paranext` org. Permissions: **Pull requests: read** only.

Install the App on **All repositories** in `paranext`, so new private repos
sync with no further step. Record the **App ID** and the
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

For repos outside `paranext` (any owner can be requested), create a GitHub
personal access token with read-only access to public repositories, **on a shared machine
account — not a personal PAT.** A token tied to one person's account
reintroduces exactly the single-point-of-failure dependency the org-owned
GitHub App was chosen to avoid for `paranext`.

Record the token's **expiry date** in `docs/operations.md`'s credential
rotation section (there is a line reserved for it) before moving on — a
fine-grained token expiring mid-sprint with no warning is a predictable,
avoidable outage.

## 9. Fill in `config/config.ts` and open a PR

Two placeholders need real values before this deploys against a real
server:

- `allowedChannelIds` / `digestChannelId` — the real review channel ID

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
wrangler secret put DISCORD_APP_ID   # also read as a Worker binding at request time — the modal's callback needs it
wrangler secret put DISCORD_GUILD_ID
wrangler secret put DISCORD_BOT_USER_ID
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_INSTALLATION_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY   # the PKCS#8 pem from step 7
wrangler secret put GITHUB_PUBLIC_TOKEN
wrangler secret put HEALTH_TOKEN              # any long random string, e.g. `openssl rand -hex 32`
wrangler secret put STATS_TOKEN               # a different long random string
```

`HEALTH_TOKEN` is the shared secret for `GET /health`. That endpoint reports
the GitHub App installation id, each credential's failure reason, the digest
message id, the record census and the lease state — a useful map of this
deployment to anyone who guesses the `*.workers.dev` hostname. **Until this
secret is set, `/health` answers 404** (not 401: an unset secret should not
advertise that there is an endpoint here to guess at). Set it before step 12,
or step 16 has nothing to read.

`STATS_TOKEN` is the shared secret for `GET /stats`, the anonymous weekly
review-time figures (see `docs/operations.md`, "Review stats"). It is a
separate secret so it can be handed to a manager without exposing the health
body. Like `/health`, **`/stats` answers 404 until it is set.**

## 12. Deploy and watch three ticks

```bash
npm run deploy
wrangler tail --format pretty
```

**Expected:** three consecutive ticks with `syncOk: true` in the tick
summary and a subrequest count well under 50. With no requests yet, the
digest is empty; that is correct.

**Do not proceed past this step until a tick has run clean.**

## 13. Pin the digest

Wait for the next tick (up to 5 minutes) to post the first digest message,
then **pin that message by hand** in Discord. The bot cannot pin it itself
(see step 5 — no `PIN_MESSAGES` permission, by design) and will not attempt
to.

## 14. Set the Discord interactions endpoint URL

Developer Portal → General Information → Interactions Endpoint URL:
`https://<your-worker-subdomain>.workers.dev/interactions`.

Discord sends an unsigned probe first and expects a `401` (this bot's
signature verification, `src/discord/verify.ts`, correctly rejects it), then
a signed `PING`, which the endpoint must answer with a `PONG` before Discord
will accept the URL.

## 15. Register both commands

```bash
DISCORD_APP_ID=... DISCORD_GUILD_ID=... DISCORD_BOT_TOKEN=... \
  npm run register-commands
```

The npm script compiles with the repo's own `tsc` and runs the emitted JS —
the same shape as `npm run preview`. (It used to be documented as
`npx tsx …`; `tsx` is not a dependency of this repo, so that line asked npm
to fetch a package nothing here declares.)

This registers `/review-list`, `/review-request` and `/review-stats`; there
is no flag. When a release adds a command (`/review-stats` was added with
schema v7), re-run `npm run register-commands` after deploying, or Discord
won't offer it.

Then announce it to the team, and set the channel topic (or pin a message)
saying: "Use `/review-request` to ask for a review. Pasted links aren't
tracked." The bot can't tell anyone a pasted link was ignored, so this note is
how people find out.

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

Also try a `:code_review:` reaction claim once on the live server. Discord's
docs don't say whether reading reactions needs Read Message History.

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
