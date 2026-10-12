import { describe, expect, it } from "vitest";
import { config as baseConfig, type UrgencyLevel } from "../../config/config.js";
import {
  noteRequiredLevel,
  urgencyEmojiFor,
  urgencyFor,
  urgencyLevel,
  urgencyText,
} from "../../src/core/urgency.js";
import { newScannedRecord, type PrRecord } from "../../src/core/record.js";

const T0 = 1_756_000_000_000;

const WITH_EMOJI: UrgencyLevel = {
  key: "blocking",
  emoji: "🔥",
  label: "Blocking",
  rank: 0,
  requiresNote: true,
};

const WITHOUT_EMOJI: UrgencyLevel = {
  key: "soon",
  emoji: null,
  label: "Soon",
  rank: 1,
  requiresNote: false,
};

function rec(overrides: Partial<PrRecord> = {}): PrRecord {
  const base = newScannedRecord({
    pr: { owner: "paranext", repo: "paranext-core", number: 1 },
    channelId: "chan",
    messageId: "msg",
    messageTimestamp: T0,
    title: "PT-1 Some change",
    prAuthorLogin: "jolie",
    isDraft: false,
  });
  return { ...base, ...overrides };
}

describe("urgencyText", () => {
  it("joins emoji and label when the level has an emoji", () => {
    expect(urgencyText(WITH_EMOJI)).toBe("🔥 Blocking");
  });

  it("returns the bare label with no leading space when the emoji is null", () => {
    expect(urgencyText(WITHOUT_EMOJI)).toBe("Soon");
  });

  it("bolds the label only, leaving the emoji outside the markdown", () => {
    expect(urgencyText(WITH_EMOJI, { bold: true })).toBe("🔥 **Blocking**");
    expect(urgencyText(WITHOUT_EMOJI, { bold: true })).toBe("**Soon**");
  });
});

describe("urgencyEmojiFor", () => {
  it("returns the emoji on its own when the record's level has one", () => {
    expect(urgencyEmojiFor(rec({ urgency: "blocking" }), baseConfig)).toBe("🔥");
  });

  it("returns null — never the label's first word — when the level's emoji is null", () => {
    // The previous implementation recovered the emoji with
    // `urgencyText(level).split(" ")[0]`, which silently yields "Soon" here.
    expect(urgencyEmojiFor(rec({ urgency: "soon" }), baseConfig)).toBeNull();
  });

  it("returns null for a record with no urgency", () => {
    expect(urgencyEmojiFor(rec({ urgency: null }), baseConfig)).toBeNull();
  });
});

describe("urgencyLevel", () => {
  it("finds the level matching a key", () => {
    expect(urgencyLevel("thisWeek", baseConfig)?.key).toBe("thisWeek");
  });

  it("returns null for no key and for a key the config does not list", () => {
    expect(urgencyLevel(null, baseConfig)).toBeNull();
    expect(urgencyLevel("", baseConfig)).toBeNull();
    expect(urgencyLevel("retired", baseConfig)).toBeNull();
  });
});

describe("noteRequiredLevel", () => {
  it("returns the level that requires a note", () => {
    expect(noteRequiredLevel(baseConfig)?.key).toBe("blocking");
  });

  it("returns null when no level requires one", () => {
    const config = { ...baseConfig, urgencies: baseConfig.urgencies.map((u) => ({ ...u, requiresNote: false })) };
    expect(noteRequiredLevel(config)).toBeNull();
  });
});

describe("urgencyFor", () => {
  it("finds the level matching the record's urgency key", () => {
    expect(urgencyFor(rec({ urgency: "blocking" }), baseConfig)?.key).toBe("blocking");
  });

  it("returns null for a record with no urgency", () => {
    expect(urgencyFor(rec({ urgency: null }), baseConfig)).toBeNull();
  });

  it("returns null for an urgency key the config no longer lists", () => {
    expect(urgencyFor(rec({ urgency: "retired" as never }), baseConfig)).toBeNull();
  });
});
