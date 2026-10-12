import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../../config/config.js";
import { SUPPRESS_EMBEDS_FLAG } from "../../src/discord/components.js";
import {
  DiscordRest,
  FLAG_MESSAGE_CONTENT,
  FLAG_MESSAGE_CONTENT_LIMITED,
  makeDigestPublisher,
} from "../../src/discord/rest.js";

interface Call { url: string; method: string; body: unknown; headers: Record<string, string> }

function stubFetch(responses: { status: number; json?: unknown }[]): Call[];
function stubFetch(responseFactory: () => Response): ReturnType<typeof vi.fn>;
function stubFetch(responsesOrFactory: { status: number; json?: unknown }[] | (() => Response)): Call[] | ReturnType<typeof vi.fn> {
  if (typeof responsesOrFactory === "function") {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async () => responsesOrFactory());
  }
  const calls: Call[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    });
    const response = responsesOrFactory[Math.min(index, responsesOrFactory.length - 1)]!;
    index += 1;
    return new Response(response.json === undefined ? null : JSON.stringify(response.json), {
      status: response.status,
    });
  });
  return calls;
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200 });
}

afterEach(() => vi.unstubAllGlobals());

describe("intent flags", () => {
  // Checked against Discord's documented values, not against themselves — the startup
  // intent assertion (Task 19) ANDs a fixture flag against these same constants, so a
  // self-consistent fixture there could not have caught either bit being wrong.
  it("pins the application flag bits to their documented values", () => {
    expect(FLAG_MESSAGE_CONTENT).toBe(262144);
    expect(FLAG_MESSAGE_CONTENT_LIMITED).toBe(524288);
  });
});

