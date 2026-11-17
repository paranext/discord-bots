import { collected, figures, mergeWeeks, type Figures } from "../core/stats/figures.js";
import { shiftWeek } from "../core/stats/week.js";
import type { Store } from "../store/types.js";
import { healthAuthFailure } from "./health.js";

const DEFAULT_WEEKS = 26;
const MAX_WEEKS = 104;

export interface StatsDeps {
  store: Store;
  /** The configured shared secret, or undefined when none is set. */
  token?: string | undefined;
  /** The request's `Authorization` header, or null. */
  authorization?: string | null | undefined;
  url: URL;
}

export interface StatsRow extends Figures {
  week: string;
  rolling4: Figures;
}

/** A missing, non-integer or non-positive value falls back to the default
 *  rather than erroring: the endpoint is a read-only convenience. */
function weekCount(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw)) return DEFAULT_WEEKS;
  const n = Number(raw);
  if (n < 1) return DEFAULT_WEEKS;
  return Math.min(n, MAX_WEEKS);
}

/**
 * Anonymous weekly figures for the operator, behind the same shared-secret
 * rule as `/health` (404 when `STATS_TOKEN` is unset). Reads folded weeks only,
 * through `foldedThrough`, so pending entries are never visible. `figures`
 * applies the disclosure thresholds and carries no histograms, so nothing
 * finer than a week's counts and gated percentiles can leave here.
 *
 * Rows start no earlier than `sinceWeek`, so a week before collection began
 * never appears as a row of zeros; asking for more weeks than exist just
 * returns fewer rows. `rolling4` skips those weeks the same way (in
 * `mergeWeeks`).
 */
export async function handleStats(deps: StatsDeps): Promise<Response> {
  const denied = healthAuthFailure(deps.token, deps.authorization);
  if (denied !== null) return denied;

  const { stats } = await deps.store.readState();
  const last = stats.foldedThrough;
  const count = weekCount(deps.url.searchParams.get("weeks"));

  const weeks: StatsRow[] = [];
  if (last !== null) {
    for (let delta = -(count - 1); delta <= 0; delta += 1) {
      const week = shiftWeek(last, delta);
      if (!collected(stats, week)) continue;
      weeks.push({
        week,
        ...figures(mergeWeeks(stats, week, 1)),
        rolling4: figures(mergeWeeks(stats, week, 4)),
      });
    }
  }

  return new Response(JSON.stringify({ foldedThrough: last, sinceWeek: stats.sinceWeek, weeks }, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
