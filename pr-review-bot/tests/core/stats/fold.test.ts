import { describe, expect, it } from "vitest";
import { foldStats } from "../../../src/core/stats/fold.js";
import { histogramCount } from "../../../src/core/stats/histogram.js";
import { emptyStats, type PendingEntry, type StatsState } from "../../../src/core/stats/types.js";

const H = 3_600_000;
const WINDOW = 24 * H;
const MON_NOON = Date.UTC(2026, 10, 2, 12); // Mon 2026-11-02 12:00Z, W45
const TUE_MIDNIGHT = Date.UTC(2026, 10, 3, 0);

function entry(overrides: Partial<PendingEntry> = {}): PendingEntry {
  return {
    id: 1,
    week: "2026-W44",
    outcome: "reviewed",
    waitToClaimMs: H,
    claimToDoneMs: 2 * H,
    totalMs: 3 * H,
    claimed: true,
    claimsDropped: 0,
    reRequests: 0,
    ...overrides,
  };
}

/** Collection already running since well before the weeks under test. */
function withPending(...pending: PendingEntry[]): StatsState {
  return { ...emptyStats(), sinceWeek: "2026-W40", pending };
}

describe("foldStats", () => {
  it("keeps an entry pending while its week ended less than the reopen window ago", () => {
    const out = foldStats(withPending(entry()), MON_NOON, WINDOW);
    expect(out.stats.pending).toHaveLength(1);
    expect(out.foldedIds).toEqual([]);
    expect(out.stats.foldedThrough).toBe("2026-W43");
  });

  it("folds the entry once the window after the week's end has passed", () => {
    const out = foldStats(withPending(entry()), TUE_MIDNIGHT, WINDOW);
    const week = out.stats.weeks["2026-W44"]!;
    expect(week.outcomes.reviewed).toBe(1);
    expect(histogramCount(week.histograms.total)).toBe(1);
    expect(histogramCount(week.histograms.waitToClaim)).toBe(1);
    expect(histogramCount(week.histograms.claimToDone)).toBe(1);
    expect(out.stats.pending).toEqual([]);
    expect(out.folded).toBe(1);
    expect(out.stats.foldedThrough).toBe("2026-W44");
    expect(out.foldedIds).toEqual([1]);
  });

  it("counts a cleared entry in outcomes but in no histogram", () => {
    const out = foldStats(withPending(entry({ outcome: "cleared" })), TUE_MIDNIGHT, WINDOW);
    const week = out.stats.weeks["2026-W44"]!;
    expect(week.outcomes.cleared).toBe(1);
    expect(histogramCount(week.histograms.total)).toBe(0);
    expect(histogramCount(week.histograms.waitToClaim)).toBe(0);
    expect(histogramCount(week.histograms.claimToDone)).toBe(0);
  });

  it("adds an unclaimed reviewed entry to the total histogram only", () => {
    const out = foldStats(
      withPending(entry({ claimed: false, waitToClaimMs: null, claimToDoneMs: null })),
      TUE_MIDNIGHT,
      WINDOW,
    );
    const week = out.stats.weeks["2026-W44"]!;
    expect(histogramCount(week.histograms.total)).toBe(1);
    expect(histogramCount(week.histograms.waitToClaim)).toBe(0);
    expect(histogramCount(week.histograms.claimToDone)).toBe(0);
  });

  it("sums drops and re-requests, counting a round with drops once", () => {
    const out = foldStats(
      withPending(entry({ claimsDropped: 2, reRequests: 3 }), entry({ id: 2 })),
      TUE_MIDNIGHT,
      WINDOW,
    );
    const week = out.stats.weeks["2026-W44"]!;
    expect(week.claimsDropped).toBe(2);
    expect(week.roundsWithDrop).toBe(1);
    expect(week.reRequests).toBe(3);
    expect(week.outcomes.reviewed).toBe(2);
  });

  it("is a no-op the second time", () => {
    const first = foldStats(withPending(entry()), TUE_MIDNIGHT, WINDOW);
    const second = foldStats(first.stats, TUE_MIDNIGHT, WINDOW);
    expect(second.stats).toEqual(first.stats);
    expect(second.foldedIds).toEqual([]);
  });

  it("adds to a week that already has totals", () => {
    const first = foldStats(withPending(entry()), TUE_MIDNIGHT, WINDOW);
    // A late entry for an already-folded week is folded on the next pass.
    const second = foldStats({ ...first.stats, pending: [entry({ id: 2 })] }, TUE_MIDNIGHT, WINDOW);
    expect(second.stats.weeks["2026-W44"]?.outcomes.reviewed).toBe(2);
  });

  it("never moves foldedThrough backwards", () => {
    const stats = { ...emptyStats(), foldedThrough: "2026-W50" };
    expect(foldStats(stats, TUE_MIDNIGHT, WINDOW).stats.foldedThrough).toBe("2026-W50");
  });

  it("does not mutate its input", () => {
    const input = withPending(entry());
    const snapshot = structuredClone(input);
    foldStats(input, TUE_MIDNIGHT, WINDOW);
    expect(input).toEqual(snapshot);
  });

  it("advances foldedThrough with no entries to fold", () => {
    const stats = { ...emptyStats(), sinceWeek: "2026-W40", foldedThrough: "2026-W43" };
    const out = foldStats(stats, TUE_MIDNIGHT, WINDOW);
    expect(out.stats.foldedThrough).toBe("2026-W44");
    expect(out.stats.weeks).toEqual({});
    expect(out.foldedIds).toEqual([]);
  });
});

