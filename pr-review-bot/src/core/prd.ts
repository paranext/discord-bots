/** One PRD forum thread, as the modal's dropdown needs it. */
export interface PrdOption {
  id: string;
  name: string;
}

/**
 * The cached PRD list the modal is built from. Refreshed by the cron (refresh
 * loop step 7) and never fetched on the modal path: a modal cannot be sent after
 * a deferred response, so any live call there is a latent outage with no escape
 * hatch.
 *
 * `truncated` is what lets the modal say "25 most recent shown" instead of
 * quietly presenting a partial list as complete.
 */
export interface PrdCache {
  options: PrdOption[];
  truncated: boolean;
  refreshedAt: number;
}

/** A thread as either Discord threads endpoint returns it, narrowed to the
 *  fields this module reads. `last_message_id` is optional AND nullable, and
 *  Discord documents that it "may not point to an existing or valid message" —
 *  so all three of absent, null and unparseable are handled the same way. */
export interface RawThread {
  id: string;
  name: string;
  parent_id?: string | null;
  last_message_id?: string | null;
}

/**
 * How many cached threads the modal's PRD select may carry.
 *
 * Discord caps a string select at 25 options and "None" is one of them, so the
 * cache contributes 24. `src/core/render/digest.ts` does the same reservation
 * for the resolve menu's reopen options.
 */
export const PRD_OPTION_CAP = 24;

const OPTION_LABEL_LIMIT = 100;

/**
 * Sort key: last activity, falling back to creation.
 *
 * Both are snowflakes and therefore time-ordered, but they encode DIFFERENT
 * clocks — a thread id is creation time, `last_message_id` is last activity —
 * so a list sorted across both is an approximation of "most recently active",
 * not a total order on it. That is acceptable for a 24-entry dropdown and is
 * written down so nobody later reads the sort as exact.
 */
function activityKey(t: RawThread): bigint {
  const raw = t.last_message_id;
  if (raw !== null && raw !== undefined && /^\d+$/.test(raw)) return BigInt(raw);
  return /^\d+$/.test(t.id) ? BigInt(t.id) : 0n;
}

export function buildPrdCache(input: {
  active: RawThread[];
  archived: RawThread[];
  parentId: string;
  refreshedAt: number;
}): PrdCache {
  // Active first so its copy wins the dedupe: an archived listing can carry a
  // stale name for a thread that has since been renamed and revived.
  const byId = new Map<string, RawThread>();

  // `/guilds/{id}/threads/active` is guild-wide, so this filter is not
  // optional — without it the dropdown fills with every thread in the server.
  for (const t of input.active) {
    if ((t.parent_id ?? null) !== input.parentId) continue;
    byId.set(t.id, t);
  }

  // `/channels/{id}/threads/archived/public` is already scoped to `parentId`
  // by the URL, so this loop applies NO parent filter — and must not: if a
  // forum's archived thread objects on that route ever omit `parent_id`, a
  // filter here would silently drop every archived thread, forever, with
  // `truncated: false` asserting a complete list. Archived threads are the
  // whole reason this cache exists (forum posts auto-archive), so this is the
  // one branch that must never go quietly empty.
  for (const t of input.archived) {
    if (!byId.has(t.id)) byId.set(t.id, t);
  }

  const sorted = [...byId.values()].sort((a, b) => {
    const ka = activityKey(a);
    const kb = activityKey(b);
    return ka === kb ? 0 : kb > ka ? 1 : -1;
  });

  return {
    options: sorted.slice(0, PRD_OPTION_CAP).map((t) => ({ id: t.id, name: t.name.slice(0, OPTION_LABEL_LIMIT) })),
    truncated: sorted.length > PRD_OPTION_CAP,
    refreshedAt: input.refreshedAt,
  };
}
