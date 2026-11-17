import type { Config } from "../../config/config.js";
import { renderDailyPost } from "../core/render/daily.js";
import { renderDigest } from "../core/render/digest.js";
import { applyCommands, emptyState } from "./apply.js";
import {
  LEASE_TIMEOUT_MS,
  type ApplyResult,
  type BeginTickResult,
  type Command,
  type DigestOutcome,
  type DigestPayload,
  type DigestPublisher,
  type FinishTickInput,
  type FinishTickResult,
  type MetaPatch,
  type Store,
  type StoreState,
} from "./types.js";

function dateKey(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(epochMs));
}

function localHour(epochMs: number, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(new Date(epochMs)),
  );
}

/** Everything `commitTick` decided, plus what the caller needs to write it back
 *  safely. `metaPatch` deliberately excludes `digestBodyHash`: that one field
 *  cannot be written unconditionally (see `digestHashWriteBack`). */
export interface TickCommitOutcome {
  metaPatch: MetaPatch;
  /** `Meta.digestBodyVersion` as it stood when this tick decided what to PATCH —
   *  before any Discord I/O. The write-back compares it against the counter
   *  actually in the store at write-back time; a difference means another writer
   *  wrote the hash while this tick's PATCH was in flight, whatever the hash
   *  VALUE happens to be by then. */
  expectedBodyVersion: number;
  /** Hash of the body this tick successfully PATCHed, or null when it patched
   *  nothing, the PATCH failed, or a create already persisted the hash. */
  newBodyHash: string | null;
  digest: DigestOutcome;
  dailyPosted: boolean;
}

/**
 * Compare-and-set for `digestBodyHash`, shared by `finishTick` and `apply()` in
 * both `Store` implementations.
 *
 * `apply()` deliberately bypasses the lease, so a tick and an interaction are
 * always two concurrent writers to the same Discord message and the same stored
 * hash. Which body the message ends up displaying is decided by the order
 * *Discord* processes the two PATCHes; which hash ends up stored is decided by
 * the order the two *responses* come back. Those orders are independent, so a
 * blind write can leave the stored hash matching a body the message is not
 * showing — and because the next tick recomputes exactly that hash, it reports
 * `skipped-unchanged` and never repaints. The digest then stays wrong until a
 * human notices; nothing self-heals it.
 *
 * So a writer may only claim the hash if nothing else has written the hash since
 * it read. If something has, the other writer's PATCH crossed ours and neither
 * writer can know whose body Discord kept — so we store `null` rather than a
 * hash we cannot vouch for. A null hash never equals a render, so the next tick
 * unconditionally repaints and the message converges. One extra PATCH is the
 * only safe direction to err in: the opposite error is permanent.
 *
 * The compare is on `Meta.digestBodyVersion` — a monotonic count of hash writes
 * — and NOT on the hash value, because the value can come back round. Three
 * ordinary interactions inside one PATCH round-trip (claim a row, reopen the row
 * this tick just cleared, unclaim the first row) return the records to rendering
 * exactly the body the tick read and the stored hash to exactly the value the
 * tick read, since `renderDigest` reads a coarse projection that ignores
 * `resolvedAt`, `resolutionHistory` and `claimedAt`. A value compare passes
 * there, stores a hash for a body nobody can see, and — because the next tick
 * re-derives that same body from unchanged GitHub data and `commitTick` skips
 * the PATCH when the render already equals the stored hash — never gets another
 * compare to fail into `null`. That is ABA, and the counter closes it
 * structurally: it never returns to a previous value, so "unchanged since I
 * read" cannot be faked.
 */
export function digestHashWriteBack(
  currentVersion: number,
  expectedVersion: number,
  newHash: string,
): MetaPatch {
  if (currentVersion === expectedVersion) return { digestBodyHash: newHash };
  return { digestBodyHash: null };
}

/**
 * `finishTick`'s closing write, as commands: the decided meta patch, then the
 * FENCED lease release. Shared by both `Store` implementations so neither can
 * quietly go back to releasing the lease unconditionally, and so the two cannot
 * disagree about the order.
 *
 * Both go into one `applyCommands` call, which is what keeps `finishTick` at a
 * single store subrequest for the caller.
 */
