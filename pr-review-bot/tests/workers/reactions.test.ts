import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordRest } from "../../src/discord/rest.js";
import { readReactors } from "../../src/discord/reactions.js";

const EMOJI = "code_review:1075535230087221248";

interface Call { url: string }

function stubFetch(responses: { status: number; json?: unknown }[]): Call[] {
  const calls: Call[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (input: string) => {
    calls.push({ url: String(input) });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(response.json === undefined ? null : JSON.stringify(response.json), {
      status: response.status,
    });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

function rest(): DiscordRest {
  return new DiscordRest("test-token-not-a-real-credential");
}

/** The caller-owned subrequest accumulator. Charged BEFORE each request, so it
 *  is also what a test asserting the cost of a read reads. */
let counters: { subrequests: number };
beforeEach(() => { counters = { subrequests: 0 }; });

describe("readReactors", () => {
  it("requests the reactions route with the colon UNESCAPED and limit=25", async () => {
    const calls = stubFetch([{ status: 200, json: [] }]);
    await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: null,
    }, counters);
    // Discord requires the literal `name:id` in the path. Percent-encoding the
    // colon produces 10014 Unknown Emoji on every read.
    expect(calls[0]!.url).toContain(`/channels/c1/messages/m1/reactions/${EMOJI}`);
    expect(calls[0]!.url).not.toContain("%3A");
    expect(calls[0]!.url).toContain("limit=25");
  });

  it("maps users to reactors, preferring global_name and dropping the bot", async () => {
    stubFetch([{ status: 200, json: [
      { id: "u1", username: "katherine", global_name: "Katherine" },
      { id: "u2", username: "ira", global_name: null },
      { id: "bot", username: "reviewbot", global_name: null },
    ] }]);
    const result = await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: null,
    }, counters);
    expect(result).toEqual({
      kind: "ok",
      reactors: [{ id: "u1", name: "Katherine" }, { id: "u2", name: "ira" }],
    });
    expect(counters.subrequests).toBe(1);
  });

  it("classifies 10008 as message-gone", async () => {
    stubFetch([{ status: 404, json: { code: 10008, message: "Unknown Message" } }]);
    const result = await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: null,
    }, counters);
    expect(result.kind).toBe("message-gone");
  });

  it("classifies 10014 as emoji-invalid — the branch that must NOT touch state", async () => {
    // Keyed on the error code, not the status: Discord does not document which
    // status wraps which code, and a deleted emoji fails on EVERY record in the
    // same tick. Had this shared the 404 branch, one emoji deletion would null
    // every messageId on the list, permanently.
    stubFetch([{ status: 400, json: { code: 10014, message: "Unknown Emoji" } }]);
    const result = await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: null,
    }, counters);
    expect(result.kind).toBe("emoji-invalid");
  });

  it("classifies a 404 with an unrecognised code as a plain failure, not message-gone", async () => {
    stubFetch([{ status: 404, json: { code: 50001, message: "Missing Access" } }]);
    const result = await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: null,
    }, counters);
    expect(result).toEqual({ kind: "failed", status: 404 });
    expect(counters.subrequests).toBe(1);
  });

  it("reports 429 separately so the caller can abandon the step", async () => {
    stubFetch([{ status: 429, json: { message: "You are being rate limited." } }]);
    const result = await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: null,
    }, counters);
    expect(result.kind).toBe("rate-limited");
  });

  it("reports a FULL page as a failed read rather than a complete observation", async () => {
    // Discord returns reactors ordered by user id, not by reaction time, so on a
    // message with 27 reactors the holder can simply sort outside the first 25.
    // Handing that page to the diff reads them as departed and releases a claim
    // out from under an active review. A truncated page is not an observation.
    const calls = stubFetch([{ status: 200, json: Array.from({ length: 25 }, (_, i) => ({
      id: `u${i}`, username: `user${i}`, global_name: null,
    })) }]);
    const result = await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: "u99",
    }, counters);
    expect(result).toEqual({ kind: "truncated" });
    // And it does not pay for a burst confirmation of a page it is discarding.
    expect(calls).toHaveLength(1);
    expect(counters.subrequests).toBe(1);
  });

  it("confirms an absent claim holder against the BURST list before reporting them gone", async () => {
    // A reviewer who upgrades a normal reaction to a super one vanishes from the
    // default type-0 read. Releasing on that would take the row away from
    // someone who did the opposite of releasing.
    const calls = stubFetch([
      { status: 200, json: [] },
      { status: 200, json: [{ id: "u1", username: "katherine", global_name: "Katherine" }] },
    ]);
    const result = await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: "u1",
    }, counters);
    expect(calls[1]!.url).toContain("type=1");
    expect(result).toEqual({ kind: "ok", reactors: [{ id: "u1", name: "Katherine" }] });
    expect(counters.subrequests).toBe(2);
  });

  it("does not make the burst read when the holder is present in the normal list", async () => {
    const calls = stubFetch([
      { status: 200, json: [{ id: "u1", username: "katherine", global_name: "Katherine" }] },
    ]);
    const result = await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: "u1",
    }, counters);
    expect(calls).toHaveLength(1);
    expect(result.kind).toBe("ok");
  });

  it("treats a failed burst confirmation as 'still there' rather than releasing on a guess", async () => {
    stubFetch([{ status: 200, json: [] }, { status: 500 }]);
    const result = await readReactors(rest(), {
      channelId: "c1", messageId: "m1", emoji: EMOJI, botUserId: "bot", confirmHolderId: "u1",
    }, counters);
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.reactors.map((r) => r.id)).toEqual(["u1"]);
  });
});
