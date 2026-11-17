# Move to paranext/discord-bots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copy the PR review bot, with its full history, into `paranext/discord-bots` under `pr-review-bot/`, with CI, gitleaks and secret scanning running there and the deploy wired up but switched off.

**Architecture:** Rewrite the personal repo's `master` history into a `pr-review-bot/` subfolder with `git filter-repo`, merge it into the org repo's `main` with a merge commit, then move the repo-root-only files (`.github/`, `.gitleaks.toml`) to the root with paths prefixed. The bot's folder stays a self-contained npm project; nothing is shared between bots.

**Tech Stack:** git, git-filter-repo, GitHub Actions, gitleaks 8.30.1, actionlint, Node 24 / npm, Wrangler (unchanged).

**Spec:** `docs/superpowers/specs/2026-11-13-move-to-discord-bots-repo-design.md`

## Global Constraints

- Source is `jolierabideau/pr-review-bot` **`master`** (currently `c2df8e7`). Not `test-server`, not PR #13's branch.
- Target is `paranext/discord-bots`, default branch `main`. Bot folder: `pr-review-bot/`.
- Nothing in the personal repo changes: no pushes, no setting changes, no archive.
- Worker name stays `pr-review-bot`; `wrangler.jsonc`, Durable Object class and migration tag are untouched. `package.json` name stays `pr-review-bot`.
- No behaviour changes to the bot. No shared tooling between bots.
- Deploy gate: repository variable `PR_REVIEW_BOT_DEPLOY_ENABLED`; environment `pr-review-bot-production`. **Nothing in this plan sets either.**
- Workflow names (the `name:` field) exactly: `pr-review-bot CI`, `pr-review-bot Deploy`, `gitleaks`.
- The restructure PR is merged with a **merge commit**, never squash or rebase.
- No secret value is ever typed, echoed or passed as a command argument by this plan.
- Git over SSH to github.com fails on this machine. Use HTTPS with gh as the credential helper: `git -c credential.helper= -c credential.helper='!gh auth git-credential' <cmd>`, or run `gh auth setup-git` once.
- Merging any PR in `paranext/discord-bots` is an outward action: stop and get the user's go-ahead first.

## Review Focus

- **A fresh clone of the new repo, `cd pr-review-bot && npm ci && npm test`.** Expected: passes with no file outside the folder. Covered by Task 3 step "Run the bot's checks from the folder".
- **gitleaks over the full imported history with the root config.** Expected: no leaks; the test RSA keys and the placeholder Discord key are still allowlisted at their new `pr-review-bot/` paths. Covered by Task 3's before/after gitleaks steps.
- **Merging the restructure PR to `main`.** Expected: CI and gitleaks run, the Deploy workflow is triggered and **skips** (variable unset), not fails. Covered by Task 5's post-merge check.
- **A future PR that touches only the root README or another bot's folder.** Expected: `pr-review-bot CI` does not run, `gitleaks` does. Covered by Task 3's actionlint step and by the path filter reviewed in Task 5's PR checks (the root-README change in that PR is in the same PR, so this is checked by reading the filter, not by a run).
- **History preserved after merge.** Expected: `git log --oneline -- pr-review-bot/src/index.ts` on `main` shows commits from August 2026. Covered by Task 5's post-merge check.

---

### Task 1: Rewrite the personal repo's history into `pr-review-bot/`

**Files:**
- Create (scratch, not committed anywhere): `$SCRATCH/rewrite/` — a fresh clone of the personal repo, rewritten. `$SCRATCH` is this session's scratchpad directory.

**Interfaces:**
- Produces: a local repo at `$SCRATCH/rewrite` whose `master` holds every original commit with every path under `pr-review-bot/`. Task 3 fetches from it.

- [ ] **Step 1: Install tools**

Run: `brew install git-filter-repo actionlint`
Expected: `git filter-repo --version` and `actionlint --version` both print a version.

- [ ] **Step 2: Fresh clone of the source**

Run: `git clone --single-branch --branch master https://github.com/jolierabideau/pr-review-bot.git "$SCRATCH/rewrite"` (with the gh credential helper from Global Constraints).
Expected: `git -C "$SCRATCH/rewrite" rev-parse --short HEAD` prints `c2df8e7` (or later, if master moved — record which).

- [ ] **Step 3: Record the before-state**

Run: `git -C "$SCRATCH/rewrite" rev-list --count HEAD` and note the number N.

