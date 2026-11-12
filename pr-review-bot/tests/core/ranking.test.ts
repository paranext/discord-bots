import { describe, expect, it } from "vitest";
import { config as baseConfig } from "../../config/config.js";
import {
  decodeOptionValue,
  encodeOptionValue,
  menuOptions,
  rankRows,
  truncateRows,
  urgencyRank,
} from "../../src/core/ranking.js";
import { resolveRecord, type PrRecord } from "../../src/core/record.js";
import { testRecord } from "../../fixtures/records.js";
import type { UrgencyKey } from "../../config/config.js";

const T0 = 1_756_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function rec(
  number: number,
  opts: {
    urgency?: UrgencyKey | null;
    firstRequestedAt?: number;
    claimedBy?: string | null;
    claimedByName?: string | null;
  } = {},
): PrRecord {
  const base = testRecord({
    pr: { owner: "paranext", repo: "paranext-core", number },
    channelId: "chan",
    messageId: `msg-${number}`,
    messageTimestamp: opts.firstRequestedAt ?? T0,
    title: `PT-${number} Title`,
    prAuthorLogin: "jolie",
    isDraft: false,
  });
  return {
    ...base,
    urgency: opts.urgency ?? null,
    claimedBy: opts.claimedBy ?? null,
    claimedByName: opts.claimedByName ?? null,
    claimedAt: opts.claimedBy === undefined || opts.claimedBy === null ? null : T0,
  };
}

describe("urgencyRank", () => {
  it("orders blocking, soon, this week", () => {
    expect(urgencyRank("blocking", baseConfig)).toBeLessThan(urgencyRank("soon", baseConfig));
    expect(urgencyRank("soon", baseConfig)).toBeLessThan(urgencyRank("thisWeek", baseConfig));
  });

  it("ranks null urgency BELOW this week — a record with no urgency sorts last", () => {
    expect(urgencyRank(null, baseConfig)).toBeGreaterThan(urgencyRank("thisWeek", baseConfig));
  });

  it("degrades gracefully rather than crashing when a config drops a level the type still allows", () => {
    // config.urgencies is a fixed list matched 1:1 to UrgencyKey today, so this
    // is defensive code for a config edited out of step with the type — but a
    // config author CAN produce exactly this shape, and the fallback rank must
    // still sort the row below every level that IS configured, and above null.
    const partialConfig = { ...baseConfig, urgencies: baseConfig.urgencies.filter((u) => u.key !== "thisWeek") };
    const rank = urgencyRank("thisWeek", partialConfig);
    expect(rank).toBeGreaterThan(urgencyRank("soon", partialConfig));
    expect(rank).toBeLessThan(urgencyRank(null, partialConfig));
  });
});

describe("rankRows", () => {
  it("excludes resolved records", () => {
    const rows = rankRows([resolveRecord(rec(1), T0, "merged")], baseConfig);
    expect(rows).toHaveLength(0);
  });

  it("sorts urgency descending then age oldest-first in one list", () => {
    const rows = rankRows(
      [
        rec(1, { urgency: "soon", firstRequestedAt: T0 - 8 * DAY }),
        rec(2, { urgency: "blocking", firstRequestedAt: T0 - 1 * HOUR }),
        rec(3, { urgency: "soon", firstRequestedAt: T0 - 30 * DAY }),
      ],
      baseConfig,
    );
    // Blocking first despite being newest; then the two Soon rows oldest-first.
    expect(rows.map((r) => r.record.number)).toEqual([2, 3, 1]);
  });

  it("ranks a record with no urgency last among the open rows", () => {
    const rows = rankRows([rec(1), rec(2, { urgency: "thisWeek" })], baseConfig);
    expect(rows.map((r) => r.record.number)).toEqual([2, 1]);
    expect(rows.every((r) => r.record.claimedBy === null)).toBe(true);
  });

  it("moves claimed rows into a claimed section after the open rows", () => {
    const rows = rankRows(
      [
        rec(1, { urgency: "blocking", claimedBy: "u1", claimedByName: "Katherine" }),
        rec(2, { urgency: "soon" }),
        rec(3),
      ],
      baseConfig,
    );
    expect(rows.map((r) => r.record.claimedBy !== null)).toEqual([false, false, true]);
    expect(rows.at(-1)?.record.number).toBe(1);
  });

  it("breaks ties on record id so the body is deterministic across ticks", () => {
    const a = rankRows([rec(9, { urgency: "soon" }), rec(4, { urgency: "soon" })], baseConfig);
    const b = rankRows([rec(4, { urgency: "soon" }), rec(9, { urgency: "soon" })], baseConfig);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  });
});

