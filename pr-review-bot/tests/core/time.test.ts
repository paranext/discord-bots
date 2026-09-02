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
