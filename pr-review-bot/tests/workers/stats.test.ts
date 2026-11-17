import { describe, expect, it } from "vitest";
import { config } from "../../config/config.js";
import type { Figures } from "../../src/core/stats/figures.js";
import { emptyWeek, type PendingEntry, type WeekTotals } from "../../src/core/stats/types.js";
import { handleStats } from "../../src/handlers/stats.js";
import { emptyState } from "../../src/store/apply.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { DigestPublisher, StoreState } from "../../src/store/types.js";

const TOKEN = "stats-secret";

/** The stats endpoint reads only through `Store.readState`, so no publisher is
 *  ever called; this exists to satisfy the constructor. */
const publisher: DigestPublisher = {
  listPinnedMessageIds: async () => [],
  patchDigest: async () => ({ ok: true }),
  createDigest: async () => ({ ok: true, messageId: "digest-1" }),
  postDaily: async () => ({ ok: true, messageId: "daily-1" }),
  messageUrl: (id) => `https://discord.com/channels/g/c/${id}`,
};

interface StatsBody {
  foldedThrough: string | null;
  sinceWeek: string | null;
  weeks: Array<{ week: string; rolling4: Figures } & Figures>;
}

/** Collection running since long before the weeks under test, unless given. */
function state(
  weeks: Record<string, WeekTotals>,
  foldedThrough: string | null,
  pending: PendingEntry[] = [],
  sinceWeek: string | null = "2020-W01",
): StoreState {
  const base = emptyState();
  return { ...base, stats: { ...base.stats, weeks, foldedThrough, pending, sinceWeek } };
}

function reviewedWeek(rounds: number): WeekTotals {
  const w = emptyWeek();
  w.outcomes.reviewed = rounds;
  w.histograms.total[2] = rounds;
  return w;
}

async function get(
  initial: StoreState,
  query = "",
  opts: { token?: string | undefined; authorization?: string | null } = {},
): Promise<Response> {
  return handleStats({
    store: new MemoryStore(config, publisher, initial),
    token: "token" in opts ? opts.token : TOKEN,
    authorization: "authorization" in opts ? opts.authorization : `Bearer ${TOKEN}`,
    url: new URL(`https://bot/stats${query}`),
  });
}

describe("handleStats — who is allowed to read it", () => {
  it("404s when no token is configured", async () => {
    expect((await get(state({}, null), "", { token: undefined })).status).toBe(404);
  });

  it("401s a wrong bearer token", async () => {
    expect((await get(state({}, null), "", { authorization: "Bearer nope" })).status).toBe(401);
  });

  it("serves JSON to the correct bearer token", async () => {
    const response = await get(state({}, null));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

describe("handleStats", () => {
  const folded = state({ "2026-W40": reviewedWeek(2) }, "2026-W45");

  it("returns ?weeks rows oldest first, ending at foldedThrough", async () => {
    const body = (await (await get(folded, "?weeks=3")).json()) as StatsBody;
    expect(body.foldedThrough).toBe("2026-W45");
    expect(body.weeks.map((w) => w.week)).toEqual(["2026-W43", "2026-W44", "2026-W45"]);
  });

  it("defaults to 26 rows when weeks is invalid, and clamps to 104", async () => {
    expect(((await (await get(folded, "?weeks=abc")).json()) as StatsBody).weeks).toHaveLength(26);
    expect(((await (await get(folded)).json()) as StatsBody).weeks).toHaveLength(26);
    expect(((await (await get(folded, "?weeks=0")).json()) as StatsBody).weeks).toHaveLength(26);
    expect(((await (await get(folded, "?weeks=500")).json()) as StatsBody).weeks).toHaveLength(104);
  });

  it("shows counts but suppresses the median below 5 rounds", async () => {
    const body = (await (await get(folded, "?weeks=6")).json()) as StatsBody;
    const row = body.weeks.find((w) => w.week === "2026-W40");
    expect(row?.outcomes.reviewed).toBe(2);
    expect(row?.medianMs.total).toBeNull();
    expect(row?.rolling4.outcomes.reviewed).toBe(2);
  });

  it("never serialises a histogram", async () => {
    const text = await (await get(folded)).text();
    expect(text).not.toContain("histograms");
  });

  it("returns no weeks when nothing is folded, even with pending entries", async () => {
    const pending: PendingEntry = {
      id: 1,
      week: "2026-W45",
      outcome: "reviewed",
      waitToClaimMs: 0,
      claimToDoneMs: 0,
      totalMs: 0,
      claimed: true,
      claimsDropped: 0,
      reRequests: 0,
    };
    const body = (await (await get(state({}, null, [pending]))).json()) as StatsBody;
    expect(body).toEqual({ foldedThrough: null, sinceWeek: "2020-W01", weeks: [] });
  });

  it("starts rows at sinceWeek and reports it", async () => {
    const clipped = state({ "2026-W43": reviewedWeek(2), "2026-W44": reviewedWeek(3) }, "2026-W45", [], "2026-W44");
    const body = (await (await get(clipped, "?weeks=6")).json()) as StatsBody;
    expect(body.sinceWeek).toBe("2026-W44");
    expect(body.weeks.map((w) => w.week)).toEqual(["2026-W44", "2026-W45"]);
    // W43's totals predate collection, so rolling4 ignores them too.
    expect(body.weeks[1]?.rolling4.outcomes.reviewed).toBe(3);
  });

  it("rolls two folded weeks together, crossing the median threshold", async () => {
    const two = state({ "2026-W44": reviewedWeek(2), "2026-W45": reviewedWeek(3) }, "2026-W45");
    const body = (await (await get(two, "?weeks=2")).json()) as StatsBody;
    const [w44, w45] = body.weeks;
    expect(w44?.medianMs.total).toBeNull();
    expect(w45?.medianMs.total).toBeNull();
    expect(w45?.rolling4.outcomes.reviewed).toBe(5);
    expect(w45?.rolling4.medianMs.total).not.toBeNull();
  });
});
