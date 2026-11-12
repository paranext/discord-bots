import { describe, expect, it } from "vitest";
import { ConfigError, config, loadConfig } from "../../config/config.js";

describe("config", () => {
  it("gives every urgency level a distinct rank", () => {
    const ranks = config.urgencies.map((u) => u.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("requires a note only for blocking", () => {
    const requiring = config.urgencies.filter((u) => u.requiresNote).map((u) => u.key);
    expect(requiring).toEqual(["blocking"]);
  });

  it("gives an emoji only to the two levels the icon scheme distinguishes", () => {
    // 🔥 means review this now, 🧊 means this can wait. Everything in between
    // carries no icon on purpose: a third icon competing with those two
    // flattens the only distinction a reader scanning the digest acts on.
    expect(config.urgencies.map((u) => [u.key, u.emoji])).toEqual([
      ["blocking", "🔥"],
      ["soon", null],
      ["thisWeek", "🧊"],
    ]);
  });

  it("keeps every reopenable row inside Recently cleared", () => {
    // A reopen option for a row with no "Recently cleared" line is a menu entry
    // with nothing in the body to explain it.
    expect(config.recentlyClearedMs).toBeGreaterThanOrEqual(config.reopenWindowMs);
  });
});

describe("loadConfig", () => {
  const A = "111111111111111111";
  const B = "222222222222222222";

  it("reads both channel ids from env", () => {
    const loaded = loadConfig({ REVIEW_CHANNEL_IDS: `${A},${B}`, DIGEST_CHANNEL_ID: A });
    expect(loaded.allowedChannelIds).toEqual([A, B]);
    expect(loaded.digestChannelId).toBe(A);
  });

  it("trims spaces and drops empty segments", () => {
    const loaded = loadConfig({ REVIEW_CHANNEL_IDS: ` ${A} , ${B},`, DIGEST_CHANNEL_ID: A });
    expect(loaded.allowedChannelIds).toEqual([A, B]);
  });

  it("names a missing binding", () => {
    expect(() => loadConfig({ DIGEST_CHANNEL_ID: A })).toThrow(ConfigError);
    expect(() => loadConfig({ DIGEST_CHANNEL_ID: A })).toThrow(/REVIEW_CHANNEL_IDS/);
    expect(() => loadConfig({ REVIEW_CHANNEL_IDS: A })).toThrow(ConfigError);
    expect(() => loadConfig({ REVIEW_CHANNEL_IDS: A })).toThrow(/DIGEST_CHANNEL_ID/);
  });

  it("rejects a non-snowflake", () => {
    const env = { REVIEW_CHANNEL_IDS: "REPLACE_WITH_REVIEW_CHANNEL_ID", DIGEST_CHANNEL_ID: A };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/REVIEW_CHANNEL_IDS/);
  });

  it("requires the digest channel to be an allowed channel", () => {
    const env = { REVIEW_CHANNEL_IDS: A, DIGEST_CHANNEL_ID: B };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/DIGEST_CHANNEL_ID/);
  });

  it("rejects a list that is only commas", () => {
    expect(() => loadConfig({ REVIEW_CHANNEL_IDS: " , ", DIGEST_CHANNEL_ID: A })).toThrow(
      ConfigError,
    );
  });
});
