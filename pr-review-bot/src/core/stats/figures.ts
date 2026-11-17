import { addHistograms, histogramCount, quantile } from "./histogram.js";
import type { RoundOutcome, StatsState, WeekTotals } from "./types.js";
import { emptyWeek } from "./types.js";
import { shiftWeek } from "./week.js";

/** Disclosure thresholds. A median over a handful of rounds can point at one
 *  person; below these counts the figure is withheld, not rounded. */
export const MIN_ROUNDS_FOR_MEDIAN = 5;
export const MIN_ROUNDS_FOR_P75 = 20;

export interface DurationFigures {
  waitToClaim: number | null;
  claimToDone: number | null;
  total: number | null;
}

export interface Figures {
  outcomes: Record<RoundOutcome, number>;
  claimsDropped: number;
  reRequests: number;
  medianMs: DurationFigures;
  p75Ms: DurationFigures;
}

/** Sum `count` consecutive weeks ending at `endWeek`. A week with no totals
 *  (nothing resolved) counts as empty rather than failing, so a gap never
 *  poisons the window. Weeks before `stats.sinceWeek` are skipped: collection
 *  hadn't started, so their (empty) totals are not real zeros. */
export function mergeWeeks(stats: StatsState, endWeek: string, count: number): WeekTotals {
  const merged = emptyWeek();
  for (let i = 0; i < count; i++) {
    const key = shiftWeek(endWeek, -i);
    if (!collected(stats, key)) continue;
    const week = stats.weeks[key];
    if (week === undefined) continue;
    for (const outcome of Object.keys(merged.outcomes) as RoundOutcome[]) {
      merged.outcomes[outcome] += week.outcomes[outcome];
    }
    merged.claimsDropped += week.claimsDropped;
    merged.roundsWithDrop += week.roundsWithDrop;
    merged.reRequests += week.reRequests;
    merged.histograms = {
      waitToClaim: addHistograms(merged.histograms.waitToClaim, week.histograms.waitToClaim),
      claimToDone: addHistograms(merged.histograms.claimToDone, week.histograms.claimToDone),
      total: addHistograms(merged.histograms.total, week.histograms.total),
    };
  }
  return merged;
}

/** Whether collection covered `week` in full. False for every week until the
 *  first fold has set `sinceWeek`. */
export function collected(stats: StatsState, week: string): boolean {
  return stats.sinceWeek !== null && week >= stats.sinceWeek;
}

function durations(histograms: WeekTotals["histograms"], p: number, min: number): DurationFigures {
  const pick = (h: number[]): number | null => (histogramCount(h) < min ? null : quantile(h, p));
  return {
    waitToClaim: pick(histograms.waitToClaim),
    claimToDone: pick(histograms.claimToDone),
    total: pick(histograms.total),
  };
}

/** The only place a histogram becomes a number. Histograms themselves are never
 *  returned, and each figure is gated on its own sample size. */
export function figures(t: WeekTotals): Figures {
  return {
    outcomes: { ...t.outcomes },
    claimsDropped: t.claimsDropped,
    reRequests: t.reRequests,
    medianMs: durations(t.histograms, 0.5, MIN_ROUNDS_FOR_MEDIAN),
    p75Ms: durations(t.histograms, 0.75, MIN_ROUNDS_FOR_P75),
  };
}

/** The last four folded weeks against the four before them. Reads folded weeks
 *  only, via `foldedThrough`, so a pending entry can never reach a figure.
 *  Null until the first week has been folded. `weeks` is how many of the
 *  current window's four weeks were collected (fewer than 4 for the first
 *  three folded weeks), so the reply never labels one week's count as four.
 *  `previous` is null until all four of its weeks were collected: a window
 *  that is partly "before the bot counted" would compare against invented
 *  zeros. */
export function reviewStatsSummary(
  stats: StatsState,
): { through: string; weeks: number; current: Figures; previous: Figures | null } | null {
  const through = stats.foldedThrough;
  if (through === null) return null;
  const previousEnd = shiftWeek(through, -4);
  let weeks = 0;
  for (let i = 0; i < 4; i++) if (collected(stats, shiftWeek(through, -i))) weeks += 1;
  return {
    through,
    weeks,
    current: figures(mergeWeeks(stats, through, 4)),
    previous: collected(stats, shiftWeek(previousEnd, -3)) ? figures(mergeWeeks(stats, previousEnd, 4)) : null,
  };
}
