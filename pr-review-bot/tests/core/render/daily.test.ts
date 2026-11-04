import { describe, expect, it } from "vitest";
import { config as baseConfig } from "../../../config/config.js";
import { renderDailyPost } from "../../../src/core/render/daily.js";
import { resolveRecord, type PrRecord } from "../../../src/core/record.js";
import { testRecord } from "../../../fixtures/records.js";
import { relTs } from "../../../src/core/time.js";
import type { TeamName, UrgencyKey } from "../../../config/config.js";

const T0 = 1_756_000_000_000;
const DAY = 86_400_000;

function rec(number: number, team: TeamName | null, urgency: UrgencyKey | null, ageDays: number): PrRecord {
  const base = testRecord({
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
    // Pin the phrasing, not just the timestamp: relTs renders "5 days ago", which only
    // reads as English after a verb that takes a point in time. "has been sitting
    // 5 days ago" typechecks, renders, and is wrong — so the sentence is asserted whole.
    expect(body).toContain(`Oldest was requested ${relTs(T0 - 8 * DAY)}.`);
    // Pin the reduce to the oldest record, not just "any relative timestamp" — a reduce
    // that picked the newest, or one that stamped Date.now(), would also match /<t:\d+:R>/.
    expect(body).toContain(relTs(T0 - 8 * DAY));
    expect(body).not.toContain(relTs(T0 - 3 * DAY));
  });

  it("finds the oldest correctly when the oldest record appears first in the array", () => {
    // The other "names the count and oldest age" test only ever puts the
    // oldest record second, so it only ever exercises the reduce's "keep b"
    // path. This one puts it first, exercising "keep a".
    const body = renderDailyPost({
      records: [rec(1, "Power", "soon", 8), rec(2, "Simple", "thisWeek", 3)],
      digestMessageUrl: URL,
      config: baseConfig,
    });
    expect(body).toContain(relTs(T0 - 8 * DAY));
    expect(body).not.toContain(relTs(T0 - 3 * DAY));
  });

  it("says 'One is.' without naming a team when the lone blocking row has no team", () => {
    const body = renderDailyPost({
      records: [rec(1, null, "blocking", 1)],
      digestMessageUrl: URL,
      config: baseConfig,
    });
    expect(body).toContain("One is.");
  });

  it("uses the plural for more than one blocking row", () => {
    const body = renderDailyPost({
      records: [rec(1, "Power", "blocking", 1), rec(2, "Power", "blocking", 2)],
      digestMessageUrl: URL,
      config: baseConfig,
    });
    expect(body).toContain("2 are blocking Power");
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
