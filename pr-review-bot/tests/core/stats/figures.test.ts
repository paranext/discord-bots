import { describe, expect, it } from "vitest";
import { config } from "../../../config/config.js";
import {
  MIN_ROUNDS_FOR_MEDIAN,
  MIN_ROUNDS_FOR_P75,
  figures,
  mergeWeeks,
  reviewStatsSummary,
} from "../../../src/core/stats/figures.js";
import { bucketIndex } from "../../../src/core/stats/histogram.js";
import { emptyStats, emptyWeek, type StatsState, type WeekTotals } from "../../../src/core/stats/types.js";
import { testRecord } from "../../../fixtures/records.js";
import { recordId } from "../../../src/core/record.js";
import type { PrSnapshot } from "../../../src/core/exit.js";
import { applyCommands, emptyState } from "../../../src/store/apply.js";

const HOUR = 3_600_000;

/** A week holding `n` reviewed rounds, all of them 3h end to end. */
function weekOf(n: number): WeekTotals {
  const w = emptyWeek();
  w.outcomes.reviewed = n;
  w.histograms.total[bucketIndex(3 * HOUR)] = n;
  w.histograms.waitToClaim[bucketIndex(HOUR)] = n;
  w.histograms.claimToDone[bucketIndex(2 * HOUR)] = n;
  return w;
}

/** Collection running since well before the weeks under test, unless given. */
function statsWith(
  weeks: Record<string, WeekTotals>,
  foldedThrough: string | null,
  sinceWeek: string | null = "2026-W30",
): StatsState {
  return { ...emptyStats(), weeks, foldedThrough, sinceWeek };
}

describe("figures", () => {
  it("withholds the median below 5 rounds and shows it at 5", () => {
    expect(MIN_ROUNDS_FOR_MEDIAN).toBe(5);
    expect(figures(weekOf(4)).medianMs.total).toBeNull();
    expect(figures(weekOf(5)).medianMs.total).not.toBeNull();
  });

  it("withholds the 75th percentile below 20 rounds and shows it at 20", () => {
    expect(MIN_ROUNDS_FOR_P75).toBe(20);
    expect(figures(weekOf(19)).p75Ms.total).toBeNull();
    expect(figures(weekOf(20)).p75Ms.total).not.toBeNull();
  });

  it("passes counts through unchanged at n=1", () => {
    const w = weekOf(1);
    w.claimsDropped = 3;
    w.roundsWithDrop = 2;
    w.reRequests = 4;
    const f = figures(w);
    expect(f.outcomes.reviewed).toBe(1);
    expect([f.claimsDropped, f.reRequests]).toEqual([3, 4]);
  });

  it("does not return roundsWithDrop, which is stored but not an output", () => {
    const w = weekOf(1);
    w.roundsWithDrop = 2;
    expect(figures(w)).not.toHaveProperty("roundsWithDrop");
  });
});

describe("mergeWeeks", () => {
  it("sums the others across a gap week", () => {
    const stats = statsWith({ "2026-W43": weekOf(2), "2026-W45": weekOf(3) }, "2026-W45");
    const merged = mergeWeeks(stats, "2026-W45", 4);
    expect(merged.outcomes.reviewed).toBe(5);
    expect(merged.histograms.total.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it("skips weeks before sinceWeek", () => {
    const stats = statsWith({ "2026-W43": weekOf(2), "2026-W45": weekOf(3) }, "2026-W45", "2026-W44");
    expect(mergeWeeks(stats, "2026-W45", 4).outcomes.reviewed).toBe(3);
  });
});

describe("reviewStatsSummary", () => {
  it("is null before the first fold", () => {
    expect(reviewStatsSummary(emptyStats())).toBeNull();
  });

  it("compares the last four folded weeks with the four before", () => {
    const stats = statsWith({ "2026-W45": weekOf(6), "2026-W41": weekOf(2) }, "2026-W45");
    const summary = reviewStatsSummary(stats);
    expect(summary?.through).toBe("2026-W45");
    expect(summary?.weeks).toBe(4);
    expect(summary?.current.outcomes.reviewed).toBe(6);
    expect(summary?.previous?.outcomes.reviewed).toBe(2);
  });

  it("is null while nothing is folded, even with sinceWeek set", () => {
    expect(reviewStatsSummary(statsWith({}, null, "2026-W46"))).toBeNull();
  });

  it("has no previous window until all four of its weeks were collected", () => {
    // previous = W38..W41; W38 is before sinceWeek W39, so it is withheld.
    const early = reviewStatsSummary(statsWith({ "2026-W45": weekOf(6), "2026-W40": weekOf(1) }, "2026-W45", "2026-W39"));
    expect(early?.previous).toBeNull();
    expect(early?.current.outcomes.reviewed).toBe(6);
    // sinceWeek W38: all four previous weeks were collected.
    const full = reviewStatsSummary(statsWith({ "2026-W45": weekOf(6), "2026-W40": weekOf(1) }, "2026-W45", "2026-W38"));
    expect(full?.previous?.outcomes.reviewed).toBe(1);
  });

  it("current counts only collected weeks", () => {
    const summary = reviewStatsSummary(statsWith({ "2026-W45": weekOf(6), "2026-W43": weekOf(4) }, "2026-W45", "2026-W45"));
    expect(summary?.current.outcomes.reviewed).toBe(6);
    expect(summary?.weeks).toBe(1);
    expect(summary?.previous).toBeNull();
  });

  it("a resolution does not change the summary until its week is folded", () => {
    const ID = "paranext/paranext-core/2695";
    const T0 = 1_788_192_000_000;
    const base = emptyState();
    const record = testRecord({
      pr: { owner: "paranext", repo: "paranext-core", number: 2695 },
      channelId: "chan",
      messageId: "msg",
      messageTimestamp: T0,
      title: "PT-9003",
      prAuthorLogin: "jolie",
      isDraft: false,
    });
    const state = {
      ...base,
      records: { [recordId(record)]: record },
      stats: { ...base.stats, weeks: { "2026-W35": weekOf(6) }, foldedThrough: "2026-W35", sinceWeek: "2026-W30" },
    };
    const before = reviewStatsSummary(state.stats);
    const snapshot: PrSnapshot = {
      slug: ID,
      title: "PT-9003",
      state: "OPEN",
      merged: false,
      isDraft: false,
      authorLogin: "jolie",
      reviews: [{ submittedAt: T0 + HOUR, state: "COMMENTED", authorLogin: "katherine", authorIsBot: false }],
      mergedAt: null,
      closedAt: null,
    };
    const out = applyCommands(state, [{ kind: "applySnapshot", id: ID, now: T0 + 5 * HOUR, snapshot }], config);
    expect(out.state.stats.pending).toHaveLength(1);
    expect(reviewStatsSummary(out.state.stats)).toEqual(before);
  });
});
