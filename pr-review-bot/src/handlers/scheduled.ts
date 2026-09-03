import type { Config } from "../../config/config.js";
import { countsAsReview } from "../core/exit.js";
import { renderDigest } from "../core/render/digest.js";
import { isOpen, recordId } from "../core/record.js";
import { scanChannels } from "../discord/scan.js";
import { fetchPrdThreads } from "../discord/threads.js";
import type { DiscordRest } from "../discord/rest.js";
import type { CredentialProvider } from "../github/credentials.js";
import { fetchSnapshots } from "../github/query.js";
import { applyCommands } from "../store/apply.js";
import type { Command, CommandResult, DigestOutcome, Store } from "../store/types.js";

export interface TickDeps {
  store: Store;
  rest: DiscordRest;
  credentials: CredentialProvider;
  config: Config;
  botUserId: string;
  /** For `GET /guilds/{id}/threads/active`, which has no channel-scoped
   *  equivalent — step 7 must ask guild-wide and filter. */
  guildId: string;
  now: number;
  /** Runs the whole loop against live data and reports what it would post,
   *  without writing anything to the store or Discord. */
  readOnly?: boolean;
}

export interface TickReport {
  skipped: boolean;
  reason?: string;
  syncOk: boolean;
  synced: number;
  resolved: number;
  scanned: number;
  staleClaimsCleared: number;
  purged: number;
  notFound: number;
  /** True when the per-tick page budget stopped a channel walk short. The tick
   *  report is logged verbatim, so a partial backfill is visible in the tick log
   *  rather than silent — which matters most in shadow mode, whose whole purpose
   *  is proving the list is right, and where a truncated backfill and "no links
   *  there" otherwise look identical. */
  scanHitPageCap: boolean;
  digest: DigestOutcome | null;
  dailyPosted: boolean;
  subrequests: number;
}

/**
 * The three report counters that are read out of command RESULTS rather than
 * from the tick's own bookkeeping.
 *
 * Shared by the live and read-only paths deliberately. Shadow mode's report is
 * its *only* output — an operator reads these numbers to decide whether the bot
 * is behaving — so it has to be derived exactly as the live one is, from the
 * same `(commands, results)` pair. Read-only gets its results by projecting the
 * same command list through `applyCommands`; the live path gets them from the
 * store. Two hand-written copies of this arithmetic is how the read-only one
 * came to report zeroes and a raw command count.
 *
 * `scanned` counts CREATED records, not scan commands: a link to a PR already on
 * the list produces an `upsertScanned` whose result is `updated`, and counting
 * commands reports it as a new arrival.
 */
function resultCounters(
  commands: Command[],
  results: CommandResult[],
): { scanned: number; staleClaimsCleared: number; purged: number } {
  const counted = (kind: Command["kind"]): number => {
    const hit = results.find((r, i) => commands[i]?.kind === kind && r.kind === "count");
    return hit?.kind === "count" ? hit.count : 0;
  };
  return {
    scanned: results.filter((r, i) => commands[i]?.kind === "upsertScanned" && r.kind === "created").length,
    staleClaimsCleared: counted("clearStaleClaims"),
    purged: counted("purgeResolved"),
  };
}

