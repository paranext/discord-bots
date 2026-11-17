import type { DurationFigures, Figures, reviewStatsSummary } from "../stats/figures.js";
import { COLOR_NORMAL as STATS_COLOR } from "./digest.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOT_ENOUGH = "not enough reviews yet";

/** Minutes under an hour, hours (one decimal) under two days, days above.
 *  The unit is chosen from the value as it will be displayed, so 59.6 minutes
 *  reads "1.0h", not "60m", and 47.96 hours reads "2.0d", not "48.0h". */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  const hours = (ms / HOUR).toFixed(1);
  if (Number(hours) < 48) return `${hours}h`;
  return `${(ms / DAY).toFixed(1)}d`;
}

/** A median with its direction against the previous window. The arrow only
 *  appears when both sides exist and read differently: a withheld figure has
 *  nothing to compare against, and an arrow between two identical-looking
 *  numbers would claim a change the reader can't see. */
function medianText(current: number | null, previous: number | null): string {
  if (current === null) return NOT_ENOUGH;
  const text = formatDuration(current);
  if (previous === null) return text;
  const before = formatDuration(previous);
  if (before === text) return text;
  const arrow = current < previous ? "▼" : "▲";
  return `${text} (${arrow} from ${before})`;
}

/** No previous window (collection hasn't covered it yet) means no arrow. */
function line(key: keyof DurationFigures, current: Figures, previous: Figures | null): string {
  return medianText(current.medianMs[key], previous?.medianMs[key] ?? null);
}

export function renderReviewStats(
  summary: ReturnType<typeof reviewStatsSummary>,
): { color: number; description: string }[] {
  if (summary === null) {
    return [{ color: STATS_COLOR, description: "Review stats start after the first full week." }];
  }
  const { through, weeks, current, previous } = summary;
  const count = (f: Figures) => f.outcomes.reviewed;
  const lines = [
    `**Review stats: ${weeks === 1 ? "1 week" : `${weeks} weeks`} through ${through}**`,
    `📥 reviews completed **${count(current)}**${previous === null ? "" : ` (prev 4 wks: ${count(previous)})`}`,
    `⏱ typical wait until claimed: ${line("waitToClaim", current, previous)}`,
    `🔍 claimed → done: ${line("claimToDone", current, previous)}`,
  ];
  const slowest = current.p75Ms.total;
  if (slowest !== null) lines.push(`🐢 slowest 1 in 4 took over ${formatDuration(slowest)} end to end`);
  lines.push(
    `↩️ **${current.claimsDropped}** claims dropped or auto-cleared`,
    "",
    "Typical = median. Complete weeks only; a figure needs at least 5 reviews.",
  );
  return [{ color: STATS_COLOR, description: lines.join("\n") }];
}
