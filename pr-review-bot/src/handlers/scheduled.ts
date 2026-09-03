import { SUBREQUEST_CEILING, type Config } from "../../config/config.js";
import { countsAsReview } from "../core/exit.js";
import { selectReactionTargets } from "../core/reactions.js";
import { renderDigest } from "../core/render/digest.js";
import { isOpen, recordId, type PrRecord } from "../core/record.js";
import { readReactors } from "../discord/reactions.js";
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
  /** Records actually polled by step 8. */
  reactionsRead: number;
  reactionClaims: number;
  reactionReleases: number;
  /** Eligible records, UNTRUNCATED — the number the cycle time is read off.
   *  Not bounded: `purgeResolved` only purges resolved records. */
  reactionsEligible: number;
  /** How much of `budgets.reactionReadsPerTick` the subrequest guard took away.
   *  NOT `eligible - read`: with 45 records and a budget of 10 that is 35 on
   *  every healthy tick, which is round-robin rotation, and a counter that is
   *  always nonzero signals nothing. */
  reactionsBudgetShed: number;
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
): { scanned: number; staleClaimsCleared: number; purged: number; reactionClaims: number; reactionReleases: number } {
  const counted = (kind: Command["kind"]): number => {
    const hit = results.find((r, i) => commands[i]?.kind === kind && r.kind === "count");
    return hit?.kind === "count" ? hit.count : 0;
  };
  // SUMMED, not `find`ed: there is one `clearStaleClaims` per tick but up to
  // `allowance` reactionSyncs, so a first-match read would report at most one.
  const syncs = results.filter((r) => r.kind === "reaction-sync");
  return {
    scanned: results.filter((r, i) => commands[i]?.kind === "upsertScanned" && r.kind === "created").length,
    staleClaimsCleared: counted("clearStaleClaims"),
    purged: counted("purgeResolved"),
    reactionClaims: syncs.reduce((sum, r) => sum + (r.kind === "reaction-sync" ? r.claimed.length : 0), 0),
    reactionReleases: syncs.reduce((sum, r) => sum + (r.kind === "reaction-sync" ? r.released.length : 0), 0),
  };
}

/**
 * The four subrequests step 8's `RESERVE` sets aside for these notices.
 *
 * The cap is on SUBREQUESTS SPENT, not on DMs delivered. Counting deliveries is
 * what let a tick whose losing reactors all have "DMs from server members"
 * disabled issue one Create-DM call per loser with no bound at all: every 403
 * `continue`d without consuming a slot, so a tick with a handful of contested
 * records could spend three times what it reserved, cross the 50-subrequest
 * ceiling, and hammer the same blocked recipients again five minutes later —
 * the exact Create-DM abuse ceiling this path exists to stay under.
 *
 * Two subrequests buy one delivered DM (open the channel, post), so this is
 * still two DMs a tick when everything works, and a failed open costs one rather
 * than forfeiting a whole slot.
 */
const DM_SUBREQUEST_CAP = 4;

async function notifySuperseded(
  rest: DiscordRest,
  results: CommandResult[],
  records: Record<string, PrRecord>,
  // A mutable accumulator the CALLER owns, not a return value: a rejection
  // from a later DM in this same loop must not discard the subrequest count
  // for DMs already sent earlier in it. `runTick`'s `finally`-style add-on
  // reads this object even when `notifySuperseded` itself throws.
  counters: { subrequests: number },
): Promise<void> {
  // The caller owns `counters` and may have spent against it already, so the
  // budget is measured from where this loop starts rather than from zero.
  const start = counters.subrequests;
  for (const result of results) {
    if (result.kind !== "reaction-sync") continue;
    for (const loser of result.superseded) {
      // Room for the WHOLE notice, not just its first half: checked before the
      // channel-open because a notice that opens a channel it cannot afford to
      // post into spends a request and delivers nothing.
      if (counters.subrequests - start + 2 > DM_SUBREQUEST_CAP) {
        console.warn(`[REACTIONS] superseded notice for ${loser.userId} on ${result.id} not sent — per-tick DM budget spent`);
        continue;
      }
      const channel = await rest.createDmChannel(loser.userId);
      counters.subrequests += 1;
      if (!channel.ok) {
        // Almost always "DMs from server members disabled" — a stable property
        // of the recipient's settings. Never retried: a hot retry against a
        // stable 4xx is what the abuse ceiling punishes.
        console.warn(`[REACTIONS] could not open a DM with ${loser.userId} (${channel.status})`);
        continue;
      }
      const title = records[result.id]?.title ?? result.id;
      const posted = await rest.postMessage(channel.value.id, {
        content: `\`${result.id}\` (${title}) is already claimed by ${loser.byName} — your \`:code_review:\` reaction did not take.`,
      });
      counters.subrequests += 1;
      if (!posted.ok) {
        // The channel opened but the post itself failed — logged the same way as
        // a failed channel-open. The two subrequests it spent are already
        // charged above and are not refunded: they are gone whether or not
        // anything was delivered, and the cap exists to bound what is spent.
        console.warn(`[REACTIONS] could not DM ${loser.userId} about ${result.id} (${posted.status})`);
      }
    }
  }
}

