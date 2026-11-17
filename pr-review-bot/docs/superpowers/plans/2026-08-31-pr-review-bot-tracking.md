# PR Review Bot — Tracking Half Implementation Plan

> Example repository names, PR titles and Jira keys in this document were anonymized for the public repository.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tracking half of the PR review bot — a pinned "Needs review" digest that stays accurate on its own, fed by channel scanning and GitHub review events — deployable in shadow mode without anyone changing how they work.

**Architecture:** One worker process with two entry points (`POST /interactions`, `scheduled()`) over three module seams: a pure `core/` holding every rule that can be subtly wrong, thin `discord/` and `github/` adapters stubbed with a fake `fetch` in tests, and a `store/` adapter behind a command interface so the deferred hosting choice reaches one file. The digest is a pure function of `(records, lastSync, now)`, which is what lets a preview harness render every scenario before a credential exists and what lets the stale banner fire when a sync fails.

**Tech Stack:** TypeScript 6.0.3 (strict), Cloudflare Workers + Durable Objects, Wrangler 4.127.1, Vitest 4.1 with `@cloudflare/vitest-plugin` 1.1.2, Istanbul coverage. No runtime dependencies — Ed25519 verification, RS256 JWT signing and GraphQL all use Web Crypto and `fetch` directly.

**Spec:** `docs/superpowers/specs/2026-08-26-pr-review-bot-design.md`

**Plan scope:** This is plan 1 of 3, matching the spec's rollout stages. It delivers rollout stages 1–2 (scratch server, then shadow mode). Deferred to their own plans: the `/review-request` modal and PRD thread cache (plan 2, rollout stage 3), and the `:code_review:` reaction claim path (plan 3). Where this plan stops short of a spec section, the task says so explicitly.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec.

- **Never read or request `reviewDecision`.** It is null on unprotected branches, never resets after a push, and ignores comment-only reviews. Requesting it at all is a defect, including in tests.
- **The digest body must be a pure function of record state**, never of wall-clock time. All ages render as Discord relative timestamps `<t:epoch:R>` in **long form** (`3 days ago`) — Discord has no compact variant, so `3d` is unreachable without computing ages, which would churn the body on nearly every tick and cost 288 no-op `PATCH`es a day.
- **At most two store subrequests per tick, regardless of record count.** Store calls count against the same 50-per-invocation subrequest ceiling as outbound `fetch`. Per-row writes both blow the budget and let a tick die mid-write.
- **Snapshots must be time-independent.** A suite whose snapshots churn when the clock crosses an hour boundary is the same defect as a body that churns, and would hide it.
- **`core/` has no I/O.** No `fetch`, no `Date.now()`, no `crypto.subtle` (async). Time and randomness arrive as arguments.
- **Records are resolved, never deleted.** Retained 30 days, then purged. Every write path that matches an existing record must state what it does when that record is resolved.
- **Coverage gate on `core/`** — 95% lines/branches. Adapters: 70%.
- **A 401 from any credential fails closed** for that credential group and stops retrying. 10,000 invalid responses in 10 minutes risks a temporary IP ban.
- **Config lives in `config/config.ts`**, typed and checked in, so changes are reviewable one-line PRs. Secrets never appear there.
- Repo allowlist initial value: `paranext/paranext-core`, `paranext/example-extension`, `paranext/paratext-bible-extensions`, `eten-tech-foundation/scripture-editors`.
- Urgency levels: `🔥 Blocking` (requires a note), `Soon` (no icon), `🧊 This week`. Teams: `Power`, `Simple`, `General`. Refresh interval 5 minutes; stale-claim threshold 2 days; recently-cleared window 1 hour; stale-banner threshold 30 minutes; retention 30 days.

---

## File Structure

Created by this plan. Each file has one responsibility; files that change together live together.

```
package.json                     pinned toolchain, scripts
tsconfig.json                    strict, ES2022, Workers types
vitest.config.ts                 two projects: core (node) and workers (pool)
wrangler.jsonc                   entry, DO binding, KV binding, cron trigger
.github/workflows/ci.yml          typecheck, lint, test, coverage gates

config/config.ts                 Config type + the checked-in value

src/core/urls.ts                 parsePrUrl, isAllowlisted
src/core/record.ts               PrRecord type, recordId, latch transitions
src/core/exit.ts                 countsAsReview, exitVerdict  ← the load-bearing rule
src/core/claims.ts               applyClaim, applyUnclaim, staleClaimClears
src/core/ranking.ts              rankRows, truncateRows, menuOptions
src/core/time.ts                 relTs, isStale
src/core/hash.ts                 stableHash (sync, pure)
src/core/render/digest.ts        renderDigest — pure fn of (records, lastSync, now)
src/core/render/request.ts       renderRequestMessage
src/core/render/daily.ts         renderDailyPost

src/store/types.ts               Store interface, Command union, result types
src/store/apply.ts               pure command application over StoreState
src/store/memory.ts              MemoryStore — tests and preview
src/store/do.ts                  RecordsObject Durable Object

src/discord/verify.ts            Ed25519 request verification
src/discord/rest.ts              thin REST client
src/discord/components.ts        select-menu and embed payload builders
src/discord/scan.ts              paginated channel message scan

src/github/credentials.ts        App JWT + installation token, owner routing
src/github/query.ts              batched GraphQL, chunked to 25, partial errors

src/handlers/scheduled.ts        the refresh loop
src/handlers/interactions.ts     interaction router (menus in this plan)
src/handlers/reviewList.ts       /review-list
src/handlers/health.ts           health endpoint
src/handlers/startup.ts          INTENT_MISSING assertion
src/index.ts                     worker entry, exports RecordsObject

fixtures/records.ts              record fixtures, shared by tests AND preview
fixtures/responses/*.json        recorded GitHub and Discord payloads
preview/build.ts                 writes preview/out/index.html + embeds.json
preview/template.ts              Discord-accurate CSS shell

docs/architecture.md  docs/setup.md  docs/operations.md
docs/architecture-decisions.md   append-only adr-<slug> log
README.md                        30-second usage + data policy
```

**Why the store is a command interface rather than a callback:** the tick reads records, then does tens of seconds of network I/O, then must write and render against *committed* state. A closure cannot cross a Durable Object RPC boundary, so interactive mutations are named, serializable `Command` values applied atomically inside the object. The `finishTick` call applies mutations, re-reads, renders, performs the Discord `PATCH` **from inside the object**, and stores the body hash only if that `PATCH` succeeded — which is what makes the record, the message and the hash consistent, and keeps the worker at two store subrequests.

---

## Task 1: Repo scaffold, config module, CI

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `eslint.config.js`
- Create: `config/config.ts`
- Create: `.github/workflows/ci.yml`
- Test: `tests/core/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Config`, `UrgencyLevel`, `TeamName` types from `config/config.ts`; `config` as the default export value. Every later task imports `Config` as a parameter type rather than importing the value, so tests can pass overrides.

- [ ] **Step 1: Initialise the package with pinned versions**

```bash
cd /Users/jolierabideau/dev/pr-review-bot
npm init -y
npm pkg set name="pr-review-bot" private=true type="module"
npm pkg delete main
npm install --save-dev \
  typescript@6.0.3 \
  vitest@4.1.11 \
  @cloudflare/vitest-plugin@1.1.2 \
  @cloudflare/workers-types@5.20260831.1 \
  @vitest/coverage-istanbul@4.1.11 \
  wrangler@4.127.1 \
  eslint@9 typescript-eslint@8.69.0
```

There are **no runtime dependencies** and there should never be one added without an ADR. Ed25519, RS256 and hashing all come from Web Crypto.

**Why TypeScript 6.0.3 and not 7.x:** `typescript-eslint` declares
`typescript: ">=4.8.4 <6.1.0"` as a peer and its latest line (8.69.0) is the only
8.x line, so no published version supports TS 7 — installing both is a hard
`ERESOLVE`. ESLint cannot parse `.ts` at all without `@typescript-eslint/parser`,
and the lint layer is load-bearing here: the `no-restricted-globals` rule on
`Date` is what mechanically enforces the Global Constraint that `core/` has no
I/O. Nothing in this plan needs a TS 7 feature — `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax` and import attributes all
predate TS 6. Revisit when `typescript-eslint` supports TS 7.

- [ ] **Step 2: Add scripts**

```bash
npm pkg set scripts.typecheck="tsc --noEmit"
npm pkg set scripts.lint="eslint ."
npm pkg set scripts.test="vitest run"
npm pkg set scripts.test:watch="vitest"
npm pkg set scripts.coverage="vitest run --coverage"
npm pkg set scripts.preview="vitest run --project=core && node --experimental-strip-types preview/build.ts"
npm pkg set scripts.deploy="wrangler deploy"
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "config", "tests", "preview", "fixtures"]
}
```

`noUncheckedIndexedAccess` matters more than it looks: the ranking and truncation code indexes arrays constantly, and this is what forces the empty-list cases to be handled rather than crashing the renderer.

- [ ] **Step 4: Write `vitest.config.ts` with two projects**

`core/` is pure and must run fast in plain Node so the preview script can reuse it. Only the store and adapter tests need the Workers pool.

```ts
import { defineConfig } from "vitest/config";
import { defineWorkersProject } from "@cloudflare/vitest-plugin/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          include: ["tests/core/**/*.test.ts", "tests/store/apply.test.ts"],
          environment: "node",
        },
      },
      defineWorkersProject({
        test: {
          name: "workers",
          include: ["tests/workers/**/*.test.ts"],
          poolOptions: { workers: { wrangler: { configPath: "./wrangler.jsonc" } } },
        },
      }),
    ],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["src/**"],
      thresholds: {
        "src/core/**": { lines: 95, branches: 95, functions: 95, statements: 95 },
        "src/**": { lines: 70, branches: 60, functions: 70, statements: 70 },
      },
    },
  },
});
```

Coverage is **Istanbul, not v8** — the Workers pool does not support v8 coverage, and a coverage gate configured for the wrong provider silently reports zero.

- [ ] **Step 5: Write `config/config.ts`**

```ts
export type TeamName = "Power" | "Simple" | "General";

export type UrgencyKey = "blocking" | "soon" | "thisWeek";

export interface UrgencyLevel {
  key: UrgencyKey;
  emoji: string | null;
  label: string;
  /** Lower sorts first. Null urgency (scanned rows) ranks below every level. */
  rank: number;
  requiresNote: boolean;
}

export interface Config {
  allowedChannelIds: string[];
  digestChannelId: string;
  prdForumChannelId: string;
  repoAllowlist: string[];
  teams: TeamName[];
  urgencies: UrgencyLevel[];
  claimEmoji: string;
  staleClaimMs: number;
  refreshIntervalMs: number;
  recentlyClearedMs: number;
  staleBannerMs: number;
  retentionMs: number;
  /** How long after resolving a row the digest offers it as a reopen option, and
   *  the handler accepts a reopen selection. One number, read by both — see Task 18. */
  reopenWindowMs: number;
  scanLookbackMs: number;
  dailyPostHourLocal: number;
  dailyPostTimeZone: string;
  budgets: { scanPagesPerTick: number; purgePerTick: number; reactionReadsPerTick: number };
  /** Off on a CPU-capped host: the submit handler writes and returns, next tick renders. */
  immediateDigestRewrite: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const config: Config = {
  allowedChannelIds: ["REPLACE_WITH_REVIEW_CHANNEL_ID"],
  digestChannelId: "REPLACE_WITH_REVIEW_CHANNEL_ID",
  prdForumChannelId: "REPLACE_WITH_PRD_FORUM_ID",
  repoAllowlist: [
    "paranext/paranext-core",
    "paranext/example-extension",
    "paranext/paratext-bible-extensions",
    "eten-tech-foundation/scripture-editors",
  ],
  teams: ["Power", "Simple", "General"],
  urgencies: [
    { key: "blocking", emoji: "🔥", label: "Blocking", rank: 0, requiresNote: true },
    { key: "soon", emoji: null, label: "Soon", rank: 1, requiresNote: false },
    { key: "thisWeek", emoji: "🧊", label: "This week", rank: 2, requiresNote: false },
  ],
  claimEmoji: "code_review:1075535230087221248",
  staleClaimMs: 2 * DAY,
  refreshIntervalMs: 5 * MINUTE,
  recentlyClearedMs: 1 * HOUR,
  staleBannerMs: 30 * MINUTE,
  retentionMs: 30 * DAY,
  reopenWindowMs: 24 * HOUR,
  scanLookbackMs: 7 * DAY,
  dailyPostHourLocal: 9,
  dailyPostTimeZone: "America/Chicago",
  budgets: { scanPagesPerTick: 5, purgePerTick: 50, reactionReadsPerTick: 10 },
  immediateDigestRewrite: true,
};
```

The three `REPLACE_WITH_*` values are filled in during Task 21's runbook pass. They are deliberately loud rather than empty strings, so a deploy against an unconfigured repo fails visibly.

- [ ] **Step 6: Write the failing config test**

`tests/core/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { config } from "../../config/config.js";

describe("config", () => {
  it("gives every urgency level a distinct rank", () => {
    const ranks = config.urgencies.map((u) => u.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("requires a note only for blocking", () => {
    const requiring = config.urgencies.filter((u) => u.requiresNote).map((u) => u.key);
    expect(requiring).toEqual(["blocking"]);
  });

  it("lists every allowlisted repo as owner/repo", () => {
    for (const entry of config.repoAllowlist) {
      expect(entry).toMatch(/^[\w.-]+\/[\w.-]+$/);
    }
  });

  it("keeps the digest channel among the allowed channels", () => {
    expect(config.allowedChannelIds).toContain(config.digestChannelId);
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm test -- --project=core`
Expected: FAIL — `Cannot find module '../../config/config.js'` until Step 5's file is in place; if Step 5 ran first, expect PASS. Confirm the file resolves before moving on.

- [ ] **Step 8: Write `eslint.config.js` and `.gitignore`**

```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "preview/out", "coverage", ".wrangler"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "no-restricted-globals": [
        "error",
        { name: "Date", message: "core/ takes time as an argument; adapters use Date.now() explicitly." },
      ],
    },
  },
  { files: ["src/handlers/**", "src/store/**", "src/discord/**", "src/github/**", "preview/**", "tests/**"], rules: { "no-restricted-globals": "off" } },
);
```

`.gitignore`:

```
node_modules/
coverage/
.wrangler/
preview/out/
.dev.vars
```

The `no-restricted-globals` rule on `Date` is the mechanical enforcement of "core/ has no I/O". It is scoped off everywhere except `src/core`, which is exactly where the constraint applies.

- [ ] **Step 9: Write `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run coverage
```

- [ ] **Step 10: Run everything and commit**

Run: `npm run typecheck && npm run lint && npm test -- --project=core`
Expected: typecheck clean, lint clean, config tests PASS.

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts eslint.config.js .gitignore config/config.ts tests/core/config.test.ts .github/workflows/ci.yml
git commit -m "chore: scaffold TypeScript Workers project with pinned toolchain and config module"
```

---

## Task 2: PR URL parsing and the repo allowlist

**Files:**
- Create: `src/core/urls.ts`
- Test: `tests/core/urls.test.ts`

**Interfaces:**
- Consumes: `Config` from Task 1.
- Produces:
  - `interface ParsedPr { owner: string; repo: string; number: number }`
  - `type ParseFailure = "not-a-url" | "not-github" | "not-a-pr" | "is-issue" | "bad-number"`
  - `type ParseResult = { ok: true; pr: ParsedPr } | { ok: false; reason: ParseFailure }`
  - `function parsePrUrl(raw: string): ParseResult`
  - `function isAllowlisted(pr: ParsedPr, allowlist: string[]): boolean`
  - `function prSlug(pr: ParsedPr): string` — returns `"owner/repo/number"`, the identity used everywhere
  - `function extractPrUrls(text: string): ParsedPr[]` — used by scanning in Task 14

- [ ] **Step 1: Write the failing tests**

`tests/core/urls.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractPrUrls, isAllowlisted, parsePrUrl, prSlug } from "../../src/core/urls.js";

const ALLOW = ["paranext/paranext-core", "eten-tech-foundation/scripture-editors"];

describe("parsePrUrl", () => {
  it("parses a plain PR url", () => {
    expect(parsePrUrl("https://github.com/paranext/paranext-core/pull/2695")).toEqual({
      ok: true,
      pr: { owner: "paranext", repo: "paranext-core", number: 2695 },
    });
  });

  it.each([
    ["/files suffix", "https://github.com/paranext/paranext-core/pull/2695/files"],
    ["#discussion fragment", "https://github.com/paranext/paranext-core/pull/2695#discussion_r123"],
    ["trailing slash", "https://github.com/paranext/paranext-core/pull/2695/"],
    ["query string", "https://github.com/paranext/paranext-core/pull/2695?w=1"],
    ["commits tab", "https://github.com/paranext/paranext-core/pull/2695/commits/abc123"],
    ["http scheme", "http://github.com/paranext/paranext-core/pull/2695"],
    ["www host", "https://www.github.com/paranext/paranext-core/pull/2695"],
  ])("parses despite %s", (_label, url) => {
    const result = parsePrUrl(url);
    expect(result).toEqual({ ok: true, pr: { owner: "paranext", repo: "paranext-core", number: 2695 } });
  });

  it("rejects an issue url distinctly from a non-PR url", () => {
    expect(parsePrUrl("https://github.com/paranext/paranext-core/issues/2695")).toEqual({
      ok: false,
      reason: "is-issue",
    });
  });

  it.each([
    ["a repo root", "https://github.com/paranext/paranext-core", "not-a-pr"],
    ["a non-github host", "https://gitlab.com/paranext/core/-/merge_requests/7", "not-github"],
    ["prose", "please review my branch", "not-a-url"],
    ["an empty string", "", "not-a-url"],
    ["a non-numeric number", "https://github.com/paranext/paranext-core/pull/abc", "bad-number"],
  ])("rejects %s as %s", (_label, url, reason) => {
    expect(parsePrUrl(url)).toEqual({ ok: false, reason });
  });
});

describe("isAllowlisted", () => {
  it("accepts a listed repo", () => {
    expect(isAllowlisted({ owner: "paranext", repo: "paranext-core", number: 1 }, ALLOW)).toBe(true);
  });

  it("rejects an unlisted repo in a listed org", () => {
    expect(isAllowlisted({ owner: "paranext", repo: "some-experiment", number: 1 }, ALLOW)).toBe(false);
  });

  it("matches case-insensitively, because GitHub does", () => {
    expect(isAllowlisted({ owner: "Paranext", repo: "Paranext-Core", number: 1 }, ALLOW)).toBe(true);
  });
});

describe("prSlug", () => {
  it("lowercases so identity is stable across url casing", () => {
    expect(prSlug({ owner: "Paranext", repo: "Paranext-Core", number: 2695 })).toBe(
      "paranext/paranext-core/2695",
    );
  });
});

describe("extractPrUrls", () => {
  it("finds every PR link in a chat message", () => {
    const text =
      "these two need eyes: https://github.com/paranext/paranext-core/pull/177 and " +
      "https://github.com/eten-tech-foundation/scripture-editors/pull/341 thanks!";
    expect(extractPrUrls(text)).toEqual([
      { owner: "paranext", repo: "paranext-core", number: 177 },
      { owner: "eten-tech-foundation", repo: "scripture-editors", number: 341 },
    ]);
  });

  it("deduplicates the same PR mentioned twice", () => {
    const text = "pull/177 again: https://github.com/paranext/paranext-core/pull/177 " +
      "https://github.com/paranext/paranext-core/pull/177/files";
    expect(extractPrUrls(text)).toHaveLength(1);
  });

  it("ignores issue links and returns an empty array for prose", () => {
    expect(extractPrUrls("see https://github.com/paranext/paranext-core/issues/9")).toEqual([]);
    expect(extractPrUrls("no links here")).toEqual([]);
  });

  it("ignores surrounding parentheses", () => {
    // Proves the URL_CANDIDATE character class excludes ( and ) — NOT the
    // trailing-punctuation strip, which the paren never reaches.
    expect(extractPrUrls("(https://github.com/paranext/paranext-core/pull/177)")).toEqual([
      { owner: "paranext", repo: "paranext-core", number: 177 },
    ]);
  });

  it.each([
    ["a sentence-ending period", "see https://github.com/paranext/paranext-core/pull/177."],
    ["a comma in a list", "https://github.com/paranext/paranext-core/pull/177, and the other one"],
    ["a semicolon", "https://github.com/paranext/paranext-core/pull/177; thanks"],
    ["a colon", "https://github.com/paranext/paranext-core/pull/177: needs eyes"],
    ["an exclamation mark", "please look at https://github.com/paranext/paranext-core/pull/177!"],
    ["a question mark", "can anyone review https://github.com/paranext/paranext-core/pull/177?"],
  ])("strips %s abutting the link", (_label, text) => {
    // These are the cases that actually exercise the trailing-punctuation
    // strip: URL_CANDIDATE captures the punctuation, then it is removed.
    // A URL ending a sentence is the commonest shape a link takes in chat, and
    // a link missed here is a row missing from the digest during shadow mode.
    expect(extractPrUrls(text)).toEqual([
      { owner: "paranext", repo: "paranext-core", number: 177 },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=core tests/core/urls.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/urls.js'`.

- [ ] **Step 3: Write the implementation**

`src/core/urls.ts`:

```ts
export interface ParsedPr {
  owner: string;
  repo: string;
  number: number;
}

export type ParseFailure = "not-a-url" | "not-github" | "not-a-pr" | "is-issue" | "bad-number";

export type ParseResult = { ok: true; pr: ParsedPr } | { ok: false; reason: ParseFailure };

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/** Identity for deduplication. Lowercased because GitHub treats owner/repo case-insensitively. */
export function prSlug(pr: ParsedPr): string {
  return `${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}/${pr.number}`;
}

export function parsePrUrl(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "not-a-url" };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "not-a-url" };
  }

  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return { ok: false, reason: "not-github" };

  const parts = url.pathname.split("/").filter((p) => p !== "");
  const [owner, repo, kind, numberRaw] = parts;
  if (owner === undefined || repo === undefined) return { ok: false, reason: "not-a-pr" };
  if (kind === "issues") return { ok: false, reason: "is-issue" };
  if (kind !== "pull") return { ok: false, reason: "not-a-pr" };
  if (numberRaw === undefined) return { ok: false, reason: "not-a-pr" };
  if (!/^\d+$/.test(numberRaw)) return { ok: false, reason: "bad-number" };

  return { ok: true, pr: { owner, repo, number: Number(numberRaw) } };
}

export function isAllowlisted(pr: ParsedPr, allowlist: string[]): boolean {
  const target = `${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}`;
  return allowlist.some((entry) => entry.toLowerCase() === target);
}

/**
 * Pulls every distinct GitHub PR link out of a chat message.
 * Deliberately permissive about surrounding punctuation and markdown: people paste
 * links inside parentheses and sentences, and a link missed here is a row missing
 * from the digest during shadow mode.
 */
const URL_CANDIDATE = /https?:\/\/[^\s<>()[\]"'`]+/gi;

export function extractPrUrls(text: string): ParsedPr[] {
  const seen = new Map<string, ParsedPr>();
  for (const match of text.matchAll(URL_CANDIDATE)) {
    const candidate = match[0].replace(/[.,;:!?]+$/, "");
    const parsed = parsePrUrl(candidate);
    if (parsed.ok) seen.set(prSlug(parsed.pr), parsed.pr);
  }
  return [...seen.values()];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --project=core tests/core/urls.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/urls.ts tests/core/urls.test.ts
git commit -m "feat(core): parse and allowlist GitHub PR urls, extract links from messages"
```

---

## Task 3: The record model and its latch transitions

**Files:**
- Create: `src/core/record.ts`
- Test: `tests/core/record.test.ts`

**Interfaces:**
- Consumes: `ParsedPr`, `prSlug` from Task 2; `TeamName`, `UrgencyKey` from Task 1.
- Produces:
  - `interface PrRecord` — the full shape below
  - `interface Resolution { resolvedAt: number; resolvedBy: string }`
  - `function recordId(r: PrRecord): string`
  - `function isOpen(r: PrRecord): boolean`
  - `function resolveRecord(r: PrRecord, at: number, by: string): PrRecord`
  - `function reopenRecord(r: PrRecord, at: number): PrRecord`
  - `function markRequested(r: PrRecord, at: number, fields: RequestFields): PrRecord`
  - `function newScannedRecord(input: NewScannedInput): PrRecord`
  - `interface RequestFields { team, urgency, prdThreadId, note, requesterId, requesterName, channelId, messageId }`

Every field on this record is a latch, and **a latch with no reset is a once-per-lifetime latch**. This task's tests assert both directions for every one.

- [ ] **Step 1: Write the failing tests**

`tests/core/record.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  isOpen,
  markRequested,
  newScannedRecord,
  recordId,
  reopenRecord,
  resolveRecord,
  type PrRecord,
} from "../../src/core/record.js";

const T0 = 1_756_000_000_000;
const HOUR = 3_600_000;

function commanded(overrides: Partial<PrRecord> = {}): PrRecord {
  return {
    owner: "paranext",
    repo: "paranext-core",
    number: 2695,
    channelId: "chan",
    messageId: "msg",
    team: "Simple",
    urgency: "thisWeek",
    prdThreadId: null,
    note: null,
    requesterId: "user-1",
    requesterName: "Jolie",
    firstRequestedAt: T0,
    lastRequestedAt: T0,
    requestCount: 1,
    claimedBy: null,
    claimedByName: null,
    claimedAt: null,
    lastClaimedByName: null,
    claimClearedAt: null,
    syncPausedSince: null,
    resolvedAt: null,
    resolvedBy: null,
    resolutionHistory: [],
    title: "PT-9003 Internet Settings UI Enhancements",
    prAuthorLogin: "jolie",
    isDraft: false,
    source: "command",
    lastSyncedAt: T0,
    ...overrides,
  };
}

describe("recordId", () => {
  it("is owner/repo/number, lowercased", () => {
    expect(recordId(commanded({ owner: "Paranext" }))).toBe("paranext/paranext-core/2695");
  });
});

describe("resolve and reopen", () => {
  it("resolving sets both fields and closes the record", () => {
    const r = resolveRecord(commanded(), T0 + HOUR, "review by Katherine");
    expect(r.resolvedAt).toBe(T0 + HOUR);
    expect(r.resolvedBy).toBe("review by Katherine");
    expect(isOpen(r)).toBe(false);
  });

  it("resolving clears any claim, so a resolved row cannot sit in Being reviewed", () => {
    const claimed = commanded({ claimedBy: "u2", claimedByName: "Ira", claimedAt: T0 });
    const r = resolveRecord(claimed, T0 + HOUR, "review by Katherine");
    expect(r.claimedBy).toBeNull();
    expect(r.claimedAt).toBeNull();
  });

  it("reopening clears both fields and appends the prior resolution to history", () => {
    const resolved = resolveRecord(commanded(), T0 + HOUR, "review by Katherine");
    const reopened = reopenRecord(resolved, T0 + 2 * HOUR);
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.resolvedBy).toBeNull();
    expect(isOpen(reopened)).toBe(true);
    expect(reopened.resolutionHistory).toEqual([
      { resolvedAt: T0 + HOUR, resolvedBy: "review by Katherine" },
    ]);
  });

  it("reopening never touches firstRequestedAt", () => {
    const resolved = resolveRecord(commanded(), T0 + HOUR, "manual by Jolie");
    expect(reopenRecord(resolved, T0 + 2 * HOUR).firstRequestedAt).toBe(T0);
  });

  it("reopening an already-open record is a no-op that appends nothing", () => {
    const open = commanded();
    expect(reopenRecord(open, T0 + HOUR)).toEqual(open);
  });

  it("accumulates history across two resolve/reopen rounds", () => {
    let r = resolveRecord(commanded(), T0 + HOUR, "review by Katherine");
    r = reopenRecord(r, T0 + 2 * HOUR);
    r = resolveRecord(r, T0 + 3 * HOUR, "review by Ira");
    r = reopenRecord(r, T0 + 4 * HOUR);
    expect(r.resolutionHistory).toHaveLength(2);
    expect(r.resolutionHistory[1]?.resolvedBy).toBe("review by Ira");
  });
});

describe("markRequested", () => {
  const fields = {
    team: "Power" as const,
    urgency: "blocking" as const,
    prdThreadId: "thread-1",
    note: "blocks the release cut",
    requesterId: "user-2",
    requesterName: "Ira",
    channelId: "chan",
    messageId: "msg-2",
  };

  it("updates lastRequestedAt and increments the count", () => {
    const r = markRequested(commanded(), T0 + HOUR, fields);
    expect(r.lastRequestedAt).toBe(T0 + HOUR);
    expect(r.requestCount).toBe(2);
  });

  it("never changes firstRequestedAt, so re-requesting is not penalised in the sort", () => {
    expect(markRequested(commanded(), T0 + 8 * HOUR, fields).firstRequestedAt).toBe(T0);
  });

  it("clears any existing claim, so a stale claim cannot hide the new request", () => {
    const claimed = commanded({ claimedBy: "u3", claimedByName: "Kat", claimedAt: T0 });
    const r = markRequested(claimed, T0 + HOUR, fields);
    expect(r.claimedBy).toBeNull();
    expect(r.claimedAt).toBeNull();
  });

  it("reopens a resolved record and preserves the prior resolution", () => {
    const resolved = resolveRecord(commanded(), T0 + HOUR, "review by Katherine");
    const r = markRequested(resolved, T0 + 2 * HOUR, fields);
    expect(isOpen(r)).toBe(true);
    expect(r.resolutionHistory).toHaveLength(1);
  });

  it("upgrades a scanned record to a commanded one in place", () => {
    const scanned = newScannedRecord({
      pr: { owner: "paranext", repo: "paranext-core", number: 2695 },
      channelId: "chan",
      messageId: "msg",
      messageTimestamp: T0,
      title: "PT-9003",
      prAuthorLogin: "jolie",
      isDraft: false,
    });
    const r = markRequested(scanned, T0 + HOUR, fields);
    expect(r.source).toBe("command");
    expect(r.team).toBe("Power");
    expect(r.urgency).toBe("blocking");
    expect(r.note).toBe("blocks the release cut");
  });
});

describe("newScannedRecord", () => {
  it("seeds lastRequestedAt from the message timestamp, not the scan time", () => {
    const r = newScannedRecord({
      pr: { owner: "paranext", repo: "paranext-core", number: 2695 },
      channelId: "chan",
      messageId: "msg",
      messageTimestamp: T0,
      title: "PT-9003",
      prAuthorLogin: "jolie",
      isDraft: false,
    });
    expect(r.lastRequestedAt).toBe(T0);
    expect(r.firstRequestedAt).toBe(T0);
  });

  it("has no team, urgency, prd or note, because nobody supplied them", () => {
    const r = newScannedRecord({
      pr: { owner: "paranext", repo: "paranext-core", number: 2695 },
      channelId: "chan",
      messageId: "msg",
      messageTimestamp: T0,
      title: "PT-9003",
      prAuthorLogin: "jolie",
      isDraft: false,
    });
    expect(r.team).toBeNull();
    expect(r.urgency).toBeNull();
    expect(r.prdThreadId).toBeNull();
    expect(r.note).toBeNull();
    expect(r.source).toBe("scanned");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=core tests/core/record.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/record.js'`.

- [ ] **Step 3: Write the implementation**

`src/core/record.ts`:

```ts
import type { TeamName, UrgencyKey } from "../../config/config.js";
import { prSlug, type ParsedPr } from "./urls.js";

export interface Resolution {
  resolvedAt: number;
  resolvedBy: string;
}

export interface PrRecord {
  // identity, from the url
  owner: string;
  repo: string;
  number: number;

  // the request message
  channelId: string;
  messageId: string | null;

  team: TeamName | null;
  urgency: UrgencyKey | null;
  prdThreadId: string | null;
  note: string | null;

  requesterId: string | null;
  requesterName: string | null;

  /** Sort key. Never changes, so re-requesting is not penalised. */
  firstRequestedAt: number;
  /** Freshness. For a scanned record this is the scanned message's timestamp. */
  lastRequestedAt: number;
  requestCount: number;

  claimedBy: string | null;
  claimedByName: string | null;
  claimedAt: number | null;
  /** Survives a stale auto-clear; renders `previously claimed`. Cleared by a new claim. */
  lastClaimedByName: string | null;
  claimClearedAt: number | null;

  /** Set on NOT_FOUND / 401 for this record's repo. Cleared by the first successful sync. */
  syncPausedSince: number | null;

  resolvedAt: number | null;
  resolvedBy: string | null;
  /** Prior resolutions, appended on reopen, so "why is it back" stays answerable. */
  resolutionHistory: Resolution[];

  title: string;
  /** GitHub login of the PR's author. A self-review is not a review. */
  prAuthorLogin: string | null;
  isDraft: boolean;

  source: "command" | "scanned";
  lastSyncedAt: number | null;
}

export interface RequestFields {
  team: TeamName;
  urgency: UrgencyKey;
  prdThreadId: string | null;
  note: string | null;
  requesterId: string;
  requesterName: string;
  channelId: string;
  messageId: string | null;
}

export interface NewScannedInput {
  pr: ParsedPr;
  channelId: string;
  messageId: string;
  /** The scanned MESSAGE's timestamp — not the scan time. See Task 14. */
  messageTimestamp: number;
  title: string;
  prAuthorLogin: string | null;
  isDraft: boolean;
}

export function recordId(r: Pick<PrRecord, "owner" | "repo" | "number">): string {
  return prSlug(r);
}

export function isOpen(r: PrRecord): boolean {
  return r.resolvedAt === null;
}

export function resolveRecord(r: PrRecord, at: number, by: string): PrRecord {
  return {
    ...r,
    resolvedAt: at,
    resolvedBy: by,
    // A resolved row must not sit in Being reviewed.
    claimedBy: null,
    claimedByName: null,
    claimedAt: null,
  };
}

export function reopenRecord(r: PrRecord, _at: number): PrRecord {
  if (r.resolvedAt === null) return r;
  return {
    ...r,
    resolvedAt: null,
    resolvedBy: null,
    resolutionHistory: [
      ...r.resolutionHistory,
      { resolvedAt: r.resolvedAt, resolvedBy: r.resolvedBy ?? "unknown" },
    ],
  };
}

export function markRequested(r: PrRecord, at: number, fields: RequestFields): PrRecord {
  const reopened = reopenRecord(r, at);
  return {
    ...reopened,
    ...fields,
    source: "command",
    lastRequestedAt: at,
    requestCount: reopened.requestCount + 1,
    // A claim from the previous round must not hide the new request.
    claimedBy: null,
    claimedByName: null,
    claimedAt: null,
  };
}

export function newScannedRecord(input: NewScannedInput): PrRecord {
  return {
    owner: input.pr.owner,
    repo: input.pr.repo,
    number: input.pr.number,
    channelId: input.channelId,
    messageId: input.messageId,
    team: null,
    urgency: null,
    prdThreadId: null,
    note: null,
    requesterId: null,
    requesterName: null,
    firstRequestedAt: input.messageTimestamp,
    lastRequestedAt: input.messageTimestamp,
    requestCount: 1,
    claimedBy: null,
    claimedByName: null,
    claimedAt: null,
    lastClaimedByName: null,
    claimClearedAt: null,
    syncPausedSince: null,
    resolvedAt: null,
    resolvedBy: null,
    resolutionHistory: [],
    title: input.title,
    prAuthorLogin: input.prAuthorLogin,
    isDraft: input.isDraft,
    source: "scanned",
    lastSyncedAt: null,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --project=core tests/core/record.test.ts`
Expected: PASS, all cases including both directions of every latch.

- [ ] **Step 5: Commit**

```bash
git add src/core/record.ts tests/core/record.test.ts
git commit -m "feat(core): record model with resolve, reopen and re-request transitions"
```

---

## Task 4: The exit condition

This is the single most important task in the plan. Everything the list is worth depends on rows leaving it correctly, and the spec records three separate ways an earlier version of this rule created a permanent-drop loop.

**Files:**
- Create: `src/core/exit.ts`
- Test: `tests/core/exit.test.ts`

**Interfaces:**
- Consumes: `PrRecord`, `resolveRecord` from Task 3.
- Produces:
  - `interface ReviewEvent { submittedAt: number | null; state: string; authorLogin: string | null; authorIsBot: boolean }`
  - `interface PrSnapshot { slug: string; title: string; state: "OPEN" | "CLOSED" | "MERGED"; merged: boolean; isDraft: boolean; authorLogin: string | null; reviews: ReviewEvent[] }`
  - `function countsAsReview(review: ReviewEvent, prAuthorLogin: string | null, since: number): boolean`
  - `type ExitVerdict = { resolve: false } | { resolve: true; resolvedBy: string }`
  - `function exitVerdict(record: PrRecord, snapshot: PrSnapshot): ExitVerdict`
  - `function applySnapshot(record: PrRecord, snapshot: PrSnapshot, now: number): PrRecord`

- [ ] **Step 1: Write the failing tests**

`tests/core/exit.test.ts`. This suite is deliberately table-driven and exhaustive — the spec calls that matrix "the product".

```ts
import { describe, expect, it } from "vitest";
import { applySnapshot, countsAsReview, exitVerdict, type PrSnapshot, type ReviewEvent } from "../../src/core/exit.js";
import { newScannedRecord, resolveRecord, type PrRecord } from "../../src/core/record.js";

const T0 = 1_756_000_000_000;
const HOUR = 3_600_000;

function record(overrides: Partial<PrRecord> = {}): PrRecord {
  const base = newScannedRecord({
    pr: { owner: "paranext", repo: "paranext-core", number: 2695 },
    channelId: "chan",
    messageId: "msg",
    messageTimestamp: T0,
    title: "PT-9003",
    prAuthorLogin: "jolie",
    isDraft: false,
  });
  return { ...base, ...overrides };
}

function review(overrides: Partial<ReviewEvent> = {}): ReviewEvent {
  return { submittedAt: T0 + HOUR, state: "APPROVED", authorLogin: "katherine", authorIsBot: false, ...overrides };
}

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    slug: "paranext/paranext-core/2695",
    title: "PT-9003",
    state: "OPEN",
    merged: false,
    isDraft: false,
    authorLogin: "jolie",
    reviews: [],
    ...overrides,
  };
}

describe("countsAsReview", () => {
  it("counts an APPROVED review by someone else after the request", () => {
    expect(countsAsReview(review(), "jolie", T0)).toBe(true);
  });

  it("counts a COMMENTED review — fifteen line comments is unambiguously a look", () => {
    expect(countsAsReview(review({ state: "COMMENTED" }), "jolie", T0)).toBe(true);
  });

  it("counts CHANGES_REQUESTED", () => {
    expect(countsAsReview(review({ state: "CHANGES_REQUESTED" }), "jolie", T0)).toBe(true);
  });

  it("does not count a review older than the request", () => {
    expect(countsAsReview(review({ submittedAt: T0 - HOUR }), "jolie", T0)).toBe(false);
  });

  it("does not count a review exactly at the request time", () => {
    expect(countsAsReview(review({ submittedAt: T0 }), "jolie", T0)).toBe(false);
  });

  it("does not count a PENDING review with a null submittedAt", () => {
    // `since: -1` is load-bearing. With `since: T0`, deleting the
    // `submittedAt === null` guard leaves `null <= T0`, which JS coerces to
    // `0 <= T0` — true — so the function still returns false and this test
    // stays green with the guard gone. At `since: -1`, coerced 0 cannot
    // satisfy the comparison, so the null guard is the only rejecter.
    expect(countsAsReview(review({ submittedAt: null, state: "PENDING" }), "jolie", -1)).toBe(false);
    expect(countsAsReview(review({ submittedAt: null, state: "PENDING" }), "jolie", T0)).toBe(false);
    // Positive control: proves the case above is not passing merely because
    // everything fails at this `since`.
    expect(countsAsReview(review({ submittedAt: 1 }), "jolie", -1)).toBe(true);
  });

  it("does not count a review whose author login ends in [bot]", () => {
    expect(countsAsReview(review({ authorLogin: "copilot-pull-request-reviewer[bot]" }), "jolie", T0)).toBe(false);
  });

  it("does not count a review flagged as a Bot by __typename even with a plain login", () => {
    expect(countsAsReview(review({ authorLogin: "coderabbitai", authorIsBot: true }), "jolie", T0)).toBe(false);
  });

  it("does not count the PR author reviewing their own PR", () => {
    expect(countsAsReview(review({ authorLogin: "jolie" }), "jolie", T0)).toBe(false);
  });

  it("compares the author case-insensitively, because GitHub logins are", () => {
    expect(countsAsReview(review({ authorLogin: "Jolie" }), "jolie", T0)).toBe(false);
  });

  it("counts a review with a null author when the PR author is known", () => {
    // A deleted account still submitted a real review; dropping it would strand the row.
    expect(countsAsReview(review({ authorLogin: null }), "jolie", T0)).toBe(true);
  });
});

describe("exitVerdict", () => {
  it("resolves on a qualifying review, naming the reviewer", () => {
    const v = exitVerdict(record(), snapshot({ reviews: [review()] }));
    expect(v).toEqual({ resolve: true, resolvedBy: "review by katherine" });
  });

  it("resolves when merged", () => {
    expect(exitVerdict(record(), snapshot({ state: "MERGED", merged: true }))).toEqual({
      resolve: true,
      resolvedBy: "merged",
    });
  });

  it("resolves when closed unmerged", () => {
    expect(exitVerdict(record(), snapshot({ state: "CLOSED" }))).toEqual({
      resolve: true,
      resolvedBy: "closed",
    });
  });

  it("does not resolve an open PR with only a bot review", () => {
    const v = exitVerdict(record(), snapshot({ reviews: [review({ authorLogin: "copilot[bot]" })] }));
    expect(v).toEqual({ resolve: false });
  });

  it("does not resolve an open PR with only a self-review", () => {
    const v = exitVerdict(record(), snapshot({ reviews: [review({ authorLogin: "jolie" })] }));
    expect(v).toEqual({ resolve: false });
  });

  it("resolves when a human review sits among bot reviews", () => {
    const v = exitVerdict(
      record(),
      snapshot({ reviews: [review({ authorLogin: "copilot[bot]" }), review({ authorLogin: "ira" })] }),
    );
    expect(v).toEqual({ resolve: true, resolvedBy: "review by ira" });
  });

  it("does not resolve a re-requested PR whose only review predates the re-request", () => {
    // The headline workflow: reviewed, changes requested, author pushes, re-requests.
    const rerequested = record({ lastRequestedAt: T0 + 2 * HOUR, requestCount: 2 });
    const v = exitVerdict(rerequested, snapshot({ reviews: [review({ submittedAt: T0 + HOUR })] }));
    expect(v).toEqual({ resolve: false });
  });

  it("resolves a re-requested PR once a new review lands", () => {
    const rerequested = record({ lastRequestedAt: T0 + 2 * HOUR, requestCount: 2 });
    const v = exitVerdict(rerequested, snapshot({ reviews: [review({ submittedAt: T0 + 3 * HOUR })] }));
    expect(v).toEqual({ resolve: true, resolvedBy: "review by katherine" });
  });

  it("is unaffected by reviewDecision even when it implies the opposite verdict", () => {
    // Setting the field to null while `reviews` is empty asserts nothing: the
    // empty list alone forces { resolve: false }, so that version passes for
    // ANY implementation, including one that reads the field. Both assertions
    // below point the field's hypothetical influence opposite to the expected
    // verdict, so a reader of it fails.
    const approved = { ...snapshot(), reviewDecision: "APPROVED" } as PrSnapshot;
    expect(exitVerdict(record(), approved)).toEqual({ resolve: false });

    const required = {
      ...snapshot({ reviews: [review()] }),
      reviewDecision: "REVIEW_REQUIRED",
    } as PrSnapshot;
    expect(exitVerdict(record(), required)).toEqual({
      resolve: true,
      resolvedBy: "review by katherine",
    });
  });

  it("uses the snapshot's author when the record has none", () => {
    const noAuthor = record({ prAuthorLogin: null });
    const v = exitVerdict(noAuthor, snapshot({ authorLogin: "jolie", reviews: [review({ authorLogin: "jolie" })] }));
    expect(v).toEqual({ resolve: false });
  });
});

describe("applySnapshot", () => {
  const NOW = T0 + 5 * HOUR;

  it("resolves an open record when the verdict says so", () => {
    const r = applySnapshot(record(), snapshot({ reviews: [review()] }), NOW);
    expect(r.resolvedAt).toBe(NOW);
    expect(r.resolvedBy).toBe("review by katherine");
  });

  it("refreshes the cached title, draft flag and author on every sync", () => {
    const r = applySnapshot(record(), snapshot({ title: "PT-9003 renamed", isDraft: true, authorLogin: "ira" }), NOW);
    expect(r.title).toBe("PT-9003 renamed");
    expect(r.isDraft).toBe(true);
    expect(r.prAuthorLogin).toBe("ira");
    expect(r.lastSyncedAt).toBe(NOW);
  });

  it("clears syncPausedSince on the first successful sync", () => {
    const paused = record({ syncPausedSince: T0 });
    expect(applySnapshot(paused, snapshot(), NOW).syncPausedSince).toBeNull();
  });

  it("leaves an already-resolved record alone rather than restamping it", () => {
    const resolved = resolveRecord(record(), T0 + HOUR, "manual by Jolie");
    const r = applySnapshot(resolved, snapshot({ reviews: [review()] }), NOW);
    expect(r.resolvedAt).toBe(T0 + HOUR);
    expect(r.resolvedBy).toBe("manual by Jolie");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=core tests/core/exit.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/exit.js'`.

- [ ] **Step 3: Write the implementation**

`src/core/exit.ts`:

```ts
import { isOpen, resolveRecord, type PrRecord } from "./record.js";

export interface ReviewEvent {
  /** Epoch ms. Null means PENDING — a reviewer with unsubmitted line comments. */
  submittedAt: number | null;
  state: string;
  authorLogin: string | null;
  /** True when GraphQL reported the author's __typename as Bot. */
  authorIsBot: boolean;
}

export interface PrSnapshot {
  slug: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  merged: boolean;
  isDraft: boolean;
  authorLogin: string | null;
  reviews: ReviewEvent[];
}

export type ExitVerdict = { resolve: false } | { resolve: true; resolvedBy: string };

function sameLogin(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

/**
 * Whether one review event means a human other than the author has looked
 * since `since`. Three filters, each closing a permanent-drop loop:
 *
 *  - null submittedAt is a PENDING review; nobody has looked yet.
 *  - a bot review (Copilot, CodeRabbit) would clear a row one minute after the
 *    request and re-clear every re-request within a tick.
 *  - the PR author's own line comments arrive as a real PullRequestReview and
 *    would do the same.
 */
export function countsAsReview(
  reviewEvent: ReviewEvent,
  prAuthorLogin: string | null,
  since: number,
): boolean {
  if (reviewEvent.submittedAt === null) return false;
  if (reviewEvent.submittedAt <= since) return false;
  if (reviewEvent.authorIsBot) return false;
  if (reviewEvent.authorLogin !== null && reviewEvent.authorLogin.toLowerCase().endsWith("[bot]")) return false;
  if (sameLogin(reviewEvent.authorLogin, prAuthorLogin)) return false;
  return true;
}

export function exitVerdict(record: PrRecord, snapshot: PrSnapshot): ExitVerdict {
  if (snapshot.merged) return { resolve: true, resolvedBy: "merged" };
  if (snapshot.state === "CLOSED") return { resolve: true, resolvedBy: "closed" };

  const author = record.prAuthorLogin ?? snapshot.authorLogin;
  const qualifying = snapshot.reviews
    .filter((r) => countsAsReview(r, author, record.lastRequestedAt))
    .sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0));

  const first = qualifying[0];
  if (first === undefined) return { resolve: false };
  return { resolve: true, resolvedBy: `review by ${first.authorLogin ?? "someone"}` };
}

/** Folds a GitHub snapshot into a record: refresh cached fields, then apply the exit rule. */
export function applySnapshot(record: PrRecord, snapshot: PrSnapshot, now: number): PrRecord {
  const refreshed: PrRecord = {
    ...record,
    title: snapshot.title,
    isDraft: snapshot.isDraft,
    prAuthorLogin: snapshot.authorLogin ?? record.prAuthorLogin,
    syncPausedSince: null,
    lastSyncedAt: now,
  };

  if (!isOpen(refreshed)) return refreshed;

  const verdict = exitVerdict(refreshed, snapshot);
  return verdict.resolve ? resolveRecord(refreshed, now, verdict.resolvedBy) : refreshed;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --project=core tests/core/exit.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Verify against real PRs before going further**

The spec requires this and puts it before everything else: **verify the review-event semantics against ~10 real PRs** across `paranext-core` and `scripture-editors`. Every other behavior is downstream of this field.

Run, with a token that can read those repos:

```bash
gh api graphql -f query='
{
  repository(owner: "paranext", name: "paranext-core") {
    pullRequests(last: 10, states: [OPEN, MERGED, CLOSED]) {
      nodes {
        number title isDraft merged state
        author { login }
        reviews(last: 20) {
          nodes { submittedAt state author { login __typename } }
        }
      }
    }
  }
}' > /tmp/real-prs.json
cat /tmp/real-prs.json | head -60
```

Confirm all four, and write what you find into `docs/architecture-decisions.md` as `adr-exit-condition` in Task 21:

1. `submittedAt` is present and ISO-8601 on submitted reviews, and null on PENDING ones.
2. `COMMENTED` reviews appear in `reviews`.
3. Bot reviewers appear with `__typename: "Bot"`, a `[bot]` login suffix, or both — note which.
4. A PR with no reviews returns an empty `nodes` array rather than null.

If any assumption is wrong, **stop and revise the spec's Exit condition before continuing.** A wrong rule here silently corrupts every row.

- [ ] **Step 6: Commit**

```bash
git add src/core/exit.ts tests/core/exit.test.ts
git commit -m "feat(core): exit condition with bot, self-review and PENDING filters"
```

---

## Task 5: Relative timestamps, staleness, and a stable body hash

Three small pure utilities that the renderer and the write-skip both depend on. They are one task because none is independently reviewable and all three are needed by Task 8.

**Files:**
- Create: `src/core/time.ts`, `src/core/hash.ts`
- Test: `tests/core/time.test.ts`, `tests/core/hash.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function relTs(epochMs: number): string` — returns `<t:SECONDS:R>`
  - `function isStale(lastSync: number | null, now: number, thresholdMs: number): boolean`
  - `function stableHash(input: string): string` — synchronous, pure, 8 hex chars

- [ ] **Step 1: Write the failing tests**

`tests/core/time.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isStale, relTs } from "../../src/core/time.js";

describe("relTs", () => {
  it("renders a Discord relative timestamp in seconds", () => {
    expect(relTs(1_756_000_000_000)).toBe("<t:1756000000:R>");
  });

  it("floors sub-second precision so the same second yields the same token", () => {
    expect(relTs(1_756_000_000_999)).toBe(relTs(1_756_000_000_000));
  });

  it("handles epoch zero without producing a negative token", () => {
    expect(relTs(0)).toBe("<t:0:R>");
  });
});

describe("isStale", () => {
  const NOW = 1_756_000_000_000;
  const THRESHOLD = 30 * 60_000;

  it("is not stale immediately after a sync", () => {
    expect(isStale(NOW, NOW, THRESHOLD)).toBe(false);
  });

  it("is not stale one millisecond inside the threshold", () => {
    expect(isStale(NOW - THRESHOLD + 1, NOW, THRESHOLD)).toBe(false);
  });

  it("is stale once the threshold is reached", () => {
    expect(isStale(NOW - THRESHOLD, NOW, THRESHOLD)).toBe(true);
  });

  it("treats a never-synced store as stale, so a fresh deploy says so", () => {
    expect(isStale(null, NOW, THRESHOLD)).toBe(true);
  });
});
```

`tests/core/hash.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { stableHash } from "../../src/core/hash.js";

describe("stableHash", () => {
  it("is stable across calls, so the write-skip is reliable", () => {
    expect(stableHash("Needs review · 4 open")).toBe(stableHash("Needs review · 4 open"));
  });

  it("differs for a one-character change", () => {
    expect(stableHash("4 open")).not.toBe(stableHash("5 open"));
  });

  it("handles emoji and the empty string without throwing", () => {
    expect(stableHash("🔥 Blocking")).toMatch(/^[0-9a-f]{8}$/);
    expect(stableHash("")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is synchronous — the renderer is pure and cannot await crypto.subtle", () => {
    const result: string = stableHash("x");
    expect(typeof result).toBe("string");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=core tests/core/time.test.ts tests/core/hash.test.ts`
Expected: FAIL — both modules missing.

- [ ] **Step 3: Write the implementations**

`src/core/time.ts`:

```ts
/**
 * A Discord relative timestamp. Long form by necessity: Discord renders
 * `<t:…:R>` as "3 days ago" and offers no compact variant, so the compact `3d`
 * form is only reachable by computing ages — which would make the digest body a
 * function of wall-clock time and defeat the write-skip.
 */
export function relTs(epochMs: number): string {
  return `<t:${Math.floor(epochMs / 1000)}:R>`;
}

/** A never-synced store counts as stale, so a fresh deploy admits it has no data. */
export function isStale(lastSync: number | null, now: number, thresholdMs: number): boolean {
  if (lastSync === null) return true;
  return now - lastSync >= thresholdMs;
}
```

`src/core/hash.ts`:

```ts
/**
 * FNV-1a over UTF-16 code units. Synchronous and dependency-free because the
 * renderer is pure: `crypto.subtle.digest` is async and would force the whole
 * render path to be awaited. Collision risk is irrelevant here — the only
 * consequence of a collision is one skipped digest edit, corrected next tick.
 */
export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --project=core tests/core/time.test.ts tests/core/hash.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/time.ts src/core/hash.ts tests/core/time.test.ts tests/core/hash.test.ts
git commit -m "feat(core): relative timestamps, staleness check and synchronous body hash"
```

---

## Task 6: Claim rules

**Files:**
- Create: `src/core/claims.ts`
- Test: `tests/core/claims.test.ts`

**Interfaces:**
- Consumes: `PrRecord`, `isOpen` from Task 3.
- Produces:
  - `type ClaimOutcome = { kind: "claimed"; record: PrRecord } | { kind: "already-claimed"; byName: string } | { kind: "released"; record: PrRecord } | { kind: "not-open" }`
  - `function applyClaim(r: PrRecord, userId: string, displayName: string, at: number): ClaimOutcome`
  - `function applyUnclaim(r: PrRecord, userId: string): ClaimOutcome`
  - `function clearStaleClaim(r: PrRecord, now: number, thresholdMs: number): PrRecord`

The conflict rule is **first-write-wins**, not earliest-timestamp-wins. The reactions endpoint returns a user list with no per-reaction timestamp, so a reaction can only be stamped at detection time, and ordering by that stamp would rank a 10:01 reaction behind a 10:03 menu claim.

- [ ] **Step 1: Write the failing tests**

`tests/core/claims.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyClaim, applyUnclaim, clearStaleClaim } from "../../src/core/claims.js";
import { newScannedRecord, resolveRecord, type PrRecord } from "../../src/core/record.js";

const T0 = 1_756_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STALE = 2 * DAY;

function record(overrides: Partial<PrRecord> = {}): PrRecord {
  const base = newScannedRecord({
    pr: { owner: "paranext", repo: "paranext-core", number: 2695 },
    channelId: "chan",
    messageId: "msg",
    messageTimestamp: T0,
    title: "PT-9003",
    prAuthorLogin: "jolie",
    isDraft: false,
  });
  return { ...base, ...overrides };
}

describe("applyClaim", () => {
  it("records the claimer and the time", () => {
    const outcome = applyClaim(record(), "u1", "Katherine", T0 + HOUR);
    expect(outcome.kind).toBe("claimed");
    if (outcome.kind !== "claimed") throw new Error("unreachable");
    expect(outcome.record.claimedBy).toBe("u1");
    expect(outcome.record.claimedByName).toBe("Katherine");
    expect(outcome.record.claimedAt).toBe(T0 + HOUR);
  });

  it("clears previously-claimed markers, so a re-claimed row stops rendering them", () => {
    const previously = record({ lastClaimedByName: "Ira", claimClearedAt: T0 });
    const outcome = applyClaim(previously, "u1", "Katherine", T0 + HOUR);
    if (outcome.kind !== "claimed") throw new Error("unreachable");
    expect(outcome.record.lastClaimedByName).toBeNull();
    expect(outcome.record.claimClearedAt).toBeNull();
  });

  it("reports the holder when someone else already claimed it — first write wins", () => {
    const held = record({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0 });
    expect(applyClaim(held, "u2", "Ira", T0 + HOUR)).toEqual({
      kind: "already-claimed",
      byName: "Katherine",
    });
  });

  it("is idempotent when the same person claims twice, without moving claimedAt", () => {
    const held = record({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0 });
    const outcome = applyClaim(held, "u1", "Katherine", T0 + HOUR);
    if (outcome.kind !== "claimed") throw new Error("unreachable");
    expect(outcome.record.claimedAt).toBe(T0);
  });

  it("refuses to claim a resolved record", () => {
    const resolved = resolveRecord(record(), T0, "merged");
    expect(applyClaim(resolved, "u1", "Katherine", T0 + HOUR)).toEqual({ kind: "not-open" });
  });
});

describe("applyUnclaim", () => {
  it("releases a claim you hold", () => {
    const held = record({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0 });
    const outcome = applyUnclaim(held, "u1");
    expect(outcome.kind).toBe("released");
    if (outcome.kind !== "released") throw new Error("unreachable");
    expect(outcome.record.claimedBy).toBeNull();
    expect(outcome.record.claimedAt).toBeNull();
  });

  it("leaves a claim you do not hold alone and names the holder", () => {
    const held = record({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0 });
    expect(applyUnclaim(held, "u2")).toEqual({ kind: "already-claimed", byName: "Katherine" });
  });

  it("does not set previously-claimed markers on a deliberate unclaim", () => {
    // `previously claimed` exists to explain an AUTO-clear. A voluntary release
    // is not a lapse and must not be labelled as one.
    const held = record({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0 });
    const outcome = applyUnclaim(held, "u1");
    if (outcome.kind !== "released") throw new Error("unreachable");
    expect(outcome.record.lastClaimedByName).toBeNull();
  });
});

describe("clearStaleClaim", () => {
  it("clears a claim older than the threshold and records who held it", () => {
    const held = record({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0 });
    const r = clearStaleClaim(held, T0 + STALE, STALE);
    expect(r.claimedBy).toBeNull();
    expect(r.claimedAt).toBeNull();
    expect(r.lastClaimedByName).toBe("Katherine");
    expect(r.claimClearedAt).toBe(T0 + STALE);
  });

  it("leaves a fresh claim untouched", () => {
    const held = record({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0 });
    expect(clearStaleClaim(held, T0 + HOUR, STALE)).toEqual(held);
  });

  it("is a no-op on an unclaimed record", () => {
    const open = record();
    expect(clearStaleClaim(open, T0 + STALE, STALE)).toEqual(open);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=core tests/core/claims.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/claims.js'`.

- [ ] **Step 3: Write the implementation**

`src/core/claims.ts`:

```ts
import { isOpen, type PrRecord } from "./record.js";

export type ClaimOutcome =
  | { kind: "claimed"; record: PrRecord }
  | { kind: "released"; record: PrRecord }
  | { kind: "already-claimed"; byName: string }
  | { kind: "not-open" };

/**
 * First-write-wins. A reaction never supersedes an existing claim, and this is
 * deliberately not "earliest timestamp wins": the reactions endpoint carries no
 * per-reaction timestamp, so a reaction can only be stamped at detection time.
 */
export function applyClaim(
  r: PrRecord,
  userId: string,
  displayName: string,
  at: number,
): ClaimOutcome {
  if (!isOpen(r)) return { kind: "not-open" };

  if (r.claimedBy !== null && r.claimedBy !== userId) {
    return { kind: "already-claimed", byName: r.claimedByName ?? "someone" };
  }
  if (r.claimedBy === userId) return { kind: "claimed", record: r };

  return {
    kind: "claimed",
    record: {
      ...r,
      claimedBy: userId,
      claimedByName: displayName,
      claimedAt: at,
      // A new claim resets the auto-clear markers.
      lastClaimedByName: null,
      claimClearedAt: null,
    },
  };
}

export function applyUnclaim(r: PrRecord, userId: string): ClaimOutcome {
  if (r.claimedBy === null) return { kind: "released", record: r };
  if (r.claimedBy !== userId) {
    return { kind: "already-claimed", byName: r.claimedByName ?? "someone" };
  }
  return {
    kind: "released",
    record: { ...r, claimedBy: null, claimedByName: null, claimedAt: null },
  };
}

/**
 * Auto-clearing returns the PR to its team section where someone else can pick it
 * up. It deliberately does NOT display a warning beside the claimer's name: a ⚠️
 * in a permanently pinned message is a public lateness board, and the predictable
 * adaptation is that people stop claiming.
 */
export function clearStaleClaim(r: PrRecord, now: number, thresholdMs: number): PrRecord {
  if (r.claimedAt === null) return r;
  if (now - r.claimedAt < thresholdMs) return r;
  return {
    ...r,
    claimedBy: null,
    claimedAt: null,
    claimedByName: null,
    lastClaimedByName: r.claimedByName,
    claimClearedAt: now,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --project=core tests/core/claims.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/claims.ts tests/core/claims.test.ts
git commit -m "feat(core): claim, unclaim and stale auto-clear with first-write-wins"
```

---

## Task 7: Ranking, truncation, and menu population

The rule this task exists to enforce: **the visible set and the actionable set are the same set.** A row dropped by truncation is absent from the menus, and every rendered row is actionable. Populating menus oldest-first independently of the digest is the specific bug being designed out — with 30 open rows the two orderings diverge in the worst direction, omitting the single most urgent row.

**Files:**
- Create: `src/core/ranking.ts`
- Test: `tests/core/ranking.test.ts`

**Interfaces:**
- Consumes: `PrRecord`, `recordId`, `isOpen` from Task 3; `Config`, `UrgencyKey`, `TeamName` from Task 1.
- Produces:
  - `type Section = { kind: "team"; team: TeamName } | { kind: "triage" } | { kind: "claimed" }`
  - `interface Row { record: PrRecord; id: string; section: Section }`
  - `function rankRows(records: PrRecord[], config: Config): Row[]`
  - `function urgencyRank(urgency: UrgencyKey | null, config: Config): number`
  - `interface TruncateResult { rendered: Row[]; droppedCount: number }`
  - `function truncateRows(rows: Row[], maxRows: number): TruncateResult`
  - `function menuOptions(rendered: Row[], kind: "claim" | "resolve", config: Config): MenuOption[]`
  - `interface MenuOption { label: string; value: string; description: string }`
  - `function encodeOptionValue(r: PrRecord): string` and `function decodeOptionValue(v: string): { id: string; lastRequestedAt: number } | null`

`encodeOptionValue` carries `lastRequestedAt` so Task 18 can detect a stale selection. Discord caps a select option `value` at 100 characters, and `paranext/example-extension/12345:1756000000000` is 46 — inside the cap with room, which is why the id can travel whole rather than hashed.

- [ ] **Step 1: Write the failing tests**

`tests/core/ranking.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { config as baseConfig } from "../../config/config.js";
import {
  decodeOptionValue,
  encodeOptionValue,
  menuOptions,
  rankRows,
  truncateRows,
  urgencyRank,
} from "../../src/core/ranking.js";
import { newScannedRecord, resolveRecord, type PrRecord } from "../../src/core/record.js";
import type { TeamName, UrgencyKey } from "../../config/config.js";

const T0 = 1_756_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function rec(
  number: number,
  opts: {
    team?: TeamName | null;
    urgency?: UrgencyKey | null;
    firstRequestedAt?: number;
    claimedBy?: string | null;
    claimedByName?: string | null;
  } = {},
): PrRecord {
  const base = newScannedRecord({
    pr: { owner: "paranext", repo: "paranext-core", number },
    channelId: "chan",
    messageId: `msg-${number}`,
    messageTimestamp: opts.firstRequestedAt ?? T0,
    title: `PT-${number} Title`,
    prAuthorLogin: "jolie",
    isDraft: false,
  });
  return {
    ...base,
    team: opts.team ?? null,
    urgency: opts.urgency ?? null,
    claimedBy: opts.claimedBy ?? null,
    claimedByName: opts.claimedByName ?? null,
    claimedAt: opts.claimedBy === undefined || opts.claimedBy === null ? null : T0,
  };
}

describe("urgencyRank", () => {
  it("orders blocking, soon, this week", () => {
    expect(urgencyRank("blocking", baseConfig)).toBeLessThan(urgencyRank("soon", baseConfig));
    expect(urgencyRank("soon", baseConfig)).toBeLessThan(urgencyRank("thisWeek", baseConfig));
  });

  it("ranks null urgency BELOW this week — every scanned row has none", () => {
    expect(urgencyRank(null, baseConfig)).toBeGreaterThan(urgencyRank("thisWeek", baseConfig));
  });
});

describe("rankRows", () => {
  it("excludes resolved records", () => {
    const rows = rankRows([resolveRecord(rec(1, { team: "Power" }), T0, "merged")], baseConfig);
    expect(rows).toHaveLength(0);
  });

  it("puts team sections in configured order: Power, Simple, General", () => {
    const rows = rankRows(
      [rec(1, { team: "General", urgency: "soon" }), rec(2, { team: "Simple", urgency: "soon" }), rec(3, { team: "Power", urgency: "soon" })],
      baseConfig,
    );
    expect(rows.map((r) => r.record.number)).toEqual([3, 2, 1]);
  });

  it("sorts urgency descending then age oldest-first inside a team", () => {
    const rows = rankRows(
      [
        rec(1, { team: "Power", urgency: "soon", firstRequestedAt: T0 - 8 * DAY }),
        rec(2, { team: "Power", urgency: "blocking", firstRequestedAt: T0 - 1 * HOUR }),
        rec(3, { team: "Power", urgency: "soon", firstRequestedAt: T0 - 30 * DAY }),
      ],
      baseConfig,
    );
    // Blocking first despite being newest; then the two Soon rows oldest-first.
    expect(rows.map((r) => r.record.number)).toEqual([2, 3, 1]);
  });

  it("places rows with no team in a triage section after every team section", () => {
    const rows = rankRows([rec(1), rec(2, { team: "General", urgency: "soon" })], baseConfig);
    expect(rows.map((r) => r.section.kind)).toEqual(["team", "triage"]);
  });

  it("moves claimed rows into a claimed section after triage", () => {
    const rows = rankRows(
      [
        rec(1, { team: "Power", urgency: "blocking", claimedBy: "u1", claimedByName: "Katherine" }),
        rec(2, { team: "Power", urgency: "soon" }),
        rec(3),
      ],
      baseConfig,
    );
    expect(rows.map((r) => r.section.kind)).toEqual(["team", "triage", "claimed"]);
    expect(rows.at(-1)?.record.number).toBe(1);
  });

  it("breaks ties on record id so the body is deterministic across ticks", () => {
    const a = rankRows([rec(9, { team: "Power", urgency: "soon" }), rec(4, { team: "Power", urgency: "soon" })], baseConfig);
    const b = rankRows([rec(4, { team: "Power", urgency: "soon" }), rec(9, { team: "Power", urgency: "soon" })], baseConfig);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  });
});

describe("truncateRows", () => {
  const many = Array.from({ length: 31 }, (_, i) =>
    rec(i + 1, { team: "Power", urgency: i === 0 ? "blocking" : "thisWeek", firstRequestedAt: T0 - (31 - i) * DAY }),
  );

  it("keeps the highest-ranked rows and reports how many were dropped", () => {
    const result = truncateRows(rankRows(many, baseConfig), 20);
    expect(result.rendered).toHaveLength(20);
    expect(result.droppedCount).toBe(11);
  });

  it("never drops the top-ranked row", () => {
    const result = truncateRows(rankRows(many, baseConfig), 20);
    expect(result.rendered[0]?.record.number).toBe(1);
  });

  it("drops nothing when everything fits", () => {
    const result = truncateRows(rankRows(many.slice(0, 5), baseConfig), 20);
    expect(result.droppedCount).toBe(0);
    expect(result.rendered).toHaveLength(5);
  });

  it("handles an empty list", () => {
    expect(truncateRows([], 20)).toEqual({ rendered: [], droppedCount: 0 });
  });
});

describe("menuOptions", () => {
  const many = Array.from({ length: 31 }, (_, i) =>
    rec(i + 1, {
      team: "Power",
      urgency: i === 30 ? "blocking" : "thisWeek",
      firstRequestedAt: T0 - (i === 30 ? HOUR : (31 - i) * DAY),
    }),
  );

  it("is populated from the digest ranking, not oldest-first", () => {
    // Row 31 is 🔥 and only 90 minutes old — the newest row and the most urgent.
    // An oldest-first menu would omit exactly this one.
    const rendered = truncateRows(rankRows(many, baseConfig), 20).rendered;
    const options = menuOptions(rendered, "claim", baseConfig);
    expect(options[0]?.value).toContain("/31:");
  });

  it("caps at Discord's 25 options", () => {
    const rendered = truncateRows(rankRows(many, baseConfig), 30).rendered;
    expect(menuOptions(rendered, "claim", baseConfig)).toHaveLength(25);
  });

  it("contains no row absent from the render", () => {
    const rendered = truncateRows(rankRows(many, baseConfig), 20).rendered;
    const renderedIds = new Set(rendered.map((r) => r.id));
    for (const option of menuOptions(rendered, "claim", baseConfig)) {
      expect(renderedIds.has(decodeOptionValue(option.value)!.id)).toBe(true);
    }
  });

  it("omits already-claimed rows from the claim menu but keeps them for resolve", () => {
    const rows = rankRows(
      [
        rec(1, { team: "Power", urgency: "soon" }),
        rec(2, { team: "Power", urgency: "soon", claimedBy: "u1", claimedByName: "Katherine" }),
      ],
      baseConfig,
    );
    expect(menuOptions(rows, "claim", baseConfig)).toHaveLength(1);
    expect(menuOptions(rows, "resolve", baseConfig)).toHaveLength(2);
  });

  it("keeps every label inside Discord's 100-character option limit", () => {
    const long = rec(1, { team: "Power", urgency: "blocking" });
    const rows = rankRows([{ ...long, title: "x".repeat(300) }], baseConfig);
    for (const option of menuOptions(rows, "claim", baseConfig)) {
      expect(option.label.length).toBeLessThanOrEqual(100);
      expect(option.value.length).toBeLessThanOrEqual(100);
      expect(option.description.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("option value encoding", () => {
  it("round-trips the id and lastRequestedAt", () => {
    const r = rec(177, { team: "Power", urgency: "blocking" });
    const decoded = decodeOptionValue(encodeOptionValue(r));
    expect(decoded).toEqual({ id: "paranext/paranext-core/177", lastRequestedAt: r.lastRequestedAt });
  });

  it("returns null for a malformed value rather than throwing", () => {
    expect(decodeOptionValue("garbage")).toBeNull();
    expect(decodeOptionValue("a/b/c:notanumber")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=core tests/core/ranking.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/ranking.js'`.

- [ ] **Step 3: Write the implementation**

`src/core/ranking.ts`:

```ts
import type { Config, TeamName, UrgencyKey } from "../../config/config.js";
import { isOpen, recordId, type PrRecord } from "./record.js";

export type Section =
  | { kind: "team"; team: TeamName }
  | { kind: "triage" }
  | { kind: "claimed" };

export interface Row {
  record: PrRecord;
  id: string;
  section: Section;
}

export interface TruncateResult {
  rendered: Row[];
  droppedCount: number;
}

export interface MenuOption {
  label: string;
  value: string;
  description: string;
}

/** Null urgency ranks below every level: every scanned row has none, so during
 *  shadow mode this rule decides the entire list. */
export function urgencyRank(urgency: UrgencyKey | null, config: Config): number {
  if (urgency === null) return Number.MAX_SAFE_INTEGER;
  return config.urgencies.find((u) => u.key === urgency)?.rank ?? Number.MAX_SAFE_INTEGER - 1;
}

function sectionOrder(section: Section, config: Config): number {
  if (section.kind === "team") return config.teams.indexOf(section.team);
  if (section.kind === "triage") return config.teams.length;
  return config.teams.length + 1;
}

function sectionFor(r: PrRecord): Section {
  if (r.claimedBy !== null) return { kind: "claimed" };
  if (r.team === null) return { kind: "triage" };
  return { kind: "team", team: r.team };
}

export function rankRows(records: PrRecord[], config: Config): Row[] {
  const rows: Row[] = records
    .filter(isOpen)
    .map((record) => ({ record, id: recordId(record), section: sectionFor(record) }));

  return rows.sort((a, b) => {
    const bySection = sectionOrder(a.section, config) - sectionOrder(b.section, config);
    if (bySection !== 0) return bySection;

    const byUrgency = urgencyRank(a.record.urgency, config) - urgencyRank(b.record.urgency, config);
    if (byUrgency !== 0) return byUrgency;

    // Oldest first.
    const byAge = a.record.firstRequestedAt - b.record.firstRequestedAt;
    if (byAge !== 0) return byAge;

    // Deterministic tie-break: without this the body can churn between ticks
    // purely from store iteration order, defeating the write-skip.
    return a.id.localeCompare(b.id);
  });
}

export function truncateRows(rows: Row[], maxRows: number): TruncateResult {
  if (rows.length <= maxRows) return { rendered: rows, droppedCount: 0 };
  return { rendered: rows.slice(0, maxRows), droppedCount: rows.length - maxRows };
}

export function encodeOptionValue(r: PrRecord): string {
  return `${recordId(r)}:${r.lastRequestedAt}`;
}

export function decodeOptionValue(value: string): { id: string; lastRequestedAt: number } | null {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const id = value.slice(0, separator);
  const stamp = Number(value.slice(separator + 1));
  if (!Number.isFinite(stamp) || id.split("/").length !== 3) return null;
  return { id, lastRequestedAt: stamp };
}

const DISCORD_OPTION_MAX = 100;

function clamp(text: string, max = DISCORD_OPTION_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Menus are populated from the digest's own ranking so the visible set and the
 * actionable set are the same set. Populating them oldest-first independently
 * would omit a 🔥 row requested 90 minutes ago — the most urgent row on the list
 * and one of the newest.
 */
export function menuOptions(rendered: Row[], kind: "claim" | "resolve", config: Config): MenuOption[] {
  const eligible = kind === "claim" ? rendered.filter((r) => r.record.claimedBy === null) : rendered;

  return eligible.slice(0, 25).map((row) => {
    const urgency = config.urgencies.find((u) => u.key === row.record.urgency);
    const prefix = urgency === undefined ? "" : `${urgency.emoji} `;
    return {
      label: clamp(`${prefix}${row.record.title}`),
      value: encodeOptionValue(row.record),
      description: clamp(`${row.record.repo}#${row.record.number}${row.record.team === null ? "" : ` · ${row.record.team}`}`),
    };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --project=core tests/core/ranking.test.ts`
Expected: PASS, all cases — in particular "is populated from the digest ranking, not oldest-first".

- [ ] **Step 5: Commit**

```bash
git add src/core/ranking.ts tests/core/ranking.test.ts
git commit -m "feat(core): rank, truncate and populate menus from one shared ordering"
```

---

## Task 8: The digest renderer

The renderer is a **pure function of `(records, lastSync, now)`**. That signature is load-bearing three ways: it makes the stale banner a rendering consequence rather than a sync side effect (so a tick that dies at the GitHub step still repaints), it makes snapshots time-independent, and it is what lets the Task 10 preview harness draw every scenario with no I/O.

**Files:**
- Create: `src/core/render/digest.ts`
- Test: `tests/core/render/digest.test.ts`

**Interfaces:**
- Consumes: `Row`, `rankRows`, `truncateRows`, `menuOptions` from Task 7; `relTs`, `isStale` from Task 5; `stableHash` from Task 5; `PrRecord`, `isOpen` from Task 3.
- Produces:
  - `interface DigestInput { records: PrRecord[]; lastSync: number | null; now: number; config: Config; maxRows?: number }`
  - `interface DigestEmbed { color: number; description: string }`
  - `interface DigestRender { embeds: DigestEmbed[]; components: unknown[]; bodyHash: string; openCount: number; renderedCount: number; droppedCount: number }`
  - `function renderDigest(input: DigestInput): DigestRender`
  - `const EMBED_DESCRIPTION_LIMIT = 4096`

Section order is fixed: team sections, then **Needs triage**, then **Being reviewed**, then **Recently cleared**.

- [ ] **Step 1: Write the failing tests**

`tests/core/render/digest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { config as baseConfig } from "../../../config/config.js";
import { renderDigest } from "../../../src/core/render/digest.js";
import { newScannedRecord, resolveRecord, type PrRecord } from "../../../src/core/record.js";
import type { TeamName, UrgencyKey } from "../../../config/config.js";

const T0 = 1_756_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = T0 + 30 * DAY;

function rec(
  number: number,
  opts: Partial<PrRecord> & { team?: TeamName | null; urgency?: UrgencyKey | null } = {},
): PrRecord {
  const base = newScannedRecord({
    pr: { owner: "paranext", repo: "paranext-core", number },
    channelId: "chan",
    messageId: `msg-${number}`,
    messageTimestamp: NOW - 3 * DAY,
    title: `PT-${number} Some change`,
    prAuthorLogin: "jolie",
    isDraft: false,
  });
  return { ...base, ...opts };
}

const FRESH = { lastSync: NOW - MINUTE, now: NOW, config: baseConfig };

describe("renderDigest — structure", () => {
  it("renders the empty state with NO components at all", () => {
    // A String Select requires 1-25 options; rendering one empty is a 400, the
    // PATCH fails, the retry fails identically, and the digest freezes showing
    // PRs that are already done.
    const result = renderDigest({ records: [], ...FRESH });
    expect(result.components).toEqual([]);
    expect(result.embeds[0]?.description).toContain("nothing waiting");
  });

  it("renders the empty state when every record is resolved", () => {
    const resolved = resolveRecord(rec(1, { team: "Power", urgency: "soon" }), NOW - 2 * HOUR, "merged");
    const result = renderDigest({ records: [resolved], ...FRESH });
    expect(result.openCount).toBe(0);
    // Recently cleared still renders, but no menus.
    expect(result.components).toEqual([]);
  });

  it("omits a team section that has no open rows", () => {
    const result = renderDigest({ records: [rec(1, { team: "Power", urgency: "soon" })], ...FRESH });
    const body = result.embeds.map((e) => e.description).join("\n");
    expect(body).toContain("__Power__");
    expect(body).not.toContain("__Simple__");
    expect(body).not.toContain("__General__");
  });

  it("orders sections: teams, triage, being reviewed, recently cleared", () => {
    const records = [
      rec(1, { team: "Power", urgency: "soon" }),
      rec(2),
      rec(3, { team: "Simple", urgency: "soon", claimedBy: "u1", claimedByName: "Katherine", claimedAt: NOW - HOUR }),
      resolveRecord(rec(4, { team: "Power", urgency: "soon" }), NOW - 10 * MINUTE, "review by Ira"),
    ];
    const body = renderDigest({ records, ...FRESH }).embeds.map((e) => e.description).join("\n");
    const order = ["__Power__", "Needs triage", "Being reviewed", "Recently cleared"].map((s) => body.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  it("counts OPEN rows in the header, not rendered rows", () => {
    const records = Array.from({ length: 31 }, (_, i) => rec(i + 1, { team: "Power", urgency: "thisWeek" }));
    const result = renderDigest({ records, ...FRESH, maxRows: 20 });
    expect(result.openCount).toBe(31);
    expect(result.renderedCount).toBe(20);
    expect(result.embeds[0]?.description).toContain("31 open");
  });
});

describe("renderDigest — row content", () => {
  it("renders urgency as emoji PLUS words, never emoji alone", () => {
    const body = renderDigest({ records: [rec(1, { team: "Power", urgency: "thisWeek" })], ...FRESH })
      .embeds.map((e) => e.description).join("\n");
    expect(body).toContain("🧊 This week");
  });

  it("links the title to the PR", () => {
    const body = renderDigest({ records: [rec(177, { team: "Power", urgency: "soon" })], ...FRESH })
      .embeds.map((e) => e.description).join("\n");
    expect(body).toContain("[PT-177 Some change](https://github.com/paranext/paranext-core/pull/177)");
  });

  it("renders ages as relative timestamps, never as computed strings", () => {
    const body = renderDigest({ records: [rec(1, { team: "Power", urgency: "soon" })], ...FRESH })
      .embeds.map((e) => e.description).join("\n");
    expect(body).toMatch(/<t:\d+:R>/);
    expect(body).not.toMatch(/\b\d+[dh]\b/);
  });

  it("renders the blocking reason inline beneath a 🔥 row", () => {
    const record = rec(1, { team: "Power", urgency: "blocking", note: "blocks the release branch cut" });
    const body = renderDigest({ records: [record], ...FRESH }).embeds.map((e) => e.description).join("\n");
    expect(body).toContain("blocks the release branch cut");
  });

  it("does not render a note on a non-blocking row", () => {
    const record = rec(1, { team: "Power", urgency: "soon", note: "just the CSS bit" });
    const body = renderDigest({ records: [record], ...FRESH }).embeds.map((e) => e.description).join("\n");
    expect(body).not.toContain("just the CSS bit");
  });

  it("marks a draft PR", () => {
    const body = renderDigest({ records: [rec(1, { team: "Power", urgency: "soon", isDraft: true })], ...FRESH })
      .embeds.map((e) => e.description).join("\n");
    expect(body).toContain("draft");
  });

  it("marks sync paused", () => {
    const body = renderDigest({ records: [rec(1, { team: "Power", urgency: "soon", syncPausedSince: NOW - DAY })], ...FRESH })
      .embeds.map((e) => e.description).join("\n");
    expect(body).toContain("sync paused");
  });

  it("marks previously claimed after an auto-clear", () => {
    const record = rec(1, { team: "Power", urgency: "soon", lastClaimedByName: "Ira", claimClearedAt: NOW - HOUR });
    const body = renderDigest({ records: [record], ...FRESH }).embeds.map((e) => e.description).join("\n");
    expect(body).toContain("previously claimed");
  });

  it("renders the PRD as a thread mention that follows renames", () => {
    const body = renderDigest({ records: [rec(1, { team: "Power", urgency: "soon", prdThreadId: "t-9" })], ...FRESH })
      .embeds.map((e) => e.description).join("\n");
    expect(body).toContain("<#t-9>");
  });
});

describe("renderDigest — per-person data stays out", () => {
  const claimed = rec(1, {
    team: "Power",
    urgency: "blocking",
    claimedBy: "u1",
    claimedByName: "Katherine",
    claimedAt: NOW - 4 * DAY,
  });

  it("shows the claimer and the urgency and team they came from", () => {
    const body = renderDigest({ records: [claimed], ...FRESH }).embeds.map((e) => e.description).join("\n");
    expect(body).toContain("Katherine");
    expect(body).toContain("🔥");
    expect(body).toContain("Power");
  });

  it("does NOT render the claim age — that is the lateness board", () => {
    const result = renderDigest({ records: [claimed], ...FRESH });
    const claimedSection = result.embeds.map((e) => e.description).join("\n").split("Being reviewed")[1] ?? "";
    expect(claimedSection).not.toContain(String(Math.floor(claimed.claimedAt! / 1000)));
  });

  it("does NOT render re-asked, even after several re-requests", () => {
    const record = rec(1, { team: "Power", urgency: "soon", requestCount: 5, lastRequestedAt: NOW - HOUR });
    const body = renderDigest({ records: [record], ...FRESH }).embeds.map((e) => e.description).join("\n");
    expect(body).not.toContain("re-asked");
  });
});

describe("renderDigest — recently cleared", () => {
  it("renders a row resolved inside the window, distinguishing review from manual", () => {
    const byReview = resolveRecord(rec(1, { team: "Power" }), NOW - 10 * MINUTE, "review by Katherine");
    const byHand = resolveRecord(rec(2, { team: "Power" }), NOW - 20 * MINUTE, "cleared by Jolie");
    const body = renderDigest({ records: [byReview, byHand], ...FRESH }).embeds.map((e) => e.description).join("\n");
    expect(body).toContain("review by Katherine");
    expect(body).toContain("cleared by Jolie");
  });

  it("omits a row resolved outside the one-hour window", () => {
    const old = resolveRecord(rec(1, { team: "Power" }), NOW - 2 * HOUR, "merged");
    const body = renderDigest({ records: [old], ...FRESH }).embeds.map((e) => e.description).join("\n");
    expect(body).not.toContain("Recently cleared");
  });
});

describe("renderDigest — stale banner", () => {
  it("renders the banner when lastSync is older than the threshold", () => {
    const result = renderDigest({ records: [rec(1, { team: "Power", urgency: "soon" })], lastSync: NOW - 47 * MINUTE, now: NOW, config: baseConfig });
    expect(result.embeds[0]?.description).toContain("Not syncing");
  });

  it("replaces the updated timestamp rather than sitting beside it", () => {
    const result = renderDigest({ records: [rec(1, { team: "Power", urgency: "soon" })], lastSync: NOW - 47 * MINUTE, now: NOW, config: baseConfig });
    expect(result.embeds[0]?.description).not.toContain("updated <t:");
  });

  it("renders the banner on a never-synced store", () => {
    const result = renderDigest({ records: [], lastSync: null, now: NOW, config: baseConfig });
    expect(result.embeds[0]?.description).toContain("Not syncing");
  });

  it("still renders every row when stale — a failed sync aborts mutation, not rendering", () => {
    const result = renderDigest({ records: [rec(1, { team: "Power", urgency: "soon" })], lastSync: NOW - 47 * MINUTE, now: NOW, config: baseConfig });
    expect(result.renderedCount).toBe(1);
  });
});

describe("renderDigest — time independence", () => {
  const records = [
    rec(1, { team: "Power", urgency: "blocking", note: "blocks the cut" }),
    rec(2, { team: "Simple", urgency: "thisWeek" }),
    rec(3, { claimedBy: "u1", claimedByName: "Katherine", claimedAt: NOW - 3 * HOUR }),
  ];

  it("produces the same body hash across an hour boundary", () => {
    // This is the property the whole write-skip depends on: with a dozen rows a
    // computed age would change the body on nearly every tick.
    // lastSync MUST advance with now. Holding it fixed while advancing now by an
    // hour puts the gap at 61 minutes — past staleBannerMs (30) — so `b` renders
    // the stale banner and `a` does not, and the sibling test below enforces
    // exactly that difference. The original fixture could not pass under any
    // correct implementation.
    const a = renderDigest({ records, lastSync: NOW - MINUTE, now: NOW, config: baseConfig });
    const b = renderDigest({
      records,
      lastSync: NOW + 60 * MINUTE - MINUTE,
      now: NOW + 60 * MINUTE,
      config: baseConfig,
    });
    expect(a.bodyHash).toBe(b.bodyHash);
  });

  it("changes the body hash when a record changes", () => {
    const a = renderDigest({ records, ...FRESH });
    const b = renderDigest({ records: [...records, rec(4, { team: "Power", urgency: "soon" })], ...FRESH });
    expect(a.bodyHash).not.toBe(b.bodyHash);
  });

  it("changes the body hash when the stale banner appears", () => {
    const fresh = renderDigest({ records, lastSync: NOW - MINUTE, now: NOW, config: baseConfig });
    const stale = renderDigest({ records, lastSync: NOW - 47 * MINUTE, now: NOW, config: baseConfig });
    expect(fresh.bodyHash).not.toBe(stale.bodyHash);
  });
});

describe("renderDigest — capacity", () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    rec(i + 1, { team: "Power", urgency: "thisWeek", title: `PT-${i} ${"long title ".repeat(6)}` }),
  );

  it("keeps every embed description inside 4096 characters", () => {
    for (const embed of renderDigest({ records: many, ...FRESH }).embeds) {
      expect(embed.description.length).toBeLessThanOrEqual(4096);
    }
  });

  it("keeps the total across embeds inside 6000 characters", () => {
    const total = renderDigest({ records: many, ...FRESH }).embeds
      .reduce((sum, e) => sum + e.description.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
  });

  it("appends an explicit and-N-more rather than truncating silently", () => {
    const result = renderDigest({ records: many, ...FRESH });
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.embeds.map((e) => e.description).join("\n")).toContain(`${result.droppedCount} more`);
  });

  it("moves Being reviewed into a second embed when the first is full", () => {
    const withClaims = [
      ...many,
      rec(99, { team: "Power", urgency: "soon", claimedBy: "u1", claimedByName: "Katherine", claimedAt: NOW - HOUR }),
    ];
    const result = renderDigest({ records: withClaims, ...FRESH });
    expect(result.embeds.length).toBeGreaterThan(1);
  });

  it("matches a stored snapshot", () => {
    const result = renderDigest({
      records: [
        rec(177, { team: "Power", urgency: "blocking", note: "needs a P10 build before Thursday's demo", prdThreadId: "t-1" }),
        rec(2701, { team: "Power", urgency: "soon" }),
        rec(2695, { team: "Simple", urgency: "thisWeek", isDraft: true }),
        rec(3408, { claimedBy: "u1", claimedByName: "Katherine", claimedAt: NOW - 2 * HOUR, team: "Power", urgency: "blocking" }),
      ],
      ...FRESH,
    });
    expect(result.embeds.map((e) => e.description)).toMatchSnapshot();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=core tests/core/render/digest.test.ts`
Expected: FAIL — `Cannot find module '.../render/digest.js'`.

- [ ] **Step 3: Write the implementation**

`src/core/render/digest.ts`:

```ts
import type { Config } from "../../../config/config.js";
import { stableHash } from "../hash.js";
import { isOpen, type PrRecord } from "../record.js";
import { menuOptions, rankRows, truncateRows, type Row } from "../ranking.js";
import { isStale, relTs } from "../time.js";

export const EMBED_DESCRIPTION_LIMIT = 4096;
export const EMBED_TOTAL_LIMIT = 6000;
/** Practical row ceiling. Real rows run 150-180 characters once titles are
 *  markdown links and ages are long-form relative timestamps. */
export const DEFAULT_MAX_ROWS = 20;

const COLOR_NORMAL = 0x5865f2;
const COLOR_STALE = 0xf0b232;

export interface DigestInput {
  records: PrRecord[];
  lastSync: number | null;
  now: number;
  config: Config;
  maxRows?: number;
}

export interface DigestEmbed {
  color: number;
  description: string;
}

export interface DigestRender {
  embeds: DigestEmbed[];
  components: unknown[];
  bodyHash: string;
  openCount: number;
  renderedCount: number;
  droppedCount: number;
}

function prUrl(r: PrRecord): string {
  return `https://github.com/${r.owner}/${r.repo}/pull/${r.number}`;
}

function urgencyLabel(r: PrRecord, config: Config): string | null {
  const level = config.urgencies.find((u) => u.key === r.urgency);
  return level === undefined ? null : `${level.emoji} ${level.label}`;
}

function markers(r: PrRecord): string[] {
  const out: string[] = [];
  if (r.isDraft) out.push("draft");
  if (r.syncPausedSince !== null) out.push("sync paused");
  if (r.lastClaimedByName !== null) out.push("previously claimed");
  return out;
}

function renderOpenRow(r: PrRecord, config: Config): string {
  const lines: string[] = [];
  const urgency = urgencyLabel(r, config);
  const head = [urgency, `[${r.title}](${prUrl(r)})`, relTs(r.firstRequestedAt)]
    .filter((part) => part !== null)
    .join(" · ");
  lines.push(head);

  const sub = [`${r.repo}#${r.number}`];
  if (r.prdThreadId !== null) sub.push(`<#${r.prdThreadId}>`);
  sub.push(...markers(r));
  lines.push(`     ${sub.join(" · ")}`);

  // The blocking reason renders inline. This is the only place it is visible to
  // anyone deciding what to pick up, and therefore the only version in which the
  // required-note gate is accountable rather than ceremonial.
  if (r.urgency === "blocking" && r.note !== null && r.note.trim() !== "") {
    lines.push(`     _${r.note.trim()}_`);
  }

  return lines.join("\n");
}

/** No claim age: a timer beside a name in a permanently pinned message is a
 *  public lateness board, and the rational response to one is to stop claiming. */
function renderClaimedRow(r: PrRecord, config: Config): string {
  const provenance = [urgencyLabel(r, config)?.split(" ")[0], r.team].filter(Boolean).join(" ");
  const suffix = provenance === "" ? "" : ` · ${provenance}`;
  return `👀 [${r.title}](${prUrl(r)}) · ${r.claimedByName ?? "someone"}${suffix}`;
}

function renderClearedLine(r: PrRecord): string {
  return `${r.repo}#${r.number} — ${r.resolvedBy ?? "resolved"}`;
}

function buildBlocks(rows: Row[], config: Config): { open: string[]; claimed: string[] } {
  const open: string[] = [];
  const claimed: string[] = [];
  let currentTeam: string | null = null;

  for (const row of rows) {
    if (row.section.kind === "claimed") {
      claimed.push(renderClaimedRow(row.record, config));
      continue;
    }
    const heading = row.section.kind === "team" ? `__${row.section.team}__` : "**Needs triage**";
    if (heading !== currentTeam) {
      open.push(heading);
      currentTeam = heading;
    }
    open.push(renderOpenRow(row.record, config));
  }
  return { open, claimed };
}

/**
 * Packs parts up to `limit`, returning what did not fit. The split is a clean
 * prefix/suffix: once one part overflows, every later part overflows too, or
 * content would be reordered across embeds.
 */
function joinWithinLimit(parts: string[], limit: number): { fitted: string[]; overflow: string[] } {
  const fitted: string[] = [];
  const overflow: string[] = [];
  let length = 0;
  for (const part of parts) {
    const cost = part.length + 1;
    if (overflow.length > 0 || length + cost > limit) {
      overflow.push(part);
    } else {
      fitted.push(part);
      length += cost;
    }
  }
  return { fitted, overflow };
}

function overflowNotice(count: number): string {
  return `_…and ${count} more not shown here (message capacity reached). Use \`/review-list\` to see everything._`;
}

/**
 * Derived, never hand-counted. A literal drifts the moment anyone rewords the
 * notice, and a reserve short by even a few characters puts the emitted
 * description past the cap — which is a 400, a failed retry, and a frozen pin.
 */
const OVERFLOW_NOTICE_RESERVE = overflowNotice(999_999).length;

/**
 * Enforces BOTH Discord bounds. joinWithinLimit alone guards 4096 per embed, so
 * two embeds could total 8192 — over the 6000-across-embeds cap. The second
 * embed's budget is therefore whatever the first left unused, and anything still
 * unrenderable is reported rather than dropped: under-reporting the list is the
 * one direction the design forbids.
 */
function fitSecondEmbed(parts: string[], firstLength: number): string | null {
  const budget = Math.min(EMBED_DESCRIPTION_LIMIT, EMBED_TOTAL_LIMIT - firstLength);
  if (budget <= 0) return null;

  const full = joinWithinLimit(parts, budget);
  if (full.overflow.length === 0) return full.fitted.join("\n");

  const contentCap = budget - OVERFLOW_NOTICE_RESERVE - 1;
  if (contentCap <= 0) return overflowNotice(parts.length).slice(0, budget);

  const constrained = joinWithinLimit(parts, contentCap);
  return [...constrained.fitted, overflowNotice(constrained.overflow.length)].join("\n");
}

export function renderDigest(input: DigestInput): DigestRender {
  const { records, lastSync, now, config } = input;
  const maxRows = input.maxRows ?? DEFAULT_MAX_ROWS;

  const allRows = rankRows(records, config);
  // Claimed rows bypass truncation. The spec requires that a claim move to a
  // section rather than off the list — "an abandoned claim stays visible
  // instead of silently vanishing" — so applying the row cap across all rows
  // would let a claim disappear once the backlog exceeded it. droppedCount
  // therefore counts backlog rows only.
  const claimedRows = allRows.filter((r) => r.section.kind === "claimed");
  const openRows = allRows.filter((r) => r.section.kind !== "claimed");
  const truncated = truncateRows(openRows, maxRows);
  const rendered = [...truncated.rendered, ...claimedRows];
  const droppedCount = truncated.droppedCount;
  const openCount = openRows.length;

  const stale = isStale(lastSync, now, config.staleBannerMs);

  const openCountText = openCount === 0 ? "nothing waiting 🎉" : `${openCount} open`;
  const freshSummary = `**Needs review** · ${openCountText}`;
  const staleBanner = `⚠️ **Not syncing.** Last successful sync ${lastSync === null ? "never" : relTs(lastSync)}. Rows below may be out of date.`;

  // The tick-rounded stamp keeps the body stable within one refresh interval.
  // Cross-tick stability comes from excluding it from the hash — see bodyHash.
  const tickStamp = Math.floor(now / config.refreshIntervalMs) * config.refreshIntervalMs;

  // When stale, the banner replaces the `updated` line rather than sitting beside
  // it, so a reader never has to do the subtraction — but the open count survives.
  const headerLines = stale
    ? [staleBanner, freshSummary]
    : [`${freshSummary} · updated ${relTs(tickStamp)}`];

  // Identical to headerLines except the fresh case drops the `updated` suffix.
  const hashHeaderLines = stale ? headerLines : [freshSummary];

  const { open, claimed } = buildBlocks(rendered, config);

  const cleared = records
    .filter((r) => !isOpen(r) && r.resolvedAt !== null && now - r.resolvedAt <= config.recentlyClearedMs)
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
    .slice(0, 5);

  const droppedLine: string[] =
    droppedCount > 0
      ? [`_…and ${droppedCount} more. Use \`/review-list\` to see everything._`]
      : [];

  const trailing: string[] = [];
  if (claimed.length > 0) trailing.push(`**Being reviewed** (${claimed.length})`, ...claimed);
  if (cleared.length > 0) trailing.push("Recently cleared", ...cleared.map(renderClearedLine));

  // Two parallel lists built from the SAME pieces: `primary` is sent, `hashParts`
  // is hashed. They differ only in the header, and only in the fresh case.
  const primary: string[] = [...headerLines, ...open, ...droppedLine];
  const hashParts: string[] = [...hashHeaderLines, ...open, ...droppedLine, ...trailing];

  const color = stale ? COLOR_STALE : COLOR_NORMAL;
  const first = joinWithinLimit([...primary, ...trailing], EMBED_DESCRIPTION_LIMIT);
  const firstBody = first.fitted.join("\n");
  const embeds: DigestEmbed[] = [{ color, description: firstBody }];
  if (first.overflow.length > 0) {
    const secondBody = fitSecondEmbed(first.overflow, firstBody.length);
    if (secondBody !== null) embeds.push({ color, description: secondBody });
  }

  // No components at all when there is nothing to act on: a String Select with an
  // empty option list is a 400, the PATCH fails, and the digest freezes showing
  // PRs that are already done.
  const claimChoices = menuOptions(rendered, "claim", config);
  const resolveChoices = menuOptions(rendered, "resolve", config);
  const components: unknown[] = [];
  if (claimChoices.length > 0) {
    components.push({
      type: 1,
      components: [{ type: 3, custom_id: "digest:claim", placeholder: droppedCount > 0 ? `Claim a PR — top ${claimChoices.length} shown` : "Claim a PR", options: claimChoices }],
    });
  }
  if (resolveChoices.length > 0) {
    components.push({
      type: 1,
      components: [{ type: 3, custom_id: "digest:resolve", placeholder: "Resolve", options: resolveChoices }],
    });
  }

  return {
    embeds,
    components,
    // The hash EXCLUDES the fresh header's `· updated <t:…:R>` suffix, which the
    // sent embeds still carry. Rounding that stamp to the tick boundary stops
    // sub-tick churn but not cross-tick churn: consecutive ticks are exactly one
    // refreshIntervalMs apart, so the rounded bucket differs on every tick and
    // hashing it would force ~288 edits a day on an idle team. Excluding it makes
    // "updated N ago" mean "last actually edited N ago", which is true and which
    // Discord renders live. The stale banner stays inside the hash — it derives
    // from lastSync, real state rather than wall-clock, and it is the
    // trust-critical signal.
    bodyHash: stableHash(hashParts.join("\u0000")),
    openCount,
    renderedCount: rendered.length,
    droppedCount,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --project=core tests/core/render/digest.test.ts -u`
Expected: PASS. The `-u` writes the snapshot on first run; inspect
`tests/core/render/__snapshots__/digest.test.ts.snap` by eye and confirm it
contains no absolute timestamps in computed form, only `<t:…:R>` tokens.

- [ ] **Step 5: Pin the write-skip against both kinds of churn**

Two separate failures can make the body vary with wall-clock time, and the Step 3
code above already guards both. These tests are what keep it that way.

**Sub-tick churn** — a raw `relTs(now)` changes every second:

```ts
it("does not churn the body between two renders inside the same interval", () => {
  const records = [rec(1, { team: "Power", urgency: "soon" })];
  const a = renderDigest({ records, lastSync: NOW, now: NOW, config: baseConfig });
  const b = renderDigest({ records, lastSync: NOW, now: NOW + 1_000, config: baseConfig });
  expect(a.bodyHash).toBe(b.bodyHash);
});
```

**Cross-tick churn** — the more important one, and the one rounding does NOT fix.
Consecutive real ticks are exactly one `refreshIntervalMs` apart, so the rounded
bucket differs on *every* tick; hashing that stamp would force ~288 edits a day on
an idle team. This is why `bodyHash` is built from `hashParts` rather than from the
sent embeds:

```ts
it("does not churn the body across consecutive ticks", () => {
  const records = [rec(1, { team: "Power", urgency: "soon" })];
  const interval = baseConfig.refreshIntervalMs;
  const a = renderDigest({ records, lastSync: NOW, now: NOW, config: baseConfig });
  const b = renderDigest({ records, lastSync: NOW + interval, now: NOW + interval, config: baseConfig });
  expect(a.bodyHash).toBe(b.bodyHash);
  // The SENT body still advances its `updated` stamp — only the hash ignores it.
  expect(a.embeds[0]!.description).not.toBe(b.embeds[0]!.description);
});
```

Run: `npm test -- --project=core tests/core/render/digest.test.ts`
Expected: PASS. If the cross-tick test fails, `bodyHash` is being computed from
the sent embeds instead of `hashParts`.

- [ ] **Step 6: Commit**

```bash
git add src/core/render/digest.ts tests/core/render/digest.test.ts tests/core/render/__snapshots__
git commit -m "feat(core): render the digest as a pure function of records, lastSync and now"
```

---

## Task 9: The request message and the daily post

**Files:**
- Create: `src/core/render/request.ts`, `src/core/render/daily.ts`
- Test: `tests/core/render/request.test.ts`, `tests/core/render/daily.test.ts`

**Interfaces:**
- Consumes: `PrRecord`, `isOpen` from Task 3; `rankRows`, `urgencyRank` from Task 7; `relTs` from Task 5.
- Produces:
  - `function renderRequestMessage(r: PrRecord, config: Config): string`
  - `function renderDailyPost(input: DailyInput): string | null`
  - `interface DailyInput { records: PrRecord[]; digestMessageUrl: string | null; config: Config }`

`renderRequestMessage` is used by plan 2's submit handler, but it belongs here with the other renderers and its tests cost nothing now. The daily post is used by this plan's Task 17.

- [ ] **Step 1: Write the failing tests**

`tests/core/render/request.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { config as baseConfig } from "../../../config/config.js";
import { renderRequestMessage } from "../../../src/core/render/request.js";
import { newScannedRecord, type PrRecord } from "../../../src/core/record.js";

const T0 = 1_756_000_000_000;

function rec(overrides: Partial<PrRecord> = {}): PrRecord {
  const base = newScannedRecord({
    pr: { owner: "paranext", repo: "example-extension", number: 177 },
    channelId: "chan",
    messageId: "msg",
    messageTimestamp: T0,
    title: "PT-9001 P10 backend progress events",
    prAuthorLogin: "jolie",
    isDraft: false,
  });
  return {
    ...base,
    team: "Power",
    urgency: "blocking",
    note: "needs a P10 build before Thursday's demo",
    prdThreadId: "t-1",
    requesterId: "u-1",
    requesterName: "Jolie",
    source: "command",
    ...overrides,
  };
}

describe("renderRequestMessage", () => {
  it("keeps the bare url alone on its own line so GitHub's unfurl renders", () => {
    const lines = renderRequestMessage(rec(), baseConfig).split("\n");
    const urlLine = lines.find((l) => l.includes("github.com"));
    expect(urlLine).toBe("https://github.com/paranext/example-extension/pull/177");
  });

  it("leads with urgency as emoji plus words, then team, then title", () => {
    expect(renderRequestMessage(rec(), baseConfig).split("\n")[0]).toBe(
      "🔥 **Blocking** · power · PT-9001 P10 backend progress events",
    );
  });

  it("renders the PRD as a thread mention and names the requester", () => {
    const body = renderRequestMessage(rec(), baseConfig);
    expect(body).toContain("<#t-1>");
    expect(body).toContain("<@u-1>");
  });

  it("omits the PRD line entirely when there is none", () => {
    const body = renderRequestMessage(rec({ prdThreadId: null }), baseConfig);
    expect(body).not.toContain("<#");
    expect(body).toContain("<@u-1>");
  });

  it("includes the note on its own line when present", () => {
    expect(renderRequestMessage(rec(), baseConfig)).toContain("needs a P10 build before Thursday's demo");
  });

  it("omits the note line when absent", () => {
    const body = renderRequestMessage(rec({ note: null, urgency: "soon" }), baseConfig);
    expect(body.split("\n").filter((l) => l.trim() === "")).toHaveLength(0);
  });

  it("marks a draft PR", () => {
    expect(renderRequestMessage(rec({ isDraft: true }), baseConfig)).toContain("draft");
  });

  it("clamps title and note to 400 chars each before assembly", () => {
    // Title/note are clamped well before the outer 2000-char limit is reachable, so
    // asserting the outer limit here would pass no matter what the inner clamps do.
    const body = renderRequestMessage(
      rec({ title: "x".repeat(1200), note: "y".repeat(1200) }),
      baseConfig,
    );
    expect(body.split("\n")[0]!.length).toBeLessThanOrEqual(450);
  });

  it("stays inside Discord's 2000-character message limit even with an unclamped owner/repo", () => {
    // owner/repo are the only inputs that reach the assembled body unclamped, so they're
    // the only way to actually exercise the outer clamp.
    const body = renderRequestMessage(
      rec({ owner: "x".repeat(900), repo: "y".repeat(900) }),
      baseConfig,
    );
    expect(body.length).toBeLessThanOrEqual(2000);
  });
});
```

`tests/core/render/daily.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { config as baseConfig } from "../../../config/config.js";
import { renderDailyPost } from "../../../src/core/render/daily.js";
import { newScannedRecord, resolveRecord, type PrRecord } from "../../../src/core/record.js";
import { relTs } from "../../../src/core/time.js";
import type { TeamName, UrgencyKey } from "../../../config/config.js";

const T0 = 1_756_000_000_000;
const DAY = 86_400_000;

function rec(number: number, team: TeamName | null, urgency: UrgencyKey | null, ageDays: number): PrRecord {
  const base = newScannedRecord({
    pr: { owner: "paranext", repo: "paranext-core", number },
    channelId: "chan",
    messageId: `m-${number}`,
    messageTimestamp: T0 - ageDays * DAY,
    title: `PT-${number}`,
    prAuthorLogin: "jolie",
    isDraft: false,
  });
  return { ...base, team, urgency };
}

const URL = "https://discord.com/channels/1/2/3";

describe("renderDailyPost", () => {
  it("returns null when nothing is waiting, so a clear queue is silent", () => {
    expect(renderDailyPost({ records: [], digestMessageUrl: URL, config: baseConfig })).toBeNull();
  });

  it("returns null when every record is resolved", () => {
    const resolved = resolveRecord(rec(1, "Power", "soon", 3), T0, "merged");
    expect(renderDailyPost({ records: [resolved], digestMessageUrl: URL, config: baseConfig })).toBeNull();
  });

  it("names the count and the oldest age", () => {
    const body = renderDailyPost({
      records: [rec(1, "Power", "soon", 3), rec(2, "Simple", "thisWeek", 8)],
      digestMessageUrl: URL,
      config: baseConfig,
    });
    expect(body).toContain("2 PRs waiting");
    // Pin the reduce to the oldest record, not just "any relative timestamp" — a reduce
    // that picked the newest, or one that stamped Date.now(), would also match /<t:\d+:R>/.
    expect(body).toContain(relTs(T0 - 8 * DAY));
    expect(body).not.toContain(relTs(T0 - 3 * DAY));
  });

  it("uses the singular for one row", () => {
    const body = renderDailyPost({ records: [rec(1, "Power", "soon", 3)], digestMessageUrl: URL, config: baseConfig });
    expect(body).toContain("1 PR waiting");
  });

  it("mentions blocking work when a 🔥 row exists, naming its team", () => {
    const body = renderDailyPost({
      records: [rec(1, "Power", "blocking", 1), rec(2, "Simple", "soon", 3)],
      digestMessageUrl: URL,
      config: baseConfig,
    });
    expect(body).toContain("blocking Power");
  });

  it("says nothing about blocking when no 🔥 row exists", () => {
    const body = renderDailyPost({ records: [rec(1, "Power", "soon", 3)], digestMessageUrl: URL, config: baseConfig });
    expect(body).not.toContain("blocking");
  });

  it("names NO individual — it is not a per-person nudge", () => {
    const body = renderDailyPost({ records: [rec(1, "Power", "soon", 3)], digestMessageUrl: URL, config: baseConfig });
    expect(body).not.toContain("<@");
  });

  it("includes the jump link when one is known", () => {
    const body = renderDailyPost({ records: [rec(1, "Power", "soon", 3)], digestMessageUrl: URL, config: baseConfig });
    expect(body).toContain(URL);
  });

  it("omits the jump link gracefully when the digest message id is unknown", () => {
    const body = renderDailyPost({ records: [rec(1, "Power", "soon", 3)], digestMessageUrl: null, config: baseConfig });
    expect(body).not.toContain("Jump");
    expect(body).toContain("1 PR waiting");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=core tests/core/render`
Expected: FAIL on the two new files; the digest tests from Task 8 still PASS.

- [ ] **Step 3: Write the implementations**

`src/core/render/request.ts`:

```ts
import type { Config } from "../../../config/config.js";
import type { PrRecord } from "../record.js";

const DISCORD_MESSAGE_LIMIT = 2000;

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function renderRequestMessage(r: PrRecord, config: Config): string {
  const level = config.urgencies.find((u) => u.key === r.urgency);
  const url = `https://github.com/${r.owner}/${r.repo}/pull/${r.number}`;

  const headParts: string[] = [];
  if (level !== undefined) headParts.push(`${level.emoji} **${level.label}**`);
  if (r.team !== null) headParts.push(r.team.toLowerCase());
  headParts.push(clamp(r.title, 400));
  if (r.isDraft) headParts.push("draft");

  const lines: string[] = [headParts.join(" · ")];

  const attribution: string[] = [];
  if (r.prdThreadId !== null) attribution.push(`<#${r.prdThreadId}>`);
  if (r.requesterId !== null) attribution.push(`requested by <@${r.requesterId}>`);
  if (attribution.length > 0) lines.push(attribution.join(" · "));

  if (r.note !== null && r.note.trim() !== "") lines.push(clamp(r.note.trim(), 400));

  // The bare url stays alone on its own line so GitHub's link unfurl renders.
  lines.push(url);

  return clamp(lines.join("\n"), DISCORD_MESSAGE_LIMIT);
}
```

`src/core/render/daily.ts`:

```ts
import type { Config } from "../../../config/config.js";
import { isOpen, type PrRecord } from "../record.js";
import { relTs } from "../time.js";

export interface DailyInput {
  records: PrRecord[];
  digestMessageUrl: string | null;
  config: Config;
}

/**
 * Posted only when something is waiting, so a clear queue is silent and the post
 * never becomes wallpaper. Names counts and the oldest age — never an individual,
 * which is what keeps it outside the non-goal on per-person nudges.
 */
export function renderDailyPost(input: DailyInput): string | null {
  const open = input.records.filter(isOpen);
  if (open.length === 0) return null;

  const oldest = open.reduce((a, b) => (a.firstRequestedAt <= b.firstRequestedAt ? a : b));
  const noun = open.length === 1 ? "PR" : "PRs";

  const sentences: string[] = [
    `**${open.length} ${noun} waiting for review.** Oldest has been sitting ${relTs(oldest.firstRequestedAt)}.`,
  ];

  const blocking = open.filter((r) => r.urgency === "blocking");
  const firstBlocking = blocking[0];
  if (firstBlocking !== undefined) {
    const teams = [...new Set(blocking.map((r) => r.team).filter((t): t is NonNullable<typeof t> => t !== null))];
    const where = teams.length === 0 ? "" : ` blocking ${teams.join(" and ")}`;
    sentences.push(blocking.length === 1 ? `One is${where}.` : `${blocking.length} are${where}.`);
  }

  if (input.digestMessageUrl !== null) {
    sentences.push(`[Jump to the list ↗](${input.digestMessageUrl})`);
  }

  return sentences.join(" ");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --project=core tests/core/render`
Expected: PASS across all three render suites.

- [ ] **Step 5: Commit**

```bash
git add src/core/render/request.ts src/core/render/daily.ts tests/core/render/request.test.ts tests/core/render/daily.test.ts
git commit -m "feat(core): render the request message and the conditional daily post"
```

---

## Task 10: Fixtures and the preview harness

Built now rather than after the adapters, because this is what lets every render decision be checked against a picture with no credentials — and because building it once already caught a defect three rounds of review missed.

**Files:**
- Create: `fixtures/records.ts`
- Create: `preview/template.ts`, `preview/build.ts`
- Test: `tests/core/fixtures.test.ts`
- Modify: `.gitignore` (already ignores `preview/out/`)

**Interfaces:**
- Consumes: everything in `src/core/`.
- Produces:
  - `interface Scenario { key: string; label: string; tests: string; records: PrRecord[]; lastSync: number | null; now: number; maxRows?: number }`
  - `const SCENARIOS: Scenario[]` — imported by BOTH the preview build and the snapshot tests
  - `const FIXTURE_NOW: number` — a fixed epoch, so nothing in the fixture set depends on the real clock

Fixtures are shared deliberately: a render change that looks right in the preview but breaks a snapshot then fails in the same commit.

- [ ] **Step 1: Write `fixtures/records.ts`**

```ts
import type { TeamName, UrgencyKey } from "../config/config.js";
import { newScannedRecord, resolveRecord, type PrRecord } from "../src/core/record.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Fixed so no fixture depends on the real clock: 2026-08-31T16:00:00Z, which is
 * 11:00 America/Chicago. Same instant as `T0` in every other task's tests — the
 * digest renderer only uses relative offsets, but keeping one value everywhere
 * removes a trap for anyone who later adds a date- or local-hour-dependent
 * assertion here.
 */
export const FIXTURE_NOW = 1_788_192_000_000;

export interface Scenario {
  key: string;
  label: string;
  tests: string;
  records: PrRecord[];
  lastSync: number | null;
  now: number;
  maxRows?: number;
}

interface MakeInput {
  owner?: string;
  repo: string;
  number: number;
  title: string;
  team?: TeamName | null;
  urgency?: UrgencyKey | null;
  ageMs: number;
  note?: string | null;
  prdThreadId?: string | null;
  isDraft?: boolean;
  claimedByName?: string | null;
  lastClaimedByName?: string | null;
  syncPaused?: boolean;
  source?: "command" | "scanned";
}

export function make(input: MakeInput): PrRecord {
  const base = newScannedRecord({
    pr: { owner: input.owner ?? "paranext", repo: input.repo, number: input.number },
    channelId: "chan",
    messageId: `msg-${input.repo}-${input.number}`,
    messageTimestamp: FIXTURE_NOW - input.ageMs,
    title: input.title,
    prAuthorLogin: "jolie",
    isDraft: input.isDraft ?? false,
  });
  return {
    ...base,
    team: input.team ?? null,
    urgency: input.urgency ?? null,
    note: input.note ?? null,
    prdThreadId: input.prdThreadId ?? null,
    source: input.source ?? (input.team === null || input.team === undefined ? "scanned" : "command"),
    requesterId: "u-jolie",
    requesterName: "Jolie",
    claimedBy: input.claimedByName == null ? null : "u-claimer",
    claimedByName: input.claimedByName ?? null,
    claimedAt: input.claimedByName == null ? null : FIXTURE_NOW - 2 * HOUR,
    lastClaimedByName: input.lastClaimedByName ?? null,
    claimClearedAt: input.lastClaimedByName == null ? null : FIXTURE_NOW - HOUR,
    syncPausedSince: input.syncPaused === true ? FIXTURE_NOW - DAY : null,
  };
}

const ordinaryDay: PrRecord[] = [
  make({ repo: "example-extension", number: 177, title: "PT-9001 P10 backend progress events", team: "Power", urgency: "blocking", ageMs: 3 * DAY, note: "needs a P10 build before Thursday's demo", prdThreadId: "t-trust" }),
  make({ repo: "paranext-core", number: 2701, title: "PT-9002 Toolbar progress indicator", team: "Power", urgency: "soon", ageMs: 6 * HOUR }),
  make({ repo: "paranext-core", number: 2695, title: "PT-9003 Internet Settings UI Enhancements", team: "Simple", urgency: "thisWeek", ageMs: 8 * DAY, isDraft: true }),
  make({ repo: "paranext-core", number: 3408, title: "PT-9009 Normalize whitespace in search input", team: "Power", urgency: "blocking", ageMs: 2 * DAY, claimedByName: "Katherine" }),
  make({ repo: "paranext-core", number: 4325, title: "PT-9004 Unsaved changes badge", team: "Simple", urgency: "soon", ageMs: 1 * DAY, claimedByName: "Ira" }),
];

const shadowMode: PrRecord[] = [
  make({ repo: "example-extension", number: 177, title: "PT-9001 P10 backend progress events", ageMs: 3 * DAY }),
  make({ repo: "paranext-core", number: 2695, title: "PT-9003 Internet Settings UI Enhancements", ageMs: 8 * DAY }),
  make({ repo: "paranext-core", number: 2708, title: "PT-9005 Badge alignment in narrow panels", ageMs: 1 * DAY }),
  make({ owner: "eten-tech-foundation", repo: "scripture-editors", number: 341, title: "Fix marker parsing for \\fig", ageMs: 2 * DAY }),
  make({ repo: "example-extension", number: 88, title: "PT-9008 Retry banner wording", ageMs: 5 * HOUR }),
];

const notSyncing: PrRecord[] = [
  make({ repo: "paranext-core", number: 2701, title: "PT-9002 Toolbar progress indicator", team: "Power", urgency: "soon", ageMs: 6 * HOUR, syncPaused: true }),
  make({ repo: "paranext-core", number: 2688, title: "PT-9006 Theme preference import", team: "Power", urgency: "thisWeek", ageMs: 4 * DAY, lastClaimedByName: "Ira" }),
  resolveRecord(make({ repo: "paranext-core", number: 2690, title: "PT-9007 Footnote caller spacing", team: "Power", urgency: "soon", ageMs: 5 * DAY }), FIXTURE_NOW - 10 * MINUTE, "review by Katherine"),
  resolveRecord(make({ repo: "example-extension", number: 88, title: "PT-9008 Retry banner wording", team: "Simple", urgency: "soon", ageMs: 2 * DAY }), FIXTURE_NOW - 25 * MINUTE, "cleared by Jolie"),
];

const atCapacity: PrRecord[] = Array.from({ length: 31 }, (_, i) =>
  make({
    repo: "paranext-core",
    number: 2600 + i,
    title: `PT-${9100 + i} A change with a realistically long descriptive title`,
    team: i % 2 === 0 ? "Power" : "Simple",
    urgency: i === 30 ? "blocking" : "thisWeek",
    ageMs: i === 30 ? 90 * MINUTE : (31 - i) * DAY,
    note: i === 30 ? "blocks the release branch cut" : null,
  }),
);

export const SCENARIOS: Scenario[] = [
  { key: "ordinary", label: "An ordinary day", tests: "team grouping · urgency within · 🔥 reason inline · claim age suppressed", records: ordinaryDay, lastSync: FIXTURE_NOW - 2 * MINUTE, now: FIXTURE_NOW },
  { key: "shadow", label: "Shadow mode — everything scanned", tests: "Needs triage · null urgency ranking · what a sprint actually looks like", records: shadowMode, lastSync: FIXTURE_NOW - 4 * MINUTE, now: FIXTURE_NOW },
  { key: "stale", label: "Not syncing, with recently cleared rows", tests: "the banner that could never fire · resolve accountability", records: notSyncing, lastSync: FIXTURE_NOW - 47 * MINUTE, now: FIXTURE_NOW },
  { key: "capacity", label: "At capacity", tests: "visible set equals actionable set · open count vs rendered count", records: atCapacity, lastSync: FIXTURE_NOW - MINUTE, now: FIXTURE_NOW, maxRows: 20 },
  { key: "empty", label: "Nothing waiting", tests: "no components at all", records: [], lastSync: FIXTURE_NOW - MINUTE, now: FIXTURE_NOW },
  { key: "never-synced", label: "Fresh deploy, never synced", tests: "a store with no lastSync admits it", records: [], lastSync: null, now: FIXTURE_NOW },
];
```

- [ ] **Step 2: Write the failing fixture test**

`tests/core/fixtures.test.ts`. Snapshotting every scenario through the real renderer is what keeps the preview and the tests honest about the same output.

```ts
import { describe, expect, it } from "vitest";
import { config } from "../../config/config.js";
import { SCENARIOS } from "../../fixtures/records.js";
import { renderDigest, EMBED_DESCRIPTION_LIMIT, EMBED_TOTAL_LIMIT } from "../../src/core/render/digest.js";

describe("fixture scenarios", () => {
  it("covers every scenario the preview harness needs", () => {
    expect(SCENARIOS.map((s) => s.key)).toEqual([
      "ordinary", "shadow", "stale", "capacity", "empty", "never-synced",
    ]);
  });

  it.each(SCENARIOS)("renders $key inside Discord's embed limits", (scenario) => {
    const result = renderDigest({ ...scenario, config });
    for (const embed of result.embeds) {
      expect(embed.description.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_LIMIT);
    }
    const total = result.embeds.reduce((sum, e) => sum + e.description.length, 0);
    expect(total).toBeLessThanOrEqual(EMBED_TOTAL_LIMIT);
  });

  it.each(SCENARIOS)("renders $key identically on a later call — no clock dependence", (scenario) => {
    const a = renderDigest({ ...scenario, config });
    const b = renderDigest({ ...scenario, now: scenario.now + 59_000, config });
    expect(a.bodyHash).toBe(b.bodyHash);
  });

  it.each(SCENARIOS)("matches the stored snapshot for $key", (scenario) => {
    expect(renderDigest({ ...scenario, config })).toMatchSnapshot();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- --project=core tests/core/fixtures.test.ts`
Expected: FAIL — `Cannot find module '../../fixtures/records.js'` before Step 1's file exists; after it, FAIL on the missing snapshot until Step 4.

- [ ] **Step 4: Run with snapshot write and read the output**

Run: `npm test -- --project=core tests/core/fixtures.test.ts -u`
Expected: PASS. Then **read the snapshot file** — this is the first time the real digest text exists, and it is worth eyes:

```bash
sed -n '1,120p' tests/core/render/../__snapshots__/fixtures.test.ts.snap
```

Confirm by eye: long-form `<t:…:R>` tokens only, no `3d`; the 🔥 reason present on row 177 and absent elsewhere; no claim age in **Being reviewed**; `31 open` against 20 rendered in the capacity scenario; no components in `empty`.

- [ ] **Step 5: Write `preview/template.ts`**

```ts
export interface RenderedScenario {
  key: string;
  label: string;
  tests: string;
  embeds: { color: number; description: string }[];
  components: unknown[];
  openCount: number;
  renderedCount: number;
  droppedCount: number;
}

/** Minimal Discord-dark markdown renderer: enough for links, bold, underline and
 *  italics, plus resolved relative timestamps so the page reads like the client. */
function discordMarkdown(text: string, now: number): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped
    .replace(/&lt;t:(\d+):R&gt;/g, (_m, seconds: string) => {
      const deltaMs = Number(seconds) * 1000 - now;
      return `<span class="ts">${relativeWords(deltaMs)}</span>`;
    })
    .replace(/&lt;#([\w-]+)&gt;/g, '<span class="mention">#$1</span>')
    .replace(/&lt;@([\w-]+)&gt;/g, '<span class="mention">@$1</span>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a class="lnk" href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, '<span class="sec">$1</span>')
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function relativeWords(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [ms, name] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      return deltaMs < 0 ? `${n} ${name}${n === 1 ? "" : "s"} ago` : `in ${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  return deltaMs < 0 ? "just now" : "in a moment";
}

function renderComponents(components: unknown[]): string {
  if (components.length === 0) {
    return '<p class="none">no components — deliberate: an empty String Select is a 400</p>';
  }
  const selects = components.flatMap((row) => {
    const inner = (row as { components?: { placeholder?: string; options?: unknown[] }[] }).components ?? [];
    return inner.map(
      (c) =>
        `<div class="select"><span>${c.placeholder ?? "Select"}</span><span class="caret">▾</span>` +
        `<span class="count">${(c.options ?? []).length} options</span></div>`,
    );
  });
  return `<div class="components">${selects.join("")}</div>`;
}

export function buildHtml(scenarios: RenderedScenario[], now: number): string {
  const cards = scenarios
    .map(
      (s) => `
<section class="specimen">
  <header>
    <h2>${s.label}</h2>
    <p class="tests">${s.tests}</p>
    <p class="counts">${s.openCount} open · ${s.renderedCount} rendered · ${s.droppedCount} dropped · ${s.embeds.length} embed(s)</p>
  </header>
  <div class="stage">
    <div class="dc">
      ${s.embeds
        .map(
          (e) =>
            `<div class="embed" style="border-left-color:#${e.color.toString(16).padStart(6, "0")}">` +
            `<div class="body">${discordMarkdown(e.description, now).replace(/\n/g, "<br>")}</div></div>`,
        )
        .join("")}
      ${renderComponents(s.components)}
    </div>
  </div>
</section>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Needs Review — render proof</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0f0f13; color:#e6e6ec;
         font:15px/1.6 ui-sans-serif,system-ui,sans-serif; }
  main { max-width:900px; margin:0 auto; padding:48px 24px 96px; }
  h1 { font-size:1.8rem; margin:0 0 6px; }
  .lede { color:#9a9aa8; margin:0 0 40px; }
  .specimen { margin-bottom:44px; }
  .specimen header { border-bottom:1px solid #2a2a34; padding-bottom:10px; margin-bottom:16px; }
  .specimen h2 { font-size:1.05rem; margin:0; }
  .tests { color:#8d8d9b; font-style:italic; margin:4px 0 0; font-size:0.9rem; }
  .counts { color:#6f6f7d; margin:4px 0 0; font-size:0.82rem;
            font-family:ui-monospace,Menlo,monospace; }
  .stage { background:#1a1a20; border:1px solid #24242c; border-radius:6px; padding:20px; overflow-x:auto; }
  .dc { background:#313338; border-radius:7px; padding:16px; font-size:15px;
        font-family:"Noto Sans",system-ui,sans-serif; color:#dbdee1; min-width:420px; }
  .embed { background:#2b2d31; border-left:4px solid #5865f2; border-radius:4px;
           padding:14px 16px; margin-bottom:10px; max-width:520px; }
  .sec { font-weight:600; text-decoration:underline; color:#f2f3f5; }
  .lnk { color:#00a8fc; text-decoration:none; }
  .mention { background:rgba(88,101,242,.24); color:#c9cdfb; border-radius:3px; padding:0 2px; }
  .ts { background:rgba(78,93,148,.36); border-radius:3px; padding:0 2px; }
  code { background:#1e1f22; border-radius:3px; padding:0 4px; font-size:0.86em; }
  .components { display:flex; flex-wrap:wrap; gap:8px; }
  .select { background:#1e1f22; border:1px solid #26272b; border-radius:4px;
            padding:8px 11px; color:#949ba4; display:flex; gap:10px; align-items:center; }
  .count { color:#5d5d6b; font-size:0.78rem; }
  .none { color:#7a7a88; font-style:italic; margin:0; font-size:0.9rem; }
  strong { color:#f2f3f5; }
</style></head>
<body><main>
<h1>Needs Review — render proof</h1>
<p class="lede">Rendered by <code>src/core/render/digest.ts</code> from
<code>fixtures/records.ts</code>. No credentials, no network. Timestamps are resolved
the way Discord would resolve them, from a fixed fixture clock.</p>
${cards}
</main></body></html>`;
}
```

- [ ] **Step 6: Write `preview/build.ts`**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { config } from "../config/config.js";
import { FIXTURE_NOW, SCENARIOS } from "../fixtures/records.js";
import { renderDigest } from "../src/core/render/digest.js";
import { buildHtml, type RenderedScenario } from "./template.js";

const OUT = new URL("./out/", import.meta.url);

const rendered: RenderedScenario[] = SCENARIOS.map((scenario) => {
  const result = renderDigest({ ...scenario, config });
  return {
    key: scenario.key,
    label: scenario.label,
    tests: scenario.tests,
    embeds: result.embeds,
    components: result.components,
    openCount: result.openCount,
    renderedCount: result.renderedCount,
    droppedCount: result.droppedCount,
  };
});

await mkdir(OUT, { recursive: true });
await writeFile(new URL("index.html", OUT), buildHtml(rendered, FIXTURE_NOW), "utf8");

// Tier 2: the raw payload, for pasting into a renderer that applies Discord's own
// rules. This is what catches wrapping and character budget errors a CSS mock hides.
await writeFile(
  new URL("embeds.json", OUT),
  JSON.stringify(
    Object.fromEntries(rendered.map((r) => [r.key, { embeds: r.embeds, components: r.components }])),
    null,
    2,
  ),
  "utf8",
);

for (const r of rendered) {
  const chars = r.embeds.reduce((sum, e) => sum + e.description.length, 0);
  console.log(`${r.key.padEnd(14)} ${String(r.openCount).padStart(3)} open  ${String(r.renderedCount).padStart(3)} rendered  ${String(chars).padStart(5)} chars`);
}
console.log("\nwrote preview/out/index.html and preview/out/embeds.json");
```

- [ ] **Step 7: Build the preview and look at it**

Run:

```bash
npm run preview
open preview/out/index.html
```

Expected: the character-count table prints for all six scenarios, and the page shows six specimens. **Look at it.** Confirm against the spec's rendering rules: teams in Power/Simple/General order, 🔥 reason only on blocking rows, no claim age, `Recently cleared` distinguishing review from manual, the stale banner replacing the updated line, and no components on `empty`.

- [ ] **Step 8: Add a CI guard so the preview cannot silently break**

Append to `.github/workflows/ci.yml`, inside the `check` job's steps:

```yaml
      - run: npm run preview
```

A preview build that throws means `core/` and the fixtures have diverged, which is worth failing CI over — it is the same divergence that would make the snapshots meaningless.

- [ ] **Step 9: Commit**

```bash
git add fixtures/records.ts preview/ tests/core/fixtures.test.ts tests/core/__snapshots__ .github/workflows/ci.yml
git commit -m "feat(preview): render every digest scenario to HTML and embed JSON from shared fixtures"
```

---

## Task 11: Store state, the command set, and pure command application

The store is reached through **named, serializable commands** rather than a callback, because a closure cannot cross a Durable Object RPC boundary. Applying them is a pure function over `StoreState`, so every concurrency rule is testable in plain Node before any Durable Object exists.

**Files:**
- Create: `src/store/types.ts`, `src/store/apply.ts`
- Test: `tests/store/apply.test.ts`

**Interfaces:**
- Consumes: `PrRecord`, `NewScannedInput`, `RequestFields`, `markRequested`, `newScannedRecord`, `reopenRecord`, `resolveRecord`, `recordId` from Task 3; `applySnapshot`, `PrSnapshot` from Task 4; `applyClaim`, `applyUnclaim`, `clearStaleClaim` from Task 6; `ParsedPr` from Task 2.
- Produces:
  - `interface Meta` and `interface StoreState`
  - `type Command` (the union below) and `type CommandResult`
  - `function applyCommands(state: StoreState, commands: Command[], config: Config): { state: StoreState; results: CommandResult[] }`
  - `function emptyState(): StoreState`
  - `interface DigestPublisher` — the seam the store uses to reach Discord
  - `interface Store` — the interface Tasks 12 and 17 implement and consume

- [ ] **Step 1: Write `src/store/types.ts`**

```ts
import type { Config } from "../../config/config.js";
import type { PrSnapshot } from "../core/exit.js";
import type { NewScannedInput, PrRecord, RequestFields } from "../core/record.js";
import type { ParsedPr } from "../core/urls.js";

export interface Meta {
  lastSync: number | null;
  digestMessageId: string | null;
  digestBodyHash: string | null;
  /** Cleared by any tick that observes the digest pinned, so a second unpinning
   *  weeks later is reported like the first. */
  unpinnedReportedAt: number | null;
  /** YYYY-MM-DD in the configured timezone. Keeps the daily post to once a day. */
  lastDailyPostDate: string | null;
  /** channelId -> last fully processed message id. */
  scanCursors: Record<string, string>;
  /** Requires an atomic take, which is why it lives here and not in KV. */
  syncLease: { heldSince: number } | null;
}

export interface StoreState {
  records: Record<string, PrRecord>;
  meta: Meta;
}

export type Command =
  | { kind: "upsertScanned"; input: NewScannedInput; now: number }
  | {
      kind: "upsertRequest";
      pr: ParsedPr;
      at: number;
      fields: RequestFields;
      title: string;
      prAuthorLogin: string | null;
      isDraft: boolean;
    }
  | { kind: "applySnapshot"; id: string; snapshot: PrSnapshot; now: number }
  | { kind: "markSyncPaused"; id: string; at: number }
  | {
      kind: "claim";
      id: string;
      userId: string;
      displayName: string;
      at: number;
      /** From the menu option value. Null skips the staleness check. */
      expectLastRequestedAt: number | null;
    }
  | { kind: "unclaim"; id: string; userId: string }
  | {
      kind: "resolve";
      id: string;
      by: string;
      at: number;
      expectLastRequestedAt: number | null;
    }
  | { kind: "reopen"; id: string; at: number }
  | { kind: "clearStaleClaims"; now: number }
  | { kind: "purgeResolved"; now: number }
  | { kind: "setMeta"; patch: Partial<Meta> };

export type CommandResult =
  | { kind: "ok" }
  | { kind: "created" }
  | { kind: "updated" }
  | { kind: "skipped-resolved" }
  | { kind: "stale" }
  | { kind: "already-claimed"; byName: string }
  | { kind: "not-found" }
  | { kind: "not-open" }
  | { kind: "count"; count: number };

export type DigestPayload = {
  embeds: { color: number; description: string }[];
  components: unknown[];
};

/** The store's seam to Discord. The PATCH happens inside the store so the record,
 *  the message and the body hash are all written by the same tick. */
export interface DigestPublisher {
  listPinnedMessageIds(): Promise<string[]>;
  patchDigest(messageId: string, payload: DigestPayload): Promise<{ ok: true } | { ok: false; status: number }>;
  createDigest(payload: DigestPayload): Promise<{ ok: true; messageId: string } | { ok: false; status: number }>;
  postDaily(content: string): Promise<{ ok: true; messageId: string } | { ok: false; status: number }>;
  messageUrl(messageId: string): string;
}

/** A tick that finds a live lease younger than this exits immediately without
 *  writing. Cron gives no overlap prevention. Exported here — not derived from
 *  `config.refreshIntervalMs` — because this value tracks Cloudflare's scheduled
 *  wall-clock limit, not the tick interval; coupling them would let a future
 *  interval change silently move a platform bound. `memory.ts` and `do.ts` both
 *  import this constant so the two implementations cannot drift apart. */
export const LEASE_TIMEOUT_MS = 15 * 60_000;

export type BeginTickResult =
  | { acquired: true; state: StoreState }
  | { acquired: false; reason: "lease-held"; heldSince: number };

export interface FinishTickInput {
  commands: Command[];
  now: number;
  /** False when the GitHub sync failed. Record mutation is aborted, rendering is not. */
  syncOk: boolean;
}

export interface DigestOutcome {
  action: "patched" | "created" | "skipped-unchanged" | "failed" | "unpinned-reported";
  bodyHash: string;
  openCount: number;
  renderedCount: number;
}

export interface FinishTickResult {
  results: CommandResult[];
  digest: DigestOutcome;
  dailyPosted: boolean;
}

export interface ApplyResult {
  results: CommandResult[];
  digest: DigestOutcome | null;
}

export interface Store {
  /** Takes the lease atomically and returns a snapshot. One subrequest. */
  beginTick(now: number): Promise<BeginTickResult>;
  /**
   * Applies mutations, RE-READS, renders, PATCHes, stores the hash on success,
   * posts the daily message if due, and releases the lease. One subrequest.
   */
  finishTick(input: FinishTickInput): Promise<FinishTickResult>;
  /** The interactive path: apply atomically and optionally re-render. */
  apply(commands: Command[], opts: { now: number; rerender: boolean }): Promise<ApplyResult>;
  /** Read-only, for the health endpoint and /review-list. */
  readState(): Promise<StoreState>;
}

export type { Config };
```

- [ ] **Step 2: Write the failing tests**

`tests/store/apply.test.ts`. This runs in the `core` project — it is pure.

```ts
import { describe, expect, it } from "vitest";
import { config } from "../../config/config.js";
import { applyCommands, emptyState } from "../../src/store/apply.js";
import type { Command, StoreState } from "../../src/store/types.js";
import type { PrSnapshot } from "../../src/core/exit.js";
import { newScannedRecord, resolveRecord, type PrRecord } from "../../src/core/record.js";
import { recordId } from "../../src/core/record.js";

const T0 = 1_756_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ID = "paranext/paranext-core/2695";

function withRecord(overrides: Partial<PrRecord> = {}): StoreState {
  const base = newScannedRecord({
    pr: { owner: "paranext", repo: "paranext-core", number: 2695 },
    channelId: "chan",
    messageId: "msg",
    messageTimestamp: T0,
    title: "PT-9003",
    prAuthorLogin: "jolie",
    isDraft: false,
  });
  const record = { ...base, ...overrides };
  const state = emptyState();
  return { ...state, records: { [recordId(record)]: record } };
}

function run(state: StoreState, ...commands: Command[]) {
  return applyCommands(state, commands, config);
}

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    slug: ID,
    title: "PT-9003",
    state: "OPEN",
    merged: false,
    isDraft: false,
    authorLogin: "jolie",
    reviews: [],
    ...overrides,
  };
}

describe("upsertScanned", () => {
  const input = {
    pr: { owner: "paranext", repo: "paranext-core", number: 2695 },
    channelId: "chan",
    messageId: "msg",
    messageTimestamp: T0,
    title: "PT-9003",
    prAuthorLogin: "jolie",
    isDraft: false,
  };

  it("creates a record on first sight", () => {
    const out = run(emptyState(), { kind: "upsertScanned", input, now: T0 + HOUR });
    expect(out.results[0]).toEqual({ kind: "created" });
    expect(out.state.records[ID]?.source).toBe("scanned");
  });

  it("is idempotent — re-scanning the same PR does not duplicate or reset it", () => {
    // The second scan must carry its OWN messageTimestamp, distinct from the first — otherwise
    // `firstRequestedAt === T0` can't tell "left alone" from "recreated from this same input".
    const once = run(emptyState(), { kind: "upsertScanned", input, now: T0 + HOUR });
    const secondInput = { ...input, messageTimestamp: T0 + 2 * HOUR, messageId: "msg-2" };
    const twice = run(once.state, { kind: "upsertScanned", input: secondInput, now: T0 + 2 * HOUR });
    expect(Object.keys(twice.state.records)).toHaveLength(1);
    expect(twice.state.records[ID]?.firstRequestedAt).toBe(T0);
    expect(twice.state.records[ID]?.lastRequestedAt).toBe(T0);
  });

  it("does NOT reopen a resolved record — conversational mentions are the common case", () => {
    const resolved = withRecord({ resolvedAt: T0 + HOUR, resolvedBy: "merged" });
    const out = run(resolved, { kind: "upsertScanned", input, now: T0 + 2 * HOUR });
    expect(out.results[0]).toEqual({ kind: "skipped-resolved" });
    expect(out.state.records[ID]?.resolvedAt).toBe(T0 + HOUR);
  });

  it("leaves a commanded record's fields intact when the same PR is scanned", () => {
    const commanded = withRecord({ source: "command", team: "Power", urgency: "blocking" });
    const out = run(commanded, { kind: "upsertScanned", input, now: T0 + HOUR });
    expect(out.state.records[ID]?.team).toBe("Power");
    expect(out.state.records[ID]?.source).toBe("command");
  });
});

describe("upsertRequest", () => {
  const command: Command = {
    kind: "upsertRequest",
    pr: { owner: "paranext", repo: "paranext-core", number: 2695 },
    at: T0 + 2 * HOUR,
    fields: {
      team: "Power",
      urgency: "blocking",
      prdThreadId: "t-1",
      note: "blocks the cut",
      requesterId: "u-1",
      requesterName: "Jolie",
      channelId: "chan",
      messageId: "msg-2",
    },
    title: "PT-9003",
    prAuthorLogin: "jolie",
    isDraft: false,
  };

  it("creates a commanded record when none exists", () => {
    const out = run(emptyState(), command);
    expect(out.results[0]).toEqual({ kind: "created" });
    expect(out.state.records[ID]?.source).toBe("command");
    expect(out.state.records[ID]?.requestCount).toBe(1);
  });

  it("upgrades a scanned record in place rather than duplicating", () => {
    const out = run(withRecord(), command);
    expect(Object.keys(out.state.records)).toHaveLength(1);
    expect(out.state.records[ID]?.source).toBe("command");
    expect(out.state.records[ID]?.urgency).toBe("blocking");
  });

  it("REOPENS a resolved record — this is the headline workflow", () => {
    const resolved = withRecord({ resolvedAt: T0 + HOUR, resolvedBy: "review by Katherine" });
    const out = run(resolved, command);
    expect(out.state.records[ID]?.resolvedAt).toBeNull();
    expect(out.state.records[ID]?.resolutionHistory).toHaveLength(1);
  });

  it("clears a claim and preserves firstRequestedAt on re-request", () => {
    const claimed = withRecord({ source: "command", claimedBy: "u9", claimedByName: "Ira", claimedAt: T0 });
    const out = run(claimed, command);
    expect(out.state.records[ID]?.claimedBy).toBeNull();
    expect(out.state.records[ID]?.firstRequestedAt).toBe(T0);
    expect(out.state.records[ID]?.requestCount).toBe(2);
  });
});

describe("applySnapshot and markSyncPaused", () => {
  it("resolves a record on a qualifying review", () => {
    const out = run(withRecord(), {
      kind: "applySnapshot",
      id: ID,
      now: T0 + 5 * HOUR,
      snapshot: snapshot({
        reviews: [{ submittedAt: T0 + HOUR, state: "COMMENTED", authorLogin: "katherine", authorIsBot: false }],
      }),
    });
    expect(out.state.records[ID]?.resolvedBy).toBe("review by katherine");
  });

  it("returns not-found for an unknown id rather than throwing", () => {
    const out = run(emptyState(), { kind: "applySnapshot", id: ID, now: T0, snapshot: snapshot() });
    expect(out.results[0]).toEqual({ kind: "not-found" });
  });

  it("marks sync paused without resolving — a null is never 'gone'", () => {
    const out = run(withRecord(), { kind: "markSyncPaused", id: ID, at: T0 + HOUR });
    expect(out.state.records[ID]?.syncPausedSince).toBe(T0 + HOUR);
    expect(out.state.records[ID]?.resolvedAt).toBeNull();
  });

  it("does not overwrite an existing syncPausedSince on a later tick", () => {
    const paused = withRecord({ syncPausedSince: T0 });
    const out = run(paused, { kind: "markSyncPaused", id: ID, at: T0 + HOUR });
    expect(out.state.records[ID]?.syncPausedSince).toBe(T0);
  });
});

describe("menu revalidation", () => {
  it("refuses to overwrite a resolvedBy the tick already set", () => {
    // The tick resolved this row 60 seconds ago; the reader's client still shows it.
    // This exercises applyOne's `!isOpen(existing)` check, which runs BEFORE the
    // staleness check below — it is a different guard from the one the next test covers.
    const resolved = withRecord({ resolvedAt: T0 + HOUR, resolvedBy: "review by Katherine" });
    const out = run(resolved, {
      kind: "resolve",
      id: ID,
      by: "cleared by Jolie",
      at: T0 + 2 * HOUR,
      expectLastRequestedAt: T0,
    });
    expect(out.results[0]).toEqual({ kind: "not-open" });
    expect(out.state.records[ID]?.resolvedBy).toBe("review by Katherine");
  });

  it("rejects a resolve whose option value is stale, preserving the audit trail", () => {
    // Open and unresolved, so the `!isOpen` guard above does NOT fire — this is the only
    // test that reaches the resolve path's own staleness check.
    const rerequested = withRecord({ lastRequestedAt: T0 + 3 * HOUR });
    const out = run(rerequested, {
      kind: "resolve",
      id: ID,
      by: "cleared by Jolie",
      at: T0 + 4 * HOUR,
      expectLastRequestedAt: T0,
    });
    expect(out.results[0]).toEqual({ kind: "stale" });
    expect(out.state.records[ID]?.resolvedAt).toBeNull();
  });

  it("rejects a claim whose expected lastRequestedAt no longer matches", () => {
    const rerequested = withRecord({ lastRequestedAt: T0 + 3 * HOUR });
    const out = run(rerequested, {
      kind: "claim",
      id: ID,
      userId: "u1",
      displayName: "Katherine",
      at: T0 + 4 * HOUR,
      expectLastRequestedAt: T0,
    });
    expect(out.results[0]).toEqual({ kind: "stale" });
    expect(out.state.records[ID]?.claimedBy).toBeNull();
  });

  it("accepts a claim whose expected lastRequestedAt matches", () => {
    const out = run(withRecord(), {
      kind: "claim",
      id: ID,
      userId: "u1",
      displayName: "Katherine",
      at: T0 + HOUR,
      expectLastRequestedAt: T0,
    });
    expect(out.results[0]).toEqual({ kind: "ok" });
    expect(out.state.records[ID]?.claimedByName).toBe("Katherine");
  });

  it("skips the check when the expectation is null", () => {
    const out = run(withRecord(), {
      kind: "claim",
      id: ID,
      userId: "u1",
      displayName: "Katherine",
      at: T0 + HOUR,
      expectLastRequestedAt: null,
    });
    expect(out.results[0]).toEqual({ kind: "ok" });
  });
});

describe("claim conflicts", () => {
  it("first write wins: a second claimant is told who holds it", () => {
    const first = run(withRecord(), {
      kind: "claim", id: ID, userId: "u1", displayName: "Katherine", at: T0 + HOUR, expectLastRequestedAt: null,
    });
    const second = applyCommands(first.state, [
      { kind: "claim", id: ID, userId: "u2", displayName: "Ira", at: T0 + 2 * HOUR, expectLastRequestedAt: null },
    ], config);
    expect(second.results[0]).toEqual({ kind: "already-claimed", byName: "Katherine" });
    expect(second.state.records[ID]?.claimedBy).toBe("u1");
  });
});

describe("reopen", () => {
  it("clears resolvedAt and appends history", () => {
    const resolved = withRecord({ resolvedAt: T0 + HOUR, resolvedBy: "cleared by Jolie" });
    const out = run(resolved, { kind: "reopen", id: ID, at: T0 + 2 * HOUR });
    expect(out.state.records[ID]?.resolvedAt).toBeNull();
    expect(out.state.records[ID]?.resolutionHistory).toHaveLength(1);
  });
});

describe("clearStaleClaims", () => {
  it("clears only claims past the threshold and reports how many", () => {
    const state = emptyState();
    const stale = { ...withRecord({ claimedBy: "u1", claimedByName: "Ira", claimedAt: T0 }).records[ID]! };
    const fresh = {
      ...stale,
      number: 2696,
      claimedAt: T0 + 47 * HOUR,
    };
    const seeded: StoreState = {
      ...state,
      records: { [recordId(stale)]: stale, [recordId(fresh)]: fresh },
    };
    const out = applyCommands(seeded, [{ kind: "clearStaleClaims", now: T0 + 49 * HOUR }], config);
    expect(out.results[0]).toEqual({ kind: "count", count: 1 });
    expect(out.state.records[recordId(stale)]?.lastClaimedByName).toBe("Ira");
    expect(out.state.records[recordId(fresh)]?.claimedBy).toBe("u1");
  });
});

describe("purgeResolved", () => {
  it("purges records resolved beyond retention, capped per tick", () => {
    const records: Record<string, PrRecord> = {};
    for (let i = 0; i < 120; i += 1) {
      const r = resolveRecord(
        { ...withRecord().records[ID]!, number: 3000 + i },
        T0 - 40 * DAY,
        "merged",
      );
      records[recordId(r)] = r;
    }
    const out = applyCommands({ ...emptyState(), records }, [{ kind: "purgeResolved", now: T0 }], config);
    expect(out.results[0]).toEqual({ kind: "count", count: config.budgets.purgePerTick });
    expect(Object.keys(out.state.records)).toHaveLength(120 - config.budgets.purgePerTick);
  });

  it("never purges an open record, however old", () => {
    const ancient = withRecord({ firstRequestedAt: T0 - 400 * DAY, lastRequestedAt: T0 - 400 * DAY });
    const out = applyCommands(ancient, [{ kind: "purgeResolved", now: T0 }], config);
    expect(Object.keys(out.state.records)).toHaveLength(1);
  });

  it("never purges a record resolved inside the retention window", () => {
    const recent = withRecord({ resolvedAt: T0 - 5 * DAY, resolvedBy: "merged" });
    const out = applyCommands(recent, [{ kind: "purgeResolved", now: T0 }], config);
    expect(Object.keys(out.state.records)).toHaveLength(1);
  });
});

describe("setMeta", () => {
  it("patches only the named keys", () => {
    const out = run(emptyState(), { kind: "setMeta", patch: { lastSync: T0 } });
    expect(out.state.meta.lastSync).toBe(T0);
    expect(out.state.meta.digestMessageId).toBeNull();
  });

  it("clears unpinnedReportedAt when told to, so a later unpinning is reported again", () => {
    const reported = { ...emptyState(), meta: { ...emptyState().meta, unpinnedReportedAt: T0 } };
    const out = applyCommands(reported, [{ kind: "setMeta", patch: { unpinnedReportedAt: null } }], config);
    expect(out.state.meta.unpinnedReportedAt).toBeNull();
  });
});

describe("purity", () => {
  it("never mutates the input state", () => {
    const before = withRecord();
    const frozen = JSON.stringify(before);
    run(before, { kind: "claim", id: ID, userId: "u1", displayName: "K", at: T0, expectLastRequestedAt: null });
    expect(JSON.stringify(before)).toBe(frozen);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- --project=core tests/store/apply.test.ts`
Expected: FAIL — `Cannot find module '../../src/store/apply.js'`.

- [ ] **Step 4: Write `src/store/apply.ts`**

```ts
import type { Config } from "../../config/config.js";
import { applyClaim, applyUnclaim, clearStaleClaim } from "../core/claims.js";
import { applySnapshot } from "../core/exit.js";
import {
  isOpen,
  markRequested,
  newScannedRecord,
  recordId,
  reopenRecord,
  resolveRecord,
  type PrRecord,
} from "../core/record.js";
import { prSlug } from "../core/urls.js";
import type { Command, CommandResult, Meta, StoreState } from "./types.js";

export function emptyState(): StoreState {
  return {
    records: {},
    meta: {
      lastSync: null,
      digestMessageId: null,
      digestBodyHash: null,
      unpinnedReportedAt: null,
      lastDailyPostDate: null,
      scanCursors: {},
      syncLease: null,
    },
  };
}

function put(records: Record<string, PrRecord>, record: PrRecord): Record<string, PrRecord> {
  return { ...records, [recordId(record)]: record };
}

/** Shared revalidation for both menu-driven commands. Components persist across
 *  message edits, so an option list is only as fresh as the reader's client. */
function stale(record: PrRecord, expected: number | null): boolean {
  return expected !== null && record.lastRequestedAt !== expected;
}

function applyOne(
  state: StoreState,
  command: Command,
  config: Config,
): { state: StoreState; result: CommandResult } {
  switch (command.kind) {
    case "upsertScanned": {
      const id = prSlug(command.input.pr);
      const existing = state.records[id];
      if (existing === undefined) {
        return {
          state: { ...state, records: put(state.records, newScannedRecord(command.input)) },
          result: { kind: "created" },
        };
      }
      // A scanned link matching a resolved record is ignored rather than
      // reopening it: conversational mentions of finished PRs are the common
      // case, and resurrecting rows from chatter is how a list becomes untrusted.
      if (!isOpen(existing)) return { state, result: { kind: "skipped-resolved" } };
      return { state, result: { kind: "updated" } };
    }

    case "upsertRequest": {
      const id = prSlug(command.pr);
      const existing = state.records[id];
      const base =
        existing ??
        newScannedRecord({
          pr: command.pr,
          channelId: command.fields.channelId,
          messageId: command.fields.messageId ?? "",
          messageTimestamp: command.at,
          title: command.title,
          prAuthorLogin: command.prAuthorLogin,
          isDraft: command.isDraft,
        });

      const withMeta: PrRecord = {
        ...base,
        title: command.title,
        prAuthorLogin: command.prAuthorLogin,
        isDraft: command.isDraft,
      };

      if (existing === undefined) {
        // A brand new record has requestCount 1, not 2: newScannedRecord already
        // starts at 1 and markRequested would increment it.
        const created = markRequested(withMeta, command.at, command.fields);
        return {
          state: { ...state, records: put(state.records, { ...created, requestCount: 1 }) },
          result: { kind: "created" },
        };
      }

      return {
        state: { ...state, records: put(state.records, markRequested(withMeta, command.at, command.fields)) },
        result: { kind: "updated" },
      };
    }

    case "applySnapshot": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      return {
        state: { ...state, records: put(state.records, applySnapshot(existing, command.snapshot, command.now)) },
        result: { kind: "ok" },
      };
    }

    case "markSyncPaused": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      if (existing.syncPausedSince !== null) return { state, result: { kind: "ok" } };
      return {
        state: { ...state, records: put(state.records, { ...existing, syncPausedSince: command.at }) },
        result: { kind: "ok" },
      };
    }

    case "claim": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      if (stale(existing, command.expectLastRequestedAt)) return { state, result: { kind: "stale" } };
      const outcome = applyClaim(existing, command.userId, command.displayName, command.at);
      if (outcome.kind === "claimed") {
        return { state: { ...state, records: put(state.records, outcome.record) }, result: { kind: "ok" } };
      }
      if (outcome.kind === "already-claimed") return { state, result: outcome };
      return { state, result: { kind: "not-open" } };
    }

    case "unclaim": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      const outcome = applyUnclaim(existing, command.userId);
      if (outcome.kind === "released") {
        return { state: { ...state, records: put(state.records, outcome.record) }, result: { kind: "ok" } };
      }
      if (outcome.kind === "already-claimed") return { state, result: outcome };
      return { state, result: { kind: "not-open" } };
    }

    case "resolve": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      // A row the tick already resolved must not have its resolvedBy overwritten
      // by a manual actor — that destroys the audit trail retention provides.
      if (!isOpen(existing)) return { state, result: { kind: "not-open" } };
      if (stale(existing, command.expectLastRequestedAt)) return { state, result: { kind: "stale" } };
      return {
        state: { ...state, records: put(state.records, resolveRecord(existing, command.at, command.by)) },
        result: { kind: "ok" },
      };
    }

    case "reopen": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      return {
        state: { ...state, records: put(state.records, reopenRecord(existing, command.at)) },
        result: { kind: "ok" },
      };
    }

    case "clearStaleClaims": {
      let count = 0;
      const records: Record<string, PrRecord> = {};
      for (const [id, record] of Object.entries(state.records)) {
        const cleared = clearStaleClaim(record, command.now, config.staleClaimMs);
        if (cleared !== record) count += 1;
        records[id] = cleared;
      }
      return { state: { ...state, records }, result: { kind: "count", count } };
    }

    case "purgeResolved": {
      const expired = Object.entries(state.records)
        .filter(([, r]) => r.resolvedAt !== null && command.now - r.resolvedAt > config.retentionMs)
        .sort((a, b) => (a[1].resolvedAt ?? 0) - (b[1].resolvedAt ?? 0))
        .slice(0, config.budgets.purgePerTick)
        .map(([id]) => id);

      if (expired.length === 0) return { state, result: { kind: "count", count: 0 } };
      const records = { ...state.records };
      for (const id of expired) delete records[id];
      return { state: { ...state, records }, result: { kind: "count", count: expired.length } };
    }

    case "setMeta": {
      const meta: Meta = { ...state.meta, ...command.patch };
      return { state: { ...state, meta }, result: { kind: "ok" } };
    }
  }
}

/** Pure. Never mutates the input state — every store implementation relies on this. */
export function applyCommands(
  state: StoreState,
  commands: Command[],
  config: Config,
): { state: StoreState; results: CommandResult[] } {
  let current = state;
  const results: CommandResult[] = [];
  for (const command of commands) {
    const step = applyOne(current, command, config);
    current = step.state;
    results.push(step.result);
  }
  return { state: current, results };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- --project=core tests/store/apply.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Commit**

```bash
git add src/store/types.ts src/store/apply.ts tests/store/apply.test.ts
git commit -m "feat(store): serializable command set applied as a pure function over state"
```

---

## Task 12: The store implementations and the lost-update ordering test

Two implementations of one interface. `MemoryStore` is not a mock — it holds real state and enforces the real lease, so the concurrency tests exercise the actual ordering rules. The Durable Object is then a thin serialization layer over the same logic.

**Files:**
- Create: `src/store/memory.ts`, `src/store/do.ts`
- Test: `tests/store/memory.test.ts`, `tests/workers/do.test.ts`
- Modify: `wrangler.jsonc` (created here), `vitest.config.ts` (adds the `workers` project and collects this task's test file — see Step 2)

**Interfaces:**
- Consumes: everything from Task 11; `renderDigest` from Task 8; `renderDailyPost` from Task 9.
- Produces:
  - `class MemoryStore implements Store` — constructor `(config: Config, publisher: DigestPublisher, initial?: StoreState)`
  - `class RecordsObject extends DurableObject` — the Cloudflare implementation
  - `function makeFakePublisher(): DigestPublisher & { patches: DigestPayload[]; dailies: string[]; pins: string[] }`
  - `function commitTick(state, input, config, publisher): Promise<{ state; results; digest; dailyPosted }>` — the shared logic both implementations call

- [ ] **Step 1: Write the shared commit logic and MemoryStore**

`src/store/memory.ts`:

```ts
import type { Config } from "../../config/config.js";
import { renderDailyPost } from "../core/render/daily.js";
import { renderDigest } from "../core/render/digest.js";
import { applyCommands, emptyState } from "./apply.js";
import {
  LEASE_TIMEOUT_MS,
  type ApplyResult,
  type BeginTickResult,
  type Command,
  type CommandResult,
  type DigestOutcome,
  type DigestPublisher,
  type FinishTickInput,
  type FinishTickResult,
  type Store,
  type StoreState,
} from "./types.js";

function dateKey(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(epochMs));
}

function localHour(epochMs: number, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(new Date(epochMs)),
  );
}

/**
 * The heart of the design's concurrency rule. Mutations are applied, then state is
 * RE-READ (here, simply the post-apply state, which is the committed value), then
 * the digest is rendered from it, then the PATCH happens, and only then is the hash
 * written. A render built from the tick's opening snapshot would overwrite any
 * interactive claim or resolve that landed during the tick's network I/O.
 */
export async function commitTick(
  opening: StoreState,
  input: FinishTickInput,
  config: Config,
  publisher: DigestPublisher,
): Promise<{ state: StoreState; results: CommandResult[]; digest: DigestOutcome; dailyPosted: boolean }> {
  const applied = applyCommands(opening, input.commands, config);
  let state = applied.state;

  // Rendering happens even when the sync failed: the digest is a pure function of
  // (records, lastSync, now), so the stale banner is a rendering consequence.
  const records = Object.values(state.records);
  const render = renderDigest({ records, lastSync: state.meta.lastSync, now: input.now, config });

  const pinned = await publisher.listPinnedMessageIds();
  const messageId = state.meta.digestMessageId;
  const isPinned = messageId !== null && pinned.includes(messageId);

  let action: DigestOutcome["action"] = "skipped-unchanged";

  if (messageId === null) {
    const created = await publisher.createDigest(render);
    if (created.ok) {
      state = applyCommands(state, [
        { kind: "setMeta", patch: { digestMessageId: created.messageId, digestBodyHash: render.bodyHash } },
      ], config).state;
      action = "created";
    } else {
      action = "failed";
    }
  } else if (state.meta.digestBodyHash !== render.bodyHash) {
    const patched = await publisher.patchDigest(messageId, render);
    if (patched.ok) {
      // The hash is written ONLY on a successful PATCH. Writing it optimistically
      // would suppress the correction on every later tick.
      state = applyCommands(state, [{ kind: "setMeta", patch: { digestBodyHash: render.bodyHash } }], config).state;
      action = "patched";
    } else if (patched.status === 404) {
      const created = await publisher.createDigest(render);
      if (created.ok) {
        state = applyCommands(state, [
          { kind: "setMeta", patch: { digestMessageId: created.messageId, digestBodyHash: render.bodyHash } },
        ], config).state;
        action = "created";
      } else {
        action = "failed";
      }
    } else {
      action = "failed";
    }
  }

  // Unpinned reporting: once per unpinning, and the latch resets when pinned again.
  if (messageId !== null && !isPinned && state.meta.unpinnedReportedAt === null) {
    state = applyCommands(state, [{ kind: "setMeta", patch: { unpinnedReportedAt: input.now } }], config).state;
    action = action === "skipped-unchanged" ? "unpinned-reported" : action;
  } else if (isPinned && state.meta.unpinnedReportedAt !== null) {
    state = applyCommands(state, [{ kind: "setMeta", patch: { unpinnedReportedAt: null } }], config).state;
  }

  // The daily post: once a day, only when something is waiting.
  let dailyPosted = false;
  const today = dateKey(input.now, config.dailyPostTimeZone);
  const dueToday =
    localHour(input.now, config.dailyPostTimeZone) >= config.dailyPostHourLocal &&
    state.meta.lastDailyPostDate !== today;

  if (dueToday) {
    const url = state.meta.digestMessageId === null ? null : publisher.messageUrl(state.meta.digestMessageId);
    const content = renderDailyPost({ records: Object.values(state.records), digestMessageUrl: url, config });
    if (content !== null) {
      const posted = await publisher.postDaily(content);
      if (posted.ok) {
        state = applyCommands(state, [{ kind: "setMeta", patch: { lastDailyPostDate: today } }], config).state;
        dailyPosted = true;
      }
    } else {
      // A clear queue is silent, but the date still advances so a queue that fills
      // later today does not trigger a second post attempt every tick.
      state = applyCommands(state, [{ kind: "setMeta", patch: { lastDailyPostDate: today } }], config).state;
    }
  }

  // Release the lease last.
  state = applyCommands(state, [{ kind: "setMeta", patch: { syncLease: null } }], config).state;

  return {
    state,
    results: applied.results,
    digest: {
      action,
      bodyHash: render.bodyHash,
      openCount: render.openCount,
      renderedCount: render.renderedCount,
    },
    dailyPosted,
  };
}

export class MemoryStore implements Store {
  private state: StoreState;

  constructor(
    private readonly config: Config,
    private readonly publisher: DigestPublisher,
    initial: StoreState = emptyState(),
  ) {
    this.state = initial;
  }

  async beginTick(now: number): Promise<BeginTickResult> {
    const lease = this.state.meta.syncLease;
    if (lease !== null && now - lease.heldSince < LEASE_TIMEOUT_MS) {
      return { acquired: false, reason: "lease-held", heldSince: lease.heldSince };
    }
    this.state = applyCommands(
      this.state,
      [{ kind: "setMeta", patch: { syncLease: { heldSince: now } } }],
      this.config,
    ).state;
    return { acquired: true, state: this.state };
  }

  async finishTick(input: FinishTickInput): Promise<FinishTickResult> {
    // Deliberately reads this.state, NOT the snapshot handed out by beginTick.
    const outcome = await commitTick(this.state, input, this.config, this.publisher);
    this.state = outcome.state;
    return { results: outcome.results, digest: outcome.digest, dailyPosted: outcome.dailyPosted };
  }

  async apply(commands: Command[], opts: { now: number; rerender: boolean }): Promise<ApplyResult> {
    const applied = applyCommands(this.state, commands, this.config);
    this.state = applied.state;
    if (!opts.rerender) return { results: applied.results, digest: null };

    const render = renderDigest({
      records: Object.values(this.state.records),
      lastSync: this.state.meta.lastSync,
      now: opts.now,
      config: this.config,
    });
    const messageId = this.state.meta.digestMessageId;
    if (messageId === null) return { results: applied.results, digest: null };
    if (this.state.meta.digestBodyHash === render.bodyHash) {
      return {
        results: applied.results,
        digest: { action: "skipped-unchanged", bodyHash: render.bodyHash, openCount: render.openCount, renderedCount: render.renderedCount },
      };
    }
    const patched = await this.publisher.patchDigest(messageId, render);
    if (patched.ok) {
      this.state = applyCommands(this.state, [{ kind: "setMeta", patch: { digestBodyHash: render.bodyHash } }], this.config).state;
    }
    return {
      results: applied.results,
      digest: {
        action: patched.ok ? "patched" : "failed",
        bodyHash: render.bodyHash,
        openCount: render.openCount,
        renderedCount: render.renderedCount,
      },
    };
  }

  async readState(): Promise<StoreState> {
    return this.state;
  }
}
```

- [ ] **Step 2: Add the `workers` vitest project and collect this task's test file**

`vitest.config.ts` (from Task 1) defines only the `core` project, and that project's `include` doesn't match `tests/store/memory.test.ts` — the lost-update ordering suite the spec names explicitly would never be collected. It also has no `workers` project at all yet, so every `tests/workers/**` suite from this task through Task 19 (do, verify, rest, scan, credentials, query, scheduled, interactions, startup, reviewList, index) would be silently unreachable. Fix both in one edit:

```ts
import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          include: ["tests/core/**/*.test.ts", "tests/store/apply.test.ts", "tests/store/memory.test.ts"],
          environment: "node",
        },
      },
      defineWorkersProject({
        test: {
          name: "workers",
          include: ["tests/workers/**/*.test.ts"],
          poolOptions: {
            workers: {
              wrangler: { configPath: "./wrangler.jsonc" },
            },
          },
        },
      }),
    ],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["src/**"],
      thresholds: {
        "src/core/**": { lines: 95, branches: 95, functions: 95, statements: 95 },
      },
    },
  },
});
```

Do not restore a broad `src/**` coverage threshold here — it would overlap `src/core/**` and double-count, which is why it was removed. A narrower threshold scoped to the adapter directories (`src/discord/**`, `src/github/**`, `src/store/**`, `src/handlers/**`) can be added once those directories exist, not before.

- [ ] **Step 3: Write the lost-update ordering test**

`tests/store/memory.test.ts`. This is the test the spec names explicitly: drive it by interleaving the handler and the tick against the store, **not** by mocking the store away — the bug lives precisely in the seam a mock would remove.

```ts
import { describe, expect, it } from "vitest";
import { config } from "../../config/config.js";
import { emptyState } from "../../src/store/apply.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { DigestPayload, DigestPublisher, StoreState } from "../../src/store/types.js";
import { newScannedRecord, recordId } from "../../src/core/record.js";

const T0 = 1_788_192_000_000; // 2026-08-31T16:00:00Z = 11:00 America/Chicago
const MINUTE = 60_000;
const ID = "paranext/paranext-core/177";

function makeFakePublisher() {
  const patches: DigestPayload[] = [];
  const dailies: string[] = [];
  const pins: string[] = ["digest-1"];
  const publisher: DigestPublisher = {
    listPinnedMessageIds: async () => pins,
    patchDigest: async (_id, payload) => {
      patches.push(payload);
      return { ok: true };
    },
    createDigest: async (payload) => {
      patches.push(payload);
      return { ok: true, messageId: "digest-1" };
    },
    postDaily: async (content) => {
      dailies.push(content);
      return { ok: true, messageId: "daily-1" };
    },
    messageUrl: (id) => `https://discord.com/channels/g/c/${id}`,
  };
  return { publisher, patches, dailies, pins };
}

function seeded(): StoreState {
  const record = {
    ...newScannedRecord({
      pr: { owner: "paranext", repo: "paranext-core", number: 177 },
      channelId: "chan",
      messageId: "msg",
      messageTimestamp: T0 - 3 * 86_400_000,
      title: "PT-9001 P10 backend progress events",
      prAuthorLogin: "jolie",
      isDraft: false,
    }),
    team: "Power" as const,
    urgency: "blocking" as const,
    note: "blocks the release cut",
  };
  const base = emptyState();
  return {
    records: { [recordId(record)]: record },
    meta: { ...base.meta, digestMessageId: "digest-1", lastSync: T0 - MINUTE, lastDailyPostDate: "2026-08-31" },
  };
}

describe("the lease", () => {
  it("lets one tick in and turns the overlapping one away without writing", async () => {
    const { publisher } = makeFakePublisher();
    const store = new MemoryStore(config, publisher, seeded());

    const first = await store.beginTick(T0);
    const second = await store.beginTick(T0 + 30_000);

    expect(first.acquired).toBe(true);
    expect(second).toMatchObject({ acquired: false, reason: "lease-held" });
  });

  it("breaks a lease older than the scheduled wall-clock limit", async () => {
    const { publisher } = makeFakePublisher();
    const store = new MemoryStore(config, publisher, seeded());
    await store.beginTick(T0);
    const later = await store.beginTick(T0 + 16 * MINUTE);
    expect(later.acquired).toBe(true);
  });

  it("releases the lease at finishTick so the next tick can run", async () => {
    const { publisher } = makeFakePublisher();
    const store = new MemoryStore(config, publisher, seeded());
    await store.beginTick(T0);
    await store.finishTick({ commands: [], now: T0 + 20_000, syncOk: true });
    expect(await store.beginTick(T0 + 40_000)).toMatchObject({ acquired: true });
  });
});

describe("lost-update ordering", () => {
  it("a claim committed mid-tick survives the tick's write", async () => {
    // 10:05:00 tick reads. 10:05:02 Katherine claims. 10:05:20 tick PATCHes.
    // The claim must still be there, and the PATCHed body must show it.
    const { publisher, patches } = makeFakePublisher();
    const store = new MemoryStore(config, publisher, seeded());

    const opening = await store.beginTick(T0);
    expect(opening.acquired).toBe(true);

    await store.apply(
      [{ kind: "claim", id: ID, userId: "u1", displayName: "Katherine", at: T0 + 2_000, expectLastRequestedAt: null }],
      { now: T0 + 2_000, rerender: true },
    );

    await store.finishTick({ commands: [], now: T0 + 20_000, syncOk: true });

    const state = await store.readState();
    expect(state.records[ID]?.claimedByName).toBe("Katherine");

    const lastBody = patches.at(-1)!.embeds.map((e) => e.description).join("\n");
    expect(lastBody).toContain("Being reviewed");
    expect(lastBody).toContain("Katherine");
  });

  it("a resolve committed mid-tick is not undone by the tick", async () => {
    const { publisher } = makeFakePublisher();
    const store = new MemoryStore(config, publisher, seeded());
    await store.beginTick(T0);
    await store.apply(
      [{ kind: "resolve", id: ID, by: "cleared by Jolie", at: T0 + 2_000, expectLastRequestedAt: null }],
      { now: T0 + 2_000, rerender: false },
    );
    await store.finishTick({ commands: [], now: T0 + 20_000, syncOk: true });
    expect((await store.readState()).records[ID]?.resolvedBy).toBe("cleared by Jolie");
  });
});

describe("the write-skip", () => {
  it("does not PATCH when the body is unchanged", async () => {
    const { publisher, patches } = makeFakePublisher();
    const store = new MemoryStore(config, publisher, seeded());

    await store.beginTick(T0);
    await store.finishTick({ commands: [], now: T0 + 10_000, syncOk: true });
    const afterFirst = patches.length;

    await store.beginTick(T0 + 5 * MINUTE);
    await store.finishTick({ commands: [], now: T0 + 5 * MINUTE + 10_000, syncOk: true });

    expect(patches.length).toBe(afterFirst);
  });

  it("does not write the hash when the PATCH fails, so the correction is not suppressed", async () => {
    const { publisher } = makeFakePublisher();
    const failing: DigestPublisher = { ...publisher, patchDigest: async () => ({ ok: false, status: 500 }) };
    const base = seeded();
    // Seed a known, deliberately-wrong hash so we can prove it survives the failed PATCH —
    // comparing against seeded()'s null hash can't distinguish "left alone" from "erased".
    const store = new MemoryStore(config, failing, {
      ...base,
      meta: { ...base.meta, digestBodyHash: "deadbeef" },
    });

    await store.beginTick(T0);
    const first = await store.finishTick({ commands: [], now: T0 + 10_000, syncOk: true });
    // The PATCH failed (not a 404), so the action reported is "failed", not "patched" —
    // attempting a PATCH is not the same as it having succeeded.
    expect(first.digest.action).toBe("failed");
    const stored = (await store.readState()).meta.digestBodyHash;
    expect(stored).toBe("deadbeef");
  });
});

describe("rendering when the sync failed", () => {
  it("still renders, and the stale banner appears", async () => {
    const { publisher, patches } = makeFakePublisher();
    const state = seeded();
    const store = new MemoryStore(config, publisher, {
      ...state,
      meta: { ...state.meta, lastSync: T0 - 47 * MINUTE },
    });

    await store.beginTick(T0);
    const result = await store.finishTick({ commands: [], now: T0 + 10_000, syncOk: false });

    expect(result.digest.action).toBe("patched");
    expect(patches.at(-1)!.embeds[0]!.description).toContain("Not syncing");
    expect(result.digest.renderedCount).toBe(1);
  });
});

describe("the unpinned latch", () => {
  it("reports once and resets when the digest is pinned again", async () => {
    const { publisher, pins } = makeFakePublisher();
    const store = new MemoryStore(config, publisher, seeded());

    pins.length = 0; // someone unpinned it
    await store.beginTick(T0);
    await store.finishTick({ commands: [], now: T0 + 10_000, syncOk: true });
    const first = (await store.readState()).meta.unpinnedReportedAt;
    expect(first).not.toBeNull();

    await store.beginTick(T0 + 5 * MINUTE);
    await store.finishTick({ commands: [], now: T0 + 5 * MINUTE + 10_000, syncOk: true });
    expect((await store.readState()).meta.unpinnedReportedAt).toBe(first);

    pins.push("digest-1"); // re-pinned
    await store.beginTick(T0 + 10 * MINUTE);
    await store.finishTick({ commands: [], now: T0 + 10 * MINUTE + 10_000, syncOk: true });
    expect((await store.readState()).meta.unpinnedReportedAt).toBeNull();
  });
});

describe("the daily post", () => {
  it("posts once when rows are open and the hour has passed", async () => {
    const { publisher, dailies } = makeFakePublisher();
    const state = seeded();
    const store = new MemoryStore(config, publisher, {
      ...state,
      meta: { ...state.meta, lastDailyPostDate: null },
    });

    await store.beginTick(T0);
    const result = await store.finishTick({ commands: [], now: T0 + 10_000, syncOk: true });
    expect(result.dailyPosted).toBe(true);
    expect(dailies).toHaveLength(1);
    expect(dailies[0]).toContain("1 PR waiting");

    await store.beginTick(T0 + 5 * MINUTE);
    const second = await store.finishTick({ commands: [], now: T0 + 5 * MINUTE, syncOk: true });
    expect(second.dailyPosted).toBe(false);
    expect(dailies).toHaveLength(1);
  });

  it("posts nothing when the queue is clear, and does not retry every tick", async () => {
    const { publisher, dailies } = makeFakePublisher();
    const base = emptyState();
    const store = new MemoryStore(config, publisher, {
      records: {},
      meta: { ...base.meta, digestMessageId: "digest-1", lastSync: T0 - MINUTE, lastDailyPostDate: null },
    });

    await store.beginTick(T0);
    await store.finishTick({ commands: [], now: T0, syncOk: true });
    expect(dailies).toHaveLength(0);
    expect((await store.readState()).meta.lastDailyPostDate).toBe("2026-08-31");
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail, then pass**

Run: `npm test -- --project=core tests/store/memory.test.ts`
Expected: FAIL first (missing module), then PASS once Step 1's file is in place. If "a claim committed mid-tick survives the tick's write" fails, `finishTick` is reading the `beginTick` snapshot instead of `this.state` — that is exactly the lost-update bug.

- [ ] **Step 5: Write `wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "pr-review-bot",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "triggers": { "crons": ["*/5 * * * *"] },
  "durable_objects": {
    "bindings": [{ "name": "RECORDS", "class_name": "RecordsObject" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RecordsObject"] }],
  "kv_namespaces": [{ "binding": "META", "id": "REPLACE_WITH_KV_NAMESPACE_ID" }]
}
```

The KV namespace holds only genuinely independent values — the PRD cache (plan 2) and nothing this plan writes on every tick. `syncLease` and `digestBodyHash` live in the Durable Object: the lease needs an atomic take that KV cannot provide, and a take-and-release KV write every tick would be ~576 writes a day that the write-skip cannot elide.

- [ ] **Step 6: Write `src/store/do.ts`**

```ts
import { DurableObject } from "cloudflare:workers";
import { config as defaultConfig } from "../../config/config.js";
import { renderDigest } from "../core/render/digest.js";
import { applyCommands, emptyState } from "./apply.js";
import { commitTick } from "./memory.js";
import {
  LEASE_TIMEOUT_MS,
  type ApplyResult,
  type BeginTickResult,
  type Command,
  type Config,
  type DigestPublisher,
  type FinishTickInput,
  type FinishTickResult,
  type StoreState,
} from "./types.js";

const STATE_KEY = "state";

export interface RecordsObjectEnv {
  DISCORD_BOT_TOKEN: string;
  DISCORD_GUILD_ID: string;
}

/**
 * All record state in one serialized object. Reads and writes below use
 * DO-internal `ctx.storage`, which does NOT count against the invoking worker's
 * subrequest ceiling — which is what holds the "at most two store subrequests per
 * tick" invariant regardless of record count.
 */
export class RecordsObject extends DurableObject<RecordsObjectEnv> {
  private config: Config = defaultConfig;
  private publisherFactory: ((env: RecordsObjectEnv, config: Config) => DigestPublisher) | null = null;

  /** Injected by src/index.ts at module load so this file has no Discord import. */
  setPublisherFactory(factory: (env: RecordsObjectEnv, config: Config) => DigestPublisher): void {
    this.publisherFactory = factory;
  }

  private publisher(): DigestPublisher {
    if (this.publisherFactory === null) throw new Error("publisher factory not configured");
    return this.publisherFactory(this.env, this.config);
  }

  private async load(): Promise<StoreState> {
    return (await this.ctx.storage.get<StoreState>(STATE_KEY)) ?? emptyState();
  }

  private async save(state: StoreState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }

  async beginTick(now: number): Promise<BeginTickResult> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.load();
      const lease = state.meta.syncLease;
      if (lease !== null && now - lease.heldSince < LEASE_TIMEOUT_MS) {
        return { acquired: false as const, reason: "lease-held" as const, heldSince: lease.heldSince };
      }
      const taken = applyCommands(state, [{ kind: "setMeta", patch: { syncLease: { heldSince: now } } }], this.config).state;
      await this.save(taken);
      return { acquired: true as const, state: taken };
    });
  }

  async finishTick(input: FinishTickInput): Promise<FinishTickResult> {
    // NOT wrapped in blockConcurrencyWhile: this does outbound Discord I/O, and
    // blocking the object for the duration would serialise interactive handlers
    // behind a network call. The re-read below is what makes it safe.
    const opening = await this.load();
    const outcome = await commitTick(opening, input, this.config, this.publisher());
    await this.save(outcome.state);
    return { results: outcome.results, digest: outcome.digest, dailyPosted: outcome.dailyPosted };
  }

  async apply(commands: Command[], opts: { now: number; rerender: boolean }): Promise<ApplyResult> {
    const applied = await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.load();
      const next = applyCommands(state, commands, this.config);
      await this.save(next.state);
      return next;
    });

    if (!opts.rerender) return { results: applied.results, digest: null };

    const state = await this.load();
    const render = renderDigest({
      records: Object.values(state.records),
      lastSync: state.meta.lastSync,
      now: opts.now,
      config: this.config,
    });
    const messageId = state.meta.digestMessageId;
    if (messageId === null || state.meta.digestBodyHash === render.bodyHash) {
      return { results: applied.results, digest: null };
    }
    const patched = await this.publisher().patchDigest(messageId, render);
    if (patched.ok) {
      await this.ctx.blockConcurrencyWhile(async () => {
        const fresh = await this.load();
        await this.save(applyCommands(fresh, [{ kind: "setMeta", patch: { digestBodyHash: render.bodyHash } }], this.config).state);
      });
    }
    return {
      results: applied.results,
      digest: {
        action: patched.ok ? "patched" : "failed",
        bodyHash: render.bodyHash,
        openCount: render.openCount,
        renderedCount: render.renderedCount,
      },
    };
  }

  async readState(): Promise<StoreState> {
    return this.load();
  }
}
```

- [ ] **Step 7: Write the Durable Object test**

`tests/workers/do.test.ts`. This runs in the Workers pool and proves the object serializes what `MemoryStore` serializes.

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { config } from "../../config/config.js";
import { emptyState } from "../../src/store/apply.js";
import { newScannedRecord, recordId } from "../../src/core/record.js";
import type { DigestPayload, DigestPublisher } from "../../src/store/types.js";

const T0 = 1_788_192_000_000; // 2026-08-31T16:00:00Z = 11:00 America/Chicago
const ID = "paranext/paranext-core/177";

function fakePublisher(patches: DigestPayload[]): DigestPublisher {
  return {
    listPinnedMessageIds: async () => ["digest-1"],
    patchDigest: async (_id, payload) => {
      patches.push(payload);
      return { ok: true };
    },
    createDigest: async (payload) => {
      patches.push(payload);
      return { ok: true, messageId: "digest-1" };
    },
    postDaily: async () => ({ ok: true, messageId: "daily-1" }),
    messageUrl: (id) => `https://discord.com/channels/g/c/${id}`,
  };
}

describe("RecordsObject", () => {
  it("persists state across separate stub calls", async () => {
    const id = env.RECORDS.idFromName("test-persist");
    const stub = env.RECORDS.get(id);

    const record = newScannedRecord({
      pr: { owner: "paranext", repo: "paranext-core", number: 177 },
      channelId: "chan",
      messageId: "msg",
      messageTimestamp: T0,
      title: "PT-9001",
      prAuthorLogin: "jolie",
      isDraft: false,
    });

    await stub.apply(
      [{ kind: "upsertScanned", input: {
          pr: { owner: "paranext", repo: "paranext-core", number: 177 },
          channelId: "chan", messageId: "msg", messageTimestamp: T0,
          title: "PT-9001", prAuthorLogin: "jolie", isDraft: false,
        }, now: T0 }],
      { now: T0, rerender: false },
    );

    const state = await stub.readState();
    expect(Object.keys(state.records)).toEqual([recordId(record)]);
  });

  it("refuses a second overlapping beginTick", async () => {
    const id = env.RECORDS.idFromName("test-lease");
    const stub = env.RECORDS.get(id);
    expect(await stub.beginTick(T0)).toMatchObject({ acquired: true });
    expect(await stub.beginTick(T0 + 30_000)).toMatchObject({ acquired: false });
  });

  it("breaks a lease older than LEASE_TIMEOUT_MS, same as MemoryStore", async () => {
    // do.ts and memory.ts both import LEASE_TIMEOUT_MS from types.ts. This pins the
    // Durable Object side of that shared constant so the two cannot silently drift —
    // a mismatch here would break a live lease mid-tick and let the loop overlap.
    const id = env.RECORDS.idFromName("test-lease-break");
    const stub = env.RECORDS.get(id);
    expect(await stub.beginTick(T0)).toMatchObject({ acquired: true });
    expect(await stub.beginTick(T0 + 16 * 60_000)).toMatchObject({ acquired: true });
  });

  it("keeps a mid-tick claim through finishTick", async () => {
    const patches: DigestPayload[] = [];
    const id = env.RECORDS.idFromName("test-ordering");
    const stub = env.RECORDS.get(id);

    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { setPublisherFactory: (f: unknown) => void }).setPublisherFactory(
        () => fakePublisher(patches),
      );
    });

    await stub.apply(
      [{ kind: "upsertRequest",
         pr: { owner: "paranext", repo: "paranext-core", number: 177 },
         at: T0 - 86_400_000,
         fields: { team: "Power", urgency: "blocking", prdThreadId: null, note: "blocks the cut", requesterId: "u0", requesterName: "Jolie", channelId: "chan", messageId: "msg" },
         title: "PT-9001", prAuthorLogin: "jolie", isDraft: false }],
      { now: T0, rerender: false },
    );
    await stub.apply([{ kind: "setMeta", patch: { digestMessageId: "digest-1", lastSync: T0, lastDailyPostDate: "2026-08-31" } }], { now: T0, rerender: false });

    await stub.beginTick(T0);
    await stub.apply(
      [{ kind: "claim", id: ID, userId: "u1", displayName: "Katherine", at: T0 + 2_000, expectLastRequestedAt: null }],
      { now: T0 + 2_000, rerender: false },
    );
    await stub.finishTick({ commands: [], now: T0 + 20_000, syncOk: true });

    const state = await stub.readState();
    expect(state.records[ID]?.claimedByName).toBe("Katherine");
    expect(patches.at(-1)!.embeds.map((e) => e.description).join("\n")).toContain("Katherine");
  });
});
```

- [ ] **Step 8: Run the Workers-pool tests**

Run: `npm test -- --project=workers`
Expected: PASS. If the pool cannot start, check that `wrangler.jsonc` parses and that `migrations` names `RecordsObject` under `new_sqlite_classes`.

- [ ] **Step 9: Commit**

```bash
git add src/store/memory.ts src/store/do.ts wrangler.jsonc vitest.config.ts tests/store/memory.test.ts tests/workers/do.test.ts
git commit -m "feat(store): memory and Durable Object stores with lease, write-skip and mid-tick claim safety"
```

---

## Task 13: Discord signature verification and the REST adapter

**Files:**
- Create: `src/discord/verify.ts`, `src/discord/rest.ts`
- Test: `tests/workers/verify.test.ts`, `tests/workers/rest.test.ts`

**Interfaces:**
- Consumes: `DigestPublisher`, `DigestPayload` from Task 11.
- Produces:
  - `function verifyDiscordRequest(rawBody: string, signature: string | null, timestamp: string | null, publicKeyHex: string): Promise<boolean>`
  - `class DiscordRest` — constructor `(token: string)`, methods below
  - `function makeDigestPublisher(rest: DiscordRest, guildId: string, config: Config): DigestPublisher`
  - `DiscordRest` methods: `getMessages`, `patchMessage`, `postMessage`, `getPins`, `getApplication`

Two API details that must be right, both from the spec:

- **Pinning moved.** Effective 12 January 2026, pins live at `GET /channels/{id}/messages/pins` (listing) and `PUT /channels/{id}/messages/pins/{message.id}` (pinning). The older `GET /channels/{id}/pins` is deprecated, so the unpinned check **must** use the new route.
- **The bot never pins.** `PIN_MESSAGES` is deliberately not requested; the digest is pinned once by hand and thereafter only edited.

- [ ] **Step 1: Write `src/discord/verify.ts`**

```ts
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Ed25519 over `timestamp + rawBody`, verified before anything else happens.
 * Discord sends unsigned probes at the endpoint and expects a 401.
 */
export async function verifyDiscordRequest(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  publicKeyHex: string,
): Promise<boolean> {
  if (signature === null || timestamp === null) return false;
  if (!/^[0-9a-f]+$/i.test(signature) || signature.length !== 128) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + rawBody),
    );
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Write the failing verification test**

`tests/workers/verify.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { verifyDiscordRequest } from "../../src/discord/verify.js";

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signed(body: string, timestamp: string) {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    pair.privateKey,
    new TextEncoder().encode(timestamp + body),
  );
  return { publicKeyHex: toHex(raw), signatureHex: toHex(signature) };
}

describe("verifyDiscordRequest", () => {
  const body = '{"type":1}';
  const timestamp = "1756000000";

  it("accepts a correctly signed request", async () => {
    const { publicKeyHex, signatureHex } = await signed(body, timestamp);
    expect(await verifyDiscordRequest(body, signatureHex, timestamp, publicKeyHex)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const { publicKeyHex, signatureHex } = await signed(body, timestamp);
    expect(await verifyDiscordRequest('{"type":2}', signatureHex, timestamp, publicKeyHex)).toBe(false);
  });

  it("rejects a replayed signature against a different timestamp", async () => {
    const { publicKeyHex, signatureHex } = await signed(body, timestamp);
    expect(await verifyDiscordRequest(body, signatureHex, "1756000001", publicKeyHex)).toBe(false);
  });

  it("rejects missing headers rather than throwing", async () => {
    const { publicKeyHex } = await signed(body, timestamp);
    expect(await verifyDiscordRequest(body, null, timestamp, publicKeyHex)).toBe(false);
    expect(await verifyDiscordRequest(body, "ab".repeat(64), null, publicKeyHex)).toBe(false);
  });

  it("rejects a malformed signature without throwing", async () => {
    const { publicKeyHex } = await signed(body, timestamp);
    expect(await verifyDiscordRequest(body, "not-hex", timestamp, publicKeyHex)).toBe(false);
    expect(await verifyDiscordRequest(body, "abcd", timestamp, publicKeyHex)).toBe(false);
  });

  it("rejects a malformed signature via the hex/length guard, never reaching crypto.subtle", async () => {
    // Without this guard, "not-hex" and "abcd" would still return false, but via
    // hexToBytes throwing (caught by the outer try/catch) or a genuine failed verify —
    // both indistinguishable from the guard actually running. Spy on importKey to prove
    // the guard, not the catch-all, is what rejects these inputs.
    const { publicKeyHex } = await signed(body, timestamp);
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    await verifyDiscordRequest(body, "abcd", timestamp, publicKeyHex);
    expect(importKey).not.toHaveBeenCalled();
    importKey.mockRestore();
  });
});
```

- [ ] **Step 3: Write `src/discord/rest.ts`**

```ts
import type { Config } from "../../config/config.js";
import type { DigestPayload, DigestPublisher } from "../store/types.js";

const API = "https://discord.com/api/v10";

export interface DiscordMessage {
  id: string;
  content: string;
  timestamp: string;
  author: { id: string; bot?: boolean; username: string };
}

export interface DiscordApplication {
  id: string;
  flags: number;
}

/**
 * GATEWAY_MESSAGE_CONTENT and GATEWAY_MESSAGE_CONTENT_LIMITED — application flags,
 * NOT the (differently-numbered) gateway intents bitfield. These bit positions are
 * knowledge-based, not confirmed by a documentation lookup; `rest.test.ts` pins
 * them to raw literals so a wrong value is visible and checkable rather than
 * silently green, and Task 20's runbook adds a live-data verification step
 * (`GET /applications/@me` against the real application).
 */
export const FLAG_MESSAGE_CONTENT = 1 << 18;
export const FLAG_MESSAGE_CONTENT_LIMITED = 1 << 19;

export type RestResult<T> = { ok: true; value: T } | { ok: false; status: number; body: string };

export class DiscordRest {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<RestResult<T>> {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "pr-review-bot (https://github.com/paranext, 1.0)",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      return { ok: false, status: response.status, body: await response.text() };
    }
    if (response.status === 204) return { ok: true, value: undefined as T };
    return { ok: true, value: (await response.json()) as T };
  }

  /**
   * One page, newest-first with no cursor; ascending after `after`; descending
   * (older) before `before`. `before` is what a first-run backward walk needs —
   * see Task 14 — since `after=<newest id>` has no messages newer than it to find.
   * Caps at 100.
   */
  getMessages(
    channelId: string,
    opts: { after?: string; before?: string; limit?: number },
  ): Promise<RestResult<DiscordMessage[]>> {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 100) });
    if (opts.after !== undefined) params.set("after", opts.after);
    if (opts.before !== undefined) params.set("before", opts.before);
    return this.call<DiscordMessage[]>("GET", `/channels/${channelId}/messages?${params.toString()}`);
  }

  patchMessage(channelId: string, messageId: string, payload: DigestPayload): Promise<RestResult<DiscordMessage>> {
    return this.call<DiscordMessage>("PATCH", `/channels/${channelId}/messages/${messageId}`, payload);
  }

  postMessage(channelId: string, payload: DigestPayload | { content: string }): Promise<RestResult<DiscordMessage>> {
    return this.call<DiscordMessage>("POST", `/channels/${channelId}/messages`, payload);
  }

  /**
   * The 2026 pins route. `GET /channels/{id}/pins` is deprecated and returns a
   * different shape, so using it would silently report the digest as unpinned
   * forever.
   */
  getPins(channelId: string): Promise<RestResult<{ items: { message: DiscordMessage }[] }>> {
    return this.call<{ items: { message: DiscordMessage }[] }>("GET", `/channels/${channelId}/messages/pins`);
  }

  getApplication(): Promise<RestResult<DiscordApplication>> {
    return this.call<DiscordApplication>("GET", "/applications/@me");
  }
}

export function makeDigestPublisher(
  rest: DiscordRest,
  guildId: string,
  config: Config,
): DigestPublisher {
  const channelId = config.digestChannelId;
  return {
    async listPinnedMessageIds() {
      const result = await rest.getPins(channelId);
      if (!result.ok) return [];
      return result.value.items.map((item) => item.message.id);
    },
    async patchDigest(messageId, payload) {
      const result = await rest.patchMessage(channelId, messageId, payload);
      return result.ok ? { ok: true } : { ok: false, status: result.status };
    },
    async createDigest(payload) {
      const result = await rest.postMessage(channelId, payload);
      return result.ok ? { ok: true, messageId: result.value.id } : { ok: false, status: result.status };
    },
    async postDaily(content) {
      const result = await rest.postMessage(channelId, { content });
      return result.ok ? { ok: true, messageId: result.value.id } : { ok: false, status: result.status };
    },
    messageUrl(messageId) {
      return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
    },
  };
}
```

- [ ] **Step 4: Write the REST adapter test**

`tests/workers/rest.test.ts`. Adapters are exercised against a stubbed `fetch`, asserting **request shape** rather than live behavior.

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../../config/config.js";
import {
  DiscordRest,
  FLAG_MESSAGE_CONTENT,
  FLAG_MESSAGE_CONTENT_LIMITED,
  makeDigestPublisher,
} from "../../src/discord/rest.js";

interface Call { url: string; method: string; body: unknown; headers: Record<string, string> }

function stubFetch(responses: { status: number; json?: unknown }[]) {
  const calls: Call[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(response.json === undefined ? null : JSON.stringify(response.json), {
      status: response.status,
    });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("intent flags", () => {
  // Checked against Discord's documented values, not against themselves — the startup
  // intent assertion (Task 19) ANDs a fixture flag against these same constants, so a
  // self-consistent fixture there could not have caught either bit being wrong.
  it("pins the application flag bits to their documented values", () => {
    expect(FLAG_MESSAGE_CONTENT).toBe(262144);
    expect(FLAG_MESSAGE_CONTENT_LIMITED).toBe(524288);
  });
});

describe("DiscordRest", () => {
  it("sends the bot token and a User-Agent on every call", async () => {
    const calls = stubFetch([{ status: 200, json: [] }]);
    await new DiscordRest("tok").getMessages("chan", {});
    expect(calls[0]!.headers.Authorization).toBe("Bot tok");
    expect(calls[0]!.headers["User-Agent"]).toContain("pr-review-bot");
  });

  it("requests messages with limit 100 and an after cursor", async () => {
    const calls = stubFetch([{ status: 200, json: [] }]);
    await new DiscordRest("tok").getMessages("chan", { after: "9" });
    expect(calls[0]!.url).toContain("/channels/chan/messages?");
    expect(calls[0]!.url).toContain("limit=100");
    expect(calls[0]!.url).toContain("after=9");
  });

  it("lists pins from the 2026 route, not the deprecated one", async () => {
    const calls = stubFetch([{ status: 200, json: { items: [] } }]);
    await new DiscordRest("tok").getPins("chan");
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/channels/chan/messages/pins");
  });

  it("returns a typed failure rather than throwing on a non-2xx", async () => {
    stubFetch([{ status: 403, json: { message: "Missing Access" } }]);
    const result = await new DiscordRest("tok").getMessages("chan", {});
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("handles a 204 with no body", async () => {
    stubFetch([{ status: 204 }]);
    const result = await new DiscordRest("tok").patchMessage("chan", "m", { embeds: [], components: [] });
    expect(result.ok).toBe(true);
  });
});

describe("makeDigestPublisher", () => {
  const payload = { embeds: [{ color: 1, description: "x" }], components: [] };

  it("PATCHes the digest channel and reports success", async () => {
    const calls = stubFetch([{ status: 200, json: { id: "m1" } }]);
    const publisher = makeDigestPublisher(new DiscordRest("tok"), "guild", config);
    expect(await publisher.patchDigest("m1", payload)).toEqual({ ok: true });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.body).toEqual(payload);
  });

  it("surfaces a 404 so commitTick can recreate the message", async () => {
    stubFetch([{ status: 404, json: { message: "Unknown Message" } }]);
    const publisher = makeDigestPublisher(new DiscordRest("tok"), "guild", config);
    expect(await publisher.patchDigest("m1", payload)).toEqual({ ok: false, status: 404 });
  });

  it("posts the daily message as plain content, not an embed", async () => {
    const calls = stubFetch([{ status: 200, json: { id: "m2" } }]);
    const publisher = makeDigestPublisher(new DiscordRest("tok"), "guild", config);
    await publisher.postDaily("3 PRs waiting");
    expect(calls[0]!.body).toEqual({ content: "3 PRs waiting" });
  });

  it("returns an empty pin list when the pins call fails, so a 403 does not crash the tick", async () => {
    stubFetch([{ status: 403, json: {} }]);
    const publisher = makeDigestPublisher(new DiscordRest("tok"), "guild", config);
    expect(await publisher.listPinnedMessageIds()).toEqual([]);
  });

  it("builds a jump link the daily post can use", () => {
    const publisher = makeDigestPublisher(new DiscordRest("tok"), "guild-1", config);
    expect(publisher.messageUrl("m1")).toBe(
      `https://discord.com/channels/guild-1/${config.digestChannelId}/m1`,
    );
  });
});
```

- [ ] **Step 5: Run both test files**

Run: `npm test -- --project=workers tests/workers/verify.test.ts tests/workers/rest.test.ts`
Expected: PASS. The Ed25519 tests need the Workers runtime — Node 24 supports Ed25519 in Web Crypto, but running them in the pool proves the deployed runtime does.

- [ ] **Step 6: Commit**

```bash
git add src/discord/verify.ts src/discord/rest.ts tests/workers/verify.test.ts tests/workers/rest.test.ts
git commit -m "feat(discord): Ed25519 verification and REST adapter using the 2026 pins route"
```

---

## Task 14: Paginated message scanning

Scanning is what makes shadow-mode rollout possible and what keeps the list complete afterwards when someone posts a link by hand out of habit.

**Files:**
- Create: `src/discord/scan.ts`
- Test: `tests/workers/scan.test.ts`

**Interfaces:**
- Consumes: `DiscordRest`, `DiscordMessage` from Task 13; `extractPrUrls`, `isAllowlisted`, `prSlug` from Task 2; `Command` from Task 11.
- Produces:
  - `interface ScanOutcome { commands: Command[]; cursors: Record<string, string>; pagesRead: number; hitPageCap: boolean }`
  - `function scanChannels(rest: DiscordRest, config: Config, cursors: Record<string, string>, botUserId: string, now: number): Promise<ScanOutcome>`

Known limits, accepted rather than solved (all three are in the spec):
- Messages inside threads are not returned by `GET /channels/{id}/messages`, so a link in a thread is not picked up.
- A message edited to add a link after the cursor passed it is not picked up.
- The cursor advances only after records are durably written, so a tick that dies mid-run re-scans. Re-scanning is safe because identity is `owner/repo/number`.

- [ ] **Step 1: Write the failing tests**

`tests/workers/scan.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { config as baseConfig } from "../../config/config.js";
import { DiscordRest, type DiscordMessage } from "../../src/discord/rest.js";
import { scanChannels } from "../../src/discord/scan.js";

const T0 = 1_788_192_000_000; // 2026-08-31T16:00:00Z = 11:00 America/Chicago
const CHANNEL = baseConfig.digestChannelId;
const config = { ...baseConfig, allowedChannelIds: [CHANNEL], digestChannelId: CHANNEL };

function message(id: string, content: string, opts: { authorId?: string; bot?: boolean; ageMs?: number } = {}): DiscordMessage {
  return {
    id,
    content,
    timestamp: new Date(T0 - (opts.ageMs ?? 3_600_000)).toISOString(),
    author: { id: opts.authorId ?? "human-1", bot: opts.bot ?? false, username: "jolie" },
  };
}

function stubPages(pages: DiscordMessage[][]) {
  const urls: string[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (input: string) => {
    urls.push(String(input));
    const page = pages[index] ?? [];
    index += 1;
    return new Response(JSON.stringify(page), { status: 200 });
  });
  return urls;
}

/**
 * Keys each response off the `before`/`after` query parameter rather than call
 * order, so a test can actually assert which direction the scan paged in — a
 * call-order stub would accept either direction silently.
 */
function stubPagesByQuery(byParam: Record<string, DiscordMessage[]>) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: string) => {
    urls.push(String(input));
    const url = new URL(String(input));
    const key = url.searchParams.has("before")
      ? `before=${url.searchParams.get("before")}`
      : url.searchParams.has("after")
        ? `after=${url.searchParams.get("after")}`
        : "initial";
    return new Response(JSON.stringify(byParam[key] ?? []), { status: 200 });
  });
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

const PR = "https://github.com/paranext/paranext-core/pull/2695";
const OTHER = "https://github.com/paranext/example-extension/pull/177";

describe("scanChannels", () => {
  it("emits an upsertScanned command per allowlisted link", async () => {
    stubPages([[message("10", `please review ${PR}`)]]);
    const outcome = await scanChannels(new DiscordRest("tok"), config, {}, "bot-1", T0);
    expect(outcome.commands).toHaveLength(1);
    expect(outcome.commands[0]).toMatchObject({ kind: "upsertScanned" });
  });

  it("seeds messageTimestamp from the MESSAGE, not the scan time", async () => {
    const sixDaysAgo = 6 * 86_400_000;
    stubPages([[message("10", PR, { ageMs: sixDaysAgo })]]);
    const outcome = await scanChannels(new DiscordRest("tok"), config, {}, "bot-1", T0);
    const command = outcome.commands[0];
    if (command?.kind !== "upsertScanned") throw new Error("unreachable");
    expect(command.input.messageTimestamp).toBe(T0 - sixDaysAgo);
    expect(command.input.messageTimestamp).not.toBe(T0);
  });

  it("skips repos not on the allowlist", async () => {
    stubPages([[message("10", "https://github.com/paranext/some-experiment/pull/1")]]);
    const outcome = await scanChannels(new DiscordRest("tok"), config, {}, "bot-1", T0);
    expect(outcome.commands).toHaveLength(0);
  });

  it("skips the bot's own messages to avoid double-counting its request posts", async () => {
    stubPages([[message("10", PR, { authorId: "bot-1", bot: true })]]);
    const outcome = await scanChannels(new DiscordRest("tok"), config, {}, "bot-1", T0);
    expect(outcome.commands).toHaveLength(0);
  });

  it("finds two links in one message", async () => {
    stubPages([[message("10", `these two need eyes: ${PR} ${OTHER}`)]]);
    const outcome = await scanChannels(new DiscordRest("tok"), config, {}, "bot-1", T0);
    expect(outcome.commands).toHaveLength(2);
  });

  it("pages until a short page arrives", async () => {
    // GET with no cursor returns the NEWEST 100 messages, so a first run pages OLDER
    // with before=<oldest id so far> — paging forward with after=<newest id> would
    // ask for messages newer than the newest, of which there are none.
    const newest = Array.from({ length: 100 }, (_, i) => message(String(300 + i), "no links"));
    const older = [message("299", PR)];
    const urls = stubPagesByQuery({
      initial: newest,
      "before=300": older,
    });
    const outcome = await scanChannels(new DiscordRest("tok"), config, {}, "bot-1", T0);
    expect(outcome.pagesRead).toBe(2);
    expect(outcome.commands).toHaveLength(1);
    expect(urls[1]).toContain("before=300");
  });

  it("stops at the page cap and advances the cursor to the newest fully processed message", async () => {
    // Ten 100-message groups, oldest-to-newest by index. A first run walks
    // backwards starting from the newest group (index 9).
    const groups = Array.from({ length: 10 }, (_, g) =>
      Array.from({ length: 100 }, (_, i) => message(String(g * 100 + i + 1), "no links")),
    );
    stubPagesByQuery({
      initial: groups[9]!,
      "before=901": groups[8]!,
      "before=801": groups[7]!,
    });
    const capped = { ...config, budgets: { ...config.budgets, scanPagesPerTick: 3 } };
    const outcome = await scanChannels(new DiscordRest("tok"), capped, {}, "bot-1", T0);
    expect(outcome.pagesRead).toBe(3);
    expect(outcome.hitPageCap).toBe(true);
    // "1000" is the NEWEST id seen (from the first, most-recent group), not the
    // oldest — the cursor lets the NEXT tick page forward with after=<cursor>.
    expect(outcome.cursors[CHANNEL]).toBe("1000");
  });

  it("returns no cursor change when a channel has no new messages", async () => {
    stubPages([[]]);
    const outcome = await scanChannels(new DiscordRest("tok"), config, { [CHANNEL]: "500" }, "bot-1", T0);
    expect(outcome.cursors).toEqual({});
  });

  it("limits the first run to the lookback window rather than the whole history", async () => {
    const inside = message("10", PR, { ageMs: 3 * 86_400_000 });
    const outside = message("9", OTHER, { ageMs: 30 * 86_400_000 });
    stubPages([[outside, inside]]);
    const outcome = await scanChannels(new DiscordRest("tok"), config, {}, "bot-1", T0);
    expect(outcome.commands).toHaveLength(1);
    const command = outcome.commands[0];
    if (command?.kind !== "upsertScanned") throw new Error("unreachable");
    expect(command.input.pr.number).toBe(2695);
  });

  it("does not apply the lookback once a cursor exists", async () => {
    const old = message("600", PR, { ageMs: 30 * 86_400_000 });
    stubPages([[old]]);
    const outcome = await scanChannels(new DiscordRest("tok"), config, { [CHANNEL]: "500" }, "bot-1", T0);
    expect(outcome.commands).toHaveLength(1);
  });

  it("leaves the cursor untouched for a channel whose fetch failed", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    const outcome = await scanChannels(new DiscordRest("tok"), config, { [CHANNEL]: "500" }, "bot-1", T0);
    expect(outcome.cursors).toEqual({});
    expect(outcome.commands).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=workers tests/workers/scan.test.ts`
Expected: FAIL — `Cannot find module '../../src/discord/scan.js'`.

- [ ] **Step 3: Write the implementation**

`src/discord/scan.ts`:

```ts
import type { Config } from "../../config/config.js";
import { extractPrUrls, isAllowlisted } from "../core/urls.js";
import type { Command } from "../store/types.js";
import type { DiscordMessage, DiscordRest } from "./rest.js";

export interface ScanOutcome {
  commands: Command[];
  /** Only channels whose pages were fully processed appear here. */
  cursors: Record<string, string>;
  pagesRead: number;
  hitPageCap: boolean;
}

const PAGE_SIZE = 100;

function toCommands(
  messages: DiscordMessage[],
  channelId: string,
  botUserId: string,
  config: Config,
  now: number,
): Command[] {
  const commands: Command[] = [];
  for (const message of messages) {
    // The bot's own request messages would double-count their own PRs.
    if (message.author.id === botUserId) continue;

    for (const pr of extractPrUrls(message.content)) {
      if (!isAllowlisted(pr, config.repoAllowlist)) continue;
      commands.push({
        kind: "upsertScanned",
        now,
        input: {
          pr,
          channelId,
          messageId: message.id,
          // The MESSAGE's timestamp, not the scan time. This is what lets a
          // scanned record ever satisfy the exit condition: a record whose
          // review already happened is born resolved.
          messageTimestamp: Date.parse(message.timestamp),
          title: `${pr.repo}#${pr.number}`,
          prAuthorLogin: null,
          isDraft: false,
        },
      });
    }
  }
  return commands;
}

async function scanOne(
  rest: DiscordRest,
  config: Config,
  channelId: string,
  cursor: string | undefined,
  botUserId: string,
  now: number,
  pageBudget: number,
): Promise<{ commands: Command[]; cursor: string | null; pagesRead: number; hitCap: boolean }> {
  const lookbackFrom = now - config.scanLookbackMs;

  if (cursor === undefined) {
    // First run, no stored cursor. `GET /channels/{id}/messages` with no query
    // returns the NEWEST 100 messages. Paging FORWARD from there with
    // after=<newest id> would ask for messages newer than the newest — there are
    // none — so the only way to reach the configured lookback window on a first
    // run is to walk BACKWARDS with before=<oldest id seen so far>, stopping once
    // a message predates `now - scanLookbackMs` or the page cap is hit.
    const commands: Command[] = [];
    let before: string | undefined;
    let newestOfFirstPage: string | null = null;
    let pagesRead = 0;
    let hitCap = false;

    while (pagesRead < pageBudget) {
      const page = await rest.getMessages(channelId, before === undefined ? {} : { before });
      if (!page.ok) {
        // Leave the cursor alone: a tick that dies mid-run re-scans rather than
        // skipping, and re-scanning is safe because identity is owner/repo/number.
        return { commands: [], cursor: null, pagesRead, hitCap: false };
      }
      pagesRead += 1;

      const messages: DiscordMessage[] = page.value;
      if (messages.length === 0) break;

      // Ascending by id.
      const ordered = [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      if (newestOfFirstPage === null) newestOfFirstPage = ordered.at(-1)!.id;

      const inWindow = ordered.filter((m) => Date.parse(m.timestamp) >= lookbackFrom);
      commands.push(...toCommands(inWindow, channelId, botUserId, config, now));

      const hitLookbackEdge = inWindow.length < ordered.length;
      before = ordered[0]!.id;

      if (hitLookbackEdge) break;
      if (messages.length < PAGE_SIZE) break;
      if (pagesRead >= pageBudget) {
        hitCap = true;
        break;
      }
    }

    // The cursor advances to the newest message seen — the FIRST page fetched,
    // since a backward walk starts at "now" — so the next tick can page FORWARD
    // with after=<cursor> instead of repeating this backward walk.
    return { commands, cursor: newestOfFirstPage, pagesRead, hitCap };
  }

  // A cursor exists: page FORWARD with after=<cursor>, which is what the
  // endpoint actually supports for "give me what's new since I last looked".
  const commands: Command[] = [];
  let after: string | undefined = cursor;
  let newestProcessed: string | null = null;
  let pagesRead = 0;
  let hitCap = false;

  while (pagesRead < pageBudget) {
    const page = await rest.getMessages(channelId, { after });
    if (!page.ok) {
      return { commands: [], cursor: null, pagesRead, hitCap: false };
    }
    pagesRead += 1;

    const messages: DiscordMessage[] = page.value;
    if (messages.length === 0) break;

    const ordered = [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    newestProcessed = ordered.at(-1)!.id;
    after = newestProcessed;
    commands.push(...toCommands(ordered, channelId, botUserId, config, now));

    if (messages.length < PAGE_SIZE) break;
    if (pagesRead >= pageBudget) {
      hitCap = true;
      break;
    }
  }

  return { commands, cursor: newestProcessed, pagesRead, hitCap };
}

export async function scanChannels(
  rest: DiscordRest,
  config: Config,
  cursors: Record<string, string>,
  botUserId: string,
  now: number,
): Promise<ScanOutcome> {
  const commands: Command[] = [];
  const nextCursors: Record<string, string> = {};
  let pagesRead = 0;
  let hitPageCap = false;

  for (const channelId of config.allowedChannelIds) {
    const remaining = config.budgets.scanPagesPerTick - pagesRead;
    if (remaining <= 0) {
      hitPageCap = true;
      break;
    }
    const outcome = await scanOne(rest, config, channelId, cursors[channelId], botUserId, now, remaining);
    commands.push(...outcome.commands);
    pagesRead += outcome.pagesRead;
    if (outcome.hitCap) hitPageCap = true;
    if (outcome.cursor !== null) nextCursors[channelId] = outcome.cursor;
  }

  return { commands, cursors: nextCursors, pagesRead, hitPageCap };
}
```

Note the title placeholder: a scanned record's real title arrives from GitHub on the next sync. Rendering `paranext-core#2695` until then is honest and costs no extra call.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --project=workers tests/workers/scan.test.ts`
Expected: PASS, all cases — in particular "seeds messageTimestamp from the MESSAGE, not the scan time".

- [ ] **Step 5: Commit**

```bash
git add src/discord/scan.ts tests/workers/scan.test.ts
git commit -m "feat(discord): paginated channel scan seeding records from message timestamps"
```

---

## Task 15: GitHub credentials — App token minting and owner routing

Two credentials, routed by owner. Private repos exist only in `paranext`, where an App can be installed; everything else the team reviews is public, so a read-only token covers other orgs with no admin approval there.

**Files:**
- Create: `src/github/credentials.ts`
- Test: `tests/workers/credentials.test.ts`

**Interfaces:**
- Produces:
  - `type CredentialGroup = "app" | "public"`
  - `function routeOwner(owner: string): CredentialGroup`
  - `interface CredentialState { token: string | null; expiresAt: number | null; failedClosed: boolean; failureReason: string | null }`
  - `class CredentialProvider` — constructor `(secrets: GithubSecrets)`, methods `tokenFor(group, now)`, `reportStatus(group, status)`, `health(now)`
  - `interface GithubSecrets { appId: string; appInstallationId: string; appPrivateKeyPem: string; publicToken: string }`
  - `function signAppJwt(appId: string, privateKeyPem: string, now: number): Promise<string>`

**Installation tokens expire hourly.** Minting them (a locally signed RS256 JWT plus `POST /app/installations/{id}/access_tokens`) is a recurring cost against the tick's subrequest budget, not a startup step — one extra subrequest at most once an hour, cached between ticks.

- [ ] **Step 1: Write the failing tests**

`tests/workers/credentials.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialProvider, routeOwner, signAppJwt } from "../../src/github/credentials.js";

const T0 = 1_788_192_000_000; // 2026-08-31T16:00:00Z = 11:00 America/Chicago
const HOUR = 3_600_000;

// A throwaway 2048-bit RSA key generated for tests only. Never a real credential.
const TEST_PEM_PLACEHOLDER = "GENERATE_IN_STEP_2";

const secrets = {
  appId: "12345",
  appInstallationId: "67890",
  appPrivateKeyPem: TEST_PEM_PLACEHOLDER,
  publicToken: "ghp_public",
};

function stubFetch(responses: { status: number; json?: unknown }[]) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    calls.push({ url: String(input), method: init.method ?? "GET", headers: init.headers as Record<string, string> });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(response.json === undefined ? null : JSON.stringify(response.json), { status: response.status });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("routeOwner", () => {
  it("routes paranext to the App installation", () => {
    expect(routeOwner("paranext")).toBe("app");
    expect(routeOwner("Paranext")).toBe("app");
  });

  it("routes every other owner to the public token", () => {
    expect(routeOwner("eten-tech-foundation")).toBe("public");
  });
});

describe("signAppJwt", () => {
  it("produces three base64url segments with RS256 and the app id as issuer", async () => {
    const jwt = await signAppJwt("12345", secrets.appPrivateKeyPem, T0);
    const [header, payload, signature] = jwt.split(".");
    expect(signature).toBeTruthy();
    const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    expect(decode(header!).alg).toBe("RS256");
    expect(decode(payload!).iss).toBe("12345");
  });

  it("backdates iat by 60 seconds to tolerate clock skew, and expires within 10 minutes", async () => {
    const jwt = await signAppJwt("12345", secrets.appPrivateKeyPem, T0);
    const payload = JSON.parse(atob(jwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    const nowSeconds = Math.floor(T0 / 1000);
    expect(payload.iat).toBe(nowSeconds - 60);
    // Pinned to the exact value, not just an upper bound: `<=` alone is satisfied by
    // any already-expired JWT (exp === iat, or even 0), and GitHub's 401 on an expired
    // JWT is what trips the fail-closed latch below — this is the one direction with
    // a large blast radius.
    expect(payload.exp).toBe(nowSeconds + 540);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
  });
});

describe("CredentialProvider", () => {
  it("returns the public token without any network call", async () => {
    const calls = stubFetch([]);
    const provider = new CredentialProvider(secrets);
    expect(await provider.tokenFor("public", T0)).toEqual({ ok: true, token: "ghp_public" });
    expect(calls).toHaveLength(0);
  });

  it("mints an installation token on first use", async () => {
    const calls = stubFetch([
      { status: 201, json: { token: "ghs_installation", expires_at: new Date(T0 + HOUR).toISOString() } },
    ]);
    const provider = new CredentialProvider(secrets);
    expect(await provider.tokenFor("app", T0)).toEqual({ ok: true, token: "ghs_installation" });
    expect(calls[0]!.url).toBe("https://api.github.com/app/installations/67890/access_tokens");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.Authorization).toMatch(/^Bearer ey/);
  });

  it("caches the installation token until it nears expiry", async () => {
    const calls = stubFetch([
      { status: 201, json: { token: "ghs_a", expires_at: new Date(T0 + HOUR).toISOString() } },
      { status: 201, json: { token: "ghs_b", expires_at: new Date(T0 + 2 * HOUR).toISOString() } },
    ]);
    const provider = new CredentialProvider(secrets);
    await provider.tokenFor("app", T0);
    expect(await provider.tokenFor("app", T0 + 30 * 60_000)).toEqual({ ok: true, token: "ghs_a" });
    expect(calls).toHaveLength(1);
  });

  it("re-mints inside the 5-minute expiry margin", async () => {
    const calls = stubFetch([
      { status: 201, json: { token: "ghs_a", expires_at: new Date(T0 + HOUR).toISOString() } },
      { status: 201, json: { token: "ghs_b", expires_at: new Date(T0 + 2 * HOUR).toISOString() } },
    ]);
    const provider = new CredentialProvider(secrets);
    await provider.tokenFor("app", T0);
    expect(await provider.tokenFor("app", T0 + HOUR - 60_000)).toEqual({ ok: true, token: "ghs_b" });
    expect(calls).toHaveLength(2);
  });

  it("FAILS CLOSED on a 401 and stops retrying", async () => {
    // 10,000 invalid responses in 10 minutes risks a temporary IP ban, so an
    // expired-credential bug must not retry hot every five minutes.
    const calls = stubFetch([{ status: 401, json: { message: "Bad credentials" } }]);
    const provider = new CredentialProvider(secrets);
    const first = await provider.tokenFor("app", T0);
    expect(first).toMatchObject({ ok: false, failedClosed: true });

    const second = await provider.tokenFor("app", T0 + 5 * 60_000);
    expect(second).toMatchObject({ ok: false, failedClosed: true });
    expect(calls).toHaveLength(1);
  });

  it("distinguishes a transient 500 from a 401 and retries it", async () => {
    const calls = stubFetch([
      { status: 500, json: {} },
      { status: 201, json: { token: "ghs_a", expires_at: new Date(T0 + HOUR).toISOString() } },
    ]);
    const provider = new CredentialProvider(secrets);
    expect(await provider.tokenFor("app", T0)).toMatchObject({ ok: false, failedClosed: false });
    expect(await provider.tokenFor("app", T0 + 5 * 60_000)).toEqual({ ok: true, token: "ghs_a" });
    expect(calls).toHaveLength(2);
  });

  it("fails the public credential closed on a reported 401", async () => {
    const provider = new CredentialProvider(secrets);
    provider.reportStatus("public", 401);
    expect(await provider.tokenFor("public", T0)).toMatchObject({ ok: false, failedClosed: true });
  });

  it("reports health per credential — token expiry for the App, not a key age", async () => {
    // health() has no private-key-age field: key creation time isn't derivable from
    // a PEM, and reporting it would mean inventing a new secret. It reports
    // tokenExpiresInMs instead; the gap this leaves (a rotated-late key is caught by
    // a human, not this endpoint) is recorded as a runbook line in Task 20.
    const provider = new CredentialProvider(secrets);
    expect(provider.health(T0).app.tokenExpiresInMs).toBeNull();

    stubFetch([{ status: 201, json: { token: "ghs_a", expires_at: new Date(T0 + HOUR).toISOString() } }]);
    await provider.tokenFor("app", T0);
    const health = provider.health(T0);
    expect(health.app).toMatchObject({ failedClosed: false, installationId: "67890", tokenExpiresInMs: HOUR });
    expect(health.public).toMatchObject({ failedClosed: false });
  });
});
```

- [ ] **Step 2: Generate the test key and paste it into the test file**

Run:

```bash
node -e '
const { generateKeyPairSync } = require("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.stdout.write(JSON.stringify(privateKey.export({ type: "pkcs8", format: "pem" })));
'
```

Replace `TEST_PEM_PLACEHOLDER` in the test file with the printed string literal. This key exists only in the test file and is not a credential — say so in a comment beside it, so a future reader does not treat it as a leak.

- [ ] **Step 3: Write the implementation**

`src/github/credentials.ts`:

```ts
export type CredentialGroup = "app" | "public";

export interface GithubSecrets {
  appId: string;
  appInstallationId: string;
  appPrivateKeyPem: string;
  publicToken: string;
}

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; failedClosed: boolean; reason: string };

interface GroupState {
  token: string | null;
  expiresAt: number | null;
  failedClosed: boolean;
  failureReason: string | null;
}

const EXPIRY_MARGIN_MS = 5 * 60_000;
const API = "https://api.github.com";

/** Private repos exist only in paranext, where an App can be installed. */
export function routeOwner(owner: string): CredentialGroup {
  return owner.toLowerCase() === "paranext" ? "app" : "public";
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** RS256 is RSASSA-PKCS1-v1_5 with SHA-256, which Web Crypto provides directly —
 *  no JWT library, and therefore no runtime dependency. */
export async function signAppJwt(appId: string, privateKeyPem: string, now: number): Promise<string> {
  const seconds = Math.floor(now / 1000);
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(
    new TextEncoder().encode(
      // iat is backdated 60s: GitHub rejects a JWT whose iat is in the future,
      // and Workers clocks are not guaranteed to match GitHub's to the second.
      JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

export class CredentialProvider {
  private readonly state: Record<CredentialGroup, GroupState> = {
    app: { token: null, expiresAt: null, failedClosed: false, failureReason: null },
    public: { token: null, expiresAt: null, failedClosed: false, failureReason: null },
  };

  constructor(private readonly secrets: GithubSecrets) {}

  async tokenFor(group: CredentialGroup, now: number): Promise<TokenResult> {
    const state = this.state[group];
    if (state.failedClosed) {
      return { ok: false, failedClosed: true, reason: state.failureReason ?? "failed closed" };
    }

    if (group === "public") return { ok: true, token: this.secrets.publicToken };

    if (state.token !== null && state.expiresAt !== null && now < state.expiresAt - EXPIRY_MARGIN_MS) {
      return { ok: true, token: state.token };
    }

    const jwt = await signAppJwt(this.secrets.appId, this.secrets.appPrivateKeyPem, now);
    const response = await fetch(`${API}/app/installations/${this.secrets.appInstallationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "pr-review-bot",
      },
    });

    if (response.status === 401 || response.status === 403 || response.status === 404) {
      // Not transient: a bad key, a revoked install, or a wrong installation id.
      // Fail closed rather than retry hot every five minutes.
      state.failedClosed = true;
      state.failureReason = `installation token mint returned ${response.status}`;
      return { ok: false, failedClosed: true, reason: state.failureReason };
    }
    if (!response.ok) {
      return { ok: false, failedClosed: false, reason: `installation token mint returned ${response.status}` };
    }

    const body = (await response.json()) as { token: string; expires_at: string };
    state.token = body.token;
    state.expiresAt = Date.parse(body.expires_at);
    return { ok: true, token: body.token };
  }

  /** Called by the query adapter when a request comes back 401/403. */
  reportStatus(group: CredentialGroup, status: number): void {
    if (status === 401 || status === 403) {
      const state = this.state[group];
      state.failedClosed = true;
      state.failureReason = `GitHub returned ${status}`;
      state.token = null;
    }
  }

  health(now: number): {
    app: { failedClosed: boolean; reason: string | null; installationId: string; tokenExpiresInMs: number | null };
    public: { failedClosed: boolean; reason: string | null };
  } {
    const app = this.state.app;
    return {
      app: {
        failedClosed: app.failedClosed,
        reason: app.failureReason,
        installationId: this.secrets.appInstallationId,
        tokenExpiresInMs: app.expiresAt === null ? null : app.expiresAt - now,
      },
      public: { failedClosed: this.state.public.failedClosed, reason: this.state.public.failureReason },
    };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --project=workers tests/workers/credentials.test.ts`
Expected: PASS. If `signAppJwt` throws on import, the PEM in the test file is not PKCS#8 — GitHub issues PKCS#1 (`BEGIN RSA PRIVATE KEY`) and Web Crypto needs PKCS#8. Convert it once at setup time and record the command in `docs/setup.md` at Task 21:

```bash
openssl pkcs8 -topk8 -nocrypt -in github-app.private-key.pem -out github-app.pkcs8.pem
```

- [ ] **Step 5: Commit**

```bash
git add src/github/credentials.ts tests/workers/credentials.test.ts
git commit -m "feat(github): App JWT minting, owner routing and fail-closed credential state"
```

---

## Task 16: The batched GraphQL query

**Files:**
- Create: `src/github/query.ts`
- Test: `tests/workers/query.test.ts`
- Create: `fixtures/responses/github-batch.json`, `fixtures/responses/github-partial-error.json`

**Interfaces:**
- Consumes: `CredentialProvider`, `routeOwner` from Task 15; `PrSnapshot`, `ReviewEvent` from Task 4.
- Produces:
  - `interface FetchOutcome { snapshots: Map<string, PrSnapshot>; notFound: string[]; failedGroups: CredentialGroup[]; subrequests: number }`
  - `function fetchSnapshots(provider: CredentialProvider, slugs: string[], now: number): Promise<FetchOutcome>`
  - `function buildQuery(prs: { alias: string; owner: string; repo: string; number: number }[]): string`

Three rules from the spec, each with a test:
- **Chunk to 25 PRs per query.** Requests running longer than 10 seconds are terminated by GitHub with a 502/504.
- **Read the `errors` array even on HTTP 200.** A batch containing one inaccessible PR returns partial data plus a `NOT_FOUND` error for that alias. Map that alias to `sync paused` — never to "resolved", and never treat the whole response as failed.
- **Never request `reviewDecision`.**

- [ ] **Step 1: Write the failing tests**

`tests/workers/query.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialProvider } from "../../src/github/credentials.js";
import { buildQuery, fetchSnapshots } from "../../src/github/query.js";

const T0 = 1_788_192_000_000; // 2026-08-31T16:00:00Z = 11:00 America/Chicago
const HOUR = 3_600_000;

// A throwaway 2048-bit RSA key generated for tests only — see Step 2. Not a
// credential. Real (not a placeholder string) because the "groups by credential"
// test below actually mints an App JWT, and an unparseable PEM throws before the
// test can assert anything about the request it's meant to check.
const TEST_PEM_PLACEHOLDER = "GENERATE_IN_STEP_2";

const secrets = {
  appId: "1",
  appInstallationId: "2",
  appPrivateKeyPem: TEST_PEM_PLACEHOLDER,
  publicToken: "ghp_public",
};

// buildQuery aliases each PR as `p0: repository(...) { pullRequest(number: N) { ... } }`,
// so a real response nests the PR node one level deeper than the alias — the
// implementation reads `body.data?.[alias]?.pullRequest`. Every fixture below must
// carry that wrapper, or every one of these tests would land every slug in
// `notFound` against a real server, however green they are against each other.
function prNode(number: number, overrides: Record<string, unknown> = {}) {
  return {
    pullRequest: {
      number,
      title: `PT-${number}`,
      isDraft: false,
      merged: false,
      state: "OPEN",
      author: { login: "jolie" },
      reviews: { nodes: [] },
      ...overrides,
    },
  };
}

/**
 * Routes by URL, exactly like Task 17's `stubAll`: an App-credential mint
 * (`/access_tokens`) is itself a `fetch` that a call-count-only stub would
 * misroute — the mint request has no JSON body, so treating it as a GraphQL call
 * would blow up `JSON.parse`. Only `/graphql` calls are pushed into `requests`.
 */
function stubGraphql(bodies: unknown[]) {
  const requests: { query: string }[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const url = String(input);
    if (url.includes("/access_tokens")) {
      return new Response(
        JSON.stringify({ token: "ghs_x", expires_at: new Date(T0 + HOUR).toISOString() }),
        { status: 201 },
      );
    }
    requests.push(JSON.parse(String(init.body)) as { query: string });
    const body = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe("buildQuery", () => {
  const prs = [{ alias: "p0", owner: "eten-tech-foundation", repo: "scripture-editors", number: 341 }];

  it("requests reviews with submittedAt, state and a Bot-aware author", () => {
    const query = buildQuery(prs);
    expect(query).toContain("reviews(last: 20)");
    expect(query).toContain("submittedAt");
    expect(query).toContain("__typename");
  });

  it("NEVER requests reviewDecision", () => {
    expect(buildQuery(prs)).not.toContain("reviewDecision");
  });

  it("aliases each PR so a partial error can be mapped back to one record", () => {
    expect(buildQuery(prs)).toContain("p0:");
  });
});

describe("fetchSnapshots", () => {
  const provider = () => new CredentialProvider(secrets);

  it("returns a snapshot per requested slug", async () => {
    stubGraphql([{ data: { p0: prNode(341) } }]);
    const outcome = await fetchSnapshots(provider(), ["eten-tech-foundation/scripture-editors/341"], T0);
    expect(outcome.snapshots.get("eten-tech-foundation/scripture-editors/341")).toMatchObject({
      title: "PT-341",
      state: "OPEN",
      authorLogin: "jolie",
    });
  });

  it("chunks to 25 PRs per query", async () => {
    const slugs = Array.from({ length: 60 }, (_, i) => `eten-tech-foundation/scripture-editors/${i + 1}`);
    const data = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, prNode(i + 1)]));
    const requests = stubGraphql([{ data }, { data }, { data }]);
    const outcome = await fetchSnapshots(provider(), slugs, T0);
    expect(requests).toHaveLength(3);
    expect(outcome.subrequests).toBe(3);
  });

  it("maps a NOT_FOUND alias to notFound and leaves every other record alone", async () => {
    stubGraphql([
      {
        data: { p0: prNode(341), p1: null },
        errors: [{ type: "NOT_FOUND", path: ["p1"], message: "Could not resolve to a PullRequest" }],
      },
    ]);
    const outcome = await fetchSnapshots(
      provider(),
      ["eten-tech-foundation/scripture-editors/341", "eten-tech-foundation/scripture-editors/999"],
      T0,
    );
    expect(outcome.notFound).toEqual(["eten-tech-foundation/scripture-editors/999"]);
    expect(outcome.snapshots.has("eten-tech-foundation/scripture-editors/341")).toBe(true);
    expect(outcome.snapshots.has("eten-tech-foundation/scripture-editors/999")).toBe(false);
  });

  it("parses reviews, flagging bot authors by __typename", async () => {
    stubGraphql([
      {
        data: {
          p0: prNode(341, {
            reviews: {
              nodes: [
                { submittedAt: "2026-08-30T10:00:00Z", state: "COMMENTED", author: { login: "copilot", __typename: "Bot" } },
                { submittedAt: "2026-08-30T11:00:00Z", state: "APPROVED", author: { login: "katherine", __typename: "User" } },
                { submittedAt: null, state: "PENDING", author: { login: "ira", __typename: "User" } },
              ],
            },
          }),
        },
      },
    ]);
    const outcome = await fetchSnapshots(provider(), ["eten-tech-foundation/scripture-editors/341"], T0);
    const reviews = outcome.snapshots.get("eten-tech-foundation/scripture-editors/341")!.reviews;
    expect(reviews[0]).toMatchObject({ authorIsBot: true });
    expect(reviews[1]).toMatchObject({ authorIsBot: false, authorLogin: "katherine" });
    expect(reviews[2]).toMatchObject({ submittedAt: null });
  });

  it("derives MERGED state from the merged flag, not from GitHub's own state field", async () => {
    // GitHub's raw state says CLOSED here — an implementation that passed raw.state
    // straight through, ignoring `merged`, would also produce a plausible-looking
    // result if the fixture's state field already said "MERGED".
    stubGraphql([{ data: { p0: prNode(341, { merged: true, state: "CLOSED" }) } }]);
    const outcome = await fetchSnapshots(provider(), ["eten-tech-foundation/scripture-editors/341"], T0);
    expect(outcome.snapshots.get("eten-tech-foundation/scripture-editors/341")).toMatchObject({
      merged: true,
      state: "MERGED",
    });
  });

  it("keeps CLOSED state when merged is false", async () => {
    stubGraphql([{ data: { p0: prNode(341, { merged: false, state: "CLOSED" }) } }]);
    const outcome = await fetchSnapshots(provider(), ["eten-tech-foundation/scripture-editors/341"], T0);
    expect(outcome.snapshots.get("eten-tech-foundation/scripture-editors/341")).toMatchObject({
      merged: false,
      state: "CLOSED",
    });
  });

  it("groups by credential, so paranext and other owners are separate queries", async () => {
    // paranext routes to "app", which mints a JWT and hits /access_tokens BEFORE
    // it can query — that mint is a real fetch too, and must not be counted as
    // one of the two graphql requests this test exists to prove.
    const requests = stubGraphql([{ data: { p0: prNode(1) } }, { data: { p0: prNode(2) } }]);
    await fetchSnapshots(provider(), ["paranext/paranext-core/1", "eten-tech-foundation/scripture-editors/2"], T0);
    expect(requests).toHaveLength(2);
  });

  it("records a failed group on a 401 rather than throwing, and fails it closed", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }));
    const shared = provider();
    const outcome = await fetchSnapshots(shared, ["eten-tech-foundation/scripture-editors/341"], T0);
    expect(outcome.failedGroups).toEqual(["public"]);
    expect(outcome.snapshots.size).toBe(0);
    expect(await shared.tokenFor("public", T0)).toMatchObject({ ok: false, failedClosed: true });
  });

  it("does no work and no subrequests for an empty slug list", async () => {
    const requests = stubGraphql([]);
    const outcome = await fetchSnapshots(provider(), [], T0);
    expect(requests).toHaveLength(0);
    expect(outcome.subrequests).toBe(0);
  });
});
```

- [ ] **Step 2: Generate the test key and paste it into the test file**

Same throwaway key as Task 15 — a fresh one is fine, this file does not share state with `tests/workers/credentials.test.ts`. Run:

```bash
node -e '
const { generateKeyPairSync } = require("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.stdout.write(JSON.stringify(privateKey.export({ type: "pkcs8", format: "pem" })));
'
```

Replace `TEST_PEM_PLACEHOLDER` in the test file with the printed string literal.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- --project=workers tests/workers/query.test.ts`
Expected: FAIL — `Cannot find module '../../src/github/query.js'`.

- [ ] **Step 4: Write the implementation**

`src/github/query.ts`:

```ts
import type { PrSnapshot, ReviewEvent } from "../core/exit.js";
import { routeOwner, type CredentialGroup, type CredentialProvider } from "./credentials.js";

const GRAPHQL = "https://api.github.com/graphql";
/** Requests running longer than 10 seconds are terminated by GitHub with a 502/504. */
const CHUNK_SIZE = 25;

interface Target {
  alias: string;
  slug: string;
  owner: string;
  repo: string;
  number: number;
}

export interface FetchOutcome {
  snapshots: Map<string, PrSnapshot>;
  /** Aliases GitHub could not resolve. Map these to `sync paused`, never resolved. */
  notFound: string[];
  failedGroups: CredentialGroup[];
  subrequests: number;
}

export function buildQuery(prs: { alias: string; owner: string; repo: string; number: number }[]): string {
  const parts = prs.map(
    (pr) => `  ${pr.alias}: repository(owner: ${JSON.stringify(pr.owner)}, name: ${JSON.stringify(pr.repo)}) {
    pullRequest(number: ${pr.number}) {
      number
      title
      isDraft
      merged
      state
      author { login }
      reviews(last: 20) {
        nodes {
          submittedAt
          state
          author { login __typename }
        }
      }
    }
  }`,
  );
  // No reviewDecision: it is null on unprotected branches, never resets after a
  // push, and ignores comment-only reviews. Requesting it at all is a defect.
  return `query {\n${parts.join("\n")}\n}`;
}

interface RawReview {
  submittedAt: string | null;
  state: string;
  author: { login: string; __typename?: string } | null;
}

interface RawPr {
  number: number;
  title: string;
  isDraft: boolean;
  merged: boolean;
  state: string;
  author: { login: string } | null;
  reviews: { nodes: RawReview[] } | null;
}

function toReview(raw: RawReview): ReviewEvent {
  return {
    submittedAt: raw.submittedAt === null ? null : Date.parse(raw.submittedAt),
    state: raw.state,
    authorLogin: raw.author?.login ?? null,
    authorIsBot: raw.author?.__typename === "Bot",
  };
}

function toSnapshot(slug: string, raw: RawPr): PrSnapshot {
  return {
    slug,
    title: raw.title,
    state: raw.merged ? "MERGED" : raw.state === "CLOSED" ? "CLOSED" : "OPEN",
    merged: raw.merged,
    isDraft: raw.isDraft,
    authorLogin: raw.author?.login ?? null,
    reviews: (raw.reviews?.nodes ?? []).map(toReview),
  };
}

function parseSlug(slug: string, index: number): Target | null {
  const [owner, repo, numberRaw] = slug.split("/");
  if (owner === undefined || repo === undefined || numberRaw === undefined) return null;
  const number = Number(numberRaw);
  if (!Number.isInteger(number)) return null;
  return { alias: `p${index}`, slug, owner, repo, number };
}

export async function fetchSnapshots(
  provider: CredentialProvider,
  slugs: string[],
  now: number,
): Promise<FetchOutcome> {
  const snapshots = new Map<string, PrSnapshot>();
  const notFound: string[] = [];
  const failedGroups: CredentialGroup[] = [];
  let subrequests = 0;

  const byGroup = new Map<CredentialGroup, string[]>();
  for (const slug of slugs) {
    const owner = slug.split("/")[0] ?? "";
    const group = routeOwner(owner);
    byGroup.set(group, [...(byGroup.get(group) ?? []), slug]);
  }

  for (const [group, groupSlugs] of byGroup) {
    const token = await provider.tokenFor(group, now);
    if (!token.ok) {
      failedGroups.push(group);
      continue;
    }

    for (let offset = 0; offset < groupSlugs.length; offset += CHUNK_SIZE) {
      const chunk = groupSlugs.slice(offset, offset + CHUNK_SIZE);
      const targets = chunk
        .map((slug, index) => parseSlug(slug, index))
        .filter((t): t is Target => t !== null);
      if (targets.length === 0) continue;

      const response = await fetch(GRAPHQL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "pr-review-bot",
        },
        body: JSON.stringify({ query: buildQuery(targets) }),
      });
      subrequests += 1;

      if (response.status === 401 || response.status === 403) {
        provider.reportStatus(group, response.status);
        if (!failedGroups.includes(group)) failedGroups.push(group);
        break;
      }
      if (!response.ok) {
        if (!failedGroups.includes(group)) failedGroups.push(group);
        continue;
      }

      const body = (await response.json()) as {
        data?: Record<string, { pullRequest: RawPr | null } | null>;
        errors?: { type?: string; path?: (string | number)[] }[];
      };

      // The errors array must be read even on HTTP 200: a batch containing one
      // inaccessible PR returns partial data plus a NOT_FOUND for that alias.
      // Treating the whole response as failed would freeze all syncing; treating
      // a null as "gone" would delete good records.
      const missingAliases = new Set(
        (body.errors ?? [])
          .filter((e) => e.type === "NOT_FOUND")
          .map((e) => String(e.path?.[0] ?? ""))
          .filter((alias) => alias !== ""),
      );

      for (const target of targets) {
        if (missingAliases.has(target.alias)) {
          notFound.push(target.slug);
          continue;
        }
        const raw = body.data?.[target.alias]?.pullRequest;
        if (raw === undefined || raw === null) {
          notFound.push(target.slug);
          continue;
        }
        snapshots.set(target.slug, toSnapshot(target.slug, raw));
      }
    }
  }

  return { snapshots, notFound, failedGroups, subrequests };
}
```

- [ ] **Step 5: Record real fixtures so an upstream payload change fails in CI**

Run, then trim to two or three PRs each:

```bash
mkdir -p fixtures/responses
gh api graphql -f query='
query {
  p0: repository(owner: "paranext", name: "paranext-core") {
    pullRequest(number: 2695) {
      number title isDraft merged state
      author { login }
      reviews(last: 20) { nodes { submittedAt state author { login __typename } } }
    }
  }
}' > fixtures/responses/github-batch.json
```

Then add a test asserting the recorded shape still parses:

```ts
// append to tests/workers/query.test.ts
import batch from "../../fixtures/responses/github-batch.json" with { type: "json" };

it("parses a recorded real GitHub response", async () => {
  stubGraphql([batch]);
  const outcome = await fetchSnapshots(provider(), ["paranext/paranext-core/2695"], T0);
  const snapshot = outcome.snapshots.get("paranext/paranext-core/2695");
  expect(snapshot).toBeDefined();
  expect(typeof snapshot!.title).toBe("string");
  expect(Array.isArray(snapshot!.reviews)).toBe(true);
});
```

Hand-write `fixtures/responses/github-partial-error.json` from the partial-error test's body — GitHub will not reliably produce one on demand, and the shape is what matters.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- --project=workers tests/workers/query.test.ts`
Expected: PASS, including the recorded-fixture test and "NEVER requests reviewDecision".

- [ ] **Step 7: Commit**

```bash
git add src/github/query.ts tests/workers/query.test.ts fixtures/responses/
git commit -m "feat(github): batched GraphQL query with chunking and partial-error handling"
```

---

## Task 17: The refresh loop

Every five minutes, under a lease, at **two store subrequests**. The order matters: the digest render is the last thing that happens and it happens whether or not the sync succeeded.

**Files:**
- Create: `src/handlers/scheduled.ts`
- Test: `tests/workers/scheduled.test.ts`

**Interfaces:**
- Consumes: `Store`, `Command` from Task 11; `fetchSnapshots` from Task 16; `CredentialProvider` from Task 15; `scanChannels` from Task 14; `DiscordRest` from Task 13; `isOpen`, `recordId` from Task 3.
- Produces:
  - `interface TickDeps { store: Store; rest: DiscordRest; credentials: CredentialProvider; config: Config; botUserId: string; now: number; readOnly?: boolean }`
  - `interface TickReport { skipped: boolean; reason?: string; syncOk: boolean; synced: number; resolved: number; scanned: number; staleClaimsCleared: number; purged: number; notFound: number; digest: DigestOutcome | null; dailyPosted: boolean; subrequests: number }`
  - `function runTick(deps: TickDeps): Promise<TickReport>`

- [ ] **Step 1: Write the failing tests**

`tests/workers/scheduled.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { config as baseConfig } from "../../config/config.js";
import { newScannedRecord, recordId, resolveRecord, type PrRecord } from "../../src/core/record.js";
import { DiscordRest } from "../../src/discord/rest.js";
import { CredentialProvider } from "../../src/github/credentials.js";
import { runTick } from "../../src/handlers/scheduled.js";
import { emptyState } from "../../src/store/apply.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { DigestPayload, DigestPublisher, StoreState } from "../../src/store/types.js";

const T0 = 1_788_192_000_000; // 2026-08-31T16:00:00Z = 11:00 America/Chicago
const DAY = 86_400_000;
const CHANNEL = "chan-1";
const config = { ...baseConfig, allowedChannelIds: [CHANNEL], digestChannelId: CHANNEL };

const secrets = { appId: "1", appInstallationId: "2", appPrivateKeyPem: "unused", publicToken: "ghp_public" };

function makePublisher() {
  const patches: DigestPayload[] = [];
  const dailies: string[] = [];
  const publisher: DigestPublisher = {
    listPinnedMessageIds: async () => ["digest-1"],
    patchDigest: async (_id, p) => { patches.push(p); return { ok: true }; },
    createDigest: async (p) => { patches.push(p); return { ok: true, messageId: "digest-1" }; },
    postDaily: async (c) => { dailies.push(c); return { ok: true, messageId: "daily-1" }; },
    messageUrl: (id) => `https://discord.com/channels/g/c/${id}`,
  };
  return { publisher, patches, dailies };
}

function record(number: number, overrides: Partial<PrRecord> = {}): PrRecord {
  return {
    ...newScannedRecord({
      pr: { owner: "eten-tech-foundation", repo: "scripture-editors", number },
      channelId: CHANNEL,
      messageId: `m-${number}`,
      messageTimestamp: T0 - 3 * DAY,
      title: `PT-${number}`,
      prAuthorLogin: "jolie",
      isDraft: false,
    }),
    team: "Power",
    urgency: "soon",
    ...overrides,
  };
}

function seeded(records: PrRecord[]): StoreState {
  const base = emptyState();
  return {
    records: Object.fromEntries(records.map((r) => [recordId(r), r])),
    meta: { ...base.meta, digestMessageId: "digest-1", lastSync: T0 - 60_000, lastDailyPostDate: "2026-08-31", scanCursors: { [CHANNEL]: "500" } },
  };
}

/** Routes stubbed fetch by url: GitHub GraphQL vs Discord messages. */
function stubAll(opts: { graphql?: unknown; graphqlStatus?: number; messages?: unknown[] }) {
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const url = String(input);
    if (url.includes("api.github.com/graphql")) {
      return new Response(JSON.stringify(opts.graphql ?? { data: {} }), { status: opts.graphqlStatus ?? 200 });
    }
    if (url.includes("/messages/pins")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (url.includes("/messages")) return new Response(JSON.stringify(opts.messages ?? []), { status: 200 });
    return new Response("{}", { status: 200 });
  });
}

function deps(store: MemoryStore, overrides: Partial<Parameters<typeof runTick>[0]> = {}) {
  return {
    store,
    rest: new DiscordRest("tok"),
    credentials: new CredentialProvider(secrets),
    config,
    botUserId: "bot-1",
    now: T0,
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("runTick — the lease", () => {
  it("exits immediately without writing when a live lease is held", async () => {
    stubAll({});
    const { publisher, patches } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([record(1)]));
    await store.beginTick(T0 - 30_000);

    const report = await runTick(deps(store));
    expect(report.skipped).toBe(true);
    expect(report.reason).toBe("lease-held");
    expect(patches).toHaveLength(0);
  });
});

describe("runTick — the exit condition end to end", () => {
  it("resolves a record when a human review lands, and the row leaves the digest", async () => {
    stubAll({
      graphql: {
        data: {
          p0: {
            pullRequest: {
              number: 1, title: "PT-1", isDraft: false, merged: false, state: "OPEN",
              author: { login: "jolie" },
              reviews: { nodes: [{ submittedAt: new Date(T0 - DAY).toISOString(), state: "COMMENTED", author: { login: "katherine", __typename: "User" } }] },
            },
          },
        },
      },
    });
    const { publisher, patches } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([record(1)]));

    const report = await runTick(deps(store));
    expect(report.syncOk).toBe(true);
    expect(report.resolved).toBe(1);

    const state = await store.readState();
    expect(state.records["eten-tech-foundation/scripture-editors/1"]?.resolvedBy).toBe("review by katherine");
    expect(patches.at(-1)!.embeds.map((e) => e.description).join("\n")).toContain("nothing waiting");
  });

  it("does NOT resolve on a bot review", async () => {
    stubAll({
      graphql: {
        data: {
          p0: {
            pullRequest: {
              number: 1, title: "PT-1", isDraft: false, merged: false, state: "OPEN",
              author: { login: "jolie" },
              reviews: { nodes: [{ submittedAt: new Date(T0 - DAY).toISOString(), state: "COMMENTED", author: { login: "copilot", __typename: "Bot" } }] },
            },
          },
        },
      },
    });
    const { publisher, patches } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([record(1)]));
    const report = await runTick(deps(store));
    expect(report.resolved).toBe(0);
    // report.resolved alone isn't enough: it's now derived from the SAME
    // countsAsReview call the store uses (see 17.2/R25), but assert the store's
    // committed state directly too, so this stays the end-to-end proof it claims
    // to be rather than trusting the report to describe what was committed.
    const state = await store.readState();
    expect(state.records["eten-tech-foundation/scripture-editors/1"]?.resolvedAt).toBeNull();
    expect(patches.at(-1)!.embeds.map((e) => e.description).join("\n")).toContain("PT-1");
  });

  it("REOPENS and re-lists: reviewed, re-requested, listed again", async () => {
    // The design's primary workflow, asserted end to end rather than per-step.
    const resolved = resolveRecord(record(1), T0 - 2 * DAY, "review by katherine");
    const { publisher, patches } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([resolved]));

    await store.apply(
      [{ kind: "upsertRequest",
         pr: { owner: "eten-tech-foundation", repo: "scripture-editors", number: 1 },
         at: T0 - 60_000,
         fields: { team: "Power", urgency: "blocking", prdThreadId: null, note: "addressed the feedback", requesterId: "u1", requesterName: "Jolie", channelId: CHANNEL, messageId: "m-new" },
         title: "PT-1", prAuthorLogin: "jolie", isDraft: false }],
      { now: T0 - 60_000, rerender: false },
    );

    stubAll({
      graphql: {
        data: {
          p0: {
            pullRequest: {
              number: 1, title: "PT-1", isDraft: false, merged: false, state: "OPEN",
              author: { login: "jolie" },
              // The OLD review, now older than lastRequestedAt.
              reviews: { nodes: [{ submittedAt: new Date(T0 - 2 * DAY).toISOString(), state: "CHANGES_REQUESTED", author: { login: "katherine", __typename: "User" } }] },
            },
          },
        },
      },
    });

    const report = await runTick(deps(store));
    expect(report.resolved).toBe(0);
    const body = patches.at(-1)!.embeds.map((e) => e.description).join("\n");
    expect(body).toContain("PT-1");
    expect(body).toContain("addressed the feedback");
  });
});

describe("runTick — partial GitHub failures", () => {
  it("marks one NOT_FOUND record sync paused and leaves the other untouched", async () => {
    stubAll({
      graphql: {
        data: {
          p0: { pullRequest: { number: 1, title: "PT-1", isDraft: false, merged: false, state: "OPEN", author: { login: "jolie" }, reviews: { nodes: [] } } },
          p1: null,
        },
        errors: [{ type: "NOT_FOUND", path: ["p1"] }],
      },
    });
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([record(1), record(2)]));

    const report = await runTick(deps(store));
    expect(report.notFound).toBe(1);

    const state = await store.readState();
    expect(state.records["eten-tech-foundation/scripture-editors/2"]?.syncPausedSince).toBe(T0);
    expect(state.records["eten-tech-foundation/scripture-editors/2"]?.resolvedAt).toBeNull();
    expect(state.records["eten-tech-foundation/scripture-editors/1"]?.syncPausedSince).toBeNull();
  });

  it("still renders when the whole GitHub call fails, and lastSync is not advanced", async () => {
    stubAll({ graphqlStatus: 500 });
    const { publisher, patches } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([record(1)]));

    const report = await runTick(deps(store));
    expect(report.syncOk).toBe(false);
    expect(report.digest).not.toBeNull();
    expect(patches.length).toBeGreaterThan(0);
    // lastSync untouched, so the stale banner appears once the threshold passes.
    expect((await store.readState()).meta.lastSync).toBe(T0 - 60_000);
  });

  it("advances lastSync only on a successful sync", async () => {
    stubAll({ graphql: { data: { p0: { pullRequest: { number: 1, title: "PT-1", isDraft: false, merged: false, state: "OPEN", author: { login: "jolie" }, reviews: { nodes: [] } } } } } });
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([record(1)]));
    await runTick(deps(store));
    expect((await store.readState()).meta.lastSync).toBe(T0);
  });
});

describe("runTick — scanning and housekeeping", () => {
  it("ingests a scanned link and advances the cursor", async () => {
    stubAll({
      graphql: { data: {} },
      messages: [
        { id: "600", content: "review please https://github.com/paranext/paranext-core/pull/2695",
          timestamp: new Date(T0 - DAY).toISOString(), author: { id: "human", bot: false, username: "jolie" } },
      ],
    });
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([]));

    const report = await runTick(deps(store));
    expect(report.scanned).toBe(1);

    const state = await store.readState();
    expect(state.records["paranext/paranext-core/2695"]?.source).toBe("scanned");
    expect(state.meta.scanCursors[CHANNEL]).toBe("600");
  });

  it("clears a stale claim and reports it", async () => {
    stubAll({ graphql: { data: { p0: { pullRequest: { number: 1, title: "PT-1", isDraft: false, merged: false, state: "OPEN", author: { login: "jolie" }, reviews: { nodes: [] } } } } } });
    const stale = record(1, { claimedBy: "u1", claimedByName: "Ira", claimedAt: T0 - 3 * DAY });
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([stale]));

    const report = await runTick(deps(store));
    expect(report.staleClaimsCleared).toBe(1);
    expect((await store.readState()).records["eten-tech-foundation/scripture-editors/1"]?.lastClaimedByName).toBe("Ira");
  });

  it("purges records resolved beyond retention", async () => {
    stubAll({ graphql: { data: {} } });
    const ancient = resolveRecord(record(1), T0 - 40 * DAY, "merged");
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([ancient]));

    const report = await runTick(deps(store));
    expect(report.purged).toBe(1);
    expect(Object.keys((await store.readState()).records)).toHaveLength(0);
  });

  it("stays inside the subrequest budget with 40 tracked PRs", async () => {
    stubAll({ graphql: { data: {} } });
    const records = Array.from({ length: 40 }, (_, i) => record(i + 1));
    const { publisher } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded(records));

    const report = await runTick(deps(store));
    // The design invariant is "at most TWO store subrequests per tick, independent
    // of record count" — `< 50` would also pass a regression that read the store
    // once per record. Pin the exact count: 1 beginTick + 2 GraphQL chunks (40
    // records, chunked to 25) + 1 scan page (no messages) + 1 finishTick.
    expect(report.subrequests).toBe(5);
  });
});

describe("runTick — read-only mode", () => {
  it("runs the full loop, logs the body, and writes nothing", async () => {
    stubAll({
      graphql: { data: { p0: { pullRequest: { number: 1, title: "PT-1 renamed", isDraft: false, merged: true, state: "MERGED", author: { login: "jolie" }, reviews: { nodes: [] } } } } },
    });
    const { publisher, patches } = makePublisher();
    const store = new MemoryStore(config, publisher, seeded([record(1)]));

    const report = await runTick(deps(store, { readOnly: true }));
    expect(patches).toHaveLength(0);
    expect(report.digest).not.toBeNull();
    // The record is unchanged: nothing was committed.
    expect((await store.readState()).records["eten-tech-foundation/scripture-editors/1"]?.resolvedAt).toBeNull();
    // The lease taken by beginTick must still be released even though finishTick
    // never runs in read-only mode — otherwise every tick for the next
    // LEASE_TIMEOUT_MS is turned away with lease-held, for the whole of shadow mode.
    expect((await store.readState()).meta.syncLease).toBeNull();
    expect(await store.beginTick(T0 + 60_000)).toMatchObject({ acquired: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project=workers tests/workers/scheduled.test.ts`
Expected: FAIL — `Cannot find module '../../src/handlers/scheduled.js'`.

- [ ] **Step 3: Write the implementation**

`src/handlers/scheduled.ts`:

```ts
import type { Config } from "../../config/config.js";
import { countsAsReview } from "../core/exit.js";
import { renderDigest } from "../core/render/digest.js";
import { isOpen, recordId } from "../core/record.js";
import { scanChannels } from "../discord/scan.js";
import type { DiscordRest } from "../discord/rest.js";
import type { CredentialProvider } from "../github/credentials.js";
import { fetchSnapshots } from "../github/query.js";
import type { Command, DigestOutcome, Store } from "../store/types.js";

export interface TickDeps {
  store: Store;
  rest: DiscordRest;
  credentials: CredentialProvider;
  config: Config;
  botUserId: string;
  now: number;
  /** Runs the whole loop against live data and reports what it would post. */
  readOnly?: boolean;
}

export interface TickReport {
  skipped: boolean;
  reason?: string;
  syncOk: boolean;
  synced: number;
  resolved: number;
  scanned: number;
  staleClaimsCleared: number;
  purged: number;
  notFound: number;
  digest: DigestOutcome | null;
  dailyPosted: boolean;
  subrequests: number;
}

export async function runTick(deps: TickDeps): Promise<TickReport> {
  const { store, rest, credentials, config, now } = deps;
  const readOnly = deps.readOnly === true;

  const empty: TickReport = {
    skipped: false, syncOk: true, synced: 0, resolved: 0, scanned: 0,
    staleClaimsCleared: 0, purged: 0, notFound: 0, digest: null,
    dailyPosted: false, subrequests: 0,
  };

  // 1. Take the lease and read a snapshot. Store subrequest #1.
  const opening = await store.beginTick(now);
  let subrequests = 1;
  if (!opening.acquired) {
    return { ...empty, skipped: true, reason: opening.reason, subrequests };
  }

  const openRecords = Object.values(opening.state.records).filter(isOpen);
  const commands: Command[] = [];
  let syncOk = true;
  let resolved = 0;
  let notFound = 0;

  // 2-4. Query GitHub per credential group, chunked, and apply the exit condition.
  if (openRecords.length > 0) {
    const outcome = await fetchSnapshots(credentials, openRecords.map(recordId), now);
    subrequests += outcome.subrequests;

    if (outcome.failedGroups.length > 0) syncOk = false;

    for (const record of openRecords) {
      const id = recordId(record);
      const snapshot = outcome.snapshots.get(id);
      if (snapshot !== undefined) {
        commands.push({ kind: "applySnapshot", id, snapshot, now });
        // Counted here rather than after the fact so the report is honest even in
        // read-only mode, where nothing is committed. Uses the SAME predicate the
        // store applies via applySnapshot/exitVerdict — a hand-copied
        // re-implementation here previously diverged on a null-author review:
        // countsAsReview's sameLogin() treats two nulls as NOT a match (a review by
        // a deleted account on a record with no known author counts), where the old
        // inline `(a ?? "") === (b ?? "")` compared "" === "" and wrongly called it
        // a self-review.
        const prAuthorLogin = record.prAuthorLogin ?? snapshot.authorLogin;
        if (snapshot.merged || snapshot.state === "CLOSED") resolved += 1;
        else if (snapshot.reviews.some((r) => countsAsReview(r, prAuthorLogin, record.lastRequestedAt))) resolved += 1;
      } else if (outcome.notFound.includes(id)) {
        // A null is never "gone": mark it paused, never resolved.
        commands.push({ kind: "markSyncPaused", id, at: now });
        notFound += 1;
      }
    }
  }

  // 5. Clear stale claims.
  commands.push({ kind: "clearStaleClaims", now });

  // 6. Scan configured channels, paginated.
  const scan = await scanChannels(rest, config, opening.state.meta.scanCursors, deps.botUserId, now);
  subrequests += scan.pagesRead;
  commands.push(...scan.commands);
  if (Object.keys(scan.cursors).length > 0) {
    commands.push({
      kind: "setMeta",
      patch: { scanCursors: { ...opening.state.meta.scanCursors, ...scan.cursors } },
    });
  }

  // 7 (PRD cache) and 8 (reaction reads) belong to plans 2 and 3.

  // 10. Purge beyond retention, capped per tick.
  commands.push({ kind: "purgeResolved", now });

  // lastSync advances only on a successful sync, so a stale list looks stale.
  if (syncOk) commands.push({ kind: "setMeta", patch: { lastSync: now } });

  if (readOnly) {
    // Render from the opening snapshot plus what WOULD have been applied, without
    // committing anything and without touching Discord.
    const render = renderDigest({
      records: Object.values(opening.state.records),
      lastSync: opening.state.meta.lastSync,
      now,
      config,
    });
    console.log("[read-only] would render:\n" + render.embeds.map((e) => e.description).join("\n---\n"));

    // beginTick already took the lease above; finishTick is the only thing that
    // releases it, and read-only mode never calls finishTick. Without this, the
    // first tick under READ_ONLY takes the lease and every tick for the next
    // LEASE_TIMEOUT_MS is turned away with lease-held — the loop runs once per
    // lease timeout instead of once per refreshIntervalMs, for the entire
    // duration of shadow mode.
    await store.apply([{ kind: "setMeta", patch: { syncLease: null } }], { now, rerender: false });

    return {
      ...empty,
      syncOk,
      synced: openRecords.length,
      resolved,
      scanned: scan.commands.length,
      notFound,
      subrequests,
      digest: {
        action: "skipped-unchanged",
        bodyHash: render.bodyHash,
        openCount: render.openCount,
        renderedCount: render.renderedCount,
      },
    };
  }

  // 9 + 11. Apply, re-read, render, PATCH, post the daily message, release the
  // lease — all inside one store call. Store subrequest #2.
  const finished = await store.finishTick({ commands, now, syncOk });
  subrequests += 1;

  const staleCleared = finished.results.find((r, i) => commands[i]?.kind === "clearStaleClaims" && r.kind === "count");
  const purged = finished.results.find((r, i) => commands[i]?.kind === "purgeResolved" && r.kind === "count");
  const scannedCreated = finished.results.filter((r, i) => commands[i]?.kind === "upsertScanned" && r.kind === "created");

  return {
    skipped: false,
    syncOk,
    synced: openRecords.length,
    resolved,
    scanned: scannedCreated.length,
    staleClaimsCleared: staleCleared?.kind === "count" ? staleCleared.count : 0,
    purged: purged?.kind === "count" ? purged.count : 0,
    notFound,
    digest: finished.digest,
    dailyPosted: finished.dailyPosted,
    subrequests,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --project=workers tests/workers/scheduled.test.ts`
Expected: PASS. Two failures worth naming:
- If "still renders when the whole GitHub call fails" fails, `finishTick` is being skipped on `syncOk === false` — it must not be.
- If "REOPENS and re-lists" fails, check that `runTick` reads `lastRequestedAt` from the record rather than `firstRequestedAt`.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/scheduled.ts tests/workers/scheduled.test.ts
git commit -m "feat(handlers): refresh loop with lease, partial-failure handling and render-on-failure"
```

---

## Task 18: Interaction routing and the digest select menus

**Files:**
- Create: `src/handlers/interactions.ts`, `src/discord/components.ts`
- Test: `tests/workers/interactions.test.ts`

**Interfaces:**
- Consumes: `verifyDiscordRequest` from Task 13; `Store`, `Command` from Task 11; `decodeOptionValue`, `menuOptions`, `rankRows` from Task 7; `renderDigest` from Task 8.
- Produces:
  - `function handleInteraction(request: Request, deps: InteractionDeps): Promise<Response>`
  - `interface InteractionDeps { store: Store; config: Config; publicKey: string; now: () => number }`
  - `function ephemeral(content: string): InteractionResponse`
  - `const RESOLVE_ACTIONS`, `const CUSTOM_IDS`

Interaction types handled in this plan: `PING` (1), `MESSAGE_COMPONENT` (3) for the two digest menus. `APPLICATION_COMMAND` (2) is handled for `/review-list` in Task 19; `/review-request` and `MODAL_SUBMIT` (5) belong to plan 2.

Every selection is **revalidated** — Task 11's `apply` already enforces it via `expectLastRequestedAt`, so this handler's job is to decode the option value, pass the expectation through, and turn each `CommandResult` into an ephemeral message the user can act on.

- [ ] **Step 1: Write `src/discord/components.ts`**

```ts
export const CUSTOM_IDS = {
  claim: "digest:claim",
  resolve: "digest:resolve",
} as const;

export const InteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
  MessageComponent: 3,
  ModalSubmit: 5,
} as const;

export const CallbackType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
  DeferredUpdateMessage: 6,
} as const;

export const EPHEMERAL_FLAG = 1 << 6;

export interface InteractionResponse {
  type: number;
  data?: { content?: string; flags?: number };
}

export function pong(): InteractionResponse {
  return { type: CallbackType.Pong };
}

/** Rejections are ephemeral, so a mistake leaves no noise in the channel — but
 *  ephemeral is not silent: every message names the problem and its fix. */
export function ephemeral(content: string): InteractionResponse {
  return {
    type: CallbackType.ChannelMessageWithSource,
    data: { content, flags: EPHEMERAL_FLAG },
  };
}
```

- [ ] **Step 2: Write the failing tests**

`tests/workers/interactions.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { config as baseConfig } from "../../config/config.js";
import { newScannedRecord, recordId, resolveRecord, type PrRecord } from "../../src/core/record.js";
import { handleInteraction } from "../../src/handlers/interactions.js";
import { emptyState } from "../../src/store/apply.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { DigestPayload, DigestPublisher, StoreState } from "../../src/store/types.js";

const T0 = 1_788_192_000_000; // 2026-08-31T16:00:00Z = 11:00 America/Chicago
const DAY = 86_400_000;
const CHANNEL = "chan-1";
const config = { ...baseConfig, allowedChannelIds: [CHANNEL], digestChannelId: CHANNEL };
const ID = "eten-tech-foundation/scripture-editors/341";

function record(overrides: Partial<PrRecord> = {}): PrRecord {
  return {
    ...newScannedRecord({
      pr: { owner: "eten-tech-foundation", repo: "scripture-editors", number: 341 },
      channelId: CHANNEL,
      messageId: "m-341",
      messageTimestamp: T0 - 3 * DAY,
      title: "Fix marker parsing",
      prAuthorLogin: "jolie",
      isDraft: false,
    }),
    team: "Power",
    urgency: "soon",
    ...overrides,
  };
}

function seeded(records: PrRecord[]): StoreState {
  const base = emptyState();
  return {
    records: Object.fromEntries(records.map((r) => [recordId(r), r])),
    meta: { ...base.meta, digestMessageId: "digest-1", lastSync: T0 - 60_000, lastDailyPostDate: "2026-08-31" },
  };
}

function makeStore(records: PrRecord[]) {
  const patches: DigestPayload[] = [];
  const publisher: DigestPublisher = {
    listPinnedMessageIds: async () => ["digest-1"],
    patchDigest: async (_id, p) => { patches.push(p); return { ok: true }; },
    createDigest: async (p) => { patches.push(p); return { ok: true, messageId: "digest-1" }; },
    postDaily: async () => ({ ok: true, messageId: "d" }),
    messageUrl: (id) => `https://discord.com/channels/g/c/${id}`,
  };
  return { store: new MemoryStore(config, publisher, seeded(records)), patches };
}

// Signature verification is injected through `deps.verify` below rather than
// mocked: the real Ed25519 path is covered in Task 13 against real keys.
function componentRequest(customId: string, value: string, userId = "u1", userName = "Katherine") {
  const body = JSON.stringify({
    type: 3,
    data: { custom_id: customId, component_type: 3, values: [value] },
    member: { user: { id: userId, global_name: userName, username: userName } },
    channel_id: CHANNEL,
  });
  return new Request("https://bot/interactions", {
    method: "POST",
    body,
    headers: { "x-signature-ed25519": "ab".repeat(64), "x-signature-timestamp": "1756000000" },
  });
}

function deps(store: MemoryStore, verified = true) {
  return { store, config, publicKey: "00".repeat(32), now: () => T0, verify: async () => verified };
}

afterEach(() => vi.unstubAllGlobals());

describe("handleInteraction — gatekeeping", () => {
  it("answers a PING with a PONG", async () => {
    const { store } = makeStore([]);
    const request = new Request("https://bot/interactions", {
      method: "POST",
      body: JSON.stringify({ type: 1 }),
      headers: { "x-signature-ed25519": "ab".repeat(64), "x-signature-timestamp": "1" },
    });
    const response = await handleInteraction(request, deps(store));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
  });

  it("rejects an unverified request with 401 before parsing or applying anything", async () => {
    const { store } = makeStore([]);
    const response = await handleInteraction(componentRequest("digest:claim", `${ID}:${T0 - 3 * DAY}`), deps(store, false));
    expect(response.status).toBe(401);
  });
});

describe("handleInteraction — claim", () => {
  it("records the claim and confirms ephemerally", async () => {
    const { store, patches } = makeStore([record()]);
    const value = `${ID}:${T0 - 3 * DAY}`;
    const response = await handleInteraction(componentRequest("digest:claim", value), deps(store));

    const body = (await response.json()) as { data: { content: string; flags: number } };
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("Fix marker parsing");

    const state = await store.readState();
    expect(state.records[ID]?.claimedByName).toBe("Katherine");
    expect(patches.length).toBeGreaterThan(0);
  });

  it("names the holder when someone else already claimed it", async () => {
    const { store } = makeStore([record({ claimedBy: "u9", claimedByName: "Ira", claimedAt: T0 - 3600_000 })]);
    const response = await handleInteraction(componentRequest("digest:claim", `${ID}:${T0 - 3 * DAY}`), deps(store));
    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content).toContain("Ira");
  });

  it("releases the claim when the holder selects their own row", async () => {
    const { store } = makeStore([record({ claimedBy: "u1", claimedByName: "Katherine", claimedAt: T0 - 3600_000 })]);
    const response = await handleInteraction(componentRequest("digest:claim", `${ID}:${T0 - 3 * DAY}`), deps(store));
    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content.toLowerCase()).toContain("released");
    expect((await store.readState()).records[ID]?.claimedBy).toBeNull();
  });

  it("explains and no-ops when the option value is stale", async () => {
    // "changed" also appears in not-open ("Nothing changed."), not-found ("Nothing
    // changed.") and the default branch ("Nothing changed for…") — asserting it
    // alone can't tell "stale" from those other three outcomes. "re-requested" is
    // the one phrase unique to the stale branch.
    const { store } = makeStore([record({ lastRequestedAt: T0 - 60_000 })]);
    const response = await handleInteraction(componentRequest("digest:claim", `${ID}:${T0 - 3 * DAY}`), deps(store));
    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content).toContain("re-requested");
    expect((await store.readState()).records[ID]?.claimedBy).toBeNull();
  });
});

describe("handleInteraction — resolve and reopen", () => {
  it("resolves a row, recording the actor", async () => {
    const { store } = makeStore([record()]);
    const response = await handleInteraction(componentRequest("digest:resolve", `${ID}:${T0 - 3 * DAY}`), deps(store));
    expect((await response.json() as { data: { content: string } }).data.content).toContain("Cleared");
    expect((await store.readState()).records[ID]?.resolvedBy).toBe("cleared by Katherine");
  });

  it("refuses to overwrite a resolvedBy the tick already set", async () => {
    // The specific bug: selecting Resolve on a row the tick resolved 60 seconds
    // ago would destroy the audit trail retention exists to provide.
    const alreadyResolved = resolveRecord(record(), T0 - 60_000, "review by katherine");
    const { store } = makeStore([alreadyResolved]);
    const response = await handleInteraction(componentRequest("digest:resolve", `${ID}:${T0 - 3 * DAY}`), deps(store));
    const body = (await response.json()) as { data: { content: string } };
    // "already" alone is also produced by applyOne's OWN not-open guard inside the
    // store — deleting the handler's early return this test names would still pass,
    // since describe()'s not-open branch also contains "already" (just not the
    // resolver's name). Assert the message only the handler's own check can produce.
    expect(body.data.content).toContain("review by katherine");
    expect((await store.readState()).records[ID]?.resolvedBy).toBe("review by katherine");
  });

  it("reopens a row resolved within the last 24 hours", async () => {
    const resolved = resolveRecord(record(), T0 - 3600_000, "cleared by Jolie");
    const { store } = makeStore([resolved]);
    const response = await handleInteraction(
      componentRequest("digest:resolve", `reopen:${ID}:${T0 - 3 * DAY}`),
      deps(store),
    );
    expect((await response.json() as { data: { content: string } }).data.content.toLowerCase()).toContain("back");
    expect((await store.readState()).records[ID]?.resolvedAt).toBeNull();
  });

  it("refuses to reopen a row resolved more than config.reopenWindowMs ago", async () => {
    // No test previously covered a reopen REFUSAL: if the renderer's window ever
    // exceeded the handler's, the digest would offer options that always answer
    // "cannot be reopened from here" and nothing would go red.
    const resolved = resolveRecord(record(), T0 - 30 * 3600_000, "cleared by Jolie");
    const { store } = makeStore([resolved]);
    const response = await handleInteraction(
      componentRequest("digest:resolve", `reopen:${ID}:${T0 - 3 * DAY}`),
      deps(store),
    );
    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content).toContain("cannot be reopened");
    expect((await store.readState()).records[ID]?.resolvedAt).not.toBeNull();
  });

  it("reports not-found for a record that has been purged", async () => {
    const { store } = makeStore([]);
    const response = await handleInteraction(componentRequest("digest:resolve", `${ID}:${T0}`), deps(store));
    expect((await response.json() as { data: { content: string } }).data.content.toLowerCase()).toContain("no longer");
  });

  it("rejects a malformed option value without throwing", async () => {
    const { store } = makeStore([record()]);
    const response = await handleInteraction(componentRequest("digest:resolve", "garbage"), deps(store));
    expect(response.status).toBe(200);
    expect((await response.json() as { data: { content: string } }).data.content.toLowerCase()).toContain("could not");
  });

  it("returns 200 with an explanation for an unknown custom_id", async () => {
    const { store } = makeStore([record()]);
    const response = await handleInteraction(componentRequest("digest:unknown", `${ID}:${T0}`), deps(store));
    expect(response.status).toBe(200);
  });
});
```

- [ ] **Step 3: Write the implementation**

`src/handlers/interactions.ts`:

```ts
import type { Config } from "../../config/config.js";
import { decodeOptionValue } from "../core/ranking.js";
import { isOpen } from "../core/record.js";
import { CallbackType, CUSTOM_IDS, ephemeral, InteractionType, pong } from "../discord/components.js";
import { verifyDiscordRequest } from "../discord/verify.js";
import type { Command, CommandResult, Store } from "../store/types.js";

export interface InteractionDeps {
  store: Store;
  config: Config;
  publicKey: string;
  now: () => number;
  /** Injectable so tests need not sign real payloads; defaults to the real check. */
  verify?: (body: string, signature: string | null, timestamp: string | null, key: string) => Promise<boolean>;
}

interface Interaction {
  type: number;
  data?: { custom_id?: string; values?: string[]; name?: string };
  member?: { user: { id: string; global_name?: string | null; username: string } };
  user?: { id: string; global_name?: string | null; username: string };
  channel_id?: string;
}

function actor(interaction: Interaction): { id: string; name: string } | null {
  const user = interaction.member?.user ?? interaction.user;
  if (user === undefined) return null;
  return { id: user.id, name: user.global_name ?? user.username };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function handleInteraction(request: Request, deps: InteractionDeps): Promise<Response> {
  const raw = await request.text();
  const verify = deps.verify ?? verifyDiscordRequest;
  const verified = await verify(
    raw,
    request.headers.get("x-signature-ed25519"),
    request.headers.get("x-signature-timestamp"),
    deps.publicKey,
  );
  if (!verified) return new Response("invalid request signature", { status: 401 });

  let interaction: Interaction;
  try {
    interaction = JSON.parse(raw) as Interaction;
  } catch {
    return new Response("bad request", { status: 400 });
  }

  if (interaction.type === InteractionType.Ping) return json(pong());

  if (interaction.type === InteractionType.MessageComponent) {
    return json(await handleComponent(interaction, deps));
  }

  // /review-list arrives in Task 19; /review-request and MODAL_SUBMIT in plan 2.
  return json(ephemeral("This interaction is not handled yet."));
}

async function handleComponent(interaction: Interaction, deps: InteractionDeps) {
  const who = actor(interaction);
  if (who === null) return ephemeral("Could not identify who selected that.");

  const customId = interaction.data?.custom_id ?? "";
  const rawValue = interaction.data?.values?.[0] ?? "";

  const reopen = rawValue.startsWith("reopen:");
  const decoded = decodeOptionValue(reopen ? rawValue.slice("reopen:".length) : rawValue);
  if (decoded === null) {
    return ephemeral("Could not read that selection. The list may have been rewritten — try again.");
  }

  const now = deps.now();
  const state = await deps.store.readState();
  const record = state.records[decoded.id];
  if (record === undefined) {
    return ephemeral(`That PR is no longer tracked — it may have been purged after 30 days.`);
  }

  if (customId === CUSTOM_IDS.claim) {
    // Selecting a row you already hold releases it.
    const command: Command =
      record.claimedBy === who.id
        ? { kind: "unclaim", id: decoded.id, userId: who.id }
        : {
            kind: "claim",
            id: decoded.id,
            userId: who.id,
            displayName: who.name,
            at: now,
            expectLastRequestedAt: decoded.lastRequestedAt,
          };

    const result = await deps.store.apply([command], {
      now,
      rerender: deps.config.immediateDigestRewrite,
    });
    return describe(result.results[0], record.title, command.kind === "unclaim" ? "unclaim" : "claim");
  }

  if (customId === CUSTOM_IDS.resolve) {
    if (reopen) {
      // Read from config, not a locally hand-written literal — the renderer decides
      // which rows are OFFERED as reopen options and this decides which are
      // ACCEPTED; the two numbers must be the same, and a config field with one
      // definition is what makes that true instead of merely hoped-for.
      if (record.resolvedAt === null || now - record.resolvedAt > deps.config.reopenWindowMs) {
        return ephemeral(`**${record.title}** cannot be reopened from here — resolve it again with the command.`);
      }
      const result = await deps.store.apply([{ kind: "reopen", id: decoded.id, at: now }], {
        now,
        rerender: deps.config.immediateDigestRewrite,
      });
      return describe(result.results[0], record.title, "reopen");
    }

    if (!isOpen(record)) {
      return ephemeral(
        `**${record.title}** was already cleared — ${record.resolvedBy ?? "resolved"}. Nothing changed.`,
      );
    }

    const result = await deps.store.apply(
      [{
        kind: "resolve",
        id: decoded.id,
        by: `cleared by ${who.name}`,
        at: now,
        expectLastRequestedAt: decoded.lastRequestedAt,
      }],
      { now, rerender: deps.config.immediateDigestRewrite },
    );
    return describe(result.results[0], record.title, "resolve");
  }

  return ephemeral("That control is no longer in use. Open the pinned list again.");
}

function describe(result: CommandResult | undefined, title: string, action: "claim" | "unclaim" | "resolve" | "reopen") {
  if (result === undefined) return ephemeral("Nothing happened. Try again from the pinned list.");

  switch (result.kind) {
    case "ok":
      if (action === "claim") return ephemeral(`You are reviewing **${title}**. It has moved to *Being reviewed*.`);
      if (action === "unclaim") return ephemeral(`Released **${title}**. It is back in its team section.`);
      if (action === "reopen") return ephemeral(`**${title}** is back on the list.`);
      return ephemeral(`Cleared **${title}** from the list.`);
    case "already-claimed":
      return ephemeral(`**${result.byName}** is already reviewing **${title}**.`);
    case "stale":
      return ephemeral(
        `**${title}** changed since the list was drawn — it was re-requested. Nothing changed; open the pinned list again.`,
      );
    case "not-open":
      return ephemeral(`**${title}** is already off the list. Nothing changed.`);
    case "not-found":
      return ephemeral(`**${title}** is no longer tracked. Nothing changed.`);
    default:
      return ephemeral(`Nothing changed for **${title}**.`);
  }
}
```

- [ ] **Step 4: Add `Reopen` options to the resolve menu**

**First, add `reopenWindowMs` to the live `config/config.ts`.** Task 1 already shipped this file (it is not a snippet to be created fresh here) — add the field to both the `Config` interface and the exported `config` object by hand:

```ts
// interface Config: add alongside the other duration fields
  reopenWindowMs: number;

// export const config: add alongside retentionMs
  reopenWindowMs: 24 * HOUR,
```

This is purely additive and `tests/core/config.test.ts` already guards field shape/ordering, so it does not disturb anything Task 1 already committed. Both the renderer (below) and the handler read this one field, so the "offered" window and the "accepted" window cannot drift apart the way two hand-written literals could.

Task 8's renderer builds the resolve menu from open rows only. Add the recently-resolved rows so a mis-resolve is recoverable. In `src/core/render/digest.ts`, after `resolveChoices` is computed:

```ts
  const reopenChoices = records
    .filter((r) => r.resolvedAt !== null && now - r.resolvedAt <= config.reopenWindowMs)
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
    .slice(0, Math.max(0, 25 - resolveChoices.length))
    .map((r) => ({
      label: `↩︎ ${r.title}`.slice(0, 100),
      value: `reopen:${recordId(r)}:${r.lastRequestedAt}`.slice(0, 100),
      description: `reopen · ${r.resolvedBy ?? "resolved"}`.slice(0, 100),
    }));
```

Then use `[...resolveChoices, ...reopenChoices]` as the resolve menu's options, and change its guard to `if (resolveChoices.length + reopenChoices.length > 0)`. Import `recordId` from `../record.js`.

Add the regression test to `tests/core/render/digest.test.ts`:

```ts
it("offers a row resolved in the last 24 hours as a reopen option", () => {
  const resolved = resolveRecord(rec(1, { team: "Power", urgency: "soon" }), NOW - 2 * HOUR, "cleared by Jolie");
  const result = renderDigest({ records: [resolved], ...FRESH });
  const values = JSON.stringify(result.components);
  expect(values).toContain("reopen:paranext/paranext-core/1");
});

it("does not offer a reopen for a row resolved more than 24 hours ago", () => {
  const resolved = resolveRecord(rec(1, { team: "Power", urgency: "soon" }), NOW - 30 * HOUR, "merged");
  const result = renderDigest({ records: [resolved], ...FRESH });
  expect(JSON.stringify(result.components)).not.toContain("reopen:");
});
```

Note this makes the `empty` scenario's "no components at all" assertion narrower than before: a digest with zero open rows but a row resolved ten minutes ago **does** carry a resolve menu, holding one reopen option. That is correct — the menu is non-empty, so there is no 400 — but re-run the fixture snapshots and confirm the `empty` scenario still has none, since its records list is genuinely empty.

**This also breaks an existing, merged assertion, and the fix must be made explicitly, not discovered as a mystery red test.** `tests/core/render/digest.test.ts:47`, `it("renders the empty state when every record is resolved")`, builds `resolveRecord(rec(1, …), NOW - 2 * HOUR, "merged")` and asserts `expect(result.components).toEqual([])`. `NOW - 2 * HOUR` is inside the new 24-hour reopen window, so that record now yields one reopen option and `components` has length 1 — the existing assertion fails as soon as `reopenChoices` exists. Change it to:

```ts
it("renders the empty state when every record is resolved", () => {
  const resolved = resolveRecord(rec(1, { team: "Power", urgency: "soon" }), NOW - 2 * HOUR, "merged");
  const result = renderDigest({ records: [resolved], ...FRESH });
  expect(result.components).toHaveLength(1);
  expect(JSON.stringify(result.components)).toContain("reopen:");
});

it("renders truly no components when every record is resolved well outside the reopen window", () => {
  const resolved = resolveRecord(rec(1, { team: "Power", urgency: "soon" }), NOW - 30 * HOUR, "merged");
  const result = renderDigest({ records: [resolved], ...FRESH });
  expect(result.components).toEqual([]);
});
```

The second test keeps the "no empty String Select" invariant the original test existed to guard, now pinned outside the reopen window where it still applies.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- --project=core tests/core/render/digest.test.ts && npm test -- --project=workers tests/workers/interactions.test.ts && npm test -- --project=core tests/core/fixtures.test.ts`
Expected: PASS. Re-run the preview (`npm run preview`) and look at the `stale` scenario — it now shows a reopen option count on the resolve menu.

- [ ] **Step 6: Commit**

```bash
git add src/discord/components.ts src/handlers/interactions.ts src/core/render/digest.ts tests/workers/interactions.test.ts tests/core/render/digest.test.ts tests/core/__snapshots__
git commit -m "feat(handlers): digest claim and resolve menus with revalidation and reopen"
```

---

## Task 19: The worker entry, `/review-list`, health, and the intent assertion

**Files:**
- Create: `src/index.ts`, `src/handlers/reviewList.ts`, `src/handlers/health.ts`, `src/handlers/startup.ts`
- Create: `scripts/register-commands.ts`
- Test: `tests/workers/startup.test.ts`, `tests/workers/reviewList.test.ts`, `tests/workers/index.test.ts`
- Modify: `src/handlers/interactions.ts` (route `APPLICATION_COMMAND`)

**Interfaces:**
- Produces:
  - `interface Env` — the Worker bindings and secrets
  - `default export { fetch, scheduled }` plus `export { RecordsObject }`
  - `function assertMessageContentIntent(rest: DiscordRest): Promise<{ ok: true } | { ok: false; code: "INTENT_MISSING" }>`
  - `function renderReviewList(state: StoreState, config: Config, now: number): InteractionResponse`
  - `function handleHealth(deps: HealthDeps): Promise<Response>`

**The intent assertion must be falsifiable.** Checking for messages with non-empty `embeds` but empty `content` does not work: the Message Content intent gates `content`, `embeds`, `attachments`, `components` and `poll` by the *same* rule, so an ungated fetch returns all of them empty together and the precondition never fires. The bot would report "no links found" and run a full sprint of shadow mode on an empty list. Read the application's own `flags` instead.

- [ ] **Step 1: Write `src/handlers/startup.ts`**

```ts
import { DiscordRest, FLAG_MESSAGE_CONTENT, FLAG_MESSAGE_CONTENT_LIMITED } from "../discord/rest.js";

export type IntentCheck =
  | { ok: true; limited: boolean }
  | { ok: false; code: "INTENT_MISSING" | "UNREACHABLE"; detail: string };

/**
 * Without the Message Content privileged intent, GET /channels/{id}/messages
 * returns content: "" for every message the bot did not author — so scanning
 * silently extracts zero links and the whole of shadow mode reports an empty
 * list. This check reads the application's declared flags, which is the only
 * signal that distinguishes "no links" from "no content".
 */
export async function assertMessageContentIntent(rest: DiscordRest): Promise<IntentCheck> {
  const application = await rest.getApplication();
  if (!application.ok) {
    return { ok: false, code: "UNREACHABLE", detail: `GET /applications/@me returned ${application.status}` };
  }
  const flags = application.value.flags;
  const full = (flags & FLAG_MESSAGE_CONTENT) !== 0;
  const limited = (flags & FLAG_MESSAGE_CONTENT_LIMITED) !== 0;
  if (!full && !limited) {
    return {
      ok: false,
      code: "INTENT_MISSING",
      detail:
        "MESSAGE CONTENT intent is not enabled. Enable it in the Developer Portal " +
        "(Bot → Privileged Gateway Intents). Without it, channel scanning reads " +
        "empty content and the digest will be silently empty.",
    };
  }
  return { ok: true, limited: !full && limited };
}
```

- [ ] **Step 2: Write the failing startup test**

`tests/workers/startup.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordRest, FLAG_MESSAGE_CONTENT, FLAG_MESSAGE_CONTENT_LIMITED } from "../../src/discord/rest.js";
import { assertMessageContentIntent } from "../../src/handlers/startup.js";

function stubApplication(body: unknown, status = 200) {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status }));
}

afterEach(() => vi.unstubAllGlobals());

describe("assertMessageContentIntent", () => {
  it("passes with the full intent flag", async () => {
    stubApplication({ id: "app", flags: FLAG_MESSAGE_CONTENT });
    expect(await assertMessageContentIntent(new DiscordRest("tok"))).toEqual({ ok: true, limited: false });
  });

  it("passes with the limited intent flag and says so", async () => {
    stubApplication({ id: "app", flags: FLAG_MESSAGE_CONTENT_LIMITED });
    expect(await assertMessageContentIntent(new DiscordRest("tok"))).toEqual({ ok: true, limited: true });
  });

  it("FAILS with INTENT_MISSING when neither flag is present", async () => {
    // The failure this exists to prevent: a full sprint of shadow mode on an
    // empty list, indistinguishable from "nobody posted any PRs".
    stubApplication({ id: "app", flags: 0 });
    const result = await assertMessageContentIntent(new DiscordRest("tok"));
    expect(result).toMatchObject({ ok: false, code: "INTENT_MISSING" });
    expect((result as { detail: string }).detail).toContain("Developer Portal");
  });

  it("ignores unrelated flags", async () => {
    stubApplication({ id: "app", flags: 1 << 12 });
    expect(await assertMessageContentIntent(new DiscordRest("tok"))).toMatchObject({ code: "INTENT_MISSING" });
  });

  it("passes against the raw documented bit value, not just the constant ANDed with itself", async () => {
    // `{ flags: FLAG_MESSAGE_CONTENT }` above ANDs the constant against itself —
    // (x & x) !== 0 holds for ANY non-zero x, so that fixture passes even for the
    // wrong bit position (as shipped once in Task 13 — see rest.test.ts). A raw
    // literal is the only fixture that can catch the constant itself being wrong.
    stubApplication({ id: "app", flags: 262144 });
    expect(await assertMessageContentIntent(new DiscordRest("tok"))).toEqual({ ok: true, limited: false });
  });

  it("reports UNREACHABLE rather than INTENT_MISSING when the call fails", async () => {
    stubApplication({}, 500);
    expect(await assertMessageContentIntent(new DiscordRest("tok"))).toMatchObject({ ok: false, code: "UNREACHABLE" });
  });
});
```

- [ ] **Step 3: Write `src/handlers/reviewList.ts`**

```ts
import type { Config } from "../../config/config.js";
import { renderDigest } from "../core/render/digest.js";
import { ephemeral, type InteractionResponse } from "../discord/components.js";
import type { StoreState } from "../store/types.js";

const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * The same content, ephemerally. Cheap, and it decouples the tool's value from a
 * pin the bot cannot restore itself — which is why it is registered from day one
 * rather than when the command half ships.
 */
export function renderReviewList(state: StoreState, config: Config, now: number): InteractionResponse {
  const render = renderDigest({
    records: Object.values(state.records),
    lastSync: state.meta.lastSync,
    now,
    // No truncation here: an ephemeral message is not a permanent surface, so
    // show everything that fits rather than the digest's 20-row budget.
    maxRows: 200,
    config,
  });

  const body = render.embeds.map((e) => e.description).join("\n");
  if (body.length <= DISCORD_MESSAGE_LIMIT) return ephemeral(body);

  const truncated = `${body.slice(0, DISCORD_MESSAGE_LIMIT - 80)}\n_…truncated. ${render.openCount} open in total._`;
  return ephemeral(truncated);
}
```

- [ ] **Step 4: Write the failing review-list test**

`tests/workers/reviewList.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { config } from "../../config/config.js";
import { newScannedRecord, recordId, type PrRecord } from "../../src/core/record.js";
import { renderReviewList } from "../../src/handlers/reviewList.js";
import { emptyState } from "../../src/store/apply.js";
import type { StoreState } from "../../src/store/types.js";

const T0 = 1_788_192_000_000; // 2026-08-31T16:00:00Z = 11:00 America/Chicago

function record(number: number, overrides: { title?: string } = {}): PrRecord {
  return {
    ...newScannedRecord({
      pr: { owner: "paranext", repo: "paranext-core", number },
      channelId: "c",
      messageId: `m-${number}`,
      messageTimestamp: T0 - 86_400_000,
      title: overrides.title ?? `PT-${number} A change`,
      prAuthorLogin: "jolie",
      isDraft: false,
    }),
    team: "Power",
    urgency: "soon",
  };
}

function state(records: PrRecord[]): StoreState {
  const base = emptyState();
  return {
    records: Object.fromEntries(records.map((r) => [recordId(r), r])),
    meta: { ...base.meta, lastSync: T0 - 60_000 },
  };
}

describe("renderReviewList", () => {
  it("is always ephemeral", () => {
    const response = renderReviewList(state([record(1)]), config, T0);
    expect(response.data?.flags).toBe(64);
  });

  it("shows rows the digest would have truncated", () => {
    // Short titles keep the WHOLE 25-row body under Discord's 2000-char message
    // limit. That matters: with 30 long-titled rows, `renderDigest`'s own
    // "…and 10 more" line sits past the 2000-char cutoff and gets sliced off
    // BEFORE the assertion ever sees it — so deleting the `maxRows: 200` override
    // this test exists to prove would still leave "and 10 more" absent, for a
    // completely different (and wrong) reason. With short titles and no
    // truncation possible, only the override itself can make row 25 visible.
    const many = Array.from({ length: 25 }, (_, i) => record(i + 1, { title: "x" }));
    const response = renderReviewList(state(many), config, T0);
    expect(response.data?.content).toContain("paranext-core#25");
    expect(response.data?.content).not.toContain("truncated");
  });

  it("stays inside the 2000-character message limit and says it truncated", () => {
    const many = Array.from({ length: 200 }, (_, i) => record(i + 1));
    const response = renderReviewList(state(many), config, T0);
    expect(response.data?.content!.length).toBeLessThanOrEqual(2000);
    expect(response.data?.content).toContain("truncated");
  });

  it("reports the empty state rather than an empty message", () => {
    const response = renderReviewList(state([]), config, T0);
    expect(response.data?.content).toContain("nothing waiting");
  });

  it("carries the stale banner when the store is stale", () => {
    const stale = state([record(1)]);
    const response = renderReviewList({ ...stale, meta: { ...stale.meta, lastSync: T0 - 47 * 60_000 } }, config, T0);
    expect(response.data?.content).toContain("Not syncing");
  });
});
```

- [ ] **Step 5: Route `APPLICATION_COMMAND` in the interaction handler**

In `src/handlers/interactions.ts`, replace the final fallback with:

```ts
  if (interaction.type === InteractionType.ApplicationCommand) {
    if (interaction.data?.name === "review-list") {
      const state = await deps.store.readState();
      return json(renderReviewList(state, deps.config, deps.now()));
    }
    // /review-request belongs to plan 2.
    return json(ephemeral("That command is not enabled yet."));
  }

  return json(ephemeral("This interaction is not handled yet."));
```

Add the import: `import { renderReviewList } from "./reviewList.js";`

- [ ] **Step 6: Write `src/handlers/health.ts`**

```ts
import { isOpen } from "../core/record.js";
import type { CredentialProvider } from "../github/credentials.js";
import type { Store } from "../store/types.js";

export interface HealthDeps {
  store: Store;
  credentials: CredentialProvider;
  now: number;
  staleBannerMs: number;
}

/** A silent cron failure must be discoverable without reading the channel. */
export async function handleHealth(deps: HealthDeps): Promise<Response> {
  const state = await deps.store.readState();
  const records = Object.values(state.records);
  const open = records.filter(isOpen);
  const lastSync = state.meta.lastSync;
  const ageMs = lastSync === null ? null : deps.now - lastSync;
  const stale = ageMs === null || ageMs >= deps.staleBannerMs;

  const body = {
    status: stale ? "stale" : "ok",
    lastSync: lastSync === null ? null : new Date(lastSync).toISOString(),
    lastSyncAgeMs: ageMs,
    openRecords: open.length,
    totalRecords: records.length,
    syncPaused: open.filter((r) => r.syncPausedSince !== null).length,
    claimed: open.filter((r) => r.claimedBy !== null).length,
    digestMessageId: state.meta.digestMessageId,
    digestUnpinnedReportedAt: state.meta.unpinnedReportedAt,
    lastDailyPostDate: state.meta.lastDailyPostDate,
    leaseHeld: state.meta.syncLease !== null,
    credentials: deps.credentials.health(deps.now),
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: stale ? 503 : 200,
    headers: { "Content-Type": "application/json" },
  });
}
```

Returning **503 when stale** matters: it makes the endpoint usable by an uptime checker without anyone writing a rule about the JSON body.

- [ ] **Step 7: Write `src/index.ts`**

```ts
import { config } from "../config/config.js";
import { DiscordRest, makeDigestPublisher } from "./discord/rest.js";
import { CredentialProvider } from "./github/credentials.js";
import { handleHealth } from "./handlers/health.js";
import { handleInteraction } from "./handlers/interactions.js";
import { runTick } from "./handlers/scheduled.js";
import { assertMessageContentIntent } from "./handlers/startup.js";
import { RecordsObject } from "./store/do.js";
import type { Store } from "./store/types.js";

export { RecordsObject };

export interface Env {
  RECORDS: DurableObjectNamespace<RecordsObject>;
  META: KVNamespace;
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APP_ID: string;
  DISCORD_GUILD_ID: string;
  DISCORD_BOT_USER_ID: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_PUBLIC_TOKEN: string;
  /** "true" runs the full loop against live data and writes nothing. */
  READ_ONLY?: string;
}

function storeFor(env: Env): Store {
  const id = env.RECORDS.idFromName("v1");
  return env.RECORDS.get(id) as unknown as Store;
}

function credentialsFor(env: Env): CredentialProvider {
  return new CredentialProvider({
    appId: env.GITHUB_APP_ID,
    appInstallationId: env.GITHUB_APP_INSTALLATION_ID,
    appPrivateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
    publicToken: env.GITHUB_PUBLIC_TOKEN,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return handleHealth({
        store: storeFor(env),
        credentials: credentialsFor(env),
        now: Date.now(),
        staleBannerMs: config.staleBannerMs,
      });
    }

    if (url.pathname === "/interactions" && request.method === "POST") {
      return handleInteraction(request, {
        store: storeFor(env),
        config,
        publicKey: env.DISCORD_PUBLIC_KEY,
        now: () => Date.now(),
      });
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const rest = new DiscordRest(env.DISCORD_BOT_TOKEN);

    // Falsifiable, and checked every tick rather than only at deploy: someone can
    // turn the intent off in the portal at any time, and the symptom is silence.
    const intent = await assertMessageContentIntent(rest);
    if (!intent.ok) {
      console.error(`[${intent.code}] ${intent.detail}`);
      if (intent.code === "INTENT_MISSING") return;
    }

    const report = await runTick({
      store: storeFor(env),
      rest,
      credentials: credentialsFor(env),
      config,
      botUserId: env.DISCORD_BOT_USER_ID,
      now: Date.now(),
      readOnly: env.READ_ONLY === "true",
    });

    console.log(JSON.stringify({ tick: report }));
    ctx.waitUntil(Promise.resolve());
  },
};
```

The publisher factory has to reach the Durable Object. Add to `src/store/do.ts`, at the top of `finishTick` and `apply`, a lazy default so the object can build its own publisher from its env:

```ts
  private ensurePublisher(): void {
    if (this.publisherFactory !== null) return;
    this.publisherFactory = (env, config) =>
      makeDigestPublisher(new DiscordRest(env.DISCORD_BOT_TOKEN), env.DISCORD_GUILD_ID, config);
  }
```

Call `this.ensurePublisher()` before `this.publisher()` in both methods, and import `DiscordRest`/`makeDigestPublisher` from `../discord/rest.js`. `RecordsObjectEnv` already declares both bindings.

- [ ] **Step 8: Write the entry-point test**

`tests/workers/index.test.ts`:

```ts
import { env, createExecutionContext, waitOnExecutionContext, createScheduledController } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("fetch", () => {
  it("404s an unknown path", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://bot/nope"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(404);
  });

  it("serves /health and reports stale on a fresh store", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://bot/health"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { status: string; openRecords: number };
    expect(body.status).toBe("stale");
    expect(body.openRecords).toBe(0);
  });

  it("401s an interaction with no valid signature", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://bot/interactions", { method: "POST", body: '{"type":1}' }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });
});

describe("scheduled", () => {
  it("aborts the tick when the Message Content intent is missing", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      calls.push(String(input));
      if (String(input).includes("/applications/@me")) {
        return new Response(JSON.stringify({ id: "a", flags: 0 }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, ctx);
    await waitOnExecutionContext(ctx);

    // Only the intent check ran; no channel reads. (A GitHub-call assertion would
    // be vacuous here: this DO starts with zero records, so runTick's own
    // `openRecords.length > 0` guard already skips fetchSnapshots regardless of
    // the intent check — it isn't reachable either way in this fixture.)
    expect(calls.filter((c) => c.includes("/messages"))).toHaveLength(0);
  });
});
```

Add the test-only bindings to `wrangler.jsonc` under a `vars` block so the pool can construct `env`:

```jsonc
  "vars": {
    "DISCORD_BOT_TOKEN": "test-token",
    "DISCORD_PUBLIC_KEY": "00000000000000000000000000000000000000000000000000000000000000ff",
    "DISCORD_APP_ID": "test-app",
    "DISCORD_GUILD_ID": "test-guild",
    "DISCORD_BOT_USER_ID": "test-bot-user",
    "GITHUB_APP_ID": "1",
    "GITHUB_APP_INSTALLATION_ID": "2",
    "GITHUB_APP_PRIVATE_KEY": "unused-in-tests",
    "GITHUB_PUBLIC_TOKEN": "ghp_test"
  }
```

**These are placeholders for the test runtime only.** Real values are Worker secrets set with `wrangler secret put`, never in this file. Add a comment in `wrangler.jsonc` saying exactly that, because a `vars` block is where a real token most plausibly gets committed by accident.

- [ ] **Step 9: Write `scripts/register-commands.ts`**

```ts
/**
 * Registers guild-scoped commands, so they exist only in this server and updates
 * take effect immediately. Run with the app id, guild id and bot token in env.
 *
 *   npx tsx scripts/register-commands.ts            # /review-list only
 *   npx tsx scripts/register-commands.ts --all      # adds /review-request (plan 2)
 */
const REVIEW_LIST = {
  name: "review-list",
  description: "Show what is waiting for review, privately",
  type: 1,
};

const REVIEW_REQUEST = {
  name: "review-request",
  description: "Ask for a review on a pull request",
  type: 1,
};

const appId = process.env.DISCORD_APP_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const token = process.env.DISCORD_BOT_TOKEN;
if (appId === undefined || guildId === undefined || token === undefined) {
  console.error("Set DISCORD_APP_ID, DISCORD_GUILD_ID and DISCORD_BOT_TOKEN.");
  process.exit(1);
}

const commands = process.argv.includes("--all") ? [REVIEW_LIST, REVIEW_REQUEST] : [REVIEW_LIST];

const response = await fetch(
  `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`,
  {
    method: "PUT",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  },
);

if (!response.ok) {
  console.error(`Registration failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}
console.log(`Registered: ${commands.map((c) => `/${c.name}`).join(", ")}`);
```

`/review-list` is registered at deploy and `/review-request` only when moving past shadow mode. Registering the read-only command straight away is what makes it a real mitigation for a deleted or unpinned digest — during shadow mode the hand-pin is newest and most likely to be lost, which is precisely when the fallback is claimed to be available.

- [ ] **Step 10: Run the whole suite**

Run: `npm run typecheck && npm run lint && npm test && npm run preview`
Expected: all green. If the Workers pool complains about `RECORDS` not being defined in `env`, the `durable_objects` binding name in `wrangler.jsonc` does not match `Env`.

- [ ] **Step 11: Commit**

```bash
git add src/index.ts src/handlers/reviewList.ts src/handlers/health.ts src/handlers/startup.ts src/store/do.ts src/handlers/interactions.ts scripts/register-commands.ts wrangler.jsonc tests/workers/
git commit -m "feat: worker entry, /review-list, health endpoint and falsifiable intent assertion"
```

---

## Task 20: Documentation, ADRs, and the shadow-mode deploy

The deliverable of this task is a bot running in the real review channel, maintaining a pinned list, with the command not yet registered — rollout stage 2.

**Files:**
- Create: `README.md`, `docs/architecture.md`, `docs/setup.md`, `docs/operations.md`, `docs/architecture-decisions.md`
- Modify: `config/config.ts` (real channel and forum ids)

- [ ] **Step 1: Write `README.md`**

Usable in 30 seconds, written for a teammate rather than a maintainer. It must contain, in this order:

1. **What the pinned list is** — one paragraph: a message at the top of the review channel showing every PR still waiting, grouped by team, that updates itself and drops rows once someone has actually reviewed.
2. **How to get on it** — during shadow mode, nothing: post a PR link as usual and the bot picks it up. Later, `/review-request`.
3. **How to say you are reviewing something** — pick the PR from `Claim a PR ▾` on the pinned message. It moves to *Being reviewed*.
4. **How to get something off the list** — it leaves on its own when anyone reviews it, or on merge or close. `Resolve ▾` removes a row that was never a real request.
5. **`/review-list`** — the same list, privately, if the pin is missing.
6. **A data policy section**, verbatim in substance:

```markdown
## What this bot stores

For each PR posted to the review channel: the repository, number and title; who
asked and when; which team and urgency they chose; who claimed it and when; how
many times it was re-asked; and how it left the list.

Records are kept for **30 days after they leave the list**, then deleted. The
retention exists so "why did my row disappear?" has an answer.

The pinned list deliberately does **not** show how long someone has held a claim,
or how many times a PR has been re-asked. Those fields exist because the bot needs
them — auto-clearing an abandoned claim needs the timer, and detecting a
re-request needs the count — not because anyone should be reading them off a
public message.

This data will not be used to compare people, and no per-person reporting will be
built from it. If you want your own history removed, ask and it will be.
```

That last section is not decoration. The store is one query from a per-person latency leaderboard whether or not v1 builds one, so "no review-time analytics" is otherwise a promise about the roadmap rather than about the data.

- [ ] **Step 2: Write `docs/architecture.md`**

Enough that a newcomer can find where a given behavior lives:

- The two entry points (`POST /interactions`, `scheduled()`), and why there is no gateway connection.
- The three module seams and the rule that `core/` has no I/O — including that the lint config enforces it by banning `Date` there.
- The store's command interface, and **why** it is commands rather than a callback (a closure cannot cross a DO RPC boundary) and why the PATCH happens inside the store (record, message and hash written by the same tick).
- The two-store-subrequest invariant, with the numbers.
- The data flow: a link is posted → the tick scans it → GitHub is queried in chunks of 25 → the exit condition runs → the digest is rendered from committed state → the PATCH → the hash.
- A short table mapping each spec section to the file that implements it.

- [ ] **Step 3: Write `docs/setup.md`** — the runbook, in this exact order

The order is load-bearing; several steps fail confusingly if done early.

```markdown
1. Create the Discord application. Record the app ID, public key and bot token.
2. **Enable the MESSAGE CONTENT privileged intent** (Bot → Privileged Gateway
   Intents). Self-serve below 100 guilds. Without this the bot starts and then
   scans nothing, reporting an empty list — the deploy will refuse to tick with
   `INTENT_MISSING`.
3. **Verify the intent actually took, against the real application.** Call
   `GET /applications/@me` (with the bot token) and confirm bit 18
   (`FLAG_MESSAGE_CONTENT`, value 262144) or bit 19 (`FLAG_MESSAGE_CONTENT_LIMITED`,
   value 524288) is set in the returned `flags`. This step exists because those bit
   positions are knowledge-based, not confirmed by a documentation lookup during
   this plan's review — a lookup found Discord's *gateway intents* table, a
   different bitfield, and returned no application-flag values. Live data against
   the real application is the only real verification; do this before wiring
   anything else to the intent check.
4. Install to the server with scopes `bot` and `applications.commands`.
5. Apply channel permission overwrites limiting the bot to the review channel and
   the PRD forum. Permissions needed: Send Messages, Embed Links, Read Message
   History, View Channel. **Not** Manage Messages and **not** PIN_MESSAGES.
6. Create the GitHub App on the `paranext` org: "Pull requests: read" only,
   scoped to the allowlisted repos. Install it. Record the app ID and the
   installation ID.
7. Convert the App private key to PKCS#8 — GitHub issues PKCS#1, which Web
   Crypto cannot import:

       openssl pkcs8 -topk8 -nocrypt -in github-app.private-key.pem \
         -out github-app.pkcs8.pem

8. Create the public-read token on a **shared machine account, not a personal
   PAT**. Record its expiry date in docs/operations.md.
9. Fill in the three REPLACE_WITH_* values in config/config.ts and open a PR.
10. Create the KV namespace and put its id in wrangler.jsonc.
11. Set the Worker secrets (never in the repo):

        wrangler secret put DISCORD_BOT_TOKEN
        wrangler secret put DISCORD_PUBLIC_KEY
        wrangler secret put DISCORD_APP_ID
        wrangler secret put DISCORD_GUILD_ID
        wrangler secret put DISCORD_BOT_USER_ID
        wrangler secret put GITHUB_APP_ID
        wrangler secret put GITHUB_APP_INSTALLATION_ID
        wrangler secret put GITHUB_APP_PRIVATE_KEY   # the PKCS#8 pem
        wrangler secret put GITHUB_PUBLIC_TOKEN

12. Deploy with `READ_ONLY=true` first. Watch two or three ticks in
    `wrangler tail` and read the body it says it would post. Nothing is written.
13. Set `READ_ONLY=false`. Wait for the first refresh to post the digest, then
    **pin that message by hand**.
14. Set the Discord interactions endpoint URL to `https://<worker>/interactions`.
    Discord sends an unsigned probe and expects a 401, then a signed PING.
15. Register `/review-list` only:

        npx tsx scripts/register-commands.ts

    `/review-request` is registered with `--all` only when moving past shadow
    mode.
16. Confirm `https://<worker>/health` returns 200 with a recent `lastSync`.
```

- [ ] **Step 4: Write `docs/operations.md`**

One section per failure, each with the actual commands:

- **The digest was deleted.** The next tick recreates it and posts a note; someone must re-pin by hand. The bot cannot re-pin itself and deliberately lacks the permission.
- **The digest was unpinned.** Reported once per unpinning. Re-pin it; the latch resets automatically on the next tick that sees it pinned.
- **Rows are not leaving the list.** Check `/health` for `syncPaused` and `credentials`. A `failedClosed` credential means a 401 was seen and retrying has stopped by design — fix the credential and redeploy to reset it.
- **The list has gone stale.** `/health` returns 503 with `lastSyncAgeMs`. Check `wrangler tail` for a lease that is stuck; a lease older than 15 minutes is broken automatically.
- **Rotating credentials.** Which secret, what the blast radius is, and that the App private key age (not a token expiry) is the number to watch. **Track the key's age by hand, in this document** (record the date it was created or last rotated): `/health` reports `credentials.app.tokenExpiresInMs`, an installation-token expiry, never a key age — key creation time is not derivable from a PEM, so the endpoint has no way to report it. A key rotated late is caught by whoever reads this document, not by the health endpoint.
- **Adding a repo, adding a team.** A one-line PR to `config/config.ts`.
- **Store data lost.** The documented rebuild: re-scan the lookback window and read the bot's own past request messages.
- **The named second owner.** Secrets, the Cloudflare account and Discord permissions must be held by at least two people. **Name them here.** Otherwise the tool dies the first time its author is on leave and the digest gets deleted.

- [ ] **Step 5: Write `docs/architecture-decisions.md`**

Append-only `adr-<slug>` entries matching the format of `paranext-core`'s `.context/standards/Architecture-Decisions.md`, each with Context / Decision / Alternatives rejected. Write these entries:

- `adr-no-repo-automation` — opening a PR must stay separate from requesting review. Record explicitly that the earlier "a workflow in every repo" rationale was false, so nobody re-derives it.
- `adr-exit-condition` — review events, not `reviewDecision`; the three author filters. **Include the findings from Task 4 Step 5's verification against real PRs.**
- `adr-two-github-credentials` — App for `paranext`, machine token elsewhere, routed by owner.
- `adr-embed-rendering` — embed over plain content, with the capacity numbers and the long-form-timestamp consequence.
- `adr-scanning-as-permanent-fallback` — not just for shadow mode.
- `adr-store-command-interface` — why commands rather than a callback, and why the PATCH is inside the store.
- `adr-long-form-timestamps` — that `3d` is unreachable with `<t:…:R>`, and that the write-skip is what the long form buys.
- `adr-per-person-data-off-the-render` — claim age and `re-asked` stay in the store, and why.
- `adr-daily-post` — the delivery layer, and why it is not the per-person nudge the non-goals exclude.

- [ ] **Step 6: Deploy in read-only mode and read three ticks**

Run:

```bash
wrangler secret put READ_ONLY   # value: true
npm run deploy
wrangler tail --format pretty
```

Expected: three consecutive ticks logging `[read-only] would render:` with a body that matches what the preview harness showed, `syncOk: true`, and a subrequest count well under 50. **Do not proceed until a tick has run clean.** This is the last checkpoint before the bot writes to a real channel.

- [ ] **Step 7: Go live in shadow mode and pin the digest**

```bash
wrangler secret put READ_ONLY   # value: false
npm run deploy
```

Wait for one tick, then pin the posted message by hand. Confirm `/health` returns 200.

- [ ] **Step 8: Register `/review-list` and verify the fallback works**

```bash
DISCORD_APP_ID=... DISCORD_GUILD_ID=... DISCORD_BOT_TOKEN=... npx tsx scripts/register-commands.ts
```

Then run `/review-list` in the channel and confirm it returns the same content ephemerally.

- [ ] **Step 9: Start the shadow-mode measurement**

Shadow mode's question is narrow and its threshold is agreed in advance: *does the list stay accurate on its own?* Measured by logging, daily:

- every row still listed 30 minutes after a review landed, and
- every hand-posted PR that never appeared.

**Two or more of either means fix before proceeding.** Jolie checks the log daily — without a named observer this stage measures nothing.

Note the honest limits, and write them at the top of the log so they are not forgotten: every row is scanned, so every row lands in **Needs triage**. Team grouping, urgency ordering and PRD rendering get **no** real-world exercise here, and team grouping is the primary design axis. Shadow mode validates the sync loop — the half that silently corrupts trust.

**At sprint end, ask two teammates cold what the oldest thing waiting for review is.** If neither can answer, the delivery problem is real and the daily post must be working before the command is enabled.

- [ ] **Step 10: Commit**

```bash
git add README.md docs/ config/config.ts
git commit -m "docs: README with data policy, architecture, setup runbook, operations and ADRs"
```

---

## What this plan deliberately does not build

Named so a reviewer can tell a gap from a decision:

- **`/review-request`, the modal, and the PRD thread cache** — plan 2. `renderRequestMessage` and the `upsertRequest` command are built and tested here, so plan 2 is the modal plus validation and nothing structural.
- **The `:code_review:` reaction claim path** — plan 3, including the per-tick read budget, the first-write-wins arbitration against a menu claim, and the rule that a message producing two records is skipped entirely. The claim rules those depend on are already built and tested in Task 6.
- **Refresh loop steps 7 and 8** (PRD cache refresh, reaction reads) — the numbering in `src/handlers/scheduled.ts` skips them with a comment, so the spec's step numbers still line up.
- **Multi-channel** — one channel in v1. With a global record set and a per-channel digest it is undefined whether channel B shows channel A's rows, and either answer creates a problem.
- **The same PR needing two teams' review** — collapses to one row, since identity is `owner/repo/number`. `General` is the workaround.

## Plan self-review

Run before executing, recorded here so the reviewer can check the checker.

**Spec coverage.** Every section of the spec maps to a task, or to a named deferral above: Exit condition → 4; Architecture → 19; Configuration → 1; Authoring flow → plan 2, except the record transitions (3) and the request message (9); Reopening → 3, 11; The posted request message → 9; The pinned digest → 7, 8; Refresh loop → 17, with steps 7–8 deferred; Rendering reads the committed state → 12; Data model → 3, 11; Claiming and removal → 6, 18; Message scanning → 14; Failure modes → 12, 15, 16, 17; Permissions and security → 13, 19, 20; Hosting constraints → 1, 12, 17; Monitoring → 19; `/review-list` → 19; Testing → every task, plus 10 and 16 for the harness and recorded fixtures; Preview harness → 10; Rollout → 20; Documentation → 20; Setup runbook → 20.

**Two gaps found and closed while reviewing.** The spec's `Resolve ▾` offers recently-resolved rows as `Reopen ▾`, which Task 8's original renderer had no way to produce — fixed as Task 18 Step 4, including the consequence for the empty-state assertion. And the digest header's own `updated` timestamp would have changed every second, defeating the write-skip the whole design rests on — fixed as Task 8 Step 5, with its own regression test.

**One thing left open on purpose.** `config.immediateDigestRewrite` defaults to `true`, which is correct on a paid Cloudflare plan or a container host and wrong on the free plan. Task 20's runbook does not decide it, because the spec defers hosting. Whoever deploys must set it, and the flag exists so that is a config change rather than a rewrite.

**Type consistency.** `PrRecord`, `recordId`, `prSlug`, `PrSnapshot`, `ReviewEvent`, `Row`, `Command`, `CommandResult`, `StoreState`, `Meta`, `DigestPublisher`, `DigestPayload`, `DigestOutcome`, `Store` and `Config` are each defined in exactly one task and imported by name thereafter. `recordId` and `prSlug` both produce the lowercased `owner/repo/number` identity — `prSlug` takes a `ParsedPr`, `recordId` takes a record; they are not two spellings of one function.
