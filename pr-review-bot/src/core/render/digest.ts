import type { Config } from "../../../config/config.js";
import { stableHash } from "../hash.js";
import { isOpen, recordId, type PrRecord } from "../record.js";
import { menuOptions, rankRows, truncateRows, type Row } from "../ranking.js";
import { isStale, relTs } from "../time.js";
import { urgencyEmojiFor, urgencyFor, urgencyText } from "../urgency.js";

export const EMBED_DESCRIPTION_LIMIT = 4096;
export const EMBED_TOTAL_LIMIT = 6000;
/** Practical row ceiling. Real rows run 150-180 characters once titles are
 *  markdown links and ages are long-form relative timestamps. */
export const DEFAULT_MAX_ROWS = 20;

/** Neutral blurple for a normal (not stale) embed; `/review-stats` uses it too. */
export const COLOR_NORMAL = 0x5865f2;
const COLOR_STALE = 0xf0b232;

export function overflowNotice(count: number): string {
  return `_…and ${count} more not shown here (message capacity reached). Use \`/review-list\` to see everything._`;
}

/**
 * Upper bound on the length of `overflowNotice`'s output, reserved out of the
 * second embed's budget up front. Derived, never hand-counted: a literal
 * constant would silently drift the moment anyone rewords the notice, and a
 * reserve short by even a few characters reproduces the exact 400 this
 * budgeting exists to prevent. 999_999 is a generous bound on how large the
 * dropped-row count could ever plausibly be.
 */
export const OVERFLOW_NOTICE_RESERVE = overflowNotice(999_999).length;

export interface DigestInput {
  records: PrRecord[];
  lastSync: number | null;
  now: number;
  config: Config;
  maxRows?: number;
}

export interface DigestEmbed {
  color: number;
  description: string;
}

export interface DigestRender {
  embeds: DigestEmbed[];
  components: unknown[];
  bodyHash: string;
  openCount: number;
  renderedCount: number;
  droppedCount: number;
}

function prUrl(r: PrRecord): string {
  return `https://github.com/${r.owner}/${r.repo}/pull/${r.number}`;
}

function urgencyLabel(r: PrRecord, config: Config): string | null {
  const level = urgencyFor(r, config);
  return level === null ? null : urgencyText(level);
}

function markers(r: PrRecord): string[] {
  const out: string[] = [];
  if (r.isDraft) out.push("draft");
  if (r.syncPausedSince !== null) out.push("sync paused");
  if (r.lastClaimedByName !== null) out.push("previously claimed");
  return out;
}

function renderOpenRow(r: PrRecord, config: Config): string {
  const lines: string[] = [];
  const urgency = urgencyLabel(r, config);
  const head = [urgency, `[${r.title}](${prUrl(r)})`, relTs(r.firstRequestedAt)]
    .filter((part): part is string => part !== null)
    .join(" · ");
  lines.push(head);

  const sub = [`${r.repo}#${r.number}`, ...markers(r)];
  lines.push(`     ${sub.join(" · ")}`);

  // The blocking reason renders inline. This is the only place it is visible to
  // anyone deciding what to pick up, and therefore the only version in which the
  // required-note gate is accountable rather than ceremonial.
  if (r.urgency === "blocking" && r.note !== null && r.note.trim() !== "") {
    lines.push(`     _${r.note.trim()}_`);
  }

  return lines.join("\n");
}

/** No claim age: a timer beside a name in a permanently pinned message is a
 *  public lateness board, and the rational response to one is to stop claiming. */
function renderClaimedRow(r: PrRecord, config: Config): string {
  const emoji = urgencyEmojiFor(r, config);
  const suffix = emoji === null ? "" : ` · ${emoji}`;
  return `👀 [${r.title}](${prUrl(r)}) · ${r.claimedByName ?? "someone"}${suffix}`;
}

/** Carries its resolution time: with a day-long window, a clear from this
 *  morning and one from a minute ago must not read the same. A Discord
 *  timestamp renders client-side, so this costs the write-skip nothing. */
function renderClearedLine(r: PrRecord): string {
  const when = r.resolvedAt === null ? "" : ` · ${relTs(r.resolvedAt)}`;
  return `${r.repo}#${r.number} — ${r.resolvedBy ?? "resolved"}${when}`;
}

function buildBlocks(rows: Row[], config: Config): { open: string[]; claimed: string[] } {
  const open: string[] = [];
  const claimed: string[] = [];
  for (const row of rows) {
    if (row.record.claimedBy !== null) {
      claimed.push(renderClaimedRow(row.record, config));
      continue;
    }
    open.push(renderOpenRow(row.record, config));
  }
  return { open, claimed };
}

