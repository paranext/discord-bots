# Public Repo Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **PRIVATE.** This plan and its spec name the private strings being removed.
> Both stay in the private repo and are deleted from the tree before the public
> push (spec §7).

**Goal:** Make the bot safe to publish (scrub private Paratext details, add scanner config) and deployable from GitHub Actions, with every credential and ID held as a GitHub secret.

**Architecture:** The two channel IDs leave `config.ts` and become Worker secrets, read through one `loadConfig(env)` that both the Worker entry and the Durable Object call. A new `deploy.yml` workflow, gated on `DEPLOY_ENABLED` and a strict `workflow_run` check, uploads every secret with `cloudflare/wrangler-action` and registers the slash commands. Fixtures, tests and plans are scrubbed in place, and gitleaks runs in CI.

**Tech Stack:** TypeScript, Cloudflare Workers + SQLite Durable Object, Vitest with `@cloudflare/vitest-plugin`, GitHub Actions, `cloudflare/wrangler-action@v4`, gitleaks 8.30.1.

**Spec:** `docs/superpowers/specs/2026-11-04-public-repo-readiness-design.md`

**Start condition:** Stacked on PR #9 (`feat/review-stats`, which contains #8). Branch `chore/public-repo-readiness` from `origin/feat/review-stats`; its PR targets `feat/review-stats`. If #8 or #9 change before merging, rebase this branch onto the new tip.

## Global Constraints

- Keep the 11 existing env names exactly (`src/env.d.ts`). The only new bindings are `REVIEW_CHANNEL_IDS` (comma-separated snowflakes) and `DIGEST_CHANNEL_ID` (one snowflake).
- Every deploy value is a GitHub **secret** and a Worker **secret**. None may appear in `wrangler.jsonc` `vars` or in the action's `vars` input.
- `DEPLOY_ENABLED` is a **repository** variable, not an environment variable.
- Invented replacements must be obviously fake: repo `paranext/example-extension`, Jira keys from `PT-9001` up, logins `reviewer-a`, `reviewer-b`, `reviewer-c`.
- The only snapshot changes allowed beyond the replaced strings are the `bodyHash` values that follow from them.
- Nothing that lists the private strings is committed except this plan and its spec.
- Free plan: `immediateDigestRewrite: false`.

## Review Focus

1. `REVIEW_CHANNEL_IDS` written with spaces or a trailing comma (`"111…, 222…,"`): it should be accepted after trimming and dropping empty segments. → Task 1 test.
2. A binding that's unset, or set to the old placeholder `REPLACE_WITH_REVIEW_CHANNEL_ID`: the error should name the binding, not crash with "cannot read properties of undefined". → Task 1 test.
3. A broken channel config shouldn't take `/health` down with it. `/health` should still answer, so the operator can see the bot is up, while `/interactions` returns 500 and logs which binding is wrong. → Task 2 test.
4. The DO's digest publisher has to use the env digest channel, not the placeholder. → Task 2 test.
5. A fork PR whose branch is named `master`, or a CI run that failed: deploy is skipped. Workflow YAML can't be unit-tested, so the reviewer checks the `if:` against Task 6's exact expression.

---

### Task 1: `loadConfig(env)` with validation

**Files:**
- Modify: `config/config.ts`
- Test: `tests/core/config.test.ts`

**Interfaces:**
- Produces:
  - `export interface ChannelEnv { REVIEW_CHANNEL_IDS?: string; DIGEST_CHANNEL_ID?: string }`
  - `export class ConfigError extends Error {}`
  - `export function loadConfig(env: ChannelEnv, base: Config = config): Config`, which returns `{ ...base, allowedChannelIds, digestChannelId }` or throws `ConfigError`.
  - `config` keeps its export and its placeholder channel IDs, so tests, `preview/` and `scripts/` work without an env.

