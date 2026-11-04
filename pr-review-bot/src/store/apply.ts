import type { Config } from "../../config/config.js";
import { applyClaim, applyUnclaim, clearStaleClaim } from "../core/claims.js";
import { applySnapshotWithExit, type RoundExit } from "../core/exit.js";
import {
  isOpen,
  markRequested,
  newCommandRecord,
  recordId,
  reopenRecord,
  resolveRecord,
  type PrRecord,
} from "../core/record.js";
import { syncReactions } from "../core/reactions.js";
import { buildEntry } from "../core/stats/entry.js";
import { foldStats } from "../core/stats/fold.js";
import { emptyStats } from "../core/stats/types.js";
import { prSlug } from "../core/urls.js";
import { CURRENT_SCHEMA_VERSION, type Command, type CommandResult, type Meta, type StoreState } from "./types.js";

export function emptyState(): StoreState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    records: {},
    stats: emptyStats(),
    meta: {
      lastSync: null,
      digestMessageId: null,
      digestBodyHash: null,
      digestBodyVersion: 0,
      unpinnedReportedAt: null,
      lastDailyPostDate: null,
      syncLease: null,
      retryStash: {},
    },
  };
}

function put(records: Record<string, PrRecord>, record: PrRecord): Record<string, PrRecord> {
  return { ...records, [recordId(record)]: record };
}

/**
 * Stores a just-resolved record and, unless it is a legacy round, its anonymous
 * pending entry. The entry id comes from a counter, never the PR slug, so the
 * entry cannot be traced back to a PR. The record keeps the id so `reopen` can
 * withdraw the entry if the round turns out not to be over.
 */
function endRound(state: StoreState, resolved: PrRecord, exit: RoundExit, at: number): StoreState {
  const id = state.stats.nextEntryId;
  const entry = buildEntry(resolved, exit, id, at);
  if (entry === null) return { ...state, records: put(state.records, resolved) };
  return {
    ...state,
    records: put(state.records, { ...resolved, roundPendingEntryId: id }),
    stats: { ...state.stats, nextEntryId: id + 1, pending: [...state.stats.pending, entry] },
  };
}

/**
 * Wipes a resolved record's per-round timing once its reopen window has passed.
 * Left in place, `roundStartedAt` and `roundFirstClaimedAt` sit next to the PR's
 * identity and `resolvedBy` (which can name a reviewer) until the 30-day purge,
 * so exact per-PR, per-person claim timing would stay recoverable for a month.
 * The fields only exist to build the round's anonymous entry and to let a
 * reopen withdraw it; past the window `reopen` is refused, and the only way
 * back is a re-request, which `markRequested` treats as a fresh round that
 * resets every one of these fields anyway. So nothing reads them again.
 *
 * Returns the same object when there is nothing to scrub, so callers can tell
 * a no-op from a change by identity.
 */
function scrubRoundTiming(r: PrRecord, now: number, reopenWindowMs: number): PrRecord {
  // Strictly past the window, the same boundary `reopen` and the resolve menu
  // use: at exactly the window a reopen is still allowed, so the fields stay.
  if (r.resolvedAt === null || now - r.resolvedAt <= reopenWindowMs) return r;
  if (
    r.roundStartedAt === null &&
    r.roundFirstClaimedAt === null &&
    r.roundClaimsDropped === 0 &&
    r.roundReRequests === 0 &&
    r.roundPendingEntryId === null
  ) {
    return r;
  }
  return {
    ...r,
    roundStartedAt: null,
    roundFirstClaimedAt: null,
    roundClaimsDropped: 0,
    roundReRequests: 0,
    roundPendingEntryId: null,
  };
}

/** Shared revalidation for both menu-driven commands. Components persist across
 *  message edits, so an option list is only as fresh as the reader's client. */
function stale(record: PrRecord, expected: number | null): boolean {
  return expected !== null && record.lastRequestedAt !== expected;
}