describe("truncateRows", () => {
  const many = Array.from({ length: 31 }, (_, i) =>
    rec(i + 1, { urgency: i === 0 ? "blocking" : "thisWeek", firstRequestedAt: T0 - (31 - i) * DAY }),
  );

  it("keeps the highest-ranked rows and reports how many were dropped", () => {
    const result = truncateRows(rankRows(many, baseConfig), 20);
    expect(result.rendered).toHaveLength(20);
    expect(result.droppedCount).toBe(11);
  });

  it("never drops the top-ranked row", () => {
    const result = truncateRows(rankRows(many, baseConfig), 20);
    expect(result.rendered[0]?.record.number).toBe(1);
  });

  it("drops nothing when everything fits", () => {
    const result = truncateRows(rankRows(many.slice(0, 5), baseConfig), 20);
    expect(result.droppedCount).toBe(0);
    expect(result.rendered).toHaveLength(5);
  });

  it("handles an empty list", () => {
    expect(truncateRows([], 20)).toEqual({ rendered: [], droppedCount: 0 });
  });
});

describe("menuOptions", () => {
  const many = Array.from({ length: 31 }, (_, i) =>
    rec(i + 1, {
      urgency: i === 30 ? "blocking" : "thisWeek",
      firstRequestedAt: T0 - (i === 30 ? HOUR : (31 - i) * DAY),
    }),
  );

  it("is populated from the digest ranking, not oldest-first", () => {
    // Row 31 is 🔥 and only 90 minutes old — the newest row and the most urgent.
    // An oldest-first menu would omit exactly this one.
    const rendered = truncateRows(rankRows(many, baseConfig), 20).rendered;
    const options = menuOptions(rendered, "claim", baseConfig);
    expect(options[0]?.value).toContain("/31:");
  });

  it("caps at Discord's 25 options", () => {
    const rendered = truncateRows(rankRows(many, baseConfig), 30).rendered;
    expect(menuOptions(rendered, "claim", baseConfig)).toHaveLength(25);
  });

  it("contains no row absent from the render", () => {
    const rendered = truncateRows(rankRows(many, baseConfig), 20).rendered;
    const renderedIds = new Set(rendered.map((r) => r.id));
    for (const option of menuOptions(rendered, "claim", baseConfig)) {
      expect(renderedIds.has(decodeOptionValue(option.value)!.id)).toBe(true);
    }
  });

  it("keeps already-claimed rows on the claim menu, which is what makes unclaim reachable", () => {
    // This used to assert the opposite, and the opposite is a defect: the claim
    // menu is the ONLY route to a claimed row, so filtering claimed rows out
    // left a holder unable to release one — the row stayed under their name,
    // where nobody else takes it, until the two-day stale sweep.
    const rows = rankRows(
      [
        rec(1, { urgency: "soon" }),
        rec(2, { urgency: "soon", claimedBy: "u1", claimedByName: "Katherine" }),
      ],
      baseConfig,
    );
    const claim = menuOptions(rows, "claim", baseConfig);
    expect(claim).toHaveLength(2);
    expect(menuOptions(rows, "resolve", baseConfig)).toHaveLength(2);

    // Unclaimed first: the 25-option cap is real, and an actionable row outranks
    // an informational one.
    expect(decodeOptionValue(claim[0]!.value)!.id).toContain("/1");
    const held = claim[1]!;
    expect(decodeOptionValue(held.value)!.id).toContain("/2");
    // Who holds it is legible before selecting, not only in the reply after.
    expect(held.description).toContain("held by Katherine");
    expect(held.label).toContain("👀");
  });

  it("puts every unclaimed row ahead of every claimed one, not just the first", () => {
    // Two of each, interleaved on input, so an implementation that merely kept
    // input order — or moved one row — fails.
    const rows = rankRows(
      [
        rec(1, { urgency: "soon", claimedBy: "u1", claimedByName: "Katherine" }),
        rec(2, { urgency: "soon" }),
        rec(3, { urgency: "soon", claimedBy: "u2", claimedByName: "Ira" }),
        rec(4, { urgency: "soon" }),
      ],
      baseConfig,
    );
    const held = menuOptions(rows, "claim", baseConfig).map((o) => o.description.startsWith("held by"));
    expect(held).toEqual([false, false, true, true]);
  });

  it("keeps every label inside Discord's 100-character option limit", () => {
    const long = rec(1, { urgency: "blocking" });
    const rows = rankRows([{ ...long, title: "x".repeat(300) }], baseConfig);
    for (const option of menuOptions(rows, "claim", baseConfig)) {
      expect(option.label.length).toBeLessThanOrEqual(100);
      expect(option.value.length).toBeLessThanOrEqual(100);
      expect(option.description.length).toBeLessThanOrEqual(100);
    }
  });

  it("clamps the option VALUE too, which a long title can never exercise (finding 12)", () => {
    // `value` is built from owner/repo/number and the request stamp, so the test
    // above — which only lengthens the TITLE — leaves it at ~40 characters and
    // asserts nothing about the clamp. Length has to come from the owner and
    // repo, the only inputs that actually feed `value`.
    //
    // An over-long `value` is not a bad row: Discord 400s the whole PATCH, so the
    // digest stops repainting entirely and freezes showing PRs already done.
    const long = rec(1, { urgency: "blocking" });
    const wide: PrRecord = { ...long, owner: "o".repeat(60), repo: "r".repeat(60) };
    const rows = rankRows([wide], baseConfig);
    const options = menuOptions(rows, "claim", baseConfig);

    expect(options).toHaveLength(1);
    // The premise: unclamped, this really would have overflowed. Without this the
    // assertion below could pass on a value that was short all along.
    expect(encodeOptionValue(wide).length).toBeGreaterThan(100);
    expect(options[0]!.value.length).toBeLessThanOrEqual(100);
    // And the clamp fails CLOSED: a clamped value does not decode, so selecting
    // the row gets "could not read that selection" rather than acting on a
    // truncated id that could name a different record.
    expect(decodeOptionValue(options[0]!.value)).toBeNull();
  });
});

describe("option value encoding", () => {
  it("round-trips the id and lastRequestedAt", () => {
    const r = rec(177, { urgency: "blocking" });
    const decoded = decodeOptionValue(encodeOptionValue(r));
    expect(decoded).toEqual({ id: "paranext/paranext-core/177", lastRequestedAt: r.lastRequestedAt });
  });

  it("returns null for a malformed value rather than throwing", () => {
    expect(decodeOptionValue("garbage")).toBeNull();
    expect(decodeOptionValue("a/b/c:notanumber")).toBeNull();
  });
});

describe("menuOptions — a level with no emoji", () => {
  const noEmoji = {
    ...baseConfig,
    urgencies: baseConfig.urgencies.map((u) => (u.key === "soon" ? { ...u, emoji: null } : u)),
  };

  it("starts the option label at the title, with no leading space", () => {
    const rows = rankRows([rec(1, { urgency: "soon" })], noEmoji);
    expect(menuOptions(rows, "claim", noEmoji)[0]?.label).toBe("PT-1 Title");
  });
});
