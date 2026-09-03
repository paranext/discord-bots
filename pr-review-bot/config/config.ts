export type TeamName = "Power" | "Simple" | "General";

export type UrgencyKey = "blocking" | "soon" | "thisWeek";

export interface UrgencyLevel {
  key: UrgencyKey;
  emoji: string;
  label: string;
  /** Lower sorts first. Null urgency (scanned rows) ranks below every level. */
  rank: number;
  requiresNote: boolean;
}

export interface Config {
  allowedChannelIds: string[];
  digestChannelId: string;
  prdForumChannelId: string;
  repoAllowlist: string[];
  teams: TeamName[];
  urgencies: UrgencyLevel[];
  claimEmoji: string;
  staleClaimMs: number;
  refreshIntervalMs: number;
  recentlyClearedMs: number;
  staleBannerMs: number;
  retentionMs: number;
  /** How long after resolution a row still offers a "reopen" option on the
   *  digest's resolve menu. Read by both the renderer (which rows are OFFERED)
   *  and the interaction handler (which rows are ACCEPTED) so those two
   *  windows cannot drift apart. */
  reopenWindowMs: number;
  /** How long a rejected submission's values stay stashed for the "Fix and
   *  retry" button. Deliberately LONGER than Discord's 15-minute interaction
   *  token: at exactly 15 minutes the expiry branch is unreachable, because the
   *  button lives on a message created by that same token and dies with it. A
   *  longer window makes the token the binding constraint and the "your form
   *  expired" message a path a user can actually reach. */
  retryStashMs: number;
  scanLookbackMs: number;
  dailyPostHourLocal: number;
  dailyPostTimeZone: string;
  budgets: {
    scanPagesPerTick: number;
    purgePerTick: number;
    reactionReadsPerTick: number;
    /** Hard cap on stashed submissions. All state lives under one Durable
     *  Object key, so an unbounded map on a path with no cap is a storage-size
     *  problem, not untidiness. Oldest are dropped first. */
    retryStashEntries: number;
  };
  /** Off on a CPU-capped host: the submit handler writes and returns, next tick renders. */
  immediateDigestRewrite: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const config: Config = {
  allowedChannelIds: ["REPLACE_WITH_REVIEW_CHANNEL_ID"],
  digestChannelId: "REPLACE_WITH_REVIEW_CHANNEL_ID",
  prdForumChannelId: "REPLACE_WITH_PRD_FORUM_ID",
  repoAllowlist: [
    "paranext/paranext-core",
    "paranext/paratext-10-studio",
    "paranext/paratext-assistant",
    "paranext/paratext-bible-extensions",
    "paranext/paratext-bible-internal-extensions",
    "eten-tech-foundation/scripture-editors",
  ],
  teams: ["Power", "Simple", "General"],
  urgencies: [
    { key: "blocking", emoji: "🔥", label: "Blocking", rank: 0, requiresNote: true },
    { key: "soon", emoji: "🫕", label: "Soon", rank: 1, requiresNote: false },
    { key: "thisWeek", emoji: "🧊", label: "This week", rank: 2, requiresNote: false },
  ],
  claimEmoji: "code_review:1075535230087221248",
  staleClaimMs: 2 * DAY,
  refreshIntervalMs: 5 * MINUTE,
  recentlyClearedMs: 1 * HOUR,
  staleBannerMs: 30 * MINUTE,
  retentionMs: 30 * DAY,
  reopenWindowMs: 24 * HOUR,
  retryStashMs: 30 * MINUTE,
  scanLookbackMs: 7 * DAY,
  dailyPostHourLocal: 9,
  dailyPostTimeZone: "America/Chicago",
  budgets: { scanPagesPerTick: 5, purgePerTick: 50, reactionReadsPerTick: 10, retryStashEntries: 50 },
  immediateDigestRewrite: true,
};
