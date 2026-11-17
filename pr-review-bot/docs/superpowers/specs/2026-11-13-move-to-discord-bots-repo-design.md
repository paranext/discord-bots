# Move the bot into paranext/discord-bots

## Intent

The org created [paranext/discord-bots](https://github.com/paranext/discord-bots)
as the home for this bot and for any Discord bots that may follow. No second bot
is planned, and nobody knows yet whether a future one would be a separate
Discord app or more commands on this one. So the move should:

- put the PR review bot in the org repo, working exactly as it does today, and
- leave room for a second bot without guessing what it will look like.

## Goals

- The bot's code, tests, docs and history live in `paranext/discord-bots`
  under `pr-review-bot/`.
- CI, gitleaks, secret scanning and the production deploy run from the new repo.
- The production Worker keeps its name (`pr-review-bot`) and its Durable Object
  data: no review records, claims or API keys are lost.
- Adding a sibling bot later means adding a folder plus a few lines in the
  shared root files, not moving this bot again.

## Non-goals

- No shared tooling between bots (npm workspaces, shared tsconfig/eslint/vitest
  config, shared libraries). That waits for a real second bot.
- No behaviour changes to the bot.
- No rename of the Worker, the Discord application, the GitHub App or the
  `prb_` API key prefix.

## Anti-goals (would make this a failure even if the code works)

- Both repos deploying to the same Worker at once, or production left with no
  deploy path.
- Losing Durable Object state (a new Worker name, or a migration tag change).
- A secret printed in a public Actions log during setup.
- Production or the test server interrupted by this work: the personal repo keeps
  running both until the owner switches.

## Approaches considered

- **A. Self-contained bot folder, nothing shared yet — chosen.** The bot moves
  into `pr-review-bot/` as a complete project (own `package.json`, lockfile,
  `wrangler.jsonc`, tests, docs). Only files GitHub or Claude Code read from the
  repo root live there. Cheapest now; fits either kind of future bot.
- **B. npm workspaces monorepo now** (`bots/pr-review-bot/`, shared dev tooling
  at the root). Tidier if a second Worker bot arrives, but the shared parts are
  guesses, and wasted if the "next bot" is more commands on this one.
- **C. Bot at the repo root, restructure later.** Least work today, but the later
  move re-touches every path, the workflows and the plugin install path.

## Design

### Layout of paranext/discord-bots (default branch `main`)

```
LICENSE                          (already there)
README.md                        index of bots; links to pr-review-bot/README.md
.gitignore                       repo-wide ignores (node_modules/, .wrangler/, *.pem, .dev.vars, ...)
.gitleaks.toml                   rules + allowlists, paths prefixed with pr-review-bot/
.github/
  secret_scanning.yml            paths-ignore prefixed with pr-review-bot/
  workflows/
    pr-review-bot-ci.yml
    pr-review-bot-deploy.yml
    gitleaks.yml                 repo-wide; not per bot
pr-review-bot/
  package.json, package-lock.json, .npmrc, tsconfig.json, eslint.config.js,
  vitest.config.ts, wrangler.jsonc, README.md
  src/ tests/ fixtures/ config/ preview/ scripts/ docs/
```

Everything under `pr-review-bot/` is the current repo's content with paths
unchanged relative to the folder, so `npm ci && npm test` inside it works as
today.

### History

Bring the full history of `master` across, rewritten into the subfolder
(`git filter-repo --to-subdirectory-filter pr-review-bot`, or equivalent), then
merge it into the new repo's `main` with `--allow-unrelated-histories`. Old
commit SHAs will differ; links in docs to old-repo commits/PRs stay pointing at
the old repo, which is fine.

Root-only files (`.github/`, `.gitleaks.toml`) land inside
`pr-review-bot/` from the rewrite and are then moved to the root (and edited) in
a follow-up commit, so history shows where they came from.

### Workflows

- **CI (`pr-review-bot-ci.yml`)**: triggers on `pull_request` and on `push` to
  `main`, both filtered with `paths: ['pr-review-bot/**',
  '.github/workflows/pr-review-bot-*.yml']`. `defaults.run.working-directory:
  pr-review-bot`; `setup-node` gets `cache-dependency-path:
  pr-review-bot/package-lock.json`. Same steps as today (typecheck, lint,
  coverage, preview). The comment about `master` vs `main` is updated.
- **gitleaks (`gitleaks.yml`)**: split out of CI so it scans every PR and push to
  `main` regardless of which folder changed. Same install and range logic as
  today, config at root.
- **Deploy (`pr-review-bot-deploy.yml`)**: same as today with `master` → `main`
  everywhere (workflow_run branch filter, head_branch check, `git ls-remote`
  tip check), `workflow_run.workflows: ["pr-review-bot CI"]` (must match the CI
  workflow's `name`), working directory `pr-review-bot` for `npm ci`, the
  wrangler action's `workingDirectory: pr-review-bot`, and
  `npm run register-commands` in that folder. Gated by a per-bot repository
  variable `PR_REVIEW_BOT_DEPLOY_ENABLED` and a per-bot environment
  `pr-review-bot-production`, so a later bot gets its own switch and secrets.

  Path filters don't apply to `workflow_run`, so a deploy runs whenever this
  bot's CI ran and passed — which, thanks to CI's path filter, means only when
  this bot changed. Unrelated commits to `main` would make the "tip of main"
  check skip a pending deploy; that's acceptable (the next bot change deploys),
  but the check should compare against the latest commit touching
  `pr-review-bot/` instead if that turns out to bite. Builder's call.

### Names that stay

Worker name `pr-review-bot`, Durable Object class and migration tag, the GitHub
App, the Discord app, `User-Agent` strings, the `prb_` key prefix and its
gitleaks rule. `package.json` name stays `pr-review-bot`.

### What this work delivers vs. what the owner does by hand

This work delivers a copy of the bot in the new repo, with CI passing and
deploy wired up but switched off. It does **not** retire or change the personal
repo (`jolierabideau/pr-review-bot`): that repo keeps deploying production and
the test server until the owner switches over.

Order of the PRs to the new repo:

1. A small PR adding `.github/secret_scanning.yml` (paths prefixed with
   `pr-review-bot/`), so GitHub push protection, if the org enables it, doesn't
   block the history push for the test-only RSA keys.
2. The restructure PR: rewritten history plus the root files, merged with a
   **merge commit** (not squash), so the history survives. The repo allows
   merge commits and has no branch protection today.

`PR_REVIEW_BOT_DEPLOY_ENABLED` stays unset, so merging deploys nothing.

### Cutover (owner, by hand, when ready)

Exactly one repo may deploy to the `pr-review-bot` Worker at any time. Written
into `pr-review-bot/docs/operations.md` as a checklist:

1. A repo admin (the owner's manager, or the owner once granted admin) creates
   environment `pr-review-bot-production` with the 13 bot secrets plus
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The owner holds all the
   values. Enter them in the GitHub UI or with `gh secret set --env` reading
   stdin, never as command arguments or `--var`.
2. Personal repo: set `DEPLOY_ENABLED` to `false`.
3. New repo: set `PR_REVIEW_BOT_DEPLOY_ENABLED=true`, run the deploy workflow by
   hand (`workflow_dispatch`), check `/health` and a slash command.
4. Delete the `pr-review-bot-test` Worker or leave it, as the owner prefers;
   the test server is no longer needed once production runs from the new repo.

### PR #13 (Claude Code plugin)

[jolierabideau/pr-review-bot#13](https://github.com/jolierabideau/pr-review-bot/pull/13)
does not merge before the move, so the copy is of `master` and has no plugin,
`/review-key` or `prb_` gitleaks rule. The root `.claude-plugin/marketplace.json`
and the `prb_` rule are **out of scope here**; they arrive when #13 is re-landed
against the new repo, with the layout this design sets out (marketplace at the
root named `discord-bots`, plugin source `./pr-review-bot/claude-plugin`,
`pluginHook.test.ts` reading `../.claude-plugin/marketplace.json`). That
re-landing is follow-up work, not this change.

### Test server

Stays in the personal repo: the `test-server` branch and the
`pr-review-bot-test` Worker are untouched, and no `test-server` branch is
created in the org repo.

### Source of truth

From the moment the restructure PR merges, `paranext/discord-bots` is the source
of truth: new work for the bot goes in PRs to its `main`. The personal repo's
`master` is frozen; its only remaining jobs are deploying production (until
cutover) and keeping the test server running so coworkers can look at it. The
test server is not kept in step with new work, so it shows the bot as of the
copy. Nothing needs syncing back.

Consequence: between the copy and the cutover, merged work in the new repo is
not live anywhere. Cutover deploys all of it at once.

This spec lands as the first commit of the restructure PR, under
`pr-review-bot/docs/superpowers/specs/`, rather than in the frozen personal repo.

## Left to the builder

- Exact filter-repo invocation and how the root files are moved.
- Whether the docs that refer to repo-root paths (`docs/setup.md`,
  `docs/operations.md`, `docs/architecture*.md`) need edits beyond the plugin
  install lines and the branch name. Paths relative to the bot folder don't change.
- Wording of the root README.
