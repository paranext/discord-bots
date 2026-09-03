import type { Config } from "../../config/config.js";
import { applyClaim, applyUnclaim, clearStaleClaim } from "../core/claims.js";
import { applySnapshot } from "../core/exit.js";
import {
  isOpen,
  markRequested,
  newScannedRecord,
  recordId,
  reopenRecord,
  resolveRecord,
  type PrRecord,
} from "../core/record.js";
import { prSlug } from "../core/urls.js";
import { CURRENT_SCHEMA_VERSION, type Command, type CommandResult, type Meta, type StoreState } from "./types.js";

export function emptyState(): StoreState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    records: {},
    meta: {
      lastSync: null,
      digestMessageId: null,
      digestBodyHash: null,
      digestBodyVersion: 0,
      unpinnedReportedAt: null,
      lastDailyPostDate: null,
      scanCursors: {},
      scanBackfill: {},
      syncLease: null,
      prdCache: null,
      retryStash: {},
    },
  };
}

function put(records: Record<string, PrRecord>, record: PrRecord): Record<string, PrRecord> {
  return { ...records, [recordId(record)]: record };
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
    case "upsertScanned": {
      const id = prSlug(command.input.pr);
      const existing = state.records[id];
      if (existing === undefined) {
        return {
          state: { ...state, records: put(state.records, newScannedRecord(command.input)) },
          result: { kind: "created" },
        };
      }
      // A scanned link matching a resolved record is ignored rather than
      // reopening it: conversational mentions of finished PRs are the common
      // case, and resurrecting rows from chatter is how a list becomes untrusted.
      if (!isOpen(existing)) return { state, result: { kind: "skipped-resolved" } };
      return { state, result: { kind: "updated" } };
    }

    case "upsertRequest": {
      const id = prSlug(command.pr);
      const existing = state.records[id];
      const base =
        existing ??
        newScannedRecord({
          pr: command.pr,
          channelId: command.fields.channelId,
          messageId: command.fields.messageId ?? "",
          messageTimestamp: command.at,
          title: command.title,
          prAuthorLogin: command.prAuthorLogin,
          isDraft: command.isDraft,
        });

      const withMeta: PrRecord = {
        ...base,
        title: command.title,
        prAuthorLogin: command.prAuthorLogin,
        isDraft: command.isDraft,
      };

      if (existing === undefined) {
        // A brand new record has requestCount 1, not 2: newScannedRecord already
        // starts at 1 and markRequested would increment it.
        const created = markRequested(withMeta, command.at, command.fields);
        return {
          state: { ...state, records: put(state.records, { ...created, requestCount: 1 }) },
          result: { kind: "created" },
        };
      }

      return {
        state: { ...state, records: put(state.records, markRequested(withMeta, command.at, command.fields)) },
        result: { kind: "updated" },
      };
    }

    case "setRequestMessageId": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      return {
        state: { ...state, records: put(state.records, { ...existing, messageId: command.messageId }) },
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
      return {
        state: { ...state, records: put(state.records, applySnapshot(existing, command.snapshot, command.now)) },
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

    case "claim": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      if (stale(existing, command.expectLastRequestedAt)) return { state, result: { kind: "stale" } };
      const outcome = applyClaim(existing, command.userId, command.displayName, command.at);
      if (outcome.kind === "claimed") {
        return { state: { ...state, records: put(state.records, outcome.record) }, result: { kind: "ok" } };
      }
      if (outcome.kind === "already-claimed") return { state, result: outcome };
      return { state, result: { kind: "not-open" } };
    }

    case "unclaim": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      const outcome = applyUnclaim(existing, command.userId);
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
        state: { ...state, records: put(state.records, resolveRecord(existing, command.at, command.by)) },
        result: { kind: "ok" },
      };
    }

    case "reopen": {
      const existing = state.records[command.id];
      if (existing === undefined) return { state, result: { kind: "not-found" } };
      return {
        state: { ...state, records: put(state.records, reopenRecord(existing, command.at)) },
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
