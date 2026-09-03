import { describe, expect, it } from "vitest";
import { buildPrdCache, PRD_OPTION_CAP, type RawThread } from "../../src/core/prd.js";

const T0 = 1_756_000_000_000;
const PARENT = "forum-1";

type ThreadOverride = {
  id?: string;
  name?: string;
  parent_id?: string | null;
  last_message_id?: string | null | undefined;
};

function thread(id: string, over: ThreadOverride = {}): RawThread {
  return { id, name: `PRD ${id}`, parent_id: PARENT, last_message_id: id, ...over } as RawThread;
}

function build(active: RawThread[], archived: RawThread[] = []) {
  return buildPrdCache({ active, archived, parentId: PARENT, refreshedAt: T0 });
}

describe("buildPrdCache", () => {
  it("drops threads belonging to another parent — /threads/active is guild-wide", () => {
    const cache = build([thread("100"), thread("200", { parent_id: "other-forum" })]);
    expect(cache.options.map((o) => o.id)).toEqual(["100"]);
  });

  it("sorts by last_message_id descending, not by thread id", () => {
    // Thread 300 is the newest thread but has been quiet; 100 is older with
    // recent activity. Activity wins — the dropdown is ordered by what people
    // are actually discussing.
    const cache = build([
      thread("300", { last_message_id: "310" }),
      thread("100", { last_message_id: "900" }),
    ]);
    expect(cache.options.map((o) => o.id)).toEqual(["100", "300"]);
  });

  it("falls back to the thread id when last_message_id is absent, null, or unparseable", () => {
    const cache = build([
      thread("500", { last_message_id: null }),
      thread("700", { last_message_id: undefined }),
      thread("600", { last_message_id: "not-a-snowflake" }),
    ]);
    expect(cache.options.map((o) => o.id)).toEqual(["700", "600", "500"]);
  });

  it("preserves both threads when they have the same activity key (tie in sort)", () => {
    // Thread 100 has last_message_id = "500", so activityKey = 500n.
    // Thread 500 has no last_message_id, so falls back to id, so activityKey = 500n.
    // Both compute to the same key; the sort returns 0 and both survive in input order.
    const cache = build([
      thread("100", { last_message_id: "500" }),
      thread("500", { last_message_id: undefined }),
    ]);
    expect(cache.options.map((o) => o.id)).toEqual(["100", "500"]);
  });

  it("keeps an archived thread that carries no parent_id field at all — the archived route is already channel-scoped", () => {
    // `/channels/{id}/threads/archived/public` is scoped to the forum channel
    // by its URL, not by a `parent_id` on each thread object. A filter here
    // would silently drop every archived thread if that route's objects ever
    // omitted the field — and archived is most of the list, since forum posts
    // auto-archive.
    const noParent = { id: "900", name: "PRD 900", last_message_id: "900" } as RawThread;
    const cache = build([], [noParent]);
    expect(cache.options.map((o) => o.id)).toEqual(["900"]);
  });

  it("still drops a guild-wide active thread belonging to another parent", () => {
    const cache = build([thread("100"), thread("200", { parent_id: "other-forum" })], []);
    expect(cache.options.map((o) => o.id)).toEqual(["100"]);
  });

  it("merges archived threads and dedupes by id, preferring the active copy", () => {
    const cache = build([thread("100", { name: "live name" })], [thread("100", { name: "stale name" }), thread("50")]);
    expect(cache.options).toEqual([
      { id: "100", name: "live name" },
      { id: "50", name: "PRD 50" },
    ]);
  });

  it("caps at 24 and reports truncated, leaving the 25th select slot for None", () => {
    const many = Array.from({ length: 30 }, (_, i) => thread(String(1000 + i)));
    const cache = build(many);
    expect(cache.options).toHaveLength(PRD_OPTION_CAP);
    expect(PRD_OPTION_CAP).toBe(24);
    expect(cache.truncated).toBe(true);
    // Newest kept, oldest dropped.
    expect(cache.options[0]!.id).toBe("1029");
  });

  it("is not truncated at exactly the cap", () => {
    const cache = build(Array.from({ length: PRD_OPTION_CAP }, (_, i) => thread(String(1000 + i))));
    expect(cache.truncated).toBe(false);
  });

  it("clamps names to Discord's 100-character option label limit", () => {
    const cache = build([thread("100", { name: "x".repeat(400) })]);
    expect(cache.options[0]!.name.length).toBe(100);
  });

  it("records refreshedAt", () => {
    expect(build([thread("100")]).refreshedAt).toBe(T0);
  });
});
