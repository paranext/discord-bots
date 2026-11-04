import { applyClaim, applyUnclaim } from "./claims.js";
import { isOpen, recordId, type PrRecord } from "./record.js";

/**
 * Refresh-loop step 8's poll order: every eligible record id, oldest-unchecked
 * first. Deliberately NOT truncated — the caller applies the per-tick allowance
 * and reports the untruncated length, because "how many are eligible" is the
 * number an operator reads the cycle time off, and it is not bounded (see the
 * spec's Known cost: `purgeResolved` only purges RESOLVED records, so an open
 * PR nobody ever reviews stays eligible indefinitely).
 */
export function selectReactionTargets(records: PrRecord[]): string[] {
  // A message that produced two records is skipped entirely: one reaction on it
  // cannot say which PR the reactor meant, claiming both asserts a commitment
  // nobody made, and picking one by iteration order is worse. The digest menu,
  // which names the row, remains available for those.
  const perMessage = new Map<string, number>();
  for (const record of records) {
    if (record.messageId === null || record.messageId === "") continue;
    perMessage.set(record.messageId, (perMessage.get(record.messageId) ?? 0) + 1);
  }

  return records
    .filter((r) => {
      if (!isOpen(r)) return false;
      if (r.messageId === null || r.messageId === "") return false;
      if (perMessage.get(r.messageId) !== 1) return false;
      // Unclaimed, or claimed by a reaction — the latter so that removing the
      // reaction is detectable. A menu claim is invisible to this path by
      // design: no reaction on it can change anything.
      return r.claimedBy === null || r.claimSource === "reaction";
    })
    .sort((a, b) => {
      const left = a.reactionCheckedAt;
      const right = b.reactionCheckedAt;
      if (left !== right) {
        if (left === null) return -1;
        if (right === null) return 1;
        return left - right;
      }
      return a.firstRequestedAt - b.firstRequestedAt;
    })
    .map(recordId);
}

/** One person reacting, as the adapter reports them. */
export interface Reactor {
  id: string;
  name: string;
}

export interface ReactionSyncOutcome {
  record: PrRecord;
  /** Users who gained the claim in this sync. */
  claimed: string[];
  /** Users whose claim was released because their reaction is gone. */
  released: string[];
  /** Users whose reaction lost to an existing claim. Only users who ACTED in
   *  this sync appear here — a promoted reactor who loses took no action now
   *  and must not be told anything. */
  superseded: { userId: string; byName: string }[];
}

/**
 * The diff at the heart of the reaction path: not "who is reacting?" but "what
 * changed since the last poll?"
 *
 * A null `lastReactors` means unprimed — nothing has been observed since this
 * record entered the polling set — so the poll records the set and acts on
 * nothing. See `adr-reaction-diff-not-presence`.
 */
export function syncReactions(record: PrRecord, reactors: Reactor[] | null, now: number): ReactionSyncOutcome {
  // A failed read is not an observation. Stamp the check time so the record
  // rotates to the back of the queue, and leave `lastReactors` exactly as it
  // was — writing `[]` here would assert an emptiness nobody saw, and the next
  // successful poll would read every standing reactor as newly present.
  if (reactors === null) {
    return {
      record: { ...record, reactionCheckedAt: now },
      claimed: [], released: [], superseded: [],
    };
  }

  const observed = reactors.map((r) => r.id);
  // `lastReactors` may only hold an observation for a record CURRENTLY in the
  // polling set (adr-reaction-diff-not-presence / "Leaving the polling set
  // resets lastReactors to null"). `record` here is the state already
  // committed by earlier commands in this same batch — a merge resolved by
  // this tick's own `applySnapshot`, or a menu claim landed between
  // `beginTick` and `finishTick` — so reading it, not any post-arbitration
  // value, is what "arbitration happens inside the store, against committed
  // state" requires. When the record has left the set, this sync must write
  // null instead of the freshly observed set, on EVERY branch below including
  // priming: writing the observed set here would prime a diff basis for a row
  // that is not being polled, so a future reaction picked up while it was
  // resolved or menu-claimed would read as "unchanged" instead of "arrival"
  // the moment the row becomes eligible again.
  const eligible = isOpen(record) && record.claimSource !== "menu" && record.messageId !== null && record.messageId !== "";
  const stamp = (r: PrRecord): PrRecord =>
    ({ ...r, reactionCheckedAt: now, lastReactors: eligible ? observed : null });

  if (record.lastReactors === null) {
    return { record: stamp(record), claimed: [], released: [], superseded: [] };
  }

  const previous = new Set(record.lastReactors);
  const present = new Set(observed);
  let current = stamp(record);
  const released: string[] = [];
  const claimed: string[] = [];
  const superseded: { userId: string; byName: string }[] = [];

  // 1. Releases, before anything else.
  for (const userId of record.lastReactors) {
    if (present.has(userId)) continue;
    if (current.claimedBy !== userId || current.claimSource !== "reaction") continue;
    const outcome = applyUnclaim(current, userId, now);
    if (outcome.kind === "released") {
      current = outcome.record;
      released.push(userId);
    }
  }

  // 2. Newly present reactors, then 3. promotion — everyone still standing, but
  // only where this sync actually released a claim. Scoping promotion to a real
  // release is what keeps a standing reaction from re-claiming after the
  // 48-hour auto-clear, which produces no release here.
  const arrivals = reactors.filter((r) => !previous.has(r.id));
  const promoted = released.length > 0 ? reactors.filter((r) => previous.has(r.id)) : [];

  for (const reactor of [...arrivals, ...promoted]) {
    const isArrival = !previous.has(reactor.id);
    const held = current.claimedBy;
    const outcome = applyClaim(current, reactor.id, reactor.name, now, "reaction");
    if (outcome.kind === "claimed") {
      if (held !== reactor.id) claimed.push(reactor.id);
      current = outcome.record;
    } else if (outcome.kind === "already-claimed" && isArrival) {
      superseded.push({ userId: reactor.id, byName: outcome.byName });
    }
  }

  return { record: current, claimed, released, superseded };
}
