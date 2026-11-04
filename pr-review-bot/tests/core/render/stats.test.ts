import { describe, expect, it } from "vitest";
import { figures, type Figures } from "../../../src/core/stats/figures.js";
import { renderReviewStats, formatDuration } from "../../../src/core/render/stats.js";
import { emptyWeek } from "../../../src/core/stats/types.js";

const HOUR = 3_600_000;

function fig(over: Partial<Figures> & { median?: number | null; p75?: number | null; reviewed?: number } = {}): Figures {
  const base = figures(emptyWeek());
  const m = over.median === undefined ? HOUR : over.median;
  return {
    ...base,
    outcomes: { ...base.outcomes, reviewed: over.reviewed ?? 8 },
    claimsDropped: 2,
    medianMs: { waitToClaim: m, claimToDone: m, total: m },
    p75Ms: { waitToClaim: null, claimToDone: null, total: over.p75 ?? null },
  };
}

const text = (current: Figures, previous: Figures | null, weeks = 4) =>
  renderReviewStats({ through: "2026-W45", weeks, current, previous })[0]!.description;

describe("renderReviewStats", () => {
  it("renders the first-full-week message for a null summary", () => {
    expect(renderReviewStats(null)[0]!.description).toContain("after the first full week");
  });

  it("names how many weeks the figures cover", () => {
    expect(text(fig(), fig())).toContain("**Review stats: 4 weeks through 2026-W45**");
    expect(text(fig(), null, 1)).toContain("**Review stats: 1 week through 2026-W45**");
    expect(text(fig(), null, 3)).toContain("**Review stats: 3 weeks through 2026-W45**");
  });

  it("renders a null median as not enough reviews yet", () => {
    const out = text(fig({ median: null }), fig());
    expect(out).toContain("not enough reviews yet");
    expect(out).not.toContain("▼");
    expect(out).not.toContain("▲");
  });

  it("omits the slowest line when the p75 is null and shows it otherwise", () => {
    expect(text(fig(), fig())).not.toContain("slowest");
    expect(text(fig({ p75: 60 * HOUR }), fig())).toContain("slowest 1 in 4 took over 2.5d");
  });

  it("shows arrows only when both periods have medians", () => {
    expect(text(fig({ median: HOUR }), fig({ median: 2 * HOUR }))).toContain("▼ from 2.0h");
    expect(text(fig({ median: 2 * HOUR }), fig({ median: HOUR }))).toContain("▲ from 1.0h");
    expect(text(fig({ median: HOUR }), fig({ median: null }))).not.toMatch(/[▲▼]/);
    expect(text(fig({ median: HOUR }), fig({ median: HOUR }))).not.toMatch(/[▲▼]/);
  });

  it("shows completed reviews with the previous window", () => {
    expect(text(fig({ reviewed: 9 }), fig({ reviewed: 4 }))).toContain("**9** (prev 4 wks: 4)");
  });

  it("shows no previous window and no arrows before one was collected", () => {
    const out = text(fig({ reviewed: 9, median: HOUR }), null);
    expect(out).toContain("reviews completed **9**\n");
    expect(out).not.toContain("prev 4 wks");
    expect(out).not.toMatch(/[▲▼]/);
    expect(out).toContain("typical wait until claimed: 1.0h");
  });

  it("shows no arrow when both medians format the same", () => {
    // 60m and 62m both read "1.0h".
    expect(text(fig({ median: HOUR }), fig({ median: HOUR + 2 * 60_000 }))).not.toMatch(/[▲▼]/);
  });
});

describe("formatDuration", () => {
  it("uses minutes, hours then days", () => {
    expect(formatDuration(45 * 60_000)).toBe("45m");
    expect(formatDuration(90 * 60_000)).toBe("1.5h");
    expect(formatDuration(3 * 24 * HOUR)).toBe("3.0d");
  });

  it("chooses the unit after rounding, at the 1h boundary", () => {
    expect(formatDuration(59.4 * 60_000)).toBe("59m");
    expect(formatDuration(59.6 * 60_000)).toBe("1.0h");
    expect(formatDuration(HOUR)).toBe("1.0h");
  });

  it("chooses the unit after rounding, at the 2-day boundary", () => {
    expect(formatDuration(47.9 * HOUR)).toBe("47.9h");
    expect(formatDuration(47.96 * HOUR)).toBe("2.0d");
    expect(formatDuration(48 * HOUR)).toBe("2.0d");
  });
});
