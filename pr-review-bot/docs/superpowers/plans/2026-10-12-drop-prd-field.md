# Drop the PRD Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the PRD field, along with its private-server forum fetch and its cached thread list, so that the bot runs entirely from the public Discord server.

**Architecture:** The plan is pure removal, in four commits:
- **Task 1** retires the cron's PRD fetch (refresh-loop step 7).
- **Task 2** removes the field from the request flow: modal, parser, record, renderers and preview.
- **Task 3** drops the now-unused `Meta.prdCache` and adds schema migration 4 → 5, which deletes every stored PRD value.
- **Task 4** updates the docs.

Every task leaves `npm test`, `npm run typecheck` and `npm run lint` green.

**Tech Stack:** TypeScript, Cloudflare Workers and Durable Objects, vitest (`@cloudflare/vitest-plugin`), ESLint.

**Spec:** `docs/superpowers/specs/2026-10-12-drop-prd-field-design.md`

## Global Constraints

- The bot talks to one Discord server, `DISCORD_GUILD_ID`, which is the public server.
- **Refresh-loop steps are NOT renumbered.** Step 7 becomes the one-line comment `// 7. (Retired 2026-10-12 — was the PRD thread cache refresh.)`. Steps 8, 9 and the log tag `[REACTIONS] step 8 aborted` keep their numbers.
- `CURRENT_SCHEMA_VERSION` becomes **5**. The 2→3 migration step is left exactly as it is, still writing `prdCache: null`.
- Existing ADR text is not rewritten. Only dated **Amendment (2026-10-12)** paragraphs are added.
- Earlier specs and plans under `docs/superpowers/` are not edited.
- Unused bindings use a leading `_`, as ESLint's `varsIgnorePattern: "^_"` allows.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```

## Review Focus

1. **A modal opened before the deploy and submitted after it** sends a `prd` key. It must parse exactly as if the key were absent. *Task 2, stray-key test.*
2. **A "Fix and retry" stash written before the deploy** holds `values.prdThreadId`. After migration the stash keeps every other value, and the retry modal opens with four fields. *Task 3 migration test; Task 2 prefill test.*
3. **Unversioned (v1) state** must still walk the whole chain and end at v5 with no `prdCache` key, even though 2→3 writes one. *Task 3.*
4. **A record that had a PRD**, once migrated, renders a digest row with no `<#` mention. *Task 2 digest test; Task 3 migration test.*
5. **The reaction allowance boundaries** (zero allowance, and the last single unit) must still be hit exactly once the PRD fetch's 2 subrequests are gone. *Task 1, re-derived record counts.*

---

### Task 1: Retire refresh-loop step 7 (the PRD thread fetch)

**Files:**
- Delete: `src/discord/threads.ts`, `tests/workers/threads.test.ts`
- Modify: `src/handlers/scheduled.ts` (imports at line 8, `TickDeps` at lines 21–23, step 7 at lines 265–275)
- Modify: `src/index.ts:135`
- Modify: `src/discord/rest.ts` (line 2 import, lines 189–212)
- Modify: `config/config.ts` (`prdForumChannelId` at lines 17 and 63)
- Modify: `tests/core/fixtures.test.ts` (delete lines 37 to end)
- Test: `tests/workers/scheduled.test.ts`

**Interfaces:**
- Produces: `TickDeps` without `guildId`, and `Config` without `prdForumChannelId`. `src/core/prd.ts` still exists after this task, because `Meta.prdCache` and the modal use it until Tasks 2 and 3.

- [ ] **Step 1: Write the failing test.** In `tests/workers/scheduled.test.ts`, replace the whole `describe("refresh loop step 7 — the PRD cache", ...)` block (lines 739–789) with:

```ts
describe("refresh loop step 7 — retired", () => {
  it("never requests a Discord threads route", async () => {
    // Step 7 used to list a PRD forum's threads on another server. The bot now
    // runs on the public server only, so no tick may touch a threads route.
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("api.github.com/graphql")) return new Response(JSON.stringify({ data: {} }), { status: 200 });
      if (url.includes("/messages/pins")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.includes("/messages")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const store = new MemoryStore(config, makePublisher().publisher, seeded([record(1)]));

    await runTick(deps(store));

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((u) => u.includes("/threads"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails.**

Run: `npx vitest run tests/workers/scheduled.test.ts -t "never requests a Discord threads route"`
Expected: FAIL. The filtered list contains `.../guilds/g-1/threads/active` and `.../threads/archived/public?limit=25`.

- [ ] **Step 3: Remove step 7 from `src/handlers/scheduled.ts`.**

Delete the import line `import { fetchPrdThreads } from "../discord/threads.js";`.

In `TickDeps`, delete these three lines:

```ts
  /** For `GET /guilds/{id}/threads/active`, which has no channel-scoped
   *  equivalent — step 7 must ask guild-wide and filter. */
  guildId: string;
```

Replace the whole step-7 block (from `// 7. Refresh the cached PRD thread list.` through the `console.log(\`[PRD_CACHE] ...\`);` line) with this single line, followed by the existing blank line before `// 8.`:

```ts
    // 7. (Retired 2026-10-12 — was the PRD thread cache refresh.)
```

- [ ] **Step 4: Remove the other step-7 plumbing.**

- In `src/index.ts`, delete the line `      guildId: env.DISCORD_GUILD_ID,` (line 135). `DISCORD_GUILD_ID` stays in `env.d.ts`, because `src/store/do.ts` still uses it for jump links.
- In `src/discord/rest.ts`, delete `getActiveThreads` and `getArchivedPublicThreads`, together with their doc comments (the whole span from `/**\n   * Guild-wide, NOT per-channel` through the closing `}` of `getArchivedPublicThreads`). Also delete `import type { RawThread } from "../core/prd.js";` at line 2.
- In `config/config.ts`, delete `  prdForumChannelId: string;` from `Config` and `  prdForumChannelId: "REPLACE_WITH_PRD_FORUM_ID",` from `config`.
- Run: `git rm src/discord/threads.ts tests/workers/threads.test.ts`