export function tickWriteBack(patch: MetaPatch, leaseHeldSince: number): Command[] {
  return [{ kind: "setMeta", patch }, { kind: "releaseLease", heldSince: leaseHeldSince }];
}

/**
 * Decides what to do about the digest and the daily post, given `state` as it
 * stood the instant this was called — and does the Discord I/O to carry it out.
 *
 * Deliberately does NOT return a `StoreState`. This function awaits
 * `listPinnedMessageIds`, `patchDigest`/`createDigest`, and possibly
 * `postDaily` — an interactive `apply()` can commit to the store's live state
 * at any of those await points. Returning a whole state built from the
 * pre-await `state` argument and writing it back wholesale would silently
 * discard that commit; the caller must instead re-read the *current* state
 * after this resolves and merge only `metaPatch` onto it. `metaPatch` is
 * everything this function decided to change as a plain patch: digestMessageId,
 * unpinnedReportedAt and lastDailyPostDate — never anything under `records`,
 * which this function never touches; never `digestBodyHash`, which the caller
 * must write through `digestHashWriteBack`; and never `syncLease`, whose
 * release is fenced and so arrives as `leaseHeldSince` for the caller to turn
 * into a `releaseLease` command.
 *
 * `persist` is called the moment a digest message has actually been CREATED in
 * Discord, before any further network call. Everything else this function
 * decides the next tick can re-derive, but a created message's id it cannot: if
 * that id were only returned in `metaPatch` and a later call — the daily post —
 * *rejected* rather than returning `{ok: false}`, the whole patch would be
 * discarded, the next tick would see a null `digestMessageId`, and it would post
 * a SECOND digest, orphaning the first with nobody editing it.
 */
/**
 * Narrows a `DigestRender` to just the two fields Discord is being sent.
 *
 * The render also carries `bodyHash`, `openCount`, `renderedCount` and
 * `droppedCount` — bookkeeping for this file, not fields of a Discord message.
 * Passing the whole object satisfies the `DigestPayload` parameter (excess
 * property checks do not apply to a variable) and then `JSON.stringify`s all
 * four into the PATCH body. Discord ignores unknown fields today; the day it
 * does not, the failure is a 400 on the PATCH, which is exactly the case this
 * file already treats as the one that freezes the pin showing PRs that are
 * already done. Cheap to not depend on.
 */
function toPayload(render: DigestPayload): DigestPayload {
  return { embeds: render.embeds, components: render.components };
}