export async function runTick(deps: TickDeps): Promise<TickReport> {
  const { store, rest, credentials, config, now } = deps;
  const readOnly = deps.readOnly === true;

  const empty: TickReport = {
    skipped: false, syncOk: true, synced: 0, resolved: 0, scanned: 0,
    staleClaimsCleared: 0, purged: 0, notFound: 0, scanHitPageCap: false,
    digest: null, dailyPosted: false, subrequests: 0,
    reactionsRead: 0, reactionClaims: 0, reactionReleases: 0,
    reactionsEligible: 0, reactionsBudgetShed: 0,
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
    // working dropdown.
    const prd = await fetchPrdThreads(rest, deps.guildId, config.prdForumChannelId, now);
    subrequests += prd.requests;
    if (prd.cache !== null) commands.push({ kind: "setMeta", patch: { prdCache: prd.cache } });
    // Visible every tick, not only on failure: "archived: 0" every tick is the
    // exact shape of the bug this counter exists to catch, and it otherwise
    // needs a fixture to notice.
    console.log(`[PRD_CACHE] active=${prd.activeCount} archived=${prd.archivedCount}`);

    // 8. Read `:code_review:` reactions, oldest-unchecked first, under an
    // allowance that sheds when the tick is near its subrequest ceiling. The v1
    // spec makes this the FIRST work to shed, because it is the only optional
    // work in the loop.
    //
    // The whole step is guarded: it sits between the scan and the render, and a
    // throw here would take the render with it — suppressing the stale banner,
    // which Monitoring names as the failure it most needs to avoid.
    const RESERVE = 5; // finishTick, plus two DMs at two subrequests each.
    const eligible = selectReactionTargets(Object.values(opening.state.records));
    const allowance = Math.max(
      0,
      Math.min(config.budgets.reactionReadsPerTick, SUBREQUEST_CEILING - subrequests - RESERVE),
    );
    let reactionsRead = 0;
    // A remaining BUDGET, not a record count: a burst confirmation (see
    // `readReactors`) costs a second subrequest on top of the normal one, and
    // the spec's "a confirming read cannot push a tick past its ceiling" means
    // that second subrequest has to come out of the same allowance rather than
    // being free. Tracking `remaining` and decrementing by the read's ACTUAL
    // cost is what makes that true; slicing `eligible` to a fixed record count
    // would let bursts push the tick's total subrequests past `allowance`.
    let remaining = allowance;
    // Owned here, not by `readReactors`, so the requests a rejecting fetch
    // already issued are still in the tick's total when the catch below runs.
    const readCounters = { subrequests: 0 };
    try {
      for (const id of eligible) {
        const record = opening.state.records[id];
        if (record === undefined || record.messageId === null) continue;
        // Only a claim held BY REACTION can be released by one disappearing, so
        // only that holder is worth a burst confirmation.
        const confirmHolderId = record.claimSource === "reaction" ? record.claimedBy : null;
        // A read that may need a burst confirmation costs two subrequests, so it
        // cannot start on the last single unit of the allowance: `remaining <= 0`
        // let one do exactly that and spend `allowance + 1`, one over the
        // ceiling on a tick that also pays for `finishTick` and two DMs — the
        // arithmetic RESERVE is sized to.
        const worst = confirmHolderId === null ? 1 : 2;
        if (remaining < worst) break;
        // `readReactors` charges `readCounters` before each request it issues,
        // so a rejecting fetch leaves the count truthful. Reading the delta,
        // rather than a returned total, is what survives the throw.
        const before = readCounters.subrequests;
        const read = await readReactors(rest, {
          channelId: record.channelId,
          messageId: record.messageId,
          emoji: config.claimEmoji,
          botUserId: deps.botUserId,
          confirmHolderId,
        }, readCounters);
        remaining -= readCounters.subrequests - before;

        if (read.kind === "ok") {
          // Counted here, not before the branch: `emoji-invalid` and
          // `rate-limited` below break the loop without ever inspecting a
          // per-record result, and counting them as "read" is what made a
          // deleted emoji report `read=1` forever instead of the `read=0`
          // operators are told to watch for (docs/operations.md).
          reactionsRead += 1;
          commands.push({ kind: "reactionSync", id, reactors: read.reactors, now });
          continue;
        }
        if (read.kind === "message-gone") {
          reactionsRead += 1;
          // The v1 spec's documented "Request message deleted": the record
          // survives, the digest row keeps its place and loses its link, and the
          // record drops out of the polling set for good.
          commands.push({ kind: "setRequestMessageId", id, messageId: null });
          continue;
        }
        if (read.kind === "truncated") {
          // A page Discord may have cut short is not an observation. Synced with
          // a null reactor list, which is the failed-read contract:
          // `reactionCheckedAt` advances so the record rotates to the back of
          // the queue, and `lastReactors` is left exactly as it was rather than
          // being replaced by a partial view that would read as a mass
          // departure. Logged as an error inside `readReactors`.
          reactionsRead += 1;
          commands.push({ kind: "reactionSync", id, reactors: null, now });
          continue;
        }
        if (read.kind === "emoji-invalid") {
          // NO state change. `claimEmoji` is one hardcoded snowflake, so this
          // fails on every eligible record in the same tick; anything mutating
          // here would apply to the whole list at once.
          console.error(`[REACTION_EMOJI_INVALID] ${config.claimEmoji} was rejected by Discord; the reaction path is disabled until it is fixed`);
          break;
        }
        if (read.kind === "rate-limited") break;
        // Any other 4xx/5xx: stamp the check time so the record rotates to the
        // back of the queue instead of being retried every tick. A systematic
        // 4xx must fail cold — 10,000 invalid responses in 10 minutes risks a
        // temporary IP ban.
        reactionsRead += 1;
        console.warn(`[REACTIONS] read failed for ${id} (${read.status})`);
        commands.push({ kind: "reactionSync", id, reactors: null, now });
      }
    } catch (error) {
      console.error(`[REACTIONS] step 8 aborted: ${String(error)}`);
    } finally {
      subrequests += readCounters.subrequests;
    }
    console.log(`[REACTIONS] eligible=${eligible.length} read=${reactionsRead} allowance=${allowance}`);

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
        reactionsRead,
        reactionsEligible: eligible.length,
        reactionsBudgetShed: config.budgets.reactionReadsPerTick - allowance,
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

    // Its own guard, deliberately. This runs after `leaseReleased = true`, so
    // the `finally` below does nothing for it — an unguarded rejected fetch here
    // would propagate out of a tick whose work is already committed and whose
    // digest is already patched, losing the entire TickReport for the sake of a
    // DM. `dmCounters` is mutated as each fetch actually happens, so a rejection
    // partway through (e.g. the second superseded reactor's channel-open) still
    // leaves the first DM's subrequests counted — the `finally` below reads
    // whatever `notifySuperseded` managed to accumulate before it threw.
    const dmCounters = { subrequests: 0 };
    try {
      await notifySuperseded(rest, finished.results, opening.state.records, dmCounters);
    } catch (error) {
      console.error(`[REACTIONS] superseded notices failed: ${String(error)}`);
    } finally {
      subrequests += dmCounters.subrequests;
    }

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
      reactionsRead,
      reactionsEligible: eligible.length,
      reactionsBudgetShed: config.budgets.reactionReadsPerTick - allowance,
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
