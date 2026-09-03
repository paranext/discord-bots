import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordRest } from "../../src/discord/rest.js";
import { fetchPrdThreads } from "../../src/discord/threads.js";

const T0 = 1_756_000_000_000;
const GUILD = "g-1";
const FORUM = "forum-1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(handler: (url: string) => Response) {
  const spy = vi.fn((input: RequestInfo | URL) => Promise.resolve(handler(String(input))));
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchPrdThreads", () => {
  it("reads both endpoints and merges them into one cache", async () => {
    const spy = stubFetch((url) =>
      url.includes("/guilds/")
        ? jsonResponse({ threads: [{ id: "200", name: "Active", parent_id: FORUM, last_message_id: "900" }] })
        : jsonResponse({ threads: [{ id: "100", name: "Archived", parent_id: FORUM, last_message_id: "100" }] }),
    );

    const result = await fetchPrdThreads(new DiscordRest("t"), GUILD, FORUM, T0);

    expect(result.requests).toBe(2);
    expect(result.cache?.options.map((o) => o.name)).toEqual(["Active", "Archived"]);
    expect(spy.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://discord.com/api/v10/guilds/g-1/threads/active",
      "https://discord.com/api/v10/channels/forum-1/threads/archived/public?limit=25",
    ]);
  });

  it("returns a null cache when the active-threads call fails, so the caller keeps the old list", async () => {
    stubFetch((url) => (url.includes("/guilds/") ? jsonResponse({ message: "nope" }, 403) : jsonResponse({ threads: [] })));
    const result = await fetchPrdThreads(new DiscordRest("t"), GUILD, FORUM, T0);
    expect(result.cache).toBeNull();
  });

  it("returns a null cache when the archived call fails", async () => {
    stubFetch((url) => (url.includes("/guilds/") ? jsonResponse({ threads: [] }) : jsonResponse({}, 500)));
    const result = await fetchPrdThreads(new DiscordRest("t"), GUILD, FORUM, T0);
    expect(result.cache).toBeNull();
  });

  it("still counts both requests when one fails, so the tick's subrequest budget stays honest", async () => {
    stubFetch((url) => (url.includes("/guilds/") ? jsonResponse({ threads: [] }) : jsonResponse({}, 500)));
    const result = await fetchPrdThreads(new DiscordRest("t"), GUILD, FORUM, T0);
    expect(result.requests).toBe(2);
  });

  it("names BOTH failed endpoints when both fail, not just the first", async () => {
    stubFetch((url) => (url.includes("/guilds/") ? jsonResponse({}, 403) : jsonResponse({}, 500)));
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    await fetchPrdThreads(new DiscordRest("t"), GUILD, FORUM, T0);

    expect(warned).toHaveBeenCalledTimes(1);
    const message = String(warned.mock.calls[0]?.[0]);
    expect(message).toContain("active 403");
    expect(message).toContain("archived 500");
    warned.mockRestore();
  });

  it("reports raw active/archived thread counts, so an operator can see archived: 0 without a fixture", async () => {
    const spy = stubFetch((url) =>
      url.includes("/guilds/")
        ? jsonResponse({ threads: [{ id: "1", name: "a", parent_id: FORUM, last_message_id: "1" }, { id: "2", name: "b", parent_id: FORUM, last_message_id: "2" }] })
        : jsonResponse({ threads: [] }),
    );
    const result = await fetchPrdThreads(new DiscordRest("t"), GUILD, FORUM, T0);
    expect(spy).toHaveBeenCalled();
    expect(result.activeCount).toBe(2);
    expect(result.archivedCount).toBe(0);
  });

  it("reports -1 for a count whose endpoint failed, rather than a real zero", async () => {
    stubFetch((url) => (url.includes("/guilds/") ? jsonResponse({ threads: [] }) : jsonResponse({}, 500)));
    const result = await fetchPrdThreads(new DiscordRest("t"), GUILD, FORUM, T0);
    expect(result.activeCount).toBe(0);
    expect(result.archivedCount).toBe(-1);
  });
});