export async function commitTick(
  state: StoreState,
  now: number,
  config: Config,
  publisher: DigestPublisher,
  persist: (patch: MetaPatch) => Promise<void>,
): Promise<TickCommitOutcome> {
  // Rendering happens even when the sync failed: the digest is a pure function of
  // (records, lastSync, now), so the stale banner is a rendering consequence.
  const records = Object.values(state.records);
  const render = renderDigest({ records, lastSync: state.meta.lastSync, now, config });

  const pinned = await publisher.listPinnedMessageIds();
  const messageId = state.meta.digestMessageId;
  const isPinned = messageId !== null && pinned.includes(messageId);

  let action: DigestOutcome["action"] = "skipped-unchanged";
  const metaPatch: MetaPatch = {};
  // Read BEFORE any Discord I/O below: this is the "nothing else has written the
  // hash since" baseline the caller's compare-and-set uses.
  const expectedBodyVersion = state.meta.digestBodyVersion;
  let newBodyHash: string | null = null;
  let createdMessageId: string | null = null;

  // Two doors into "create": there is no message at all, or the PATCH came back
  // 404 because someone deleted it. Both go through the one block below, so the
  // persist-before-any-further-I/O rule cannot be honoured on one path and
  // forgotten on the other.
  let mustCreate = messageId === null;

  if (messageId !== null && state.meta.digestBodyHash !== render.bodyHash) {
    const patched = await publisher.patchDigest(messageId, toPayload(render));
    if (patched.ok) {
      // The hash is written ONLY on a successful PATCH, and only through the
      // caller's compare-and-set. Writing it optimistically would suppress the
      // correction on every later tick.
      newBodyHash = render.bodyHash;
      action = "patched";
    } else if (patched.status === 404) {
      mustCreate = true;
    } else {
      action = "failed";
    }
  }

  if (mustCreate) {
    const created = await publisher.createDigest(toPayload(render));
    if (created.ok) {
      createdMessageId = created.messageId;
      // The message now EXISTS in Discord. Persist its identity, and the body we
      // put in it, before anything else that can reject — see the doc above. No
      // compare-and-set here: a message this tick just created can have no
      // competing writer, because an interactive apply() with no stored
      // digestMessageId patches nothing at all. (That `persist` still moves
      // `digestBodyVersion`, and so invalidates `expectedBodyVersion` — which
      // costs nothing, because `newBodyHash` is null on every path that reaches
      // here: it is set only in the PATCH-succeeded branch above, which neither
      // sets `mustCreate` nor falls through to it. So the caller runs no
      // compare-and-set on a tick that created the message.)
      await persist({ digestMessageId: created.messageId, digestBodyHash: render.bodyHash });
      action = "created";
    } else {
      action = "failed";
    }
  }

  // Unpinned reporting: once per unpinning, and the latch resets when pinned again.
  // Reads only the original `state.meta` — nothing above touches unpinnedReportedAt.
  if (messageId !== null && !isPinned && state.meta.unpinnedReportedAt === null) {
    metaPatch.unpinnedReportedAt = now;
    action = action === "skipped-unchanged" ? "unpinned-reported" : action;
  } else if (isPinned && state.meta.unpinnedReportedAt !== null) {
    metaPatch.unpinnedReportedAt = null;
  }

  // The daily post: once a day, only when something is waiting. The just-created
  // message id (if any) is what the post should link to, not the pre-tick one.
  let dailyPosted = false;
  const today = dateKey(now, config.dailyPostTimeZone);
  const dueToday =
    localHour(now, config.dailyPostTimeZone) >= config.dailyPostHourLocal &&
    state.meta.lastDailyPostDate !== today;

  if (dueToday) {
    const effectiveMessageId = createdMessageId ?? messageId;
    const url = effectiveMessageId === null ? null : publisher.messageUrl(effectiveMessageId);
    const content = renderDailyPost({ records, digestMessageUrl: url, config });
    if (content !== null) {
      const posted = await publisher.postDaily(content);
      if (posted.ok) {
        metaPatch.lastDailyPostDate = today;
        dailyPosted = true;
      }
    } else {
      // A clear queue is silent, but the date still advances so a queue that fills
      // later today does not trigger a second post attempt every tick.
      metaPatch.lastDailyPostDate = today;
    }
  }

  // The lease release is deliberately NOT part of `metaPatch`. It is fenced
  // against the lease identity the *caller* holds (`FinishTickInput.
  // leaseHeldSince`), which is not knowable from `state`: a tick that overran
  // LEASE_TIMEOUT_MS during the I/O above still arrives here, and by then the
  // lease in `state` is a newer tick's.

  return {
    metaPatch,
    expectedBodyVersion,
    newBodyHash,
    digest: {
      action,
      bodyHash: render.bodyHash,
      openCount: render.openCount,
      renderedCount: render.renderedCount,
    },
    dailyPosted,
  };
}

/**
 * Shared by both `Store` implementations' `apply()`. Renders from `state`,
 * PATCHes only if the body changed, and reports `skipped-unchanged` rather
 * than `null` when nothing needed to change — `null` is reserved for "there is
 * no digest message to patch at all". Returns the new hash only when the
 * PATCH actually succeeded, exactly like `commitTick`, so the caller knows
 * whether there is anything to write back. `expectedVersion` is
 * `Meta.digestBodyVersion` as this call read it, which the caller must pass to
 * `digestHashWriteBack` — an interactive PATCH races a tick's PATCH exactly as a
 * tick's races an interaction's, so the same compare-and-set is required on both
 * sides. Note that `expectedHash` (the hash this call rendered against) is still
 * used, but only to decide whether the body CHANGED; the compare-and-set is on
 * the counter. Those are two different questions and conflating them is the
 * defect the counter exists to close.
 */