- [ ] **Step 4: Rewrite into the subfolder**

Run: `git -C "$SCRATCH/rewrite" filter-repo --to-subdirectory-filter pr-review-bot`

- [ ] **Step 5: Verify the rewrite**

Run:
- `git -C "$SCRATCH/rewrite" ls-tree --name-only HEAD` → exactly `pr-review-bot`
- `git -C "$SCRATCH/rewrite" rev-list --count HEAD` → N
- `git -C "$SCRATCH/rewrite" log --oneline -1` → same subject as step 2's commit

No commit: this repo is scratch.

---

### Task 2: PR 1 — root secret-scanning ignore list

**Files:**
- Create: `~/dev/discord-bots/` — clone of `paranext/discord-bots` (the working copy for Tasks 2–5).
- Create: `.github/secret_scanning.yml`

**Interfaces:**
- Produces: `.github/secret_scanning.yml` on `main`, which Task 3 edits in place (not re-creates).

- [ ] **Step 1: Clone the org repo**

Run: `git clone https://github.com/paranext/discord-bots.git ~/dev/discord-bots` (gh credential helper).
Expected: `ls ~/dev/discord-bots` → `LICENSE`.

- [ ] **Step 2: Branch and write the file**

Branch `chore/secret-scanning-paths` from `main`. Create `.github/secret_scanning.yml` with the same comment as the personal repo's file and:

```yaml
paths-ignore:
  - "pr-review-bot/tests/workers/credentials.test.ts"
  - "pr-review-bot/tests/workers/index.test.ts"
  - "pr-review-bot/tests/workers/query.test.ts"
```

- [ ] **Step 3: Commit, push, open PR**

```bash
git add .github/secret_scanning.yml
git commit -m "chore: ignore pr-review-bot's test-only RSA keys in secret scanning"
git push -u origin chore/secret-scanning-paths
gh pr create --repo paranext/discord-bots --base main --title "chore: secret-scanning ignore list for pr-review-bot's test keys" --body "<why: the next PR imports history containing RSA keys generated only for tests; this lands first so push protection, if enabled, does not block that push>"
```

- [ ] **Step 4: STOP — get the user's go-ahead, then merge**

Merge method: any (squash is fine for this one). Expected after merge: `git pull` on `main` shows the file. Task 3 cannot push until this is on `main`.

---

### Task 3: Restructure branch — import history, move root files, rewrite workflows

**Files (all in `~/dev/discord-bots`):**
- Merge in: `pr-review-bot/**` from Task 1.
- Move: `pr-review-bot/.gitleaks.toml` → `.gitleaks.toml`
- Move: `pr-review-bot/.github/workflows/ci.yml` → `.github/workflows/pr-review-bot-ci.yml`
- Move: `pr-review-bot/.github/workflows/deploy.yml` → `.github/workflows/pr-review-bot-deploy.yml`
- Create: `.github/workflows/gitleaks.yml` (the `gitleaks` job split out of the CI file)
- Delete: `pr-review-bot/.github/secret_scanning.yml` (root copy exists from Task 2)
- Create: `.gitignore` (root)
- Keep in place: `pr-review-bot/.gitignore`, `pr-review-bot/.npmrc`, and everything else.

**Interfaces:**
- Consumes: Task 1's `$SCRATCH/rewrite` `master`; Task 2's root `.github/secret_scanning.yml` on `main`.
- Produces: branch `chore/move-pr-review-bot` with three commits (merge, move, workflows) that Task 4 adds docs to.

- [ ] **Step 1: Branch and merge the rewritten history**

```bash
git switch main && git pull
git switch -c chore/move-pr-review-bot
git fetch "$SCRATCH/rewrite" master:refs/remotes/rewrite/master
git merge --allow-unrelated-histories --no-ff rewrite/master -m "Import pr-review-bot history from jolierabideau/pr-review-bot@<sha from Task 1 step 2>"
```

Expected: no conflicts (the trees don't overlap); `ls pr-review-bot` shows `src tests docs ...`; `git log --oneline | wc -l` is N + (main's commits) + 1.

- [ ] **Step 2: Run the bot's checks from the folder**

Run: `cd pr-review-bot && npm ci && npm run typecheck && npm run lint && npm run coverage && npm run preview`
Expected: all pass, as on the personal repo.