/**
 * Fits as many `parts` as possible under `limit` characters (joined with "\n"),
 * preserving order: once one part doesn't fit, every part after it — fits or
 * not — goes to `overflow`. This one job (packing under a byte budget) is
 * kept separate from deciding what that budget IS and what to do with what's
 * left over, which is the caller's job (see `fitSecondEmbed`).
 */
function joinWithinLimit(parts: string[], limit: number): { fitted: string[]; overflow: string[] } {
  const fitted: string[] = [];
  const overflow: string[] = [];
  let length = 0;
  for (const part of parts) {
    const cost = part.length + 1;
    if (overflow.length === 0 && length + cost <= limit) {
      fitted.push(part);
      length += cost;
    } else {
      overflow.push(part);
    }
  }
  return { fitted, overflow };
}

/**
 * Fits `overflow` (whatever didn't make it into the first embed) into a
 * second embed, honoring both Discord caps at once: the second embed's own
 * 4096-character limit, and the 6000-character total across both embeds
 * given how much the first embed already used.
 *
 * `budget` is space still available under the 6000 total. We first try
 * fitting everything with no reserve — the common case, where a claim or two
 * spilled over and easily fits. Only when that still leaves a remainder do we
 * retry with `OVERFLOW_NOTICE_RESERVE` characters held back, so the notice
 * naming what got cut can never itself be the thing that busts a cap.
 */
function fitSecondEmbed(
  overflow: string[],
  budget: number,
): { description: string } {
  const cap = Math.max(0, Math.min(EMBED_DESCRIPTION_LIMIT, budget));

  const full = joinWithinLimit(overflow, cap);
  if (full.overflow.length === 0) {
    return { description: full.fitted.join("\n") };
  }

  // Content still doesn't fit even in a whole second embed. Reserve room for
  // the notice and re-pack, then append it — under-reporting the list is the
  // one direction it must never lie in, so this must never be silent.
  const contentCap = Math.max(0, cap - OVERFLOW_NOTICE_RESERVE);
  const constrained = joinWithinLimit(overflow, contentCap);
  const parts = [...constrained.fitted];
  if (constrained.overflow.length > 0) {
    parts.push(overflowNotice(constrained.overflow.length));
  }
  return { description: parts.join("\n") };
}

