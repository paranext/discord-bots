import type { Config, TeamName, UrgencyKey } from "../../config/config.js";
import { isOpen, recordId, type PrRecord } from "./record.js";

export type Section =
  | { kind: "team"; team: TeamName }
  | { kind: "triage" }
  | { kind: "claimed" };

export interface Row {
  record: PrRecord;
  id: string;
  section: Section;
}

export interface TruncateResult {
  rendered: Row[];
  droppedCount: number;
}

export interface MenuOption {
  label: string;
  value: string;
  description: string;
}

/** Null urgency ranks below every level: every scanned row has none, so during
 *  shadow mode this rule decides the entire list. */
export function urgencyRank(urgency: UrgencyKey | null, config: Config): number {
  if (urgency === null) return Number.MAX_SAFE_INTEGER;
  return config.urgencies.find((u) => u.key === urgency)?.rank ?? Number.MAX_SAFE_INTEGER - 1;
}

function sectionOrder(section: Section, config: Config): number {
  if (section.kind === "team") return config.teams.indexOf(section.team);
  if (section.kind === "triage") return config.teams.length;
  return config.teams.length + 1;
}

/**
 * A record whose team is no longer in config renders as TRIAGE, not as a section
 * of its own.
 *
 * Dropping a name from `config.teams` is a one-line edit that still typechecks —
 * `TeamName` is a union, not the array — and it does not touch records already
 * in the store. `sectionOrder`'s `indexOf` returns -1 for such a team, which
 * sorts it ahead of every real section, so the pin would open with a heading for
 * a team that no longer exists. `submit.ts` already refuses to CREATE a record
 * for an unknown team for this exact reason; this is the same guard for the
 * records that predate the config change, and it makes removing a team degrade
 * into "those rows need re-triaging" rather than into a corrupt-looking digest.
 */
function sectionFor(r: PrRecord, config: Config): Section {
  if (r.claimedBy !== null) return { kind: "claimed" };
  if (r.team === null) return { kind: "triage" };
  if (!config.teams.includes(r.team)) return { kind: "triage" };
  return { kind: "team", team: r.team };
}

/** Urgency first, then oldest first. Shared by `rankRows` (which applies it
 *  within a section) and `truncateRows` (which applies it across all of them),
 *  so the display order and the drop order cannot drift out of agreement about
 *  what "more urgent" means. */
function byUrgencyThenAge(a: Row, b: Row, config: Config): number {
  const byUrgency = urgencyRank(a.record.urgency, config) - urgencyRank(b.record.urgency, config);
  if (byUrgency !== 0) return byUrgency;

  const byAge = a.record.firstRequestedAt - b.record.firstRequestedAt;
  if (byAge !== 0) return byAge;

  // Deterministic tie-break: without this the body can churn between ticks
  // purely from store iteration order, defeating the write-skip.
  return a.id.localeCompare(b.id);
}

/** DISPLAY order: section first, so the digest can render team headings in
 *  config order. Which rows are dropped when capacity runs out is a separate
 *  question with a different answer — see `truncateRows`. */
export function rankRows(records: PrRecord[], config: Config): Row[] {
  const rows: Row[] = records
    .filter(isOpen)
    .map((record) => ({ record, id: recordId(record), section: sectionFor(record, config) }));

  return rows.sort((a, b) => {
    const bySection = sectionOrder(a.section, config) - sectionOrder(b.section, config);
    if (bySection !== 0) return bySection;
    return byUrgencyThenAge(a, b, config);
  });
}

/**
 * Chooses WHICH rows survive the row-count cap, and hands them back still in
 * `rows`'s own (section) order for display.
 *
 * Taking a flat prefix of `rankRows`'s output would drop by SECTION, not by
 * urgency: with 20 🧊 This week rows in the first team section and 3 🔥 Blocking
 * rows in the last, a cap of 20 hides all three blocking rows. The spec says the
 * opposite — "when capacity is exhausted, rows are dropped lowest-urgency and
 * most-recently requested first" — and it matters twice over, because the claim
 * and resolve menus are populated from the surviving rows, so a dropped blocking
 * row is not actionable from the digest either.
 *
 * So selection ranks across ALL sections by urgency and age; display grouping is
 * left exactly as it was.
 */
export function truncateRows(rows: Row[], maxRows: number, config: Config): TruncateResult {
  if (rows.length <= maxRows) return { rendered: rows, droppedCount: 0 };

  const kept = new Set(
    [...rows]
      .sort((a, b) => byUrgencyThenAge(a, b, config))
      .slice(0, maxRows)
      .map((row) => row.id),
  );

  return { rendered: rows.filter((row) => kept.has(row.id)), droppedCount: rows.length - maxRows };
}