In `tests/core/fixtures.test.ts`, delete everything from `const T0 = 1_756_000_000_000;` (line 37) to the end of the file. That is the guarded *PRD thread fixtures* block. The *fixture scenarios* block above it stays. Then replace the imports at the top of the file with exactly:

```ts
import { describe, expect, it } from "vitest";
import { config } from "../../config/config.js";
import { SCENARIOS } from "../../fixtures/records.js";
import { renderDigest, EMBED_DESCRIPTION_LIMIT, EMBED_TOTAL_LIMIT } from "../../src/core/render/digest.js";
```

- [ ] **Step 5: Remove the thread stubs from `tests/workers/scheduled.test.ts`.**

Delete the `threadsFail` declaration and its doc comment (lines 67–69).

Replace the doc comment on `stubAll` with:

```ts
/** Routes stubbed fetch by url: GitHub GraphQL vs Discord pins vs Discord
 *  messages. */
```

Inside `stubAll`, delete both thread branches: the `if (/\/guilds\/[^/]+\/threads\/active(\?|$)/...` block and the `if (/\/channels\/[^/]+\/threads\/archived\/public(\?|$)/...` block.

In `afterEach`, delete `  threadsFail = false;`.

In `deps()`, delete `    guildId: "g-1",`.

In the `stubRestWithReactions` doc comment, change `the
 *  other routes (scan, PRD threads, GitHub)` to `the
 *  other routes (scan, GitHub)`.

- [ ] **Step 6: Re-derive the subrequest arithmetic in `tests/workers/scheduled.test.ts`.**

The exact-count test (around line 473) becomes:

```ts
    // The design invariant is "at most TWO store subrequests per tick, independent
    // of record count" — `< 50` would also pass a regression that read the store
    // once per record. Pin the exact count: 1 beginTick + 2 GraphQL chunks (40
    // records, chunked to 25) + 1 scan page (no messages) + 10 reaction reads
    // (step 8, capped by `reactionReadsPerTick`, since all 40 records are open,
    // unclaimed, and eligible) + 1 finishTick.
    expect(report.subrequests).toBe(15);
```

The lease-releasing apply test (around line 704) becomes:

```ts
    // 1 beginTick + 1 GraphQL chunk (1 record) + 1 scan page (no messages) +
    // 1 reaction read (step 8: the one record is open, unclaimed and eligible)
    // + 1 lease-releasing apply = 5. Undercounting would report 4.
```

with `expect(report.subrequests).toBe(5);`.

The shedding test (900 records) gets a new comment. Its assertions are unchanged:

```ts
    // 900 records -> ceil(900/25) = 36 GraphQL chunks. Before step 8: 1
    // (beginTick) + 36 (GraphQL) + 1 (scan, no messages) = 38 spent.
    // allowance = min(10, 50 - 38 - 5) = 7, so 3 of the budget's 10 is shed.
```

In *"skips step 8 entirely when the allowance is zero"*, change both `1050` literals to `1100`, and change the comment to:

```ts
    // 1100 records -> ceil(1100/25) = 44 chunks -> 1 + 44 + 1 (scan) = 46 spent
    // before step 8. allowance = min(10, 50 - 46 - 5) = min(10, -1) clamped to 0.
```

In *"does not start a two-subrequest read on the last single unit of allowance"*, change `length: 1000` to `length: 1050`, and change the first lines of the comment to:

```ts
    // 1050 records -> ceil(1050/25) = 42 GraphQL chunks -> 1 (beginTick) + 42 +
    // 1 (scan) = 44 spent, so allowance = min(10, 50 - 44 - 5)
    // = 1. Every record here is claimed by reaction with its holder absent, so
```

Leave the rest of that comment as it is.

Finally, run `grep -n "PRD\|thread" tests/workers/scheduled.test.ts`. Remove any remaining arithmetic mention of PRD threads. The only hits that may remain are the new retired-step test.

- [ ] **Step 7: Run the full suite, typecheck and lint.**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass. If either boundary test fails, recompute its "spent" figure from the actual `report.subrequests` before changing anything else. The record counts above assume one scan page and no messages, which is what `stubAll` returns.

- [ ] **Step 8: Commit.**

```bash
git add -A src config tests
git commit -m "feat: retire refresh-loop step 7, the private-server PRD thread fetch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Remove the PRD from the request flow, records, renderers and preview

**Files:**
- Modify: `src/core/submit.ts`, `src/handlers/modal.ts`, `src/handlers/reviewRequest.ts`, `src/core/record.ts`
- Modify: `src/core/render/request.ts:24`, `src/core/render/digest.ts:79`, `src/core/render/rejection.ts:93`
- Modify: `preview/build.ts`, `fixtures/records.ts`
- Test: `tests/core/modal.test.ts`, `tests/core/submit.test.ts`, `tests/core/render/{request,digest,rejection}.test.ts`, `tests/core/record.test.ts`, `tests/store/apply.test.ts`, `tests/workers/do.test.ts`, `tests/workers/scheduled.test.ts`, `tests/workers/reviewRequest.test.ts`, `tests/core/__snapshots__/fixtures.test.ts.snap`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `buildRequestModal(config: Config, prefill?: SubmittedValues): InteractionResponse`.
  - `SubmittedValues = { url; team; urgency; note }`.
  - `FIELD_IDS = { url, team, urgency, note }`.
  - `PrRecord` and `RequestFields` without `prdThreadId`.
  - `PRD_NONE` and `SNOWFLAKE` no longer exist.

- [ ] **Step 1: Write the failing tests.**

Replace `tests/core/modal.test.ts` in full with:

```ts
import { describe, expect, it } from "vitest";
import { config } from "../../config/config.js";
import type { Config } from "../../config/config.js";
import { buildRequestModal } from "../../src/handlers/modal.js";
import { FIELD_IDS, MODAL_ID, NOTE_MAX_LENGTH, URL_MAX_LENGTH } from "../../src/core/submit.js";