export async function renderAndPatch(
  state: StoreState,
  now: number,
  config: Config,
  publisher: DigestPublisher,
): Promise<{ digest: ApplyResult["digest"]; newHash: string | null; expectedVersion: number }> {
  const render = renderDigest({
    records: Object.values(state.records),
    lastSync: state.meta.lastSync,
    now,
    config,
  });
  const messageId = state.meta.digestMessageId;
  const expectedHash = state.meta.digestBodyHash;
  const expectedVersion = state.meta.digestBodyVersion;
  if (messageId === null) return { digest: null, newHash: null, expectedVersion };

  if (expectedHash === render.bodyHash) {
    return {
      digest: {
        action: "skipped-unchanged",
        bodyHash: render.bodyHash,
        openCount: render.openCount,
        renderedCount: render.renderedCount,
      },
      newHash: null,
      expectedVersion,
    };
  }

  const patched = await publisher.patchDigest(messageId, toPayload(render));
  return {
    digest: {
      action: patched.ok ? "patched" : "failed",
      bodyHash: render.bodyHash,
      openCount: render.openCount,
      renderedCount: render.renderedCount,
    },
    newHash: patched.ok ? render.bodyHash : null,
    expectedVersion,
  };
}

export class MemoryStore implements Store {
  private state: StoreState;

  constructor(
    private readonly config: Config,
    private readonly publisher: DigestPublisher,
    initial: StoreState = emptyState(),
  ) {
    this.state = initial;
  }

  async beginTick(now: number): Promise<BeginTickResult> {
    const lease = this.state.meta.syncLease;
    if (lease !== null && now - lease.heldSince < LEASE_TIMEOUT_MS) {
      return { acquired: false, reason: "lease-held", heldSince: lease.heldSince };
    }
    this.state = applyCommands(
      this.state,
      [{ kind: "setMeta", patch: { syncLease: { heldSince: now } } }],
      this.config,
    ).state;
    return { acquired: true, state: this.state };
  }

  async finishTick(input: FinishTickInput): Promise<FinishTickResult> {
    // Commit this tick's own mutations synchronously, before any await — so
    // this happens atomically with respect to any interleaved `apply()` call.
    const appliedCommands = applyCommands(this.state, input.commands, this.config);
    this.state = appliedCommands.state;

    // commitTick awaits Discord I/O. An interactive apply() can commit to
    // this.state at any of those await points. Its `persist` callback lands a
    // freshly created message's id immediately, so a later rejection cannot
    // discard it.
    const outcome = await commitTick(this.state, input.now, this.config, this.publisher, async (patch) => {
      this.state = applyCommands(this.state, [{ kind: "setMeta", patch }], this.config).state;
    });

    // Merge the decided meta patch onto the CURRENT this.state — not the
    // snapshot commitTick was handed — so anything an interleaved apply()
    // committed during the awaits above survives instead of being clobbered
    // by a whole-state write-back built from a now-stale snapshot. The body
    // hash is the one field that needs more than a merge: compare-and-set it.
    const patch: MetaPatch = { ...outcome.metaPatch };
    if (outcome.newBodyHash !== null) {
      Object.assign(
        patch,
        digestHashWriteBack(this.state.meta.digestBodyVersion, outcome.expectedBodyVersion, outcome.newBodyHash),
      );
    }
    // The fenced release rides along in the same apply, after the patch, so
    // finishTick still costs the caller exactly one store call.
    this.state = applyCommands(this.state, tickWriteBack(patch, input.leaseHeldSince), this.config).state;

    return { results: appliedCommands.results, digest: outcome.digest, dailyPosted: outcome.dailyPosted };
  }

  async apply(commands: Command[], opts: { now: number; rerender: boolean }): Promise<ApplyResult> {
    const applied = applyCommands(this.state, commands, this.config);
    this.state = applied.state;
    if (!opts.rerender) return { results: applied.results, digest: null };

    const { digest, newHash, expectedVersion } = await renderAndPatch(this.state, opts.now, this.config, this.publisher);
    if (newHash !== null) {
      const patch = digestHashWriteBack(this.state.meta.digestBodyVersion, expectedVersion, newHash);
      this.state = applyCommands(this.state, [{ kind: "setMeta", patch }], this.config).state;
    }
    return { results: applied.results, digest };
  }

  async readState(): Promise<StoreState> {
    return this.state;
  }
}