export function encodeOptionValue(r: PrRecord): string {
  return `${recordId(r)}:${r.lastRequestedAt}`;
}

export function decodeOptionValue(value: string): { id: string; lastRequestedAt: number } | null {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const id = value.slice(0, separator);
  const stamp = Number(value.slice(separator + 1));
  if (!Number.isFinite(stamp) || id.split("/").length !== 3) return null;
  return { id, lastRequestedAt: stamp };
}

const DISCORD_OPTION_MAX = 100;

function clamp(text: string, max = DISCORD_OPTION_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Menus are populated from the digest's own ranking so the visible set and the
 * actionable set are the same set. Populating them oldest-first independently
 * would omit a 🔥 row requested 90 minutes ago — the most urgent row on the list
 * and one of the newest.
 */
export function menuOptions(rendered: Row[], kind: "claim" | "resolve", config: Config): MenuOption[] {
  // Claimed rows stay ON the claim menu, after the unclaimed ones. Filtering
  // them out reads as obvious housekeeping — you cannot claim what someone
  // holds — but it makes two documented behaviours unreachable: selecting a row
  // you already hold RELEASES it, and selecting someone else's reports who has
  // it. Both are implemented in the interaction handler, and neither could ever
  // fire, so a claimer who could not get to the PR had no way to give it back:
  // the row sat under their name in **Being reviewed**, where nobody else picks
  // one up, until the two-day stale-claim sweep. (The reaction path that might
  // have been the escape hatch is deferred to plan 3.)
  //
  // Unclaimed first, because the 25-option cap is real and an actionable row
  // outranks an informational one — the ranking order is preserved within each
  // half, so the visible set and the actionable set stay the same set.
  const eligible =
    kind === "claim"
      ? [
          ...rendered.filter((r) => r.record.claimedBy === null),
          ...rendered.filter((r) => r.record.claimedBy !== null),
        ]
      : rendered;

  return eligible.slice(0, 25).map((row) => {
    const urgency = config.urgencies.find((u) => u.key === row.record.urgency);
    const prefix = urgency === undefined ? "" : `${urgency.emoji} `;
    // Says who holds it before anyone selects it, so the "already claimed"
    // reply is a confirmation rather than the first anyone hears of it.
    const holder = kind === "claim" && row.record.claimedBy !== null ? (row.record.claimedByName ?? "someone") : null;
    const context = `${row.record.repo}#${row.record.number}${row.record.team === null ? "" : ` · ${row.record.team}`}`;
    return {
      label: clamp(`${holder === null ? "" : "👀 "}${prefix}${row.record.title}`),
      // `value` is capped at 100 characters by Discord exactly as `label` and
      // `description` are, and an over-long one is not a bad option — it is a
      // 400 on the whole PATCH, so the digest stops repainting and freezes
      // showing PRs that are already done. Current id shapes cannot reach 100,
      // which is why this was easy to miss; clamped anyway, because the cost of
      // being wrong is the entire message rather than one row.
      //
      // Clamping deliberately uses the same ellipsis as the others rather than a
      // bare truncation: the "…" guarantees `decodeOptionValue` returns null (the
      // trailing stamp stops being a finite number), so selecting such a row
      // fails with "could not read that selection" instead of silently decoding
      // to a truncated id that might name a different record.
      //
      // Stated plainly, because "the clamp makes this safe" is easy to read as
      // stronger than it is: this clamp is LENGTH-safe, not COLLISION-safe. It
      // cuts the tail, and the tail (`number:lastRequestedAt`) is the part that
      // varies within one repo, so two rows in a sufficiently long-named repo
      // clamp to the same string. That needs `owner/repo` alone to exceed ~97
      // characters — GitHub allows it (owner ≤ 39, repo ≤ 100) but no repo this
      // bot watches is close, which is why it is not fixed here.
      //
      // Truncating the MIDDLE to preserve the trailing stamp would be a worse
      // trade, not a better one: a middle-truncated `owner/rep…o/177:1788…`
      // still has three slash-separated parts and a finite stamp, so it DECODES
      // — into an id that names nothing, or on a real collision the wrong row.
      // The fail-closed refusal above is the property worth keeping, and it was
      // verified to hold at every truncation length, not just one fixture. If a
      // repo name ever does get long enough to matter, the fix is a shorter
      // encoding (hash the id) so the clamp never fires at all — not moving
      // where the cut lands.
      value: clamp(encodeOptionValue(row.record)),
      description: clamp(holder === null ? context : `held by ${holder} · ${context}`),
    };
  });
}