// The payload is a nested tree; these read one field out of it by custom_id.
function field(response: ReturnType<typeof buildRequestModal>, id: string) {
  const labels = (response.data?.components ?? []) as { label: string; description?: string; component: Record<string, unknown> }[];
  return labels.find((l) => l.component["custom_id"] === id)!;
}

function customIds(response: ReturnType<typeof buildRequestModal>): unknown[] {
  return ((response.data?.components ?? []) as { component: Record<string, unknown> }[]).map((l) => l.component["custom_id"]);
}

const PREFILL = {
  url: "https://github.com/paranext/paranext-core/pull/9",
  team: "Simple",
  urgency: "blocking",
  note: "just the CSS bit",
};

describe("buildRequestModal", () => {
  it("is a callback type 9 with the modal's custom_id and exactly four components", () => {
    const modal = buildRequestModal(config);
    expect(modal.type).toBe(9);
    expect(modal.data?.custom_id).toBe(MODAL_ID);
    expect(modal.data?.components).toHaveLength(4);
  });

  it("has no PRD field, fresh or prefilled — the PRD forum lived on a server the bot no longer reaches", () => {
    expect(customIds(buildRequestModal(config))).toEqual(["url", "team", "urgency", "note"]);
    expect(customIds(buildRequestModal(config, PREFILL))).toEqual(["url", "team", "urgency", "note"]);
  });

  it("wraps every input in a Label (type 18) — string selects are invalid in an action row in modals", () => {
    const modal = buildRequestModal(config);
    const labels = modal.data?.components as { type: number }[];
    expect(labels.every((l) => l.type === 18)).toBe(true);
  });

  it("puts the note requirement on the blocking urgency OPTION, not on the note field", () => {
    const modal = buildRequestModal(config);
    const urgency = field(modal, FIELD_IDS.urgency);
    const blocking = (urgency.component["options"] as { value: string; description?: string }[]).find(
      (o) => o.value === "blocking",
    );
    expect(blocking?.description).toContain("note");
    // `required` is static in the payload Discord renders before any choice is
    // made, so the note field itself must stay optional and the rule is enforced
    // on submit.
    expect(field(modal, FIELD_IDS.note).component["required"]).toBe(false);
  });

  it("prefills the text inputs and marks the chosen select options default", () => {
    const modal = buildRequestModal(config, PREFILL);
    expect(field(modal, FIELD_IDS.url).component["value"]).toBe("https://github.com/paranext/paranext-core/pull/9");
    expect(field(modal, FIELD_IDS.note).component["value"]).toBe("just the CSS bit");
    const team = (field(modal, FIELD_IDS.team).component["options"] as { value: string; default?: boolean }[]).find(
      (o) => o.value === "Simple",
    );
    expect(team?.default).toBe(true);
    const urgency = (
      field(modal, FIELD_IDS.urgency).component["options"] as { value: string; default?: boolean }[]
    ).find((o) => o.value === "blocking");
    expect(urgency?.default).toBe(true);
  });

  it("declares Discord's own max_length on the URL and note inputs", () => {
    // Discord's text input accepts up to 4000 characters with no cap declared,
    // which is what let a rejection's stashed note or URL threaten the retry
    // stash's 128 KiB Durable Object value and the digest's per-row render
    // budget. This is the client-side half of the fix — the record write in
    // `reviewRequest.ts` is the trust boundary the modal alone cannot be.
    const modal = buildRequestModal(config);
    expect(field(modal, FIELD_IDS.url).component["max_length"]).toBe(URL_MAX_LENGTH);
    expect(field(modal, FIELD_IDS.note).component["max_length"]).toBe(NOTE_MAX_LENGTH);
  });

  it("clamps every string to its documented cap", () => {
    // Drives a genuinely long string into every position that CAN be driven
    // long through the public parameters: config's team/urgency entries feed
    // the Team and Urgency selects' option label/value, and the prefill feeds
    // the text inputs. `title`, every field's Label.label, every
    // Label.description, and the urgency option's "requires a note"
    // description are all fixed literals in the implementation, disconnected
    // from any parameter, so no input can drive THEM over cap — the walk below
    // still asserts their caps so a future change to one of those literals is
    // caught.
    const longConfig: Config = {
      ...config,
      teams: ["T".repeat(400) as unknown as Config["teams"][number]],
      urgencies: [
        {
          key: "blocking",
          emoji: "🔥",
          label: "L".repeat(400),
          rank: 0,
          requiresNote: true,
        },
      ],
    };
    const modal = buildRequestModal(longConfig, {
      url: "u".repeat(5000),
      team: "Power",
      urgency: "soon",
      note: "x".repeat(5000),
    });

    expect((modal.data?.title ?? "").length).toBeLessThanOrEqual(45);

    const labels = (modal.data?.components ?? []) as {
      label: string;
      description?: string;
      component: Record<string, unknown>;
    }[];
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) {
      expect(l.label.length).toBeLessThanOrEqual(45);
      expect((l.description ?? "").length).toBeLessThanOrEqual(100);

      const options = l.component["options"] as
        | { label: string; value: string; description?: string }[]
        | undefined;
      if (options) {
        expect(options.length).toBeGreaterThan(0);
        for (const o of options) {
          expect(o.label.length).toBeLessThanOrEqual(100);
          expect(o.value.length).toBeLessThanOrEqual(100);
          expect((o.description ?? "").length).toBeLessThanOrEqual(100);
        }
      }

      const value = l.component["value"];
      if (typeof value === "string") {
        expect(value.length).toBeLessThanOrEqual(4000);
      }
    }
  });
});

