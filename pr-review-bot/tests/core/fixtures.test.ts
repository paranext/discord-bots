import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../../config/config.js";
import { SCENARIOS } from "../../fixtures/records.js";
import { renderDigest, EMBED_DESCRIPTION_LIMIT, EMBED_TOTAL_LIMIT } from "../../src/core/render/digest.js";
import { buildPrdCache, type RawThread } from "../../src/core/prd.js";

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

const T0 = 1_756_000_000_000;
const FORUM_ID = "forum-prd-1";

const RESPONSES_DIR = fileURLToPath(new URL("../../fixtures/responses/", import.meta.url));
const ACTIVE_PATH = `${RESPONSES_DIR}threads-active.json`;
const ARCHIVED_PATH = `${RESPONSES_DIR}threads-archived-public.json`;

async function readFixture(name: string): Promise<{ threads: RawThread[] }> {
  const text = await readFile(`${RESPONSES_DIR}${name}`, "utf8");
  return JSON.parse(text) as { threads: RawThread[] };
}

// NOT RECORDED. These fixtures cannot be produced by hand: the whole point of
// this test is to prove what Discord's forum-channel behaviour on
// `GET /channels/{id}/threads/archived/public` actually is, and Discord's own
// docs only describe that route under text-channel parents — forum behaviour
// is unstated. A hand-written JSON blob would just encode this task's own
// guess and "verify" it against itself, which is worthless as evidence. This
// describe block stays skipped until someone with a bot token and access to
// the scratch server (rollout stage 1) records real responses with:
//
//   curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
//     "https://discord.com/api/v10/guilds/$DISCORD_GUILD_ID/threads/active" \
//     > fixtures/responses/threads-active.json
//
//   curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
//     "https://discord.com/api/v10/channels/$PRD_FORUM_ID/threads/archived/public?limit=25" \
//     > fixtures/responses/threads-archived-public.json
//
// Scrub each recorded file down to `id`, `name`, `parent_id`, `last_message_id`
// per thread, and keep at least one active thread whose `parent_id` is not the
// PRD forum — that is what the second test below asserts still holds.
describe.skipIf(!existsSync(ACTIVE_PATH) || !existsSync(ARCHIVED_PATH))("PRD thread fixtures", () => {
  let active: { threads: RawThread[] };
  let archived: { threads: RawThread[] };

  beforeAll(async () => {
    active = await readFixture("threads-active.json");
    archived = await readFixture("threads-archived-public.json");
  });

  it("builds a cache from real recorded responses", () => {
    const cache = buildPrdCache({
      active: active.threads,
      archived: archived.threads,
      parentId: FORUM_ID,
      refreshedAt: T0,
    });

    expect(cache.options.length).toBeGreaterThan(0);
    expect(cache.options.length).toBeLessThanOrEqual(24);
    expect(cache).toMatchSnapshot();
  });

  it("the guild-wide active listing really does contain other parents", () => {
    // If this ever stops being true the parent_id filter looks like dead code and
    // someone deletes it. This is the fixture that says why it is there.
    expect(active.threads.some((t) => t.parent_id !== FORUM_ID)).toBe(true);
  });
});