- [ ] **Step 3: gitleaks with the un-prefixed config fails (proves the allowlist matters)**

Run from the repo root: `gitleaks git --config pr-review-bot/.gitleaks.toml --redact --no-banner`
Expected: exits non-zero, reporting `private-key` findings in `pr-review-bot/tests/workers/*.test.ts` (and possibly the placeholder key in the 2026-08-31 plan).

- [ ] **Step 4: Move `.gitleaks.toml` to the root and prefix its paths**

`git mv pr-review-bot/.gitleaks.toml .gitleaks.toml`. Change the two allowlist `paths` to:
- `'''^pr-review-bot/tests/workers/(credentials|index|query)\.test\.ts$'''`
- `'''^pr-review-bot/docs/superpowers/plans/2026-08-31-pr-review-bot-tracking\.md$'''`

Title becomes `"discord-bots gitleaks config"`. Delete `pr-review-bot/.github/secret_scanning.yml` (the root one from Task 2 replaces it). Add a root `.gitignore`:

```
node_modules/
.DS_Store
*.pem
.dev.vars
```

- [ ] **Step 5: gitleaks with the root config passes**

Run: `gitleaks git --config .gitleaks.toml --redact --no-banner`
Expected: `no leaks found`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: move gitleaks and secret-scanning config to the repo root"
```

- [ ] **Step 7: Rewrite the workflows**

`git mv` the two workflow files to their new names (Files above), then:

`pr-review-bot-ci.yml`:
- `name: pr-review-bot CI`
- `on.pull_request.paths` and `on.push.paths`: `['pr-review-bot/**', '.github/workflows/pr-review-bot-*.yml']`; `on.push.branches: [main]`. Rewrite the master/main comment to say the default branch is `main`.
- Only the `check` job stays. `defaults.run.working-directory: pr-review-bot`. `setup-node` gets `cache-dependency-path: pr-review-bot/package-lock.json`. Steps unchanged.

`gitleaks.yml`:
- `name: gitleaks`; `on: pull_request` and `push: branches: [main]`, **no** path filter.
- The `gitleaks` job moved verbatim from the old CI file, with `--config .gitleaks.toml` (root).

`pr-review-bot-deploy.yml`:
- `name: pr-review-bot Deploy`
- `workflow_run.workflows: ["pr-review-bot CI"]`, `branches: [main]`.
- `if:` uses `vars.PR_REVIEW_BOT_DEPLOY_ENABLED == 'true'` and `head_branch == 'main'`.
- `environment: pr-review-bot-production`; `concurrency.group: pr-review-bot-production`.
- Tip check: `git ls-remote origin refs/heads/main`; notice text says `main`. Add a comment that an unrelated commit landing on `main` meanwhile makes this skip, and the next pr-review-bot change deploys.
- `npm ci` and `npm run register-commands` steps get `working-directory: pr-review-bot`; `setup-node` gets `cache-dependency-path: pr-review-bot/package-lock.json`; the wrangler action gets `workingDirectory: pr-review-bot`. Wrangler action stays pinned to the same SHA. Secret list unchanged.

- [ ] **Step 8: Lint the workflows**

Run: `actionlint` from the repo root.
Expected: no output, exit 0. Then `grep -rn master .github/` → no matches.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "ci: run pr-review-bot CI and deploy from its folder on main; gitleaks repo-wide"
```

---

### Task 4: Docs

**Files:**
- Create: `README.md` (root)
- Modify: `pr-review-bot/README.md` (the "allowlisted in `.gitleaks.toml` and `.github/secret_scanning.yml`" sentence → "…in the repo root's `.gitleaks.toml` and `.github/secret_scanning.yml`")
- Modify: `pr-review-bot/docs/setup.md` steps 11–12
- Modify: `pr-review-bot/docs/operations.md`
- Modify: `pr-review-bot/docs/architecture-decisions.md` (append one ADR)
- Copy in: the spec and this plan to `pr-review-bot/docs/superpowers/specs/` and `pr-review-bot/docs/superpowers/plans/`

**Interfaces:**
- Consumes: the names from Global Constraints and Task 3's workflow file names.

- [ ] **Step 1: Root README**

