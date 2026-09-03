import { buildPrdCache, type PrdCache } from "../core/prd.js";
import type { DiscordRest } from "./rest.js";

/** One page is enough: the cap is 24 and the archived listing is
 *  newest-archived-first, so a second page could only contribute entries the
 *  cap would discard. */
const ARCHIVED_PAGE_LIMIT = 25;

/**
 * Refresh-loop step 7.
 *
 * A `null` cache means DO NOT WRITE — the caller skips the `setMeta` patch and
 * whatever was cached before survives. That is the whole failure policy: a
 * week-old PRD list is a working dropdown, and an empty one is exactly the
 * outage the cache exists to prevent. Both requests are counted either way so
 * the tick's subrequest total stays honest.
 */
export interface PrdFetchResult {
  cache: PrdCache | null;
  requests: number;
  /** Raw thread counts as fetched, before the parent filter or the 24-option
   *  cap — so a tick log can show "archived: 0" even without a fixture, rather
   *  than an operator inferring it from a dropdown days later. `-1` marks the
   *  endpoint that failed, so the log still shows which count is unknown
   *  rather than reading as a real zero. */
  activeCount: number;
  archivedCount: number;
}

export async function fetchPrdThreads(
  rest: DiscordRest,
  guildId: string,
  parentId: string,
  now: number,
): Promise<PrdFetchResult> {
  const active = await rest.getActiveThreads(guildId);
  const archived = await rest.getArchivedPublicThreads(parentId, ARCHIVED_PAGE_LIMIT);
  const requests = 2;
  const activeCount = active.ok ? (active.value.threads ?? []).length : -1;
  const archivedCount = archived.ok ? (archived.value.threads ?? []).length : -1;

  if (!active.ok || !archived.ok) {
    // Name BOTH failing endpoints, not just the first: when both fail, an
    // operator reading only "active 500" has no signal that the archived call
    // — the one that actually matters, since it is the whole reason this
    // cache exists — failed too.
    const failed = [
      ...(active.ok ? [] : [`active ${active.status}`]),
      ...(archived.ok ? [] : [`archived ${archived.status}`]),
    ].join(", ");
    console.warn(`[PRD_CACHE_SKIPPED] thread fetch failed (${failed}); keeping the previously cached list`);
    return { cache: null, requests, activeCount, archivedCount };
  }

  return {
    cache: buildPrdCache({
      active: active.value.threads ?? [],
      archived: archived.value.threads ?? [],
      parentId,
      refreshedAt: now,
    }),
    requests,
    activeCount,
    archivedCount,
  };
}