export function renderDigest(input: DigestInput): DigestRender {
  const { records, lastSync, now, config } = input;
  const maxRows = input.maxRows ?? DEFAULT_MAX_ROWS;

  const allRows = rankRows(records, config);
  // Claimed rows are exempt from the row-count cap: rankRows sorts claimed rows
  // after every open row, so a backlog longer than maxRows
  // would otherwise truncate away exactly the rows someone is actively
  // working — the one section that must never silently disappear.
  const openRows = allRows.filter((r) => r.record.claimedBy === null);
  const claimedRows = allRows.filter((r) => r.record.claimedBy !== null);
  const { rendered: renderedOpen, droppedCount } = truncateRows(openRows, maxRows);
  const rendered = [...renderedOpen, ...claimedRows];
  const openCount = allRows.length;

  const stale = isStale(lastSync, now, config.staleBannerMs);

  // The header timestamp is rounded down to the refresh-interval boundary so
  // the body does not churn — and the write-skip does not lose its purpose —
  // on every tick inside the same interval.
  const tickStamp = Math.floor(now / config.refreshIntervalMs) * config.refreshIntervalMs;

  const openCountText = openCount === 0 ? "nothing waiting 🎉" : `${openCount} open`;

  // The fresh header's own "updated" stamp is display-only and MUST be kept
  // out of bodyHash: the refresh loop calls renderDigest once per
  // refreshIntervalMs tick, so tickStamp advances to a new bucket on every
  // single call — if that text fed the hash, an idle digest would edit
  // on every tick (288/day) purely to bump its own clock. hashHeaderLines is
  // the same header stripped of that one volatile suffix; everything else
  // (open count, the stale banner and its lastSync epoch, row content) is
  // real state and stays hashed.
  const freshSummary = `**Needs review** · ${openCountText}`;
  const headerLines = stale
    ? [
        `⚠️ **Not syncing.** Last successful sync ${lastSync === null ? "never" : relTs(lastSync)}. Rows below may be out of date.`,
        freshSummary,
      ]
    : [`${freshSummary} · updated ${relTs(tickStamp)}`];
  const hashHeaderLines = stale ? headerLines : [freshSummary];

  const { open, claimed } = buildBlocks(rendered, config);

  // No row cap: every row cleared inside the window is listed. The point of the
  // digest is that no PR goes missing, and a fixed cap dropped rows silently on
  // any busy day. Message capacity is the only limit, and running into it adds
  // the overflow notice rather than cutting rows without a word.
  const cleared = records
    .filter((r) => !isOpen(r) && r.resolvedAt !== null && now - r.resolvedAt <= config.recentlyClearedMs)
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));

  const droppedLine =
    droppedCount > 0 ? [`_…and ${droppedCount} more. Use \`/review-list\` to see everything._`] : [];

  const primary: string[] = [...headerLines, ...open, ...droppedLine];
  const hashPrimary: string[] = [...hashHeaderLines, ...open, ...droppedLine];

  const trailing: string[] = [];
  if (claimed.length > 0) trailing.push(`**Being reviewed** (${claimed.length})`, ...claimed);
  if (cleared.length > 0) trailing.push("Recently cleared", ...cleared.map(renderClearedLine));

  const first = joinWithinLimit([...primary, ...trailing], EMBED_DESCRIPTION_LIMIT);
  const embeds: DigestEmbed[] = [
    { color: stale ? COLOR_STALE : COLOR_NORMAL, description: first.fitted.join("\n") },
  ];
  if (first.overflow.length > 0) {
    // The second embed's budget is bounded by BOTH its own 4096-character cap
    // and what's left of the 6000-across-both-embeds total once the first
    // embed's actual length is known — a claimed-row backlog (exempt from
    // maxRows) is exactly what can make the naive "always 4096" budget push
    // the pair over 6000.
    const firstLength = first.fitted.join("\n").length;
    const remainingBudget = EMBED_TOTAL_LIMIT - firstLength;
    const second = fitSecondEmbed(first.overflow, remainingBudget);
    embeds.push({ color: stale ? COLOR_STALE : COLOR_NORMAL, description: second.description });
  }

  // No components at all when there is nothing to act on: a String Select with an
  // empty option list is a 400, the PATCH fails, and the digest freezes showing
  // PRs that are already done.
  const claimChoices = menuOptions(rendered, "claim", config);
  const resolveChoices = menuOptions(rendered, "resolve", config);

  // A mis-resolve is recoverable: rows resolved within the reopen window ride
  // along on the same resolve menu as "reopen" options, filling out whatever
  // room the 25-option cap leaves after the open rows.
  const reopenChoices = records
    .filter((r) => r.resolvedAt !== null && now - r.resolvedAt <= config.reopenWindowMs)
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
    .slice(0, Math.max(0, 25 - resolveChoices.length))
    .map((r) => ({
      label: `↩︎ ${r.title}`.slice(0, 100),
      value: `reopen:${recordId(r)}:${r.lastRequestedAt}`.slice(0, 100),
      description: `reopen · ${r.resolvedBy ?? "resolved"}`.slice(0, 100),
    }));

  const components: unknown[] = [];
  if (claimChoices.length > 0) {
    components.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "digest:claim",
          placeholder: droppedCount > 0 ? `Claim a PR — top ${claimChoices.length} shown` : "Claim a PR",
          options: claimChoices,
        },
      ],
    });
  }
  if (resolveChoices.length + reopenChoices.length > 0) {
    components.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "digest:resolve",
          placeholder: "Resolve",
          options: [...resolveChoices, ...reopenChoices],
        },
      ],
    });
  }

  // bodyHash reflects the full logical content, independent of how it later
  // gets split across embeds to satisfy Discord's per-embed character cap —
  // that split is a transport detail, not a content change.
  //
  // `components` are hashed too. The reopen options are the one part of the
  // render that depends on wall-clock time (`now - resolvedAt <=
  // reopenWindowMs`). While `recentlyClearedMs >= reopenWindowMs` (a config
  // test enforces it) and "Recently cleared" lists every row in its window,
  // each reopen option has a body line, so the body text alone changes when an
  // option appears or expires. Hashing components keeps that true without
  // relying on the invariant: if a reopen option ever outlives its body line,
  // a body-only hash settles while the option is still live, every later tick
  // reports skipped-unchanged, and the pinned menu goes on offering
  // `↩︎ <title>` forever — a menu whose every selection is refused by the
  // reopen-window guard in the interaction handler.
  //
  // This does not reintroduce time-dependence into the hash. Every other input
  // to `components` is record state, and the reopen window itself moves the hash
  // exactly twice per resolved row: once when it appears, once when it expires.
  // An idle digest still writes nothing.
  const bodyHash = stableHash([...hashPrimary, ...trailing, JSON.stringify(components)].join("\u0000"));

  return {
    embeds,
    components,
    bodyHash,
    openCount,
    renderedCount: rendered.length,
    droppedCount,
  };
}