export async function runTick(deps: TickDeps): Promise<TickReport> {
  const { store, rest, credentials, config, now } = deps;
  const readOnly = deps.readOnly === true;

  const empty: TickReport = {
    skipped: false, syncOk: true, synced: 0, resolved: 0, scanned: 0,
    staleClaimsCleared: 0, purged: 0, notFound: 0, scanHitPageCap: false,
    digest: null, dailyPosted: false, subrequests: 0,
  };

  // 1. Take the lease and read a snapshot. Store subrequest #1.
  const opening = await store.beginTick(now);
  let subrequests = 1;
  if (!opening.acquired) {
    return { ...empty, skipped: true, reason: opening.reason, subrequests };
  }

  // Every path below that ends the tick releases the lease itself (the
  // read-only `apply` here, or `finishTick` on the normal path). But a
  // *rejected* fetch (DNS failure, connection refused, an aborted request —
  // not an HTTP error status, which is handled below) propagates straight out
  // of this function, past both of those releases. Left unguarded, that holds
  // the lease for the full LEASE_TIMEOUT_MS, silently stops the digest from
  // repainting, and turns away the next several ticks with `lease-held`. The
  // `finally` below releases the lease exactly when neither happy-path release
  // ran, without swallowing the original error — it still propagates so the
  // tick is recorded as failed.
  let leaseReleased = false;
  // The identity of the lease THIS tick holds, for the fenced releases below: a
  // tick whose lease ages past LEASE_TIMEOUT_MS mid-flight must not clear a
  // lease a newer tick has since taken. `beginTick` stamps `heldSince` from the
  // `now` it was passed, so this is that same `now`; reading it back off the
  // returned snapshot rather than reusing `now` keeps the fence derived from
  // what was actually stored. The `?? now` only satisfies the nullable type —
  // an acquired lease is never null.
  const leaseHeldSince = opening.state.meta.syncLease?.heldSince ?? now;
  try {
    const openRecords = Object.values(opening.state.records).filter(isOpen);
    const commands: Command[] = [];
    let syncOk = true;
    let resolved = 0;
    let notFound = 0;

    // 2-4. Query GitHub per credential group, chunked, and apply the exit condition.
    if (openRecords.length > 0) {
      const outcome = await fetchSnapshots(credentials, openRecords.map(recordId), now);
      subrequests += outcome.subrequests;

      if (outcome.failedGroups.length > 0) syncOk = false;

      for (const record of openRecords) {
        const id = recordId(record);
        const snapshot = outcome.snapshots.get(id);
        if (snapshot !== undefined) {
          commands.push({ kind: "applySnapshot", id, snapshot, now });
          // Counted here rather than after the fact so the report is honest even in
          // read-only mode, where nothing is committed. Uses the SAME predicate the
          // store applies via applySnapshot/exitVerdict — a hand-copied
          // re-implementation here would risk diverging on a null-author review:
          // countsAsReview's sameLogin() treats two nulls as NOT a match (a review
          // by a deleted account on a record with no known author counts), where an
          // inline `(a ?? "") === (b ?? "")` would compare "" === "" and wrongly
          // call it a self-review.
          const prAuthorLogin = record.prAuthorLogin ?? snapshot.authorLogin;
          if (snapshot.merged || snapshot.state === "CLOSED") resolved += 1;
          else if (snapshot.reviews.some((r) => countsAsReview(r, prAuthorLogin, record.lastRequestedAt))) resolved += 1;
        } else if (outcome.notFound.includes(id)) {
          // A null is never "gone": mark it paused, never resolved.
          commands.push({ kind: "markSyncPaused", id, at: now });
          notFound += 1;
        }
      }
    }

    // 5. Clear stale claims.
    commands.push({ kind: "clearStaleClaims", now });

    // 6. Scan configured channels, paginated.
    const storedBackfill = opening.state.meta.scanBackfill ?? {};
    const scan = await scanChannels(rest, config, opening.state.meta.scanCursors, storedBackfill, deps.botUserId, now);
    subrequests += scan.pagesRead;
    commands.push(...scan.commands);
    const backfillUpdates = Object.entries(scan.backfill);
    if (Object.keys(scan.cursors).length > 0 || backfillUpdates.length > 0) {
      // A channel whose backward walk finished is DELETED from the map rather
      // than stored as null: an absent entry is what makes the next tick take the
      // forward-walk branch.
      const scanBackfill = { ...storedBackfill };
      for (const [channelId, resumeFrom] of backfillUpdates) {
        if (resumeFrom === null) delete scanBackfill[channelId];
        else scanBackfill[channelId] = resumeFrom;
      }
      commands.push({
        kind: "setMeta",
        patch: { scanCursors: { ...opening.state.meta.scanCursors, ...scan.cursors }, scanBackfill },
      });
    }

    // 7. Refresh the cached PRD thread list. A failed fetch returns a null cache
    // and emits NO command, so the previously cached list survives — an empty
    // dropdown is the outage the cache exists to prevent, and a stale one is a
    // working dropdown. Step 8 (reaction reads) belongs to plan 3.
    const prd = await fetchPrdThreads(rest, deps.guildId, config.prdForumChannelId, now);
    subrequests += prd.requests;
    if (prd.cache !== null) commands.push({ kind: "setMeta", patch: { prdCache: prd.cache } });
    // Visible every tick, not only on failure: "archived: 0" every tick is the
    // exact shape of the bug this counter exists to catch, and it otherwise
    // needs a fixture to notice.
    console.log(`[PRD_CACHE] active=${prd.activeCount} archived=${prd.archivedCount}`);

    // 10. Purge beyond retention, capped per tick.
    commands.push({ kind: "purgeResolved", now });

    // lastSync advances only on a successful sync, so a stale list looks stale.
    if (syncOk) commands.push({ kind: "setMeta", patch: { lastSync: now } });

    if (readOnly) {
      // Render the projected state — the opening snapshot with `commands`
      // actually applied in memory — so this logs the message the tick would
      // post, not the message it would have posted before any of this tick's
      // own commands ran. Nothing is committed: `applyCommands` is pure.
      const projected = applyCommands(opening.state, commands, config);
      const render = renderDigest({
        records: Object.values(projected.state.records),
        lastSync: projected.state.meta.lastSync,
        now,
        config,
      });
      console.log("[read-only] would render:\n" + render.embeds.map((e) => e.description).join("\n---\n"));

      // beginTick already took the lease above; finishTick is the only thing that
      // releases it, and read-only mode never calls finishTick. Without this, the
      // first tick under READ_ONLY takes the lease and every tick for the next
      // LEASE_TIMEOUT_MS is turned away with lease-held — the loop runs once per
      // lease timeout instead of once per refreshIntervalMs, for the entire
      // duration of shadow mode. `apply` here never touches `records`, so this is
      // still "nothing committed" as far as the tracked data is concerned.
      await store.apply([{ kind: "releaseLease", heldSince: leaseHeldSince }], { now, rerender: false });
      leaseReleased = true;
      subrequests += 1;

      return {
        ...empty,
        syncOk,
        synced: openRecords.length,
        resolved,
        // From the projection's own results, not from zero and not from a raw
        // command count: these three are what an operator reads shadow mode's
        // behaviour off, and they must say what the tick WOULD have done.
        ...resultCounters(commands, projected.results),
        notFound,
        scanHitPageCap: scan.hitPageCap,
        subrequests,
        digest: {
          action: "skipped-unchanged",
          bodyHash: render.bodyHash,
          openCount: render.openCount,
          renderedCount: render.renderedCount,
        },
      };
    }

    // 9 + 11. Apply, re-read, render, PATCH, post the daily message, release the
    // lease — all inside one store call. Store subrequest #2. `syncOk` is not
    // part of FinishTickInput: the store's mutation is never conditioned on the
    // sync's success (scan ingests, stale-claim clears and purges are not
    // GitHub-derived), only the caller's own `lastSync` bookkeeping is.
    const finished = await store.finishTick({ commands, now, leaseHeldSince });
    leaseReleased = true;
    subrequests += 1;

    return {
      skipped: false,
      syncOk,
      synced: openRecords.length,
      resolved,
      ...resultCounters(commands, finished.results),
      notFound,
      scanHitPageCap: scan.hitPageCap,
      digest: finished.digest,
      dailyPosted: finished.dailyPosted,
      subrequests,
    };
  } finally {
    if (!leaseReleased) {
      try {
        await store.apply([{ kind: "releaseLease", heldSince: leaseHeldSince }], { now, rerender: false });
      } catch {
        // Do not mask the original error (still propagating from the try
        // block) with a failure to release the lease.
      }
    }
  }
}
