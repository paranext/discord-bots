# discord-bots

The team's Discord bots. Each bot lives in its own folder as a self-contained
project, with its own dependencies, tests, docs and deploy.

| Bot | What it does |
|---|---|
| [`pr-review-bot/`](pr-review-bot/README.md) | Keeps one always-current "Needs review" list pinned in the review channel, fed by `/review-request` |

## Working on a bot

Run everything from the bot's folder:

```bash
cd pr-review-bot
npm ci
npm test
```

## Adding a bot

- A new top-level folder that is its own project. Nothing is shared between
  bots yet; share code only once two bots actually need it.
- Its own workflows in `.github/workflows/`, named `<bot>-ci.yml` and
  `<bot>-deploy.yml`, with CI path-filtered to the bot's folder (see
  `pr-review-bot-ci.yml`).
- Its own deploy switch and secrets: a repository variable
  `<BOT>_DEPLOY_ENABLED` and an environment `<bot>-production`.
- Any known-safe test secrets allowlisted in the root `.gitleaks.toml` and
  `.github/secret_scanning.yml`, with paths starting at the bot's folder.

`gitleaks.yml` scans every change in the repository, whichever folder it
touches. See `pr-review-bot/docs/architecture-decisions.md`,
`adr-multi-bot-repo-layout`, for why the repository is laid out this way.
