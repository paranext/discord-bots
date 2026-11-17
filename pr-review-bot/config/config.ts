export type UrgencyKey = "blocking" | "soon" | "thisWeek";

export interface UrgencyLevel {
  key: UrgencyKey;
  /** Null renders the label alone. Not every level earns an icon: the scheme is
   *  🔥 for "review this now" and 🧊 for "this can wait", and a third icon
   *  competing with those two would flatten the distinction they exist to draw. */
  emoji: string | null;
  label: string;
  /** Lower sorts first. Null urgency ranks below every level. */
  rank: number;
  requiresNote: boolean;
}

export interface Config {
  allowedChannelIds: string[];
  digestChannelId: string;
  urgencies: UrgencyLevel[];
  claimEmoji: string;
  staleClaimMs: number;
  refreshIntervalMs: number;
  /** How long a resolved row keeps its line under "Recently cleared". A day,
   *  not an hour: the section is the team's standing record of what got
   *  cleared, and an hour-long window emptied it before most of the team had
   *  looked. Must stay >= `reopenWindowMs`: every row the resolve menu offers
   *  to reopen needs a line here to point at, or the menu carries an entry with
   *  no context (`tests/core/config.test.ts` enforces this). */
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
  dailyPostHourLocal: number;
  dailyPostTimeZone: string;
  budgets: {
    purgePerTick: number;
    reactionReadsPerTick: number;
    /** Hard cap on stashed submissions. All state lives under one Durable
     *  Object key, so an unbounded map on a path with no cap is a storage-size
     *  problem, not untidiness. Oldest are dropped first. */
    retryStashEntries: number;
  };
  /** Off because the free plan's CPU budget can't fit an inline rewrite; the next tick renders. */
  immediateDigestRewrite: boolean;
}

/**
 * Cloudflare's free-plan subrequest limit per invocation. A PLATFORM BOUND, not
 * a tuning knob — it tracks what Cloudflare enforces, and hitting the real
 * ceiling kills a tick mid-write, which is the failure the two-store-subrequest
 * invariant exists to prevent. (`LEASE_TIMEOUT_MS` makes the same distinction
 * but lives in `src/store/types.ts`, because both `Store` implementations
 * import it; nothing outside the tick handler needs this one.)
 */
export const SUBREQUEST_CEILING = 50;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const config: Config = {
  /** Placeholders, for tests and preview only. Production values come from
   *  `loadConfig`, which reads the Worker secrets. */
  allowedChannelIds: ["REPLACE_WITH_REVIEW_CHANNEL_ID"],
  /** Placeholder, as above. */
  digestChannelId: "REPLACE_WITH_REVIEW_CHANNEL_ID",
  urgencies: [
    { key: "blocking", emoji: "🔥", label: "Blocking", rank: 0, requiresNote: true },
    { key: "soon", emoji: null, label: "Soon", rank: 1, requiresNote: false },
    { key: "thisWeek", emoji: "🧊", label: "This week", rank: 2, requiresNote: false },
  ],
  claimEmoji: "code_review:1075535230087221248",
  staleClaimMs: 2 * DAY,
  refreshIntervalMs: 5 * MINUTE,
  recentlyClearedMs: 24 * HOUR,
  staleBannerMs: 30 * MINUTE,
  retentionMs: 30 * DAY,
  reopenWindowMs: 24 * HOUR,
  retryStashMs: 30 * MINUTE,
  dailyPostHourLocal: 9,
  dailyPostTimeZone: "America/Chicago",
  budgets: { purgePerTick: 50, reactionReadsPerTick: 10, retryStashEntries: 50 },
  immediateDigestRewrite: false,
};

/** The Worker bindings `loadConfig` reads. Secrets, not source: channel IDs
 *  are deploy-specific (a fork supplies its own), so none is committed, and
 *  a var would print them in the public deploy log. */
export interface ChannelEnv {
  /** Comma-separated channel IDs the bot accepts submissions from. */
  REVIEW_CHANNEL_IDS?: string;
  DIGEST_CHANNEL_ID?: string;
}

/** Thrown for a missing or malformed binding. Messages name the binding and
 *  never echo its value, because the value is a secret and a bad one is often a
 *  pasted token or the wrong secret entirely. */
export class ConfigError extends Error {}

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Merges the channel IDs from `env` into `base`. Fails loudly: a Worker with no
 * valid channel would otherwise accept nothing and say nothing, which looks like
 * a dead bot, not a misconfigured one.
 */
export function loadConfig(env: ChannelEnv, base: Config = config): Config {
  const allowedChannelIds = (env.REVIEW_CHANNEL_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  if (allowedChannelIds.length === 0) {
    throw new ConfigError("REVIEW_CHANNEL_IDS is missing or empty");
  }
  if (!allowedChannelIds.every((id) => SNOWFLAKE.test(id))) {
    throw new ConfigError("REVIEW_CHANNEL_IDS must be comma-separated Discord channel IDs");
  }

  const digestChannelId = (env.DIGEST_CHANNEL_ID ?? "").trim();
  if (digestChannelId === "") {
    throw new ConfigError("DIGEST_CHANNEL_ID is missing or empty");
  }
  if (!SNOWFLAKE.test(digestChannelId)) {
    throw new ConfigError("DIGEST_CHANNEL_ID must be a Discord channel ID");
  }
  if (!allowedChannelIds.includes(digestChannelId)) {
    throw new ConfigError("DIGEST_CHANNEL_ID must be one of the REVIEW_CHANNEL_IDS");
  }

  return { ...base, allowedChannelIds, digestChannelId };
}