describe("foldStats sinceWeek", () => {
  it("sets sinceWeek on the first run to the week after it", () => {
    const out = foldStats(emptyStats(), TUE_MIDNIGHT, WINDOW);
    expect(out.stats.sinceWeek).toBe("2026-W46");
  });

  it("keeps sinceWeek once set", () => {
    const stats = { ...emptyStats(), sinceWeek: "2026-W40" };
    expect(foldStats(stats, TUE_MIDNIGHT, WINDOW).stats.sinceWeek).toBe("2026-W40");
  });

  it("drops an entry from before sinceWeek without adding it to any week", () => {
    const stats = { ...emptyStats(), sinceWeek: "2026-W45", pending: [entry({ id: 3, week: "2026-W44" })] };
    const out = foldStats(stats, TUE_MIDNIGHT, WINDOW);
    expect(out.stats.pending).toEqual([]);
    expect(out.stats.weeks).toEqual({});
    expect(out.foldedIds).toEqual([3]);
    expect(out.folded).toBe(0);
  });

  it("drops a deploy-week entry on the first run", () => {
    const out = foldStats({ ...emptyStats(), pending: [entry({ week: "2026-W45" })] }, TUE_MIDNIGHT, WINDOW);
    expect(out.stats.pending).toEqual([]);
    expect(out.foldedIds).toEqual([1]);
    expect(out.stats.weeks).toEqual({});
  });

  it("leaves foldedThrough null until sinceWeek itself can be folded", () => {
    const first = foldStats(emptyStats(), TUE_MIDNIGHT, WINDOW);
    expect(first.stats.foldedThrough).toBeNull();
    // W46 ends Mon 2026-11-16; plus the 24h window, it closes Tue 2026-11-17.
    const justBefore = foldStats(first.stats, Date.UTC(2026, 10, 16, 23), WINDOW);
    expect(justBefore.stats.foldedThrough).toBeNull();
    expect(justBefore.stats).toBe(first.stats);
    const pending = { ...first.stats, pending: [entry({ week: "2026-W46" })] };
    const closed = foldStats(pending, Date.UTC(2026, 10, 17, 0), WINDOW);
    expect(closed.stats.foldedThrough).toBe("2026-W46");
    expect(closed.stats.weeks["2026-W46"]?.outcomes.reviewed).toBe(1);
  });
});