describe("DiscordRest", () => {
  it("sends the bot token and a User-Agent on every call", async () => {
    const calls = stubFetch([{ status: 200, json: [] }]);
    await new DiscordRest("tok").getMessages("chan", {});
    expect(calls[0]!.headers.Authorization).toBe("Bot tok");
    expect(calls[0]!.headers["User-Agent"]).toContain("pr-review-bot");
  });

  it("requests messages with limit 100 and an after cursor", async () => {
    const calls = stubFetch([{ status: 200, json: [] }]);
    await new DiscordRest("tok").getMessages("chan", { after: "9" });
    expect(calls[0]!.url).toContain("/channels/chan/messages?");
    expect(calls[0]!.url).toContain("limit=100");
    expect(calls[0]!.url).toContain("after=9");
  });

  it("requests messages before a cursor when walking backwards", async () => {
    const calls = stubFetch([{ status: 200, json: [] }]);
    await new DiscordRest("tok").getMessages("chan", { before: "9" });
    expect(calls[0]!.url).toContain("before=9");
  });

  it("lists pins from the 2026 route, not the deprecated one", async () => {
    const calls = stubFetch([{ status: 200, json: { items: [] } }]);
    await new DiscordRest("tok").getPins("chan");
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/channels/chan/messages/pins");
  });

  it("returns a typed failure rather than throwing on a non-2xx", async () => {
    stubFetch([{ status: 403, json: { message: "Missing Access" } }]);
    const result = await new DiscordRest("tok").getMessages("chan", {});
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("handles a 204 with no body", async () => {
    stubFetch([{ status: 204 }]);
    const result = await new DiscordRest("tok").patchMessage("chan", "m", { embeds: [], components: [] });
    expect(result.ok).toBe(true);
  });

  it("opens a DM channel by posting the recipient id to /users/@me/channels", async () => {
    const calls = stubFetch([{ status: 200, json: { id: "dm-1" } }]);
    const result = await new DiscordRest("tok").createDmChannel("u1");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/users/@me/channels");
    expect(calls[0]!.body).toEqual({ recipient_id: "u1" });
    expect(result).toEqual({ ok: true, value: { id: "dm-1" } });
  });
});

describe("editInteractionResponse", () => {
  it("PATCHes @original on the webhook route", async () => {
    const spy = stubFetch(() => jsonResponse({ id: "m-1" }));
    await new DiscordRest("bot-token").editInteractionResponse("app-1", "tok-1", { content: "done" });

    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe("https://discord.com/api/v10/webhooks/app-1/tok-1/messages/@original");
    expect((init as RequestInit).method).toBe("PATCH");
  });

  it("sends no Authorization header — the interaction token IS the credential", async () => {
    const spy = stubFetch(() => jsonResponse({ id: "m-1" }));
    await new DiscordRest("bot-token").editInteractionResponse("app-1", "tok-1", { content: "done" });

    const headers = new Headers((spy.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get("authorization")).toBeNull();
    // The bot token must not leak onto a route that does not need it.
    expect(JSON.stringify([...headers])).not.toContain("bot-token");
  });

  it("reports a failure status rather than throwing", async () => {
    stubFetch(() => new Response("expired", { status: 404 }));
    const result = await new DiscordRest("t").editInteractionResponse("app-1", "tok-1", { content: "x" });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  // `postContent` is the only way to post plain content, so every content send
  // — the request message, the daily post, a superseded-claim DM — inherits
  // the suppression rather than having to remember it.
  it("always suppresses unfurls on a plain-content post", async () => {
    const calls = stubFetch([{ status: 200, json: { id: "m3" } }]);
    await new DiscordRest("tok").postContent("c1", "`o/r#9` (Revert https://github.com/o/r/pull/8) is already claimed");
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/channels/c1/messages");
    expect(calls[0]!.body).toEqual({
      content: "`o/r#9` (Revert https://github.com/o/r/pull/8) is already claimed",
      flags: SUPPRESS_EMBEDS_FLAG,
    });
  });
});

describe("makeDigestPublisher", () => {
  const payload = { embeds: [{ color: 1, description: "x" }], components: [] };

  it("PATCHes the digest channel and reports success", async () => {
    const calls = stubFetch([{ status: 200, json: { id: "m1" } }]);
    const publisher = makeDigestPublisher(new DiscordRest("tok"), "guild", config);
    expect(await publisher.patchDigest("m1", payload)).toEqual({ ok: true });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.body).toEqual(payload);
  });

  it("surfaces a 404 so commitTick can recreate the message", async () => {
    stubFetch([{ status: 404, json: { message: "Unknown Message" } }]);
    const publisher = makeDigestPublisher(new DiscordRest("tok"), "guild", config);
    expect(await publisher.patchDigest("m1", payload)).toEqual({ ok: false, status: 404 });
  });

  it("posts the daily message as plain content, not an embed", async () => {
    const calls = stubFetch([{ status: 200, json: { id: "m2" } }]);
    const publisher = makeDigestPublisher(new DiscordRest("tok"), "guild", config);
    await publisher.postDaily("3 PRs waiting");
    expect(calls[0]!.body).toEqual({ content: "3 PRs waiting", flags: SUPPRESS_EMBEDS_FLAG });
  });

  it("suppresses the daily post's unfurl — its jump link is a discord.com message URL", async () => {
    const calls = stubFetch([{ status: 200, json: { id: "m2" } }]);
    const publisher = makeDigestPublisher(new DiscordRest("tok"), "guild", config);
    await publisher.postDaily("3 PRs waiting. [Jump to the list \u2197](https://discord.com/channels/g/c/m1)");
    expect((calls[0]!.body as { flags?: number }).flags).toBe(SUPPRESS_EMBEDS_FLAG);
  });

  // The digest IS embeds. SUPPRESS_EMBEDS hides a message's own rich embeds as
  // well as its unfurls, so setting it here would leave the pinned list blank
  // while every other signal — the PATCH succeeded, the hash advanced — still
  // reported success. Nothing in the render depends on an unfurl, so there is
  // never a reason to set it, and this is the test that says so out loud.
  it("never suppresses embeds on the digest — the flag would blank the pinned list", async () => {
    const calls = stubFetch([{ status: 200, json: { id: "m1" } }, { status: 200, json: { id: "m2" } }]);
    const publisher = makeDigestPublisher(new DiscordRest("tok"), "guild", config);
    await publisher.patchDigest("m1", payload);
    await publisher.createDigest(payload);
    expect((calls[0]!.body as { flags?: number }).flags).toBeUndefined();
    expect((calls[1]!.body as { flags?: number }).flags).toBeUndefined();
  });

  it("returns an empty pin list when the pins call fails, so a 403 does not crash the tick", async () => {
    stubFetch([{ status: 403, json: {} }]);
    const publisher = makeDigestPublisher(new DiscordRest("tok"), "guild", config);
    expect(await publisher.listPinnedMessageIds()).toEqual([]);
  });

  it("builds a jump link the daily post can use", () => {
    const publisher = makeDigestPublisher(new DiscordRest("tok"), "guild-1", config);
    expect(publisher.messageUrl("m1")).toBe(
      `https://discord.com/channels/guild-1/${config.digestChannelId}/m1`,
    );
  });
});
