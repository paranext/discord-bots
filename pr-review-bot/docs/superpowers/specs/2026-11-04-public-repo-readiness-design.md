# Public repo readiness — design

**Date:** 2026-11-04
**Status:** Approved by owner; revised after adversarial review (see end)

## Intent

The bot is moving from this private repo to a public repo in the company GitHub
org. Before that happens we need two things:

1. **Nothing in the public repo leaks private Paratext details.** A full gitleaks
   scan of every branch and commit found no real secrets. It did find details
   that shouldn't be public: the names of three private repos, a near-verbatim
   title of a real private PR, colleagues' GitHub logins, and an internal channel
   name.
2. **Secrets live in GitHub, not in code or on a laptop.** The bot has never been
   deployed. Its first deploy and every deploy after that should come from GitHub
   Actions, using values stored as GitHub secrets. No one should need a local
   `.dev.vars` or a manual `wrangler secret put` to ship.

Future contributors should still be able to see how the bot was designed, so the
planning docs under `docs/superpowers/` stay in the public repo, edited where
needed.

## Goals

- The public repo's tree has no private repo names, no titles or Jira keys from
  private PRs, no colleagues' GitHub logins, and no internal channel names.
- The public repo has **no history before its first commit**, so nothing removed
  from the current tree can be recovered from it.
- A push to `master` that passes CI deploys the Worker, pulling every credential
  and ID from GitHub secrets.
- `config/config.ts` has no real Discord IDs, and no deploy-specific ID shows up
  in a public Actions log. A fork supplies its own.
- Secret scanners (gitleaks, GitHub secret scanning, outside researchers) see the
  test-only keys as known and allowlisted, and CI catches any real secret before
  it merges.

## Non-goals

- **Rewriting this repo's history.** This private repo stays as the full record,
  including PRs #1–#9. Nothing is filter-repo'd.
- **Syncing back.** After cutover, new work happens in the public repo. This repo
  is not kept in step with it.
- **New bot features.** Removing the repo allowlist is already done by PR #8, and
  the public-server-only switch was done by PR #7. The only runtime changes here
  are: where the channel IDs are read from, failing loudly when they're missing,
  and `immediateDigestRewrite: false` for the free plan.
- **Removing first names** (Katherine, Ira, Jolie) from fixtures and plans. A
  first name in a test fixture identifies no one.
- **Anonymizing commit authorship.** The public repo starts with one fresh
  commit, so the 230 commits carrying the owner's work email don't come along.

## Anti-goals

These would be failures even if everything else works:

- Any of the three private repo names (`paratext-10-studio`,
  `paratext-assistant`, `paratext-bible-internal-extensions`), the real PR title
  "PT-4398 P10 backend sync-activity signal", or the bare keys `PT-4398` /
  `PT-4390` is findable in the public repo, in any file or commit.
- The deploy workflow prints a secret or a deploy-specific ID (guild, channel,
  app, installation) to the Actions log, or runs
  code from a fork or an unmerged branch with secrets available.
- The scrub breaks tests or quietly loosens assertions. Snapshots are
  regenerated from fixtures with the strings replaced. The only other snapshot
  changes allowed are the `bodyHash` values that follow from the new strings.

## Constraints

- **Ordering.** *(Owner decision 2026-11-04.)* This work is a third stacked PR
  on top of #9 (`feat/review-stats`, adds `STATS_TOKEN` and `GET /stats`),
  which itself sits on #8 (`feat/command-only-requests`, removes
  `repoAllowlist`). If either changes before merging, rebase onto the new tip. File and line references below are as of `feat/review-stats`.
- **Cloudflare.** The owner is creating the account, on the **free plan** (its
  limits were researched before building), and will create the API token. The
  free plan supports SQLite-backed Durable Objects only, which matches
  `new_sqlite_classes` in `wrangler.jsonc`.
- **Existing CI** (`.github/workflows/ci.yml`) runs typecheck, lint, coverage
  and preview on PRs and on pushes to `master`. Deploy must not run unless that
  passes on a push to `master`.
- **Existing runtime env names are fixed, except the `GITHUB_*` four.** The
  Worker reads its values from `env.*` (`src/env.d.ts`). Keep those names, with
  one exception found in final review: GitHub reserves the `GITHUB_` prefix for
  secret and variable names, so `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`,
  `GITHUB_APP_PRIVATE_KEY` and `GITHUB_PUBLIC_TOKEN` are renamed to `GH_*`
  everywhere. Two new names are added for the channel IDs (§2).

## What was decided

### 1. Scrub (in this repo, as a normal PR on `master`)

Find what to change **by grep, not from this table**. The table records the
treatment for each kind of string. The adversarial review found the first
version of this list incomplete.