- [ ] **Step 1: Write the failing tests.** In `tests/core/config.test.ts`, replace the test "keeps the digest channel among the allowed channels" with a `describe("loadConfig")` block (`A = "111111111111111111"`, `B = "222222222222222222"`):
  - `"reads both channel ids from env"`: `loadConfig({ REVIEW_CHANNEL_IDS: \`${A},${B}\`, DIGEST_CHANNEL_ID: A })` → `allowedChannelIds` equals `[A, B]`, `digestChannelId` is `A`, and `teams` equals `config.teams`.
  - `"trims spaces and drops empty segments"`: `REVIEW_CHANNEL_IDS: \` ${A} , ${B},\`` → `[A, B]`.
  - `"names a missing binding"`: `loadConfig({ DIGEST_CHANNEL_ID: A })` throws a `ConfigError` whose message contains `"REVIEW_CHANNEL_IDS"`. The same with `{ REVIEW_CHANNEL_IDS: A }`, expecting `"DIGEST_CHANNEL_ID"`.
  - `"rejects a non-snowflake"`: `REVIEW_CHANNEL_IDS: "REPLACE_WITH_REVIEW_CHANNEL_ID"` throws `ConfigError`, with a message containing `"REVIEW_CHANNEL_IDS"`.
  - `"requires the digest channel to be an allowed channel"`: `{ REVIEW_CHANNEL_IDS: A, DIGEST_CHANNEL_ID: B }` throws `ConfigError`, with a message containing `"DIGEST_CHANNEL_ID"`.
  - `"rejects a list that is only commas"`: `REVIEW_CHANNEL_IDS: " , "` throws `ConfigError`.

- [ ] **Step 2: Run** `npx vitest run --project=core tests/core/config.test.ts`. Expected: FAIL, `loadConfig` is not exported.

- [ ] **Step 3: Implement** `ChannelEnv`, `ConfigError` and `loadConfig` in `config/config.ts`, after the `config` constant. A snowflake is `/^\d{17,20}$/`. Split on `,`, trim each segment and drop empty ones. Error messages name the binding and say what was wrong, but never echo the value. Add a doc comment on `config.allowedChannelIds` / `digestChannelId` saying the placeholders are only for tests and preview, and production values come from `loadConfig`.

- [ ] **Step 4: Run** `npx vitest run --project=core`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -am "feat: read channel ids from env via loadConfig"`

### Task 2: Wire `loadConfig` into the Worker and the Durable Object

**Files:**
- Modify: `src/index.ts`, `src/store/do.ts:2,23-36`, `src/env.d.ts`, `vitest.config.ts`
- Test: `tests/workers/index.test.ts`, `tests/workers/do.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `ConfigError`, `ChannelEnv` (Task 1).
- Produces: `RecordsObjectEnv` gains `REVIEW_CHANNEL_IDS: string` and `DIGEST_CHANNEL_ID: string`. `Cloudflare.Env` gains the same two (required `string`, with doc comments like the existing ones). Test bindings: `REVIEW_CHANNEL_IDS = DIGEST_CHANNEL_ID = "100000000000000001"`.

- [ ] **Step 1: Add the test bindings.** In `vitest.config.ts`, `cloudflareTest({ wrangler: {...}, miniflare: { bindings: { REVIEW_CHANNEL_IDS: "100000000000000001", DIGEST_CHANNEL_ID: "100000000000000001" } } })`. Add a comment that these stand in for Worker secrets and must never move into `wrangler.jsonc`.

- [ ] **Step 2: Write the failing tests.** In `tests/workers/index.test.ts`:
  - Change the existing test "passes the Discord client, credentials and app id…" to use `channel_id: "100000000000000001"`, and update its comment: the channel comes from the `REVIEW_CHANNEL_IDS` test binding.
  - `"answers 500 on /interactions when the channel config is invalid, without echoing it"`: use `fullEnv()` with `REVIEW_CHANNEL_IDS: "nope"` and send a signed interaction. Expect status 500, and expect the body not to contain `"nope"`.
  - `"still serves /health when the channel config is invalid"`: the same broken env with a valid `HEALTH_TOKEN`. `GET /health` returns 200.

  In `tests/workers/do.test.ts`, add `"builds the digest publisher with the env digest channel"`. Install a factory with `setPublisherFactory` that records the `config` it receives, run a tick, and expect `config.digestChannelId` to be `"100000000000000001"`.

