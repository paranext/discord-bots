# Setup runbook

Follow this in order. The order is load-bearing — several steps fail
confusingly, not loudly, if done out of sequence.

Deployment target throughout is Cloudflare Workers, deployed by the Deploy
GitHub Actions workflow (steps 11 and 12). The
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
`GH_APP_PRIVATE_KEY` secret in step 11. Do not commit either PEM file to
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

## 9. Review `config/config.ts`

Nothing in `config/config.ts` needs a real value before the first deploy. The
review and digest channel IDs are not in the file: they are the secrets
`REVIEW_CHANNEL_IDS` and `DIGEST_CHANNEL_ID`, which you set in step 11. They
are deploy-specific, so a fork supplies its own and no real ID is committed,
and a var would print them unmasked in the public Actions log. `loadConfig`
reads them at request time and validates them.

What is left in the file is behaviour you may want to change in a reviewable
PR, such as `immediateDigestRewrite` below.

### `immediateDigestRewrite` ships off for the free plan

`config.immediateDigestRewrite` ships as `false`, because this bot deploys on
the Cloudflare free plan:

- **Cloudflare free plan: leave it `false`.** The free plan's per-invocation
  CPU budget is about 10 ms, and an interaction that does Ed25519 verification,
  a full render and an embed serialise inside that budget will exceed it. The
  symptom is not an error message: the person who used the menu sees a spinner
  that never resolves, and nothing in the channel explains why. With `false`,
  the interaction writes and returns, and the next tick (within 5 minutes)
  repaints the digest.
- **Paid Cloudflare plan, or a container host: you may set it to `true`.** A
  claim from the digest menu then rewrites the pinned message immediately,
  which is what makes the menus feel like buttons rather than a form.

## 10. Deploy the Durable Object

The store is a single Cloudflare Durable Object (`RecordsObject`, bound as
`RECORDS` in `wrangler.jsonc`). It is created automatically on first deploy
via the `migrations` entry in `wrangler.jsonc` — there is no separate
provisioning step and, deliberately, **no KV namespace to create**: this
plan does not use KV at all (see `adr-no-kv-namespace` in
`docs/architecture-decisions.md`). Running the Deploy workflow (step 12) is
sufficient.

## 11. Set the GitHub secrets

The bot deploys from GitHub Actions (`.github/workflows/pr-review-bot-deploy.yml`
at the repository root). Every
deploy value is a GitHub secret, and each deploy uploads them all to the
Worker as Worker secrets. Nothing is a `wrangler.jsonc` var, because this
repo's Actions logs are public (see `adr-deploy-values-are-worker-secrets`).
The GitHub credentials use a `GH_` prefix because GitHub rejects secret names
that start with `GITHUB_`.

Creating environments and repository variables needs admin on the
repository.

**Create the environment first.** Settings → Environments → New environment,
named `pr-review-bot-production` (one environment per bot in this repository).
Under "Deployment branches and tags", choose "Selected branches and tags" and
add `main` only. This rule is required: it is what
stops a manual run of Deploy from deploying another branch with the
production secrets.

Then add these as **environment secrets** on `pr-review-bot-production`:

| Secret | What it is, and where to get it |
|---|---|
| `DISCORD_BOT_TOKEN` | The bot token (step 1) |
| `DISCORD_PUBLIC_KEY` | The application's public key (step 1) |
| `GH_APP_PRIVATE_KEY` | The PKCS#8 pem from step 7, including the `BEGIN`/`END` lines |
| `GH_PUBLIC_TOKEN` | The public-read token (step 8) |
| `HEALTH_TOKEN` | A long random string: `openssl rand -hex 32` |
| `STATS_TOKEN` | A different long random string: `openssl rand -hex 32` |
| `DISCORD_APP_ID` | The application ID (step 1). Also read as a Worker binding at request time: the modal's callback needs it |
| `DISCORD_GUILD_ID` | The server ID |
| `DISCORD_BOT_USER_ID` | The bot user's ID |
| `GH_APP_ID` | The App ID (step 6) |
| `GH_APP_INSTALLATION_ID` | The installation ID (step 6) |
| `REVIEW_CHANNEL_IDS` | The channels the bot accepts `/review-request` from, comma-separated with no brackets or quotes: `111111111111111111,222222222222222222` |
| `DIGEST_CHANNEL_ID` | The channel the digest is pinned in. **Must be one of `REVIEW_CHANNEL_IDS`** |
| `CLOUDFLARE_API_TOKEN` | See below |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → the Account ID on the right |

Generate `HEALTH_TOKEN` and `STATS_TOKEN` yourself and also keep both in the
team password manager. GitHub will not show a secret's value again, and you
need both to read `/health` and `/stats`.

**The Cloudflare API token.** Cloudflare dashboard → My Profile → API Tokens →
Create Token. Use the "Edit Cloudflare Workers" template, or build the token
by hand with Workers Scripts: Edit plus Account Settings: Read, scoped to this
account. After the first deploy, update this paragraph to list the permissions
that were actually needed.

A bad `REVIEW_CHANNEL_IDS` or `DIGEST_CHANNEL_ID` does not stop the deploy.
`/interactions` answers 500 and the cron tick throws, each logging which
binding is wrong; `/health` and `/stats` keep working. Fix the secret and
re-run Deploy.

**Set the repository variable last.** Settings → Secrets and variables →
Actions → Variables → New repository variable: `PR_REVIEW_BOT_DEPLOY_ENABLED`
= `true`. Until it is `true`, pr-review-bot Deploy skips every run, which is why a fork or a fresh
copy of the repo does not fail on missing secrets. Set it only after every
secret above exists.

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

Run the deploy workflow by hand: Actions → pr-review-bot Deploy → Run workflow,
on `main`. From now on it also runs after every pr-review-bot CI success on
`main`.

The first deploy's log shows "Creating new Worker" and a warning that the
Worker was "last updated via the script API". Both are expected: the action
uploads the secrets with `wrangler secret bulk`, which creates a stub Worker,
and `wrangler deploy` then replaces it with the real code. The log also shows
the Worker's Version ID and its `workers.dev` URL. Neither is a secret.

Then watch the ticks. `wrangler tail` needs you logged in to Cloudflare
first:

```bash
npx wrangler login
npx wrangler tail --format pretty
```

Without a laptop, use the Cloudflare dashboard instead: Workers & Pages → the
Worker → Logs (Workers Logs, enabled by `observability` in `wrangler.jsonc`).

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

If the portal rejects the URL, check `wrangler tail` or Workers Logs for a
`configError` line naming a bad binding.

## 15. Register the commands

The Deploy workflow runs `npm run register-commands` after every deploy, so
the commands are already registered once step 12 succeeds. To register by
hand (for example if that step failed), run:

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
schema v7), the next deploy registers it; no manual step.

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
**404** means the `HEALTH_TOKEN` secret was never set (step 11); a **401** means the
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
