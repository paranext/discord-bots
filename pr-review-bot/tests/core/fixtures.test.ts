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
