const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
 * days_from_civil). core/ may not use `Date`, so calendar math is done by hand.
 */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Calendar year containing the given day number (inverse of daysFromCivil, year only). */
function yearOfDay(days: number): number {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const m = mp < 10 ? mp + 3 : mp - 9;
  return yoe + era * 400 + (m <= 2 ? 1 : 0);
}

/** Monday=0 .. Sunday=6; 1970-01-01 was a Thursday. */
function weekday(days: number): number {
  return (((days + 3) % 7) + 7) % 7;
}

/**
 * ISO weeks in UTC, formatted `YYYY-Www`. Zero-padded so that string order is
 * chronological order, which lets stored week keys be compared with `<`/`>`.
 */
export function isoWeek(epochMs: number): string {
  const day = Math.floor(epochMs / DAY_MS);
  // The ISO year is the year of the week's Thursday.
  const thursday = day + (3 - weekday(day));
  const year = yearOfDay(thursday);
  const week = Math.floor((thursday - daysFromCivil(year, 1, 1)) / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Monday 00:00 UTC of the given ISO week. */
export function weekStartMs(week: string): number {
  const [y, w] = week.split("-W").map(Number) as [number, number];
  // Jan 4 is always in week 1.
  const jan4 = daysFromCivil(y, 1, 4);
  return (jan4 - weekday(jan4) + (w - 1) * 7) * DAY_MS;
}

/** Exclusive end of the week: the next Monday 00:00 UTC. */
export function weekEndMs(week: string): number {
  return weekStartMs(week) + WEEK_MS;
}

/** Shift by whole weeks; going through epoch time handles 52/53-week years. */
export function shiftWeek(week: string, delta: number): string {
  return isoWeek(weekStartMs(week) + delta * WEEK_MS);
}