| Item | Known locations | Treatment |
|---|---|---|
| Private repo names | `fixtures/records.ts:104,115,125`, `tests/core/render/request.test.ts`, `tests/core/__snapshots__/fixtures.test.ts.snap`, plans and specs under `docs/superpowers/` | Replace with a made-up repo, e.g. `paranext/example-extension`. Keep the same PR numbers so the shape of each example is unchanged. |
| Real private PR title "PT-4398 P10 backend sync-activity signal" and the bare key `PT-4398` | the above, plus `tests/store/memory.test.ts:45`, `tests/workers/do.test.ts` (bare key, several lines), the design spec's sample digest | Replace with an invented title and Jira key. |
| All other PT-* Jira keys and titles (PT-4390, PT-4401, PT-4412, PT-4370, PT-4371, PT-4363, …) | fixtures, tests, plans | *(My call.)* **Replace all of them** with invented keys and titles, except titles on the two records for public `paranext-core` PRs #2695 and #2600. Most don't match the PR they sit beside, so a "leave the public-looking ones" rule would cover almost nothing, and replacing them costs nothing. Invented keys use an obviously fake range (e.g. `PT-9001`+). |
| Colleagues' GitHub logins (`katherinejensen00`, `lyonsil`, `tjcouch-sil`) | `fixtures/responses/github-batch.json` only (no test matches on them) | Replace with obvious placeholders (`reviewer-a`, `reviewer-b`, …). |
| `teamwide-epic-discussions` | 2026-08-26 design spec, 2026-10-12 drop-PRD spec and plan | Replace with "the internal PRD forum". |
| "P10", "Thursday's demo", "Trust PRD" | `preview/build.ts:39,64`, `src/handlers/modal.ts:118`, specs and plans | *(My call.)* **Keep.** Paratext 10 is a public product name, and these are generic sample text. |
| Owner line, `docs/operations.md:210` | | **Keep** the owner's name and work email. An ops doc needs a real contact. *(My call. The owner can switch it to a team contact.)* |
| Claim emoji `code_review:1075535230087221248` | `config/config.ts` and docs | **Keep.** Confirmed to be a public-server emoji (2026-10-12 drop-PRD spec). It's the only snowflake ID in the tree. |

Plans are edited **in place**. They're historical records, so add a one-line
note near the top of each edited plan or spec saying example repo names, titles
and Jira keys were anonymized for the public repo. Don't otherwise rewrite them.

After the scrub, a grep for every string in the anti-goals list and the logins
row must return nothing across the whole tree, **except** in this spec and its
implementation plan.

**This spec stays private.** *(My call.)* This document and its plan have to
name the strings being removed, so they can't be scrubbed without losing their
purpose. Both stay in this private repo and are **left out of the public
push**. The anti-goal grep is a local script kept outside the repo, in the
owner's scratch space. It is not a committed script or CI step, because the
list of strings would itself be the leak. The committed CI guard is gitleaks
only.

### 2. Channel IDs move out of `config.ts`

`allowedChannelIds` and `digestChannelId` are placeholders today
(`REPLACE_WITH_REVIEW_CHANNEL_ID`). Rather than filling in real IDs, they come
from two new env bindings:

- `REVIEW_CHANNEL_IDS`: comma-separated snowflakes. This becomes
  `allowedChannelIds`.
- `DIGEST_CHANNEL_ID`: one snowflake. This becomes `digestChannelId`.

The rest of `config.ts` (team names, thresholds, the claim emoji) stays in
code.

**Every reader of config must see the env values.** In particular, the Durable
Object keeps its own `private config: Config = defaultConfig`
(`src/store/do.ts:35`, static import at `:2`) and builds the digest and
daily-post channel from `config.digestChannelId` (`src/discord/rest.ts:153`).
If only `src/index.ts` applies the env values, the DO posts to the placeholder
and fails quietly every tick. So:

- config is built from env in both the Worker entry and the DO (e.g. a
  `loadConfig(env)` that both call);
- `RecordsObjectEnv` (`do.ts:23-26`) and `src/env.d.ts` gain the two bindings;
- missing, empty or non-snowflake values **fail loudly**: `/interactions`
  answers 500 and the tick throws, each logging which binding is wrong (never
  its value). `/health` and `/stats` keep answering, so the operator can still
  reach them. The invariant at
  `tests/core/config.test.ts:27` (the digest channel is one of the allowed
  channels) becomes a runtime check;
- `scripts/` and `preview/` keep working without env, by using fixture IDs.

**Free plan.** Set `immediateDigestRewrite` to `false` in `config.ts`, and
update `docs/setup.md` §9 so it no longer says to flip it by hand in a
channel-ID PR (that PR no longer exists). `tests/workers/interactions.test.ts:170`
spreads the real config and relies on `true`. Pin `immediateDigestRewrite:
true` in that test and add a matching `false` case.

