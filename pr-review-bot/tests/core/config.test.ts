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

  it("lists every allowlisted repo as owner/repo", () => {
    for (const entry of config.repoAllowlist) {
      expect(entry).toMatch(/^[\w.-]+\/[\w.-]+$/);
    }
  });

  it("keeps the digest channel among the allowed channels", () => {
    expect(config.allowedChannelIds).toContain(config.digestChannelId);
  });
});
