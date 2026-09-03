import type { Reactor } from "../core/reactions.js";
import type { DiscordRest, DiscordUser } from "./rest.js";

/**
 * Deliberately 25, not Discord's maximum of 100. The 10 ms per-invocation CPU
 * limit is the other half of why the reaction budget exists (the v1 spec names
 * "reaction payloads" by name), and a full budget of 100-user pages is 1,000
 * objects to parse in a tick that also parses a chunked GraphQL response and
 * renders the digest. A review request draws a handful of reactors; 25 is far
 * past the real distribution.
 */
export const REACTION_READ_LIMIT = 25;

// See DiscordRest.getReactions for why the emoji's colon must survive
// encoding — Discord requires the literal `name:id` form in the path.

/** Discord JSON error codes. The HTTP status that wraps each is undocumented,
 *  and exactly one branch below mutates state, so the code is what we branch
 *  on. */
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_EMOJI = 10014;

export type ReactionRead =
  | { kind: "ok"; reactors: Reactor[] }
  | { kind: "truncated" }
  | { kind: "message-gone" }
  | { kind: "emoji-invalid" }
  | { kind: "rate-limited" }
  | { kind: "failed"; status: number };

function errorCode(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === "number" ? parsed.code : null;
  } catch {
    return null;
  }
}

function toReactors(users: DiscordUser[], botUserId: string): Reactor[] {
  return users
    .filter((u) => u.id !== botUserId)
    .map((u) => ({ id: u.id, name: u.global_name ?? u.username }));
}

/**
 * One record's worth of refresh-loop step 8.
 *
 * `confirmHolderId` is the user who currently holds this record's claim by
 * reaction, or null. If they are missing from the normal reaction list, one
 * extra read of the BURST list decides whether they actually left or merely
 * upgraded to a super reaction. Only the release path pays for that read: a
 * super-only reactor never claiming is an accepted silent no-op, but releasing
 * a row out from under an active reviewer is not.
 */
export async function readReactors(
  rest: DiscordRest,
  args: {
    channelId: string;
    messageId: string;
    emoji: string;
    botUserId: string;
    confirmHolderId: string | null;
  },
  // A mutable accumulator the CALLER owns, not a return value, and incremented
  // BEFORE each request rather than after it. A rejecting fetch must not take
  // the count of the request it already issued with it: the tick would then
  // under-report its spend against the subrequest ceiling it is trying to
  // respect. Same shape, same reason as `notifySuperseded`'s counters.
  counters: { subrequests: number },
): Promise<ReactionRead> {
  counters.subrequests += 1;
  const response = await rest.getReactions(args.channelId, args.messageId, args.emoji, {
    limit: REACTION_READ_LIMIT,
  });

  if (!response.ok) {
    const code = errorCode(response.body);
    if (code === UNKNOWN_MESSAGE) return { kind: "message-gone" };
    if (code === UNKNOWN_EMOJI) return { kind: "emoji-invalid" };
    if (response.status === 429) return { kind: "rate-limited" };
    return { kind: "failed", status: response.status };
  }

  const users = response.value ?? [];
  if (users.length === REACTION_READ_LIMIT) {
    // A full page is indistinguishable from exactly-25 without another request,
    // so it is reported as a FAILED read rather than a complete observation.
    // Discord orders reactors by user id, not by reaction time, so the claim
    // holder can simply sort outside the page — and the burst confirmation only
    // asks about super reactions, so a normal reactor beyond it is not found
    // there either. `syncReactions` treats every id missing from `observed` as a
    // departure, so handing it a truncated page releases an active review to
    // whoever happens to be inside the first 25.
    console.error(`[REACTIONS] full page on ${args.messageId}; more than ${REACTION_READ_LIMIT} reactors cannot be diffed`);
    return { kind: "truncated" };
  }
  const reactors = toReactors(users, args.botUserId);

  const holderId = args.confirmHolderId;
  if (holderId !== null && !reactors.some((r) => r.id === holderId)) {
    counters.subrequests += 1;
    const burst = await rest.getReactions(args.channelId, args.messageId, args.emoji, {
      limit: REACTION_READ_LIMIT,
      type: 1,
    });
    // A failed confirmation reads as "still there". Releasing on a failed read
    // is a guess, and the direction of that guess takes a review away from
    // someone actively doing it.
    const burstReactors = burst.ok ? toReactors(burst.value ?? [], args.botUserId) : [];
    const holder = burstReactors.find((r) => r.id === holderId);
    if (holder !== undefined) reactors.push(holder);
    // The id doubles as the name only in the unreachable-name case: a failed
    // burst read tells us nothing about the display name, and the record
    // already stores the one the claim was made with.
    else if (!burst.ok) reactors.push({ id: holderId, name: holderId });
  }

  return { kind: "ok", reactors };
}
