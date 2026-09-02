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