Short: what this repo is (the team's Discord bots, one folder each), a table with one row — `pr-review-bot/` → one-line description, link to `pr-review-bot/README.md` — and "Adding a bot": a new folder that is its own project, plus its own `<bot>-ci.yml` / `<bot>-deploy.yml` with path filters, its own `<BOT>_DEPLOY_ENABLED` variable and `<bot>-production` environment, and any allowlist entries in the root `.gitleaks.toml`.

- [ ] **Step 2: `docs/setup.md` steps 11–12**

Replace: `.github/workflows/deploy.yml` → `.github/workflows/pr-review-bot-deploy.yml` (repo root); environment `production` → `pr-review-bot-production`; deployment branch `master` → `main`; `DEPLOY_ENABLED` → `PR_REVIEW_BOT_DEPLOY_ENABLED`; "Actions → Deploy" → "Actions → pr-review-bot Deploy"; "on `master`" → "on `main`". Note that creating environments and variables needs repo admin.

- [ ] **Step 3: `docs/operations.md`**

Rotation section: `production` → `pr-review-bot-production`, "Actions → pr-review-bot Deploy". Add a section **"Moving deploys from the personal repo (cutover)"** with the spec's four cutover steps verbatim in meaning, including: enter secrets via the GitHub UI or `gh secret set --env pr-review-bot-production` reading stdin (never as an argument); deployment-branch rule `main` only; turn `DEPLOY_ENABLED` off in `jolierabideau/pr-review-bot` **before** setting `PR_REVIEW_BOT_DEPLOY_ENABLED=true` here; run the deploy by hand and check `/health` and a slash command; the test Worker `pr-review-bot-test` can then be kept or deleted.

- [ ] **Step 4: ADR**

Append `## adr-multi-bot-repo-layout` in the existing ADR style: decision (self-contained folder per bot, root holds only GitHub-read files, per-bot workflows/variable/environment), alternatives B and C from the spec with why not, and that it supersedes the names `production`, `DEPLOY_ENABLED` and `master` in `adr-deploy-values-are-worker-secrets`. Earlier ADRs are left as written.

- [ ] **Step 5: Copy the spec and plan in**

From `~/dev/pr-review-bot/docs/superpowers/`, copy `specs/2026-11-13-move-to-discord-bots-repo-design.md` and `plans/2026-11-17-move-to-discord-bots-repo.md` into the matching folders under `pr-review-bot/docs/superpowers/`.

- [ ] **Step 6: Verify nothing stale is left**

Run: `grep -rn -E '\bDEPLOY_ENABLED\b|Actions → Deploy|`production`|on `master`' README.md pr-review-bot/README.md pr-review-bot/docs/setup.md pr-review-bot/docs/operations.md`
Expected: matches only inside the cutover section where it names the personal repo's `DEPLOY_ENABLED`. Then re-run `cd pr-review-bot && npm run lint && npm test` (docs-only change; confirms nothing else moved).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "docs: root README, deploy names on main, cutover checklist, multi-bot ADR"
```

---

### Task 5: Open the restructure PR, merge, check

**Interfaces:**
- Consumes: branch `chore/move-pr-review-bot` from Tasks 3–4; Task 2 merged.

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin chore/move-pr-review-bot
gh pr create --repo paranext/discord-bots --base main --title "Move pr-review-bot into this repo" --body "<summary of the move, link to the spec, note: merge with a MERGE COMMIT to keep history; deploy stays off until PR_REVIEW_BOT_DEPLOY_ENABLED is set>"
```

Expected: the push is not rejected by push protection. If it is, stop and tell the user (an admin bypass is needed; do not alter history to get round it).

- [ ] **Step 2: Check the PR's runs**

Expected: `pr-review-bot CI / check` and `gitleaks / gitleaks` both pass; no Deploy run.

- [ ] **Step 3: STOP — get the user's go-ahead, then merge with a merge commit**

Run: `gh pr merge <n> --repo paranext/discord-bots --merge`

- [ ] **Step 4: Post-merge checks**

- On the `main` push: `pr-review-bot CI` and `gitleaks` pass; `pr-review-bot Deploy` runs and its job is **skipped** (`gh run list --repo paranext/discord-bots --workflow pr-review-bot-deploy.yml`).
- `git pull && git log --oneline -- pr-review-bot/src/index.ts | tail -1` shows an August 2026 commit.

- [ ] **Step 5: Update session memory**

Update the `test-branch-tracks-master` memory: new work goes to `paranext/discord-bots` `main`; the personal repo's `master` and `test-server` are frozen and only keep production and the test server running until cutover.