- [ ] **Step 3: Run** `npx vitest run --project=workers tests/workers/index.test.ts tests/workers/do.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 4: Implement.**
  - `src/index.ts`: `/health` and `/stats` keep using the static `config` (they only need `staleBannerMs`). For `/interactions`, call `loadConfig(env)`. On a `ConfigError`, `console.error(JSON.stringify({ configError: e.message }))` and return `new Response("bot misconfigured", { status: 500 })`. `scheduled` calls `loadConfig(env)` and lets a `ConfigError` throw after logging it the same way, so the cron run shows as failed.
  - `src/store/do.ts`: replace `private config: Config = defaultConfig` with a memoized `private get config(): Config` that returns `loadConfig(this.env)`. Drop the `defaultConfig` import. Extend `RecordsObjectEnv`.
  - `src/env.d.ts`: add the two bindings, and update the header comment to mention that they're secrets too.

- [ ] **Step 5: Run** `npm run typecheck && npx vitest run`. Expected: PASS, all projects.

- [ ] **Step 6: Commit.** `git commit -am "feat: Worker and Durable Object read channel ids from env"`

### Task 3: `immediateDigestRewrite: false` for the free plan

**Files:**
- Modify: `config/config.ts` (`immediateDigestRewrite`), `docs/setup.md` §9
- Test: `tests/workers/interactions.test.ts:16`

- [ ] **Step 1: Pin the existing test.** Change line 16 to `const config = { ...baseConfig, allowedChannelIds: [CHANNEL], digestChannelId: CHANNEL, immediateDigestRewrite: true };`. Add a comment: the claim tests assert the immediate patch, and production runs with `false`.

- [ ] **Step 2: Add the `false` case** in `describe("handleInteraction — claim")`: `"records the claim without patching the digest when immediate rewrite is off"`. Call `deps` with `{ ...config, immediateDigestRewrite: false }`. Expect `claimedByName` to be `"Katherine"` and `patches.length` to be `0`. If `deps()` doesn't take a config, add an optional config parameter to it.

- [ ] **Step 3: Flip** `immediateDigestRewrite: false` in `config/config.ts`. Change its comment to: off because the free plan's CPU budget can't fit an inline rewrite; the next tick renders.

- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS. Then run `npm run preview`, which should also pass.

- [ ] **Step 5: Update `docs/setup.md` §9.** Say it ships `false` for the free plan and that a paid-plan deploy may set it to `true`. Remove the instruction to change it "in the same PR as the channel IDs".

- [ ] **Step 6: Commit.** `git commit -am "feat: ship immediateDigestRewrite off for the free plan"`

### Task 4: Scrub private details

**Files:**
- Create (**outside the repo, never committed**): `~/pr-review-bot-private/check-private-strings.sh`
- Modify: whatever the script finds. Known so far: `fixtures/records.ts`, `fixtures/responses/github-batch.json`, `tests/core/render/request.test.ts`, `tests/store/memory.test.ts`, `tests/workers/do.test.ts`, `tests/core/__snapshots__/fixtures.test.ts.snap`, and specs and plans under `docs/superpowers/`.

- [ ] **Step 1: Write the check script** at `~/pr-review-bot-private/check-private-strings.sh`. It takes a directory, runs `grep -rInE` over it excluding `.git`, `node_modules`, `coverage`, `preview/out` and the two `*public-repo-readiness*` files, and exits 1 on any match. Its pattern list:
  `paratext-10-studio|paratext-assistant|paratext-bible-internal-extensions|sync-activity signal|PT-4[0-9]{3}|katherinejensen00|lyonsil|tjcouch-sil|teamwide-epic-discussions`

- [ ] **Step 2: Run it** against the repo. Expected: matches (exit 1). Save the list. It's your worklist.

- [ ] **Step 3: Replace, file by file,** following spec §1:
  - private repos become `example-extension`, keeping the owner `paranext` and the PR numbers;
  - every `PT-4xxx` key and its title gets an invented `PT-9001`+ key and a plausible made-up title. Use one consistent mapping across all files, so a key that recurs in a test and a fixture stays matched. The only exception is titles on the two records for public `paranext-core` PRs #2695 and #2600. Their keys still change if they're `PT-4xxx`;
  - the logins in `github-batch.json` become `reviewer-a`, `reviewer-b` and `reviewer-c`;
  - `teamwide-epic-discussions` becomes "the internal PRD forum".
  - Keep "P10", "Thursday's demo", "Trust PRD", first names, the owner line and the claim emoji.

- [ ] **Step 4: Add the anonymization note** as the line after the title of each edited spec and plan: `> Example repository names, PR titles and Jira keys in this document were anonymized for the public repository.`

- [ ] **Step 5: Regenerate snapshots** with `npx vitest run -u`, then check them with `git diff --stat tests/` and `git diff tests/core/__snapshots__/`. Expected: only the replaced strings and the `bodyHash` lines change.

- [ ] **Step 6: Run** `npx vitest run && npm run preview && npm run lint`, then `~/pr-review-bot-private/check-private-strings.sh .`. Expected: everything PASSES, and the script exits 0.

- [ ] **Step 7: Commit.** `git commit -am "chore: anonymize example repos, titles, Jira keys and logins"`. The commit message must not name the old strings.

### Task 5: Secret scanning config and CI guard

**Files:**
- Create: `.gitleaks.toml`, `.github/secret_scanning.yml`
- Modify: `.github/workflows/ci.yml`, `README.md`

- [ ] **Step 1: Write `.gitleaks.toml`.** It has `[extend] useDefault = true`, plus one `[[allowlists]]` entry per finding, each with `condition = "AND"`, a `paths` regex and a `regexes` match:
  - the PEM blocks in `tests/workers/(credentials|index|query)\.test\.ts` (`-----BEGIN (RSA )?PRIVATE KEY-----`);
  - the zero-padded `DISCORD_PUBLIC_KEY` in `docs/superpowers/plans/2026-08-31-pr-review-bot-tracking\.md`, with `targetRules = ["discord-api-token"]` if the regex alone is too broad.

  Give each entry a `description` saying why it's safe.

- [ ] **Step 2: Verify** with `gitleaks dir . --config .gitleaks.toml --no-banner` (install 8.30.1 if needed). Expected: "no leaks found". Then check that the config still detects something: put a fake `ghp_` token of real length in a scratch file under `tests/`, run again, and expect exactly 1 finding. Delete the scratch file.

- [ ] **Step 3: Write `.github/secret_scanning.yml`** with `paths-ignore:` listing the three test files. Add a comment saying they hold keys generated for tests.

- [ ] **Step 4: Add a `gitleaks` job to `ci.yml`.**
  - It uses `actions/checkout@v4` with `fetch-depth: 0`, downloads the gitleaks 8.30.1 linux x64 release tarball from GitHub releases, and checks its SHA-256 against the published checksums file.
  - On `pull_request` it runs `gitleaks git --config .gitleaks.toml --log-opts="${{ github.event.pull_request.base.sha }}..${{ github.event.pull_request.head.sha }}" --redact --no-banner`.
  - On `push` it uses `--log-opts="-1"`.
  - It doesn't use `gitleaks/gitleaks-action`.

- [ ] **Step 5: Add a "Test keys" section to the README**: "`tests/workers/*.test.ts` contain RSA private keys generated only for these tests. They sign nothing real and are allowlisted in `.gitleaks.toml` and `.github/secret_scanning.yml`."

- [ ] **Step 6: Commit and push the branch.** Open a draft PR so CI runs, and confirm the `gitleaks` job is green. `git commit -am "chore: gitleaks config, GitHub secret-scanning exclusions and CI scan"`

### Task 6: Deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: the GitHub secrets listed in spec §3 (environment `production`), and the repository variable `DEPLOY_ENABLED`.

- [ ] **Step 1: Write `deploy.yml`.**
  - `on: workflow_run: { workflows: [CI], types: [completed], branches: [master] }` and `workflow_dispatch:`.
  - `permissions: { contents: read }`.
  - `concurrency: { group: production, cancel-in-progress: false }`.
  - One job, `deploy`, with `environment: production`. Its `if:` is exactly:

    ```yaml
    if: >-
      vars.DEPLOY_ENABLED == 'true' && (
        github.event_name == 'workflow_dispatch' || (
          github.event.workflow_run.conclusion == 'success' &&
          github.event.workflow_run.event == 'push' &&
          github.event.workflow_run.head_branch == 'master' &&
          github.event.workflow_run.head_repository.full_name == github.repository))
    ```
  - Steps:
    1. `actions/checkout@v4` with `ref: ${{ github.event.workflow_run.head_sha || github.sha }}`.
    2. `actions/setup-node@v4` (node 24, npm cache).
    3. `npm ci`.
    4. `cloudflare/wrangler-action@v4` with `apiToken`/`accountId` from secrets, `command: deploy`, and `secrets:` listing all 13 Worker secret names. Each value comes from step `env:` (`DISCORD_BOT_TOKEN: ${{ secrets.DISCORD_BOT_TOKEN }}`, …). No `vars:` input.
    5. `npm run register-commands`, with `DISCORD_APP_ID`, `DISCORD_GUILD_ID` and `DISCORD_BOT_TOKEN` in step `env:`.

- [ ] **Step 2: Lint the workflow** with `npx --yes action-validator .github/workflows/deploy.yml`, or `actionlint` if it's installed. Expected: no errors.

- [ ] **Step 3: Check for leaks** with `grep -nE 'echo|--var|vars:' .github/workflows/deploy.yml`. Expected: no line prints a secret, and nothing uses `--var` or `vars:` (the `vars.DEPLOY_ENABLED` in `if:` is fine).

- [ ] **Step 4: Note for the PR description.** `workflow_run` only fires once `deploy.yml` is on the default branch, so it can't run from the PR. After merge to this repo's master, Deploy should show as **skipped** (`DEPLOY_ENABLED` unset). Check that once it's merged.

- [ ] **Step 5: Commit.** `git commit -am "ci: deploy from GitHub Actions with every value held as a secret"`

### Task 7: Docs

**Files:**
- Modify: `docs/setup.md` §11, §12, §15; `docs/operations.md:10,20,23`; `docs/architecture.md:30`; `docs/architecture-decisions.md`; `README.md`

- [ ] **Step 1: Rewrite `docs/setup.md` §11 as "Set the GitHub secrets".** Cover:
  - creating environment `production` with its deployment-branch rule set to `master` only;
  - each of the 15 secrets from spec §3, with what it is and where to get it;
  - the comma-separated format for `REVIEW_CHANNEL_IDS`, and that `DIGEST_CHANNEL_ID` must be one of them;
  - generating `HEALTH_TOKEN`/`STATS_TOKEN` with `openssl rand -hex 32` and also keeping them in the team password manager;
  - the Cloudflare API token, created with the "Edit Cloudflare Workers" template or Workers Scripts: Edit plus Account Settings: Read, with an instruction to update this line after the first deploy to whatever was actually needed;
  - setting the repository variable `DEPLOY_ENABLED=true` last.

  Remove the `wrangler secret put` list.

- [ ] **Step 2: Rewrite §12 and §15.** In §12, run the Deploy workflow by hand (Actions → Deploy → Run workflow) and watch ticks with `wrangler tail`. In §15, commands are registered by the deploy, and a manual `npm run register-commands` stays documented as a fallback. Also fix the "fill in the channel IDs in config.ts" text: those values are now secrets.

- [ ] **Step 3: `docs/operations.md`.** To rotate a value, update the GitHub secret and re-run Deploy. Replace each `wrangler secret put` mention.

- [ ] **Step 4: `docs/architecture.md:30`.** The allowed channels come from `REVIEW_CHANNEL_IDS` through `loadConfig`.

- [ ] **Step 5: Add an ADR** to `docs/architecture-decisions.md`, following the file's existing heading format, titled "All deploy values are Worker secrets, deployed from GitHub Actions". It records why: `--var` values print unmasked in public Actions logs, vars get wiped by a local deploy, and a var and a secret can't share a name. It also records the deploy gate.

- [ ] **Step 6: README.** Add a pointer to `docs/setup.md` for deploying, next to the test-keys note.

- [ ] **Step 7: Verify** with `grep -rn "wrangler secret put\|REPLACE_WITH" docs README.md`. Expected: matches only in the historical plans and specs under `docs/superpowers/`, plus the manual fallback if one was kept. Then run `~/pr-review-bot-private/check-private-strings.sh .`, which should exit 0.

- [ ] **Step 8: Commit, then mark the PR ready.** `git commit -am "docs: deploy from GitHub secrets"`

---

## Owner steps after merge (not for the implementer)

Spec §7, steps 2 through 6: rerun gitleaks and the check script on master, `git archive` into an empty directory, delete this plan and its spec, `git init` with the right `user.email`, push to the new org repo, create `production` and the secrets, set `DEPLOY_ENABLED`, then run Deploy by hand and follow `docs/setup.md` from §13.