describe("buildRequestModal — urgency option labels", () => {
  const noEmoji: Config = {
    ...config,
    urgencies: config.urgencies.map((u) => (u.key === "soon" ? { ...u, emoji: null } : u)),
  };

  function urgencyOptions(cfg: Config) {
    return field(buildRequestModal(cfg), FIELD_IDS.urgency).component["options"] as {
      value: string;
      label: string;
    }[];
  }

  it("labels a no-emoji level with its bare label, with no leading space", () => {
    expect(urgencyOptions(noEmoji).find((o) => o.value === "soon")?.label).toBe("Soon");
  });

  it("keeps the emoji on levels that have one", () => {
    expect(urgencyOptions(noEmoji).find((o) => o.value === "blocking")?.label).toBe("🔥 Blocking");
  });

  it("derives the note hint from the level that requires one, rather than hardcoding it", () => {
    // A hardcoded "🔥 Blocking" in the hint goes stale the moment that level's
    // emoji or label changes — which is exactly what this branch does.
    const renamed: Config = {
      ...config,
      urgencies: config.urgencies.map((u) => (u.requiresNote ? { ...u, emoji: "🚨", label: "Urgent" } : u)),
    };
    expect(field(buildRequestModal(renamed), FIELD_IDS.note).description).toContain("🚨 Urgent");
  });
});
```

Then make these changes in `tests/core/submit.test.ts`:

- In `submitted()`, delete `    prd: "none",` from `values`, and delete the `{ type: 18, component: { type: 3, custom_id: "prd", ... } },` entry from the returned array.
- Delete these five tests outright: *"maps the None sentinel to a null PRD"*, *"keeps a chosen PRD thread id"*, *"treats an explicit empty-string PRD the same as the None sentinel"*, *"drops a PRD value that is not a snowflake instead of carrying it into the record"* and *"drops a PRD value one digit past a snowflake's width"*.
- In *"defaults every field when the submission carries none of them"*, change the expectation to `{ url: "", team: "", urgency: "", note: "" }`.
- Add this test at the end of the `describe("parseSubmission", ...)` block:

```ts
  it("ignores a stray `prd` field from a modal opened before the PRD field was removed", () => {
    // A form opened on the old build and submitted on the new one still carries
    // the PRD select. The parser reads fields by key, so the extra one must make
    // no difference at all — not a rejection, and not an extra value.
    const stray = [
      ...submitted(),
      { type: 18, component: { type: 3, custom_id: "prd", values: ["1075535230087221248"] } },
    ];
    const withStray = parseSubmission(stray, config);
    const without = parseSubmission(submitted(), config);
    expect(withStray).toEqual(without);
    expect(withStray.ok).toBe(true);
    expect(Object.keys(withStray.values)).toEqual(["url", "team", "urgency", "note"]);
  });
```

- [ ] **Step 2: Run the tests and confirm they fail.**

Run: `npx vitest run tests/core/modal.test.ts tests/core/submit.test.ts`
Expected: FAIL. The modal has 5 components, including `prd`, and `values` still carries `prdThreadId`.

- [ ] **Step 3: Remove the PRD from `src/core/submit.ts`.**

- Delete `  prdThreadId: string | null;` from `SubmittedValues`.
- Change `/** The modal's five field custom_ids` to `/** The modal's four field custom_ids`, and delete `  prd: "prd",` from `FIELD_IDS`.
- Delete the `PRD_NONE` doc comment and constant (`/** The PRD select's "no PRD" option.` … `export const PRD_NONE = "none";`).
- Delete the `SNOWFLAKE` doc comment and constant (`/**\n * A Discord snowflake, which is what a PRD thread id is:` … `const SNOWFLAKE = /^\d{1,20}$/;`).
- In `parseSubmission`, delete `  const prd = raw[FIELD_IDS.prd] ?? PRD_NONE;`. In the `values` literal, delete the five-line comment beginning `// The None sentinel, an empty select,` and the line `    prdThreadId: prd !== PRD_NONE && SNOWFLAKE.test(prd) ? prd : null,`.

- [ ] **Step 4: Remove the PRD select from `src/handlers/modal.ts`.**

Change the imports to:

```ts
import type { Config } from "../../config/config.js";
import { FIELD_IDS, MODAL_ID, NOTE_MAX_LENGTH, URL_MAX_LENGTH, type SubmittedValues } from "../core/submit.js";
import { CallbackType, type InteractionResponse } from "../discord/components.js";
import { noteRequiredLevel, urgencyText } from "../core/urgency.js";
```

Replace the doc comment and the start of `buildRequestModal` — from `/**\n * The \`/review-request\` modal, built ENTIRELY from cached data.` through the `prdNote` declaration's closing `: undefined;` — with:

```ts
/**
 * The `/review-request` modal, built from config alone.
 *
 * Nothing here may fetch or read the store. A modal cannot be sent after a
 * deferred response, so if the 3-second budget is missed the user sees "The
 * application did not respond" on the primary command with no escape hatch —
 * any live call on this path is a latent outage.
 */
