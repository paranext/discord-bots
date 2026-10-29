import { describe, expect, it } from "vitest";
import { config as baseConfig } from "../../../config/config.js";
import { renderRequestMessage } from "../../../src/core/render/request.js";
import { newScannedRecord, type PrRecord } from "../../../src/core/record.js";

const T0 = 1_756_000_000_000;

function rec(overrides: Partial<PrRecord> = {}): PrRecord {
  const base = newScannedRecord({
    pr: { owner: "paranext", repo: "paratext-10-studio", number: 177 },
    channelId: "chan",
    messageId: "msg",
    messageTimestamp: T0,
    title: "PT-4398 P10 backend sync-activity signal",
    prAuthorLogin: "jolie",
    isDraft: false,
  });
  return {
    ...base,
    team: "Power",
    urgency: "blocking",
    note: "needs a P10 build before Thursday's demo",
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
    expect(urlLine).toBe("https://github.com/paranext/paratext-10-studio/pull/177");
  });

  it("leads with urgency as emoji plus words, then team, then title", () => {
    expect(renderRequestMessage(rec(), baseConfig).split("\n")[0]).toBe(
      "🔥 **Blocking** · power · PT-4398 P10 backend sync-activity signal",
    );
  });

  it("names the requester and mentions no channel", () => {
    const body = renderRequestMessage(rec(), baseConfig);
    expect(body).toContain("<@u-1>");
    expect(body).not.toContain("<#");
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

  it("clamps the message while keeping the URL intact when total overflows but URL fits", () => {
    // The primary clamping path: message overflows, but the URL alone fits within 2000 chars.
    // The implementation clamps the head (header+attr+note) to make room for the intact URL.
    // owner=900, repo=960 gives URL ~1888 chars; total ~2055 (exceeds 2000).
    // The URL must survive whole — a truncated link kills the unfurl, which is the
    // only reason it sits alone on its own line.
    const owner = "x".repeat(900);
    const repo = "y".repeat(960);
    const url = `https://github.com/${owner}/${repo}/pull/177`;
    const body = renderRequestMessage(rec({ owner, repo }), baseConfig);
    expect(body.length).toBeLessThanOrEqual(2000);
    // Assert against the URL you constructed, not a re-derivation — this catches
    // regressions that would truncate the URL in the primary branch.
    expect(body.split("\n").at(-1)).toBe(url);
  });

  it("omits the urgency segment entirely when the record has no urgency", () => {
    const body = renderRequestMessage(rec({ urgency: null }), baseConfig);
    expect(body.split("\n")[0]).toBe("power · PT-4398 P10 backend sync-activity signal");
  });

  it("omits the team segment entirely when the record has no team", () => {
    const body = renderRequestMessage(rec({ team: null }), baseConfig);
    expect(body.split("\n")[0]).toBe("🔥 **Blocking** · PT-4398 P10 backend sync-activity signal");
  });

  it("omits the attribution line entirely when the requester is unknown", () => {
    // The requester is the attribution line's only part, so the line must not
    // appear at all — not even as an empty line — leaving the note directly
    // beneath the head.
    const body = renderRequestMessage(rec({ requesterId: null }), baseConfig);
    const lines = body.split("\n");
    expect(lines[1]).toBe("needs a P10 build before Thursday's demo");
    expect(body).not.toContain("<#");
    expect(body).not.toContain("requested by");
  });

  it("clamps even when the URL alone exceeds the limit (degenerate branch)", () => {
    // The degenerate branch: even the URL alone exceeds 2000 chars. The implementation
    // clamps the URL itself and accepts the overflow. These values (1000 chars each) are
    // deliberately far beyond GitHub's real limits (owner 39, repo 100).
    const rawUrl = "https://github.com/" + "x".repeat(1000) + "/" + "y".repeat(1000) + "/pull/177";
    const body = renderRequestMessage(
      rec({ owner: "x".repeat(1000), repo: "y".repeat(1000) }),
      baseConfig,
    );
    expect(body.length).toBeLessThanOrEqual(2000);
    const lines = body.split("\n");
    const lastLine = lines[lines.length - 1]!;
    // The URL is clamped to fit, but stays on its own line.
    const expectedLastLine = rawUrl.slice(0, 1999) + "…";
    expect(lastLine).toBe(expectedLastLine);
  });
});

describe("renderRequestMessage — a level with no emoji", () => {
  const noEmoji = {
    ...baseConfig,
    urgencies: baseConfig.urgencies.map((u) => (u.key === "soon" ? { ...u, emoji: null } : u)),
  };

  it("leads with the bare label, with no leading space before it", () => {
    expect(renderRequestMessage(rec({ urgency: "soon" }), noEmoji).split("\n")[0]).toBe(
      "**Soon** · power · PT-4398 P10 backend sync-activity signal",
    );
  });
});