### 3. Where each value lives

*(My call: every deploy-specific value is a GitHub **secret** and a Worker
**secret**, including the non-secret IDs.)* Two reasons:

- wrangler-action passes `vars` as `--var NAME:value` command-line arguments,
  which are echoed, unmasked, into the Actions log. In a public repo, that
  publishes the guild, channel, app and installation IDs.
- `wrangler deploy` replaces Worker vars on each deploy unless `keep_vars` is
  set, so a stray local `npm run deploy` would wipe them. Secrets survive.

This also matches how setup.md already treats these IDs. A Worker var and a
Worker secret can't share a name, so this choice is made once. None of these
names may ever appear in `wrangler.jsonc` `vars`.

| Value | GitHub store (environment `production`) | Reaches the Worker as |
|---|---|---|
| `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY` | secret | Worker secret |
| `GITHUB_APP_PRIVATE_KEY`, `GITHUB_PUBLIC_TOKEN` | secret | Worker secret |
| `HEALTH_TOKEN`, `STATS_TOKEN` | secret | Worker secret |
| `DISCORD_APP_ID`, `DISCORD_GUILD_ID`, `DISCORD_BOT_USER_ID` | secret | Worker secret |
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID` | secret | Worker secret |
| `REVIEW_CHANNEL_IDS`, `DIGEST_CHANNEL_ID` | secret | Worker secret |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | secret | used by the workflow only |
| `DEPLOY_ENABLED` | **repository** variable (not environment) | not sent; it gates the job |

GitHub is the single source of truth. Each deploy uploads the secrets through
`wrangler secret bulk` on stdin (wrangler-action's `secrets` input), so
rotating a value means updating it in GitHub and redeploying.

GitHub secrets can't be read back. The operator needs `HEALTH_TOKEN` and
`STATS_TOKEN` to curl `/health` and `/stats`, and `STATS_TOKEN` is handed to a
manager. So those two are generated with `openssl rand -hex 32` and also kept
in the team password manager.

### 4. Deploy workflow

- A new workflow deploys with `cloudflare/wrangler-action` (v4.x). It runs
  `npm ci` first, so the action uses the repo's pinned wrangler.
- **Trigger:** `workflow_run` on CI completing, plus `workflow_dispatch` for the
  first deploy and redeploys. Never on `pull_request`.
- **The deploy job runs only when all of these hold:**
  - `vars.DEPLOY_ENABLED == 'true'`. The job is skipped, not failed, otherwise.
    This repo and any fork never set it. The owner sets it in the public repo
    at cutover. *(My call on the mechanism. It avoids hard-coding the public
    repo's name, which isn't final.)*
  - For `workflow_run`: `conclusion == 'success'`, `event == 'push'`,
    `head_branch == 'master'`, and `head_repository.full_name ==
    github.repository`. CI also runs on `pull_request`, and a fork PR from a
    branch named `master` passes a plain `branches: [master]` filter while
    running in the base repo with secrets. The checkout is `workflow_run.head_sha`,
    which these checks make safe.
- **Environment `production`**, with its deployment-branch rule set to
  "`master` only". That rule is what stops `workflow_dispatch` from deploying
  another branch. Note it does *not* protect `workflow_run`, which always runs
  with the default-branch ref. That's why the checks above exist.
- `concurrency: { group: production, cancel-in-progress: false }`, so an older
  run can't deploy over a newer one.
- Slash-command registration (`npm run register-commands`) runs after deploy.
  It reads `DISCORD_APP_ID`, `DISCORD_GUILD_ID` and `DISCORD_BOT_TOKEN` from
  step `env:` (`scripts/register-commands.ts:29-34`). It's idempotent, so
  running it every deploy is fine.
- Secrets reach steps only through `env:` / the action's `secrets` input. They
  are never put in command lines or echoed.
- `package.json` `"deploy"` stays for local development deploys. Because nothing
  is a var, it can't wipe config.
- **Testing before cutover:** the workflow can be tried in a throwaway personal
  repo against a scratch Worker name, with `DEPLOY_ENABLED` set there. This is
  optional. The first manual run in the public repo is the real check.

### 5. Scanner hygiene

- **`.gitleaks.toml`** with `[extend] useDefault = true` (without it the
  built-in rules are dropped and CI detects nothing). Use the current
  `[[allowlists]]` syntax (gitleaks ≥ 8.25), scoped by path **and** pattern
  (`condition = "AND"`). It allowlists exactly what gitleaks 8.30.1 reports on
  the tree today: the three test PEMs (`tests/workers/credentials.test.ts:9`,
  `index.test.ts:9`, `query.test.ts:15`) and the zero-padded
  `DISCORD_PUBLIC_KEY` in the tracking plan (rule `discord-api-token`). The
  dummy tokens (`ghp_public`, `ghs_a`, `health-secret`, …) aren't flagged and
  need no entry.
- **`.github/secret_scanning.yml`** with `paths-ignore` for the three test
  files, because GitHub's own scanning ignores `.gitleaks.toml`. This is
  path-only by GitHub's design.
- **gitleaks in CI**, run as the binary at a pinned version. The
  `gitleaks-action` would also work, but it needs a (free) license key for org
  repos, and the binary avoids that setup. Checkout uses `fetch-depth: 0`, and
  on PRs the scan covers the PR's commit range (`--log-opts`), not just the
  tip. A secret added and removed within a PR is still reachable via public PR
  refs.
- README gets a short "Test keys" note: the keys were generated only for tests
  and sign nothing real.

### 6. Docs and tests that go stale

- `docs/setup.md` §11 becomes "Set the GitHub secrets". It lists each secret
  from §3, the `production` environment and its branch rule, `DEPLOY_ENABLED`,
  the Cloudflare token permissions, and the password-manager note. §12 and §15
  describe running the workflow instead of `npm run deploy` /
  `npm run register-commands` by hand. §9 is updated for
  `immediateDigestRewrite`.
- `docs/operations.md:10,20,23` (rotating via `wrangler secret put`) changes to
  "update the GitHub secret and re-run deploy".
- `docs/architecture.md:30` points at `config.allowedChannelIds`. Update it to
  the env binding.
- `tests/workers/index.test.ts:151-153` hard-codes
  `REPLACE_WITH_REVIEW_CHANNEL_ID` as the real config. The Workers tests get
  their env from `wrangler.jsonc` through `vitest.config.ts`, so test bindings
  for `REVIEW_CHANNEL_IDS` and `DIGEST_CHANNEL_ID` must be supplied there
  (miniflare bindings in the vitest config, not in `wrangler.jsonc`).
- README gains the test-keys note and a pointer to setup.
- An ADR in `docs/architecture-decisions.md` records "all deploy values are
  Worker secrets, deployed from GitHub Actions" and why.

### 7. Cutover (manual, done by the owner)

1. PRs #8 and #9 merge, and then the scrub PR and the deploy PR merge into this
   repo's `master`.
2. Run gitleaks and the private anti-goal grep on that tree one more time.
3. Build the tree with `git archive master | tar -x -C <empty dir>`. Don't copy
   the working copy: ignored `.dev.vars` and `.superpowers/` or `.git` could
   come along. Delete this spec and its plan from that directory.
4. In that directory, `git init`. Check `user.name`/`user.email`, because the
   single commit carries them. Commit once, create the public repo in the
   company org, and push.
5. In the public repo: create the `production` environment with its branch
   rule, add the secrets, and set `DEPLOY_ENABLED=true`. Then trigger the
   first deploy by hand and follow `docs/setup.md` from there (pin the digest,
   set the interactions URL, confirm `/health`).
6. Archive this repo or leave it private. It's the private history record.

## Left to the builder

- The shape of `loadConfig(env)` and how the DO and Worker entry share it.
- The invented replacement names, titles and keys. They must clearly be made up
  and must not collide with any real paranext repo.
- Workflow layout: a separate workflow chained with `workflow_run`, or a deploy
  job inside `ci.yml` with `needs: check`. If it's the latter, the gate is
  `github.event_name == 'push' && github.ref == 'refs/heads/master'` plus
  `DEPLOY_ENABLED`, and the `workflow_run` checks don't apply.
- The minimum Cloudflare token permissions. Workers Scripts: Edit is the core.
  Account Settings: Read may be needed for wrangler's account lookup. Verify on
  the first deploy and document what's actually required.

## Answered objections (adversarial review, 2026-11-04)

Folded in above: the deploy gate (fork PR / `workflow_run` hole), the DO's own
config copy, the incomplete scrub list and bare keys, the test that breaks with
`immediateDigestRewrite: false`, vars wiping on local deploy and appearing in
logs, write-only token secrets, the gitleaks config syntax and `useDefault`,
GitHub secret scanning's separate config, shallow-checkout scanning, stale docs
and test bindings, and the `git archive` cutover.

Deliberately not acted on:

- **"The workflow can't be tested before cutover" isn't quite true.** Agreed,
  and the spec now says it can be tried in a throwaway repo. That test stays
  optional, not a required step.
- **The gitleaks-action license is free, not paid.** Corrected. We still run
  the binary to skip the license-key setup.