export function buildRequestModal(config: Config, prefill?: SubmittedValues): InteractionResponse {
```

In the `components` array, delete the line `        label("PRD", prdNote, select(FIELD_IDS.prd, prdOptions, prefill?.prdThreadId ?? PRD_NONE)),`.

- [ ] **Step 5: Update `src/handlers/reviewRequest.ts`.**

Replace `openRequestModal` and its doc comment with:

```ts
/** Built from config alone — see `buildRequestModal`. Reads nothing: the modal
 *  has a 3-second budget and needs nothing from the store. */
export async function openRequestModal(deps: RequestDeps, prefill?: SubmittedValues): Promise<InteractionResponse> {
  return buildRequestModal(deps.config, prefill);
}
```

In the `fields: RequestFields` literal, delete `    prdThreadId: parse.values.prdThreadId,`.

- [ ] **Step 6: Remove the field from records and renderers.**

- `src/core/record.ts`: delete `  prdThreadId: string | null;` from `PrRecord` (line 25) and from `RequestFields` (line 86), and delete `    prdThreadId: null,` from `newScannedRecord` (line 175).
- `src/core/render/request.ts`: delete `  if (r.prdThreadId !== null) attribution.push(\`<#${r.prdThreadId}>\`);`.
- `src/core/render/digest.ts`: delete `  if (r.prdThreadId !== null) sub.push(\`<#${r.prdThreadId}>\`);`.
- `src/core/render/rejection.ts`: delete the line `    ...(values.prdThreadId === null ? [] : [\`> **PRD:** <#${clamp(values.prdThreadId, 40)}>\`]),`.

- [ ] **Step 7: Update the preview and fixtures.**

`fixtures/records.ts`:
- Delete `  prdThreadId?: string | null;` from `MakeInput`.
- Delete `    prdThreadId: input.prdThreadId ?? null,` from `make()`.
- Delete the four-line `// "t-trust" is a placeholder thread id…` comment above the first `ordinaryDay` entry.
- Delete `, prdThreadId: "t-trust"` from that entry.

`preview/build.ts`:
- Delete the `import type { PrdCache } from "../src/core/prd.js";` line.
- Delete `prdThreadId: "1075535230087221248",` from `REJECTION_VALUES`.
- Replace everything (this span includes `FULL_CACHE`, `TRUNCATED_CACHE` and the old `PREFILL`) from the comment `// The four cache states the modal is actually built from:` through the end of the `modals` array with:

```ts
// The two states the modal is built in: a fresh request, and a "Fix and retry"
// prefill.
const PREFILL: SubmittedValues = {
  url: "https://github.com/paranext/paranext-core/pull/2701",
  team: "Power",
  urgency: "blocking",
  note: "needs a P10 build before Thursday's demo",
};

const modals: ModalSpecimen[] = [
  {
    key: "modal-fresh",
    label: "Modal — fresh",
    description: "A new request: nothing prefilled.",
    response: buildRequestModal(config),
  },
  {
    key: "modal-prefill",
    label: "Modal — prefilled retry",
    description: "\"Fix and retry\": every field carries back exactly what the requester typed, unmodified.",
    response: buildRequestModal(config, PREFILL),
  },
];
```

`FIXTURE_NOW` stays imported, because line 137 still uses it.

- [ ] **Step 8: Update the remaining tests.**

`tests/core/render/request.test.ts`:
- Delete `    prdThreadId: "t-1",` from `rec()`.
- Replace *"renders the PRD as a thread mention and names the requester"* with:
  ```ts
  it("names the requester and mentions no channel", () => {
    const body = renderRequestMessage(rec(), baseConfig);
    expect(body).toContain("<@u-1>");
    expect(body).not.toContain("<#");
  });
  ```
- Delete *"omits the PRD line entirely when there is none"* and *"omits 'requested by' when the requester is unknown, keeping the PRD mention"*.
- In *"omits the attribution line entirely when there is neither a PRD nor a requester"*:
  - rename it to `"omits the attribution line entirely when the requester is unknown"`;
  - change its call to `renderRequestMessage(rec({ requesterId: null }), baseConfig)`;
  - change its first comment line to `// The requester is the attribution line's only part, so the line must not`.

`tests/core/render/digest.test.ts`:
- Replace *"renders the PRD as a thread mention that follows renames"* with:
  ```ts
  it("renders no channel mention in a row", () => {
    const body = renderDigest({ records: [rec(1, { team: "Power", urgency: "soon" })], ...FRESH })
      .embeds.map((e) => e.description).join("\n");
    expect(body).not.toContain("<#");
  });
  ```
- Delete `, prdThreadId: "t-1"` at line 613.

`tests/core/render/rejection.test.ts`:
- Delete `  prdThreadId: "t-1",` from `values`.
- Delete *"omits the PRD line when prdThreadId is null"*.
- In the worst-case test, delete `        prdThreadId: "p".repeat(900),` and replace its comment with:
  ```ts
    // Every echoed field (url, team, urgency, note) is clamped individually at
    // the source in rejection.ts — these per-field clamps are what keep the
    // message under Discord's 2000-character limit. Every field below is driven
    // past its own clamp so that widening or dropping any single clamp would
    // move content.length and trip this test. WORST_CASE_BOUND is the true
    // worst case (about 1565 with all clamps applied, since the 55-character PRD
    // line is gone) plus a margin — it is the alarm if a field clamp is raised,
    // a field is added to the echo, or the headline is significantly expanded.
  ```
  Leave `WORST_CASE_BOUND = 1700`.

`tests/core/record.test.ts`:
- Delete `    prdThreadId: null,` (line 24) and `    prdThreadId: "thread-1",` (line 114).
- Rename *"has no team, urgency, prd or note, because nobody supplied them"* to `"has no team, urgency or note, because nobody supplied them"`, and delete `    expect(r.prdThreadId).toBeNull();`.

`tests/store/apply.test.ts`: delete `  prdThreadId: null,` (line 18) and `      prdThreadId: "t-1",` (line 109), and change `VALUES` (line 447) to `{ url: "https://x", team: "Power", urgency: "soon", note: "" }`.

`tests/workers/do.test.ts` and `tests/workers/scheduled.test.ts`: remove `prdThreadId: null, ` from every `fields: {...}` literal:

```bash
sed -i '' 's/prdThreadId: null, //' tests/workers/do.test.ts tests/workers/scheduled.test.ts
```

`tests/workers/reviewRequest.test.ts`:
- Replace the whole `describe("openRequestModal", ...)` block with:
  ```ts
  describe("openRequestModal", () => {
    it("answers with a modal without fetching or reading the store", async () => {
      const store = new MemoryStore(config, publisher());
      let reads = 0;
      const readState = store.readState.bind(store);
      store.readState = () => { reads += 1; return readState(); };

      const response = await openRequestModal(deps(store));

      expect(response.type).toBe(9);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(reads).toBe(0);
    });
  });
  ```
- In `submission()`, add a comment above the `const v = ...` line, and keep `prd: "none"` as it is:
  ```ts
    // `prd` is deliberately still sent: a modal opened before the PRD field was
    // removed submits it, and every test here proves it is ignored.
  ```

- [ ] **Step 9: Run the tests, then regenerate the digest snapshot.**

Run: `npx vitest run --project=core -u tests/core/fixtures.test.ts`, then `git diff tests/core/__snapshots__/fixtures.test.ts.snap`

Expected: the only changes are that ` · <#t-trust>` disappears from the 'ordinary' scenario row, and that scenario's `bodyHash` changes. If anything else changed, stop and investigate before continuing.

- [ ] **Step 10: Run the full suite, typecheck and lint.**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass. Typecheck covers `preview/` too, because tsconfig includes it.

- [ ] **Step 11: Commit.**

```bash
git add -A src preview fixtures tests
git commit -m "feat: drop the PRD field from the request modal, records and renderers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Drop `Meta.prdCache` and migrate stored state to schema version 5

**Files:**
- Delete: `src/core/prd.ts`, `tests/core/prd.test.ts`
- Modify: `src/store/types.ts` (lines 5, 56–59, 100–106), `src/store/apply.ts:31`, `src/store/schema.ts`
- Test: `tests/workers/do.test.ts`, `tests/store/apply.test.ts:437-444`

**Interfaces:**
- Consumes: `SubmittedValues` without `prdThreadId`, and `PrRecord` without `prdThreadId` (from Task 2).
- Produces: `Meta` without `prdCache`, `CURRENT_SCHEMA_VERSION = 5`, and `migrateState` producing v5.

- [ ] **Step 1: Write the failing migration test.** In `tests/workers/do.test.ts`, inside the `describe` that holds the migration tests, add this after *"leaves claimSource null on an unclaimed record when migrating to 4"*:

```ts
  it("migrates version 4 state to 5, deleting every stored PRD value and nothing else", () => {
    const withPrd = {
      ...newScannedRecord({
        pr: { owner: "paranext", repo: "paranext-core", number: 3 },
        channelId: "c",
        messageId: "m",
        messageTimestamp: 1_756_000_000_000,
        title: "PT-3",
        prAuthorLogin: "jolie",
        isDraft: false,
      }),
      team: "Power",
      note: "keep me",
      prdThreadId: "1075535230087221248",
    };
    const stashed = {
      userId: "u1",
      values: { url: "https://x", team: "Power", urgency: "soon", prdThreadId: "1075535230087221248", note: "n" },
      expiresAt: 1_756_000_000_000,
    };
    const v4 = {
      schemaVersion: 4,
      records: { "paranext/paranext-core#3": withPrd },
      meta: {
        ...emptyState().meta,
        digestBodyVersion: 7,
        prdCache: { options: [{ id: "1", name: "Old" }], truncated: false, refreshedAt: 1 },
        retryStash: { "i-1": stashed },
      },
    };

    const migrated = migrateState(v4 as never);

    expect(migrated.schemaVersion).toBe(5);
    expect("prdCache" in migrated.meta).toBe(false);
    const record = migrated.records["paranext/paranext-core#3"]!;
    expect("prdThreadId" in record).toBe(false);
    expect(record.team).toBe("Power");
    expect(record.note).toBe("keep me");
    expect(migrated.meta.retryStash["i-1"]).toEqual({
      userId: "u1",
      values: { url: "https://x", team: "Power", urgency: "soon", note: "n" },
      expiresAt: 1_756_000_000_000,
    });
    expect(migrated.meta.digestBodyVersion).toBe(7);
  });
```

Update the existing migration tests in the same file:

- *"migrates version 2 state forward with defaults for the new meta fields"*: replace `expect(migrated.meta.prdCache).toBeNull();` with `expect("prdCache" in migrated.meta).toBe(false);`, and add the comment `// 2 → 3 adds it and 4 → 5 deletes it again.` above that line.
- *"migrates version 3 records to 4, priming the reaction state"*: change `expect(migrated.schemaVersion).toBe(4);` to `expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);`.
- Rename *"still walks unversioned state all the way to 4"* to `"still walks unversioned state all the way to the current version"`. Change its `toBe(4)` to `toBe(CURRENT_SCHEMA_VERSION)`, and add `expect("prdCache" in migrated.meta).toBe(false);`.

In `tests/store/apply.test.ts`, replace the `describe("schema version 4", ...)` block with:

```ts
describe("emptyState", () => {
  it("is stamped with the current schema version and has no PRD cache", () => {
    const state = emptyState();
    expect(state.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect("prdCache" in state.meta).toBe(false);
    expect(state.meta.retryStash).toEqual({});
  });
});
```

Change the type import at the top of that file to `import { CURRENT_SCHEMA_VERSION, type Command, type StoreState } from "../../src/store/types.js";`.

- [ ] **Step 2: Run the tests and confirm they fail.**

Run: `npx vitest run tests/workers/do.test.ts tests/store/apply.test.ts -t "version|emptyState"`
Expected: FAIL. The new test gets `schemaVersion` 4 with `prdCache` present, and `emptyState` still has `prdCache`.

- [ ] **Step 3: Remove `Meta.prdCache` and bump the version in `src/store/types.ts`.**

- Delete `import type { PrdCache } from "../core/prd.js";`.
- Delete the `prdCache` member of `Meta` and its three-line doc comment (`/** The PRD dropdown's source, refreshed by step 7.` … `prdCache: PrdCache | null;`).
- Replace the `CURRENT_SCHEMA_VERSION` doc comment and value with:

```ts
/** The version `emptyState()` writes and `migrateState()` upgrades to. Lives
 *  here, next to `LEASE_TIMEOUT_MS`, for the same reason: both `Store`
 *  implementations import it so they cannot drift apart. Version 1 is the
 *  pre-deploy baseline; version 2 added `Meta.digestBodyVersion`; version 3
 *  added `Meta.prdCache` and `Meta.retryStash`; version 4 added the three
 *  reaction fields to every RECORD — the first migration to touch `records`
 *  rather than `meta`; version 5 removed `Meta.prdCache` and
 *  `PrRecord.prdThreadId` when the bot moved to the public server only. */
export const CURRENT_SCHEMA_VERSION = 5;
```

In `src/store/apply.ts`, delete `      prdCache: null,` from `emptyState()`. Then run `git rm src/core/prd.ts tests/core/prd.test.ts`.

- [ ] **Step 4: Add the 4 → 5 step to `src/store/schema.ts`.**

Add `import type { SubmittedValues } from "../core/submit.js";` below the existing imports.

Replace `StoredMeta` and its doc comment's first paragraph so that they read:

```ts
/**
 * `Meta` as some *earlier* deploy could have written it: every field the current
 * shape has changed, widened to also admit the older form. `digestBodyVersion`
 * was added in version 2, so version-1 state does not have it; `prdCache` was
 * added in version 3 and removed in version 5, so only versions 3 and 4 have it.
 *
 * Widening rather than versioning per field is deliberate and has a known limit:
 * a field the current shape has *removed* has to be re-added here as optional,
 * and a renamed one appears under both names. That is fine while the list is
 * short; when it stops being short, this type is the thing to split per version.
 */
type StoredMeta = Omit<Meta, "digestBodyVersion" | "retryStash"> & {
  digestBodyVersion?: number;
  /** Versions 3–4 only. `unknown` because its type was deleted with it, and
   *  nothing reads its contents: 2 → 3 writes `null`, 4 → 5 deletes it. */
  prdCache?: unknown;
  retryStash?: Meta["retryStash"];
};
```

Replace `StoredRecord` and its doc comment with:

```ts
/**
 * A `PrRecord` as some earlier deploy could have written it. Version 4 added
 * three fields, so version-3 records lack them; version 5 removed
 * `prdThreadId`, so records before it carry it.
 */
type StoredRecord = Omit<PrRecord, "claimSource" | "reactionCheckedAt" | "lastReactors"> & {
  claimSource?: PrRecord["claimSource"];
  reactionCheckedAt?: number | null;
  lastReactors?: string[] | null;
  prdThreadId?: string | null;
};
```

Insert the new step directly after the `3 → 4` block, before the closing `// Sound because the last step above produces CURRENT_SCHEMA_VERSION` comment:

```ts
  // 4 → 5: the PRD field was removed when the bot moved to the public server
  // only (the PRD forum lived on a server it no longer reaches). Deleted, not
  // nulled, from all three places it was stored: the cache in meta, every
  // record, and every stashed retry's values. A stash entry's `values` is typed
  // as the CURRENT `SubmittedValues`, so the old shape is spelled out locally
  // rather than given a third exported `Stored*` alias for one field.
  if (state.schemaVersion === 4) {
    const records: Record<string, StoredRecord> = {};
    for (const [id, record] of Object.entries(state.records)) {
      const { prdThreadId: _prd, ...rest } = record;
      records[id] = rest;
    }
    const retryStash: Meta["retryStash"] = {};
    for (const [key, entry] of Object.entries(state.meta.retryStash ?? {})) {
      const { prdThreadId: _prd, ...values } = entry.values as SubmittedValues & { prdThreadId?: string | null };
      retryStash[key] = { ...entry, values };
    }
    const { prdCache: _cache, ...meta } = state.meta;
    state = { ...state, schemaVersion: 5, records, meta: { ...meta, retryStash } };
  }
```

Leave the 2 → 3 step and its comment exactly as they are.

- [ ] **Step 5: Run the tests and confirm they pass.**

Run: `npx vitest run tests/workers/do.test.ts tests/store/apply.test.ts`
Expected: PASS, including the new v4 → v5 test and *"refuses state from a NEWER schema version"*, which uses `CURRENT_SCHEMA_VERSION + 1` and so tracks the bump automatically.

- [ ] **Step 6: Run the full suite, typecheck and lint.**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 7: Commit.**

```bash
git add -A src tests
git commit -m "feat: schema version 5 — remove Meta.prdCache and every stored PRD value

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Docs, and the final sweep

**Files:**
- Modify: `docs/setup.md`, `docs/architecture.md`, `docs/operations.md`, `README.md`, `docs/architecture-decisions.md`

**Interfaces:**
- Consumes: the finished code from Tasks 1–3. The docs must describe that code.

- [ ] **Step 1: Update `docs/setup.md`.**

1. After the paragraph that ends `` (`wrangler.jsonc`'s
`triggers.crons`). ``, add a new paragraph:

   ```markdown
   The bot is installed on **one Discord server: the public one**. Every id in
   this runbook — `DISCORD_GUILD_ID`, the review and digest channel ids, and the
   `:code_review:` claim emoji — comes from that server. Nothing reads from any
   other server.
   ```

2. Delete the whole section from `## Rollout stage 1: record the PRD thread fixtures` up to, but not including, `## 1. Create the Discord application`. No numbered step moves.

3. In step 5, change `channel and the PRD forum (\`teamwide-epic-discussions\`). Grant only:` to `channel. Grant only:`. Then delete the paragraph that starts `The bot also needs read access to the PRD forum channel`.

4. In step 9, change `Three placeholders need real values` to `Two placeholders need real values`. Then delete the bullet `` - `prdForumChannelId` — the real PRD forum channel ID ``.

- [ ] **Step 2: Update `docs/architecture.md`.**

1. Line 19: change `` (the latter opens the modal, built entirely from the
  cached `Meta.prdCache` — never a live fetch) `` to `` (the latter opens the modal, built from config
  alone — no fetch and no store read) ``. Re-wrap the paragraph to match the surrounding line widths.

2. Replace the whole paragraph that starts `Independent of that flow, refresh-loop step 7 keeps the` (it ends `prevent.`) with:

   ```markdown
   Refresh-loop step 7 is retired. It used to refresh a cached list of PRD forum
   threads for the `/review-request` modal, but that forum lived on a server the
   bot no longer reaches, so the PRD field was removed (schema version 5). The
   later steps keep their numbers so log tags and references stay stable.
   ```

3. Run `grep -n "prdCache\|PRD" docs/architecture.md`. It must return only the new paragraph.

- [ ] **Step 3: Update `docs/operations.md`.**

1. Delete the whole section from `## The \`/review-request\` PRD dropdown looks empty or stale` up to, but not including, `## Rotating credentials`.
2. In the lost-record recovery list, change `team/urgency/PRD/note information` to `team/urgency/note information`.
3. In the shadow-mode limits paragraph, change `team
grouping, urgency ordering, and PRD rendering get **no** real-world exercise` to `team
grouping and urgency ordering get **no** real-world exercise`.
4. Run `grep -n -i "prd" docs/operations.md`. It must return nothing.

- [ ] **Step 4: Update `README.md`.**

Change `five fields — PR link, team, urgency, PRD, and a note — then submit.` to `four fields — PR link, team, urgency, and a note — then submit.`

- [ ] **Step 5: Add the ADR amendments to `docs/architecture-decisions.md`.**

At the end of `## adr-embed-rendering` (just before `## adr-scanning-as-permanent-fallback`), add:

```markdown
**Amendment (2026-10-12).** PRDs are no longer rendered — the field was removed
when the bot moved to the public server only — so rows no longer carry
`<#thread>` mentions. The per-row cost above is now an upper estimate; the
decision and `DEFAULT_MAX_ROWS` are unchanged.
```

At the end of `## adr-no-kv-namespace` (after the 2026-09-02 amendment, just before `## adr-durable-object-schema-version`), add:

```markdown
**Amendment (2026-10-12).** The PRD thread cache the previous amendment
describes has been removed, along with refresh-loop step 7 that filled it: the
PRD forum lived on a server the bot no longer reaches. The retry stash is the
only one of the two left, and it still wants the Durable Object's consistency,
so the decision stands.
```

At the end of `## adr-durable-object-schema-version` (just before `## adr-403-throttle-vs-revocation`), add:

```markdown
**Amendment (2026-10-12).** The "currently `2`" above is historical. Versions 3
and 4 were added by plans 2 and 3. Version 5 (2026-10-12) removed
`Meta.prdCache` and `PrRecord.prdThreadId` — the first step to *delete* fields,
which `StoredMeta`/`StoredRecord` admit as optional so older state stays
typeable. The current version is 5.
```

- [ ] **Step 6: Run the final sweep.**

Run:

```bash
grep -rniI 'prd' src tests config fixtures scripts preview README.md docs/setup.md docs/architecture.md docs/operations.md
grep -n guildId src/handlers/scheduled.ts src/index.ts
grep -rn "threads" src
```

Expected:
- The first grep returns only:
  - `src/store/schema.ts` (`StoredMeta`, `StoredRecord`, the 2→3 and 4→5 steps);
  - the `CURRENT_SCHEMA_VERSION` doc comment in `src/store/types.ts`;
  - the retired-step comment in `src/handlers/scheduled.ts`;
  - the migration tests in `tests/workers/do.test.ts`;
  - the `emptyState` test in `tests/store/apply.test.ts`;
  - the stray-key test in `tests/core/submit.test.ts`;
  - the `prd: "none"` entry and its comment in `tests/workers/reviewRequest.test.ts`;
  - the modal "has no PRD field" test in `tests/core/modal.test.ts`;
  - the retired step-7 test in `tests/workers/scheduled.test.ts`;
  - the new paragraph in `docs/architecture.md`.
- The second grep returns nothing.
- The third grep returns nothing.

Fix any other hit.

- [ ] **Step 7: Run the full suite, typecheck and lint one last time.**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 8: Commit.**

```bash
git add README.md docs/setup.md docs/architecture.md docs/operations.md docs/architecture-decisions.md
git commit -m "docs: the bot runs on the public server only; PRD field and step 7 retired

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