function applyOne(
  state: StoreState,
  command: Command,
  config: Config,
): { state: StoreState; result: CommandResult } {
  switch (command.kind) {
    case "upsertRequest": {
      const id = prSlug(command.pr);
      const existing = state.records[id];
      if (existing === undefined) {
        const created = newCommandRecord({
          pr: command.pr,
          at: command.at,
          fields: command.fields,
          title: command.title,
          prAuthorLogin: command.prAuthorLogin,
          isDraft: command.isDraft,
        });
        return {
          state: { ...state, records: put(state.records, created) },
          result: { kind: "created" },
        };
      }

      const withMeta: PrRecord = {
        ...existing,
        title: command.title,
        prAuthorLogin: command.prAuthorLogin,
        isDraft: command.isDraft,
      };
      return {
        state: { ...state, records: put(state.records, markRequested(withMeta, command.at, command.fields)) },
        result: { kind: "updated" },
      };
    }

    case "setRequestMessageId": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      // A changed id points the record at a message that was never observed
      // (a new post) or at none at all (message-gone) — either way the stored
      // observation describes a message this record no longer points at, so
      // it must not survive. A no-op write (the id is unchanged) leaves it be.
      const changed = existing.messageId !== command.messageId;
      return {
        state: {
          ...state,
          records: put(state.records, {
            ...existing,
            messageId: command.messageId,
            lastReactors: changed ? null : existing.lastReactors,
          }),
        },
        result: { kind: "ok" },
      };
    }

    case "stashSubmission": {
      // Prune first, then add, then cap — in that order. Pruning after adding
      // could drop the entry just written if the clock is at its expiry, and
      // capping before adding leaves the map one over.
      const live = Object.entries(state.meta.retryStash).filter(([, e]) => e.expiresAt > command.now);
      const withNew = [...live.filter(([k]) => k !== command.key), [command.key, command.entry] as const];

      // Soonest-to-expire is dropped first, so the entry most likely to still be
      // wanted survives.
      const capped = withNew
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
        .slice(Math.max(0, withNew.length - config.budgets.retryStashEntries));

      return {
        state: { ...state, meta: { ...state.meta, retryStash: Object.fromEntries(capped) } },
        result: { kind: "ok" },
      };
    }

    case "applySnapshot": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      const { record, exit } = applySnapshotWithExit(existing, command.snapshot, command.now);
      return {
        state:
          exit === null
            ? { ...state, records: put(state.records, record) }
            : endRound(state, record, exit, command.now),
        result: { kind: "ok" },
      };
    }

    case "markSyncPaused": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      if (existing.syncPausedSince !== null) return { state, result: { kind: "ok" } };
      return {
        state: { ...state, records: put(state.records, { ...existing, syncPausedSince: command.at }) },
        result: { kind: "ok" },
      };
    }

    case "reactionSync": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      const outcome = syncReactions(existing, command.reactors, command.now);
      return {
        state: { ...state, records: put(state.records, outcome.record) },
        result: {
          kind: "reaction-sync",
          id: command.id,
          claimed: outcome.claimed,
          released: outcome.released,
          superseded: outcome.superseded,
        },
      };
    }

    case "claim": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      if (stale(existing, command.expectLastRequestedAt)) return { state, result: { kind: "stale" } };
      const outcome = applyClaim(existing, command.userId, command.displayName, command.at, "menu");
      if (outcome.kind === "claimed") {
        return { state: { ...state, records: put(state.records, outcome.record) }, result: { kind: "ok" } };
      }
      if (outcome.kind === "already-claimed") return { state, result: outcome };
      return { state, result: { kind: "not-open" } };
    }

    case "unclaim": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      const outcome = applyUnclaim(existing, command.userId, command.at);
      if (outcome.kind === "released") {
        return { state: { ...state, records: put(state.records, outcome.record) }, result: { kind: "ok" } };
      }
      if (outcome.kind === "already-claimed") return { state, result: outcome };
      return { state, result: { kind: "not-open" } };
    }

    case "resolve": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      // A row the tick already resolved must not have its resolvedBy overwritten
      // by a manual actor — that destroys the audit trail retention provides.
      if (!isOpen(existing)) return { state, result: { kind: "not-open" } };
      if (stale(existing, command.expectLastRequestedAt)) return { state, result: { kind: "stale" } };
      return {
        state: endRound(
          state,
          resolveRecord(existing, command.at, command.by),
          { outcome: "cleared", doneAt: command.at },
          command.at,
        ),
        result: { kind: "ok" },
      };
    }

    case "reopen": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      // The handler checks the window too, but against the record it read before
      // this batch ran. A fold tick in between may already have scrubbed the
      // round (see `scrubRoundTiming`), so reopening now would bring back a
      // record with no round start and no entry link. Refuse it here, inside
      // the atomic apply, where the check can't race.
      if (existing.resolvedAt !== null && command.at - existing.resolvedAt > config.reopenWindowMs) {
        return { state, result: { kind: "not-open" } };
      }
      const reopened = reopenRecord(existing, command.at);
      // Only a resolved record that really reopens had its round "end" by mistake;
      // reopening an open record (or one a new request already restarted) must
      // leave the earlier round's entry alone.
      const withdrawable = !isOpen(existing) && isOpen(reopened) ? existing.roundPendingEntryId : null;
      if (withdrawable === null) {
        return { state: { ...state, records: put(state.records, reopened) }, result: { kind: "ok" } };
      }
      return {
        state: {
          ...state,
          records: put(state.records, { ...reopened, roundPendingEntryId: null }),
          stats: { ...state.stats, pending: state.stats.pending.filter((e) => e.id !== withdrawable) },
        },
        result: { kind: "ok" },
      };
    }

    case "clearStaleClaims": {
      let count = 0;
      const records: Record<string, PrRecord> = {};
      for (const [id, record] of Object.entries(state.records)) {
        const cleared = clearStaleClaim(record, command.now, config.staleClaimMs);
        if (cleared !== record) count += 1;
        records[id] = cleared;
      }
      return { state: { ...state, records }, result: { kind: "count", count } };
    }

    case "purgeResolved": {
      const expired = Object.entries(state.records)
        .filter(([, r]) => r.resolvedAt !== null && command.now - r.resolvedAt > config.retentionMs)
        .sort((a, b) => (a[1].resolvedAt ?? 0) - (b[1].resolvedAt ?? 0))
        .slice(0, config.budgets.purgePerTick)
        .map(([id]) => id);

      if (expired.length === 0) return { state, result: { kind: "count", count: 0 } };
      const records = { ...state.records };
      for (const id of expired) delete records[id];
      return { state: { ...state, records }, result: { kind: "count", count: expired.length } };
    }

    case "foldStats": {
      const { stats, foldedIds, folded: foldedCount } = foldStats(state.stats, command.now, config.reopenWindowMs);
      // The entries are gone, so the links to them would dangle; a later reopen
      // must find nothing to withdraw rather than a stale id.
      const folded = new Set(foldedIds);
      let changed = stats !== state.stats;
      const records: Record<string, PrRecord> = {};
      for (const [id, r] of Object.entries(state.records)) {
        const unlinked =
          r.roundPendingEntryId !== null && folded.has(r.roundPendingEntryId) ? { ...r, roundPendingEntryId: null } : r;
        const next = scrubRoundTiming(unlinked, command.now, config.reopenWindowMs);
        if (next !== r) changed = true;
        records[id] = next;
      }
      // Nothing folded and nothing scrubbed: hand back the same object so a
      // no-op tick doesn't rewrite state.
      if (!changed) return { state, result: { kind: "count", count: 0 } };
      // The count is entries folded into a week; pre-sinceWeek entries dropped
      // unfolded are unlinked above but not counted.
      return { state: { ...state, records, stats }, result: { kind: "count", count: foldedCount } };
    }

    case "setMeta": {
      // `digestBodyVersion` is derived here, never patched: any patch that
      // touches `digestBodyHash` — including one setting it to `null`, and
      // including one setting it to the value already there — moves the counter
      // exactly one step. That is what makes the digest compare-and-set's
      // compare (`digestHashWriteBack`, on the counter) immune to a hash that
      // wanders away and back inside a writer's Discord round-trip. `in` rather
      // than a truthiness or undefined check: a patch explicitly clearing the
      // hash to `null` is a write and must count as one.
      const wroteHash = "digestBodyHash" in command.patch;
      const meta: Meta = {
        ...state.meta,
        ...command.patch,
        digestBodyVersion: state.meta.digestBodyVersion + (wroteHash ? 1 : 0),
      };
      return { state: { ...state, meta }, result: { kind: "ok" } };
    }

    case "releaseLease": {
      // A tick whose lease expired mid-flight is still running, and still
      // reaches its own release. By then `beginTick` may have handed the lease
      // to a NEWER tick, whose lease this must leave alone. So compare on
      // `heldSince` — the identity `beginTick` stamped — rather than on the mere
      // presence of a lease. A no-op release is reported `ok`: the releaser is
      // finished either way, and there is nothing for it to do about having lost
      // the lease.
      const lease = state.meta.syncLease;
      if (lease === null || lease.heldSince !== command.heldSince) {
        return { state, result: { kind: "ok" } };
      }
      return { state: { ...state, meta: { ...state.meta, syncLease: null } }, result: { kind: "ok" } };
    }
  }
}

/** Pure. Never mutates the input state — every store implementation relies on this. */
export function applyCommands(
  state: StoreState,
  commands: Command[],
  config: Config,
): { state: StoreState; results: CommandResult[] } {
  let current = state;
  const results: CommandResult[] = [];
  for (const command of commands) {
    const step = applyOne(current, command, config);
    current = step.state;
    results.push(step.result);
  }
  return { state: current, results };
}
