import { describe, expect, it } from "vitest";
import { config as baseConfig } from "../../../config/config.js";
import {
  EMBED_DESCRIPTION_LIMIT,
  EMBED_TOTAL_LIMIT,
  overflowNotice,
  OVERFLOW_NOTICE_RESERVE,
  renderDigest,
} from "../../../src/core/render/digest.js";
import { newScannedRecord, resolveRecord, type PrRecord } from "../../../src/core/record.js";
import type { TeamName, UrgencyKey } from "../../../config/config.js";

const T0 = 1_756_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = T0 + 30 * DAY;

function rec(
  number: number,
  opts: Partial<PrRecord> & { team?: TeamName | null; urgency?: UrgencyKey | null } = {},
): PrRecord {
  const base = newScannedRecord({
    pr: { owner: "paranext", repo: "paranext-core", number },
    channelId: "chan",
    messageId: `msg-${number}`,
    messageTimestamp: NOW - 3 * DAY,
    title: `PT-${number} Some change`,
    prAuthorLogin: "jolie",
    isDraft: false,
  });
  return { ...base, ...opts };
}

const FRESH = { lastSync: NOW - MINUTE, now: NOW, config: baseConfig };

describe("renderDigest — structure", () => {
  it("renders the empty state with NO components at all", () => {
    // A String Select requires 1-25 options; rendering one empty is a 400, the
    // PATCH fails, the retry fails identically, and the digest freezes showing
    // PRs that are already done.
    const result = renderDigest({ records: [], ...FRESH });
    expect(result.components).toEqual([]);
    expect(result.embeds[0]?.description).toContain("nothing waiting");
  });

  it("renders the empty state when every record is resolved", () => {
    const resolved = resolveRecord(rec(1, { team: "Power", urgency: "soon" }), NOW - 2 * HOUR, "merged");
    const result = renderDigest({ records: [resolved], ...FRESH });
    expect(result.openCount).toBe(0);
    // Recently cleared still renders, and — since this row was resolved inside
    // the 24-hour reopen window — the resolve menu carries exactly one reopen
    // option rather than being empty.
    expect(result.components).toHaveLength(1);
    expect(JSON.stringify(result.components)).toContain("reopen:");
  });

  it("renders truly no components when every record is resolved well outside the reopen window", () => {
    const resolved = resolveRecord(rec(1, { team: "Power", urgency: "soon" }), NOW - 30 * HOUR, "merged");
    const result = renderDigest({ records: [resolved], ...FRESH });
    expect(result.components).toEqual([]);
  });

  it("offers a row resolved in the last 24 hours as a reopen option", () => {
    const resolved = resolveRecord(rec(1, { team: "Power", urgency: "soon" }), NOW - 2 * HOUR, "cleared by Jolie");
    const result = renderDigest({ records: [resolved], ...FRESH });
    const values = JSON.stringify(result.components);
    expect(values).toContain("reopen:paranext/paranext-core/1");
  });

  it("labels a reopen option 'resolved' when resolvedBy is unknown", () => {
    const resolved = { ...resolveRecord(rec(1, { team: "Power", urgency: "soon" }), NOW - 2 * HOUR, "x"), resolvedBy: null };
    const result = renderDigest({ records: [resolved], ...FRESH });
    expect(JSON.stringify(result.components)).toContain("reopen · resolved");
  });

  it("does not offer a reopen for a row resolved more than 24 hours ago", () => {
    const resolved = resolveRecord(rec(1, { team: "Power", urgency: "soon" }), NOW - 30 * HOUR, "merged");
    const result = renderDigest({ records: [resolved], ...FRESH });
    expect(JSON.stringify(result.components)).not.toContain("reopen:");
  });

  it("omits a team section that has no open rows", () => {
    const result = renderDigest({ records: [rec(1, { team: "Power", urgency: "soon" })], ...FRESH });
    const body = result.embeds.map((e) => e.description).join("\n");
    expect(body).toContain("__Power__");
    expect(body).not.toContain("__Simple__");
    expect(body).not.toContain("__General__");
  });

  it("orders sections: teams, triage, being reviewed, recently cleared", () => {
    const records = [
      rec(1, { team: "Power", urgency: "soon" }),
      rec(2),
      rec(3, { team: "Simple", urgency: "soon", claimedBy: "u1", claimedByName: "Katherine", claimedAt: NOW - HOUR }),
      resolveRecord(rec(4, { team: "Power", urgency: "soon" }), NOW - 10 * MINUTE, "review by Ira"),
    ];
    const body = renderDigest({ records, ...FRESH }).embeds.map((e) => e.description).join("\n");
    const order = ["__Power__", "Needs triage", "Being reviewed", "Recently cleared"].map((s) => body.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  it("counts OPEN rows in the header, not rendered rows", () => {
    const records = Array.from({ length: 31 }, (_, i) => rec(i + 1, { team: "Power", urgency: "thisWeek" }));
    const result = renderDigest({ records, ...FRESH, maxRows: 20 });
    expect(result.openCount).toBe(31);
    expect(result.renderedCount).toBe(20);
    expect(result.embeds[0]?.description).toContain("31 open");
  });
});

describe("renderDigest — row content", () => {
  it("renders urgency as emoji PLUS words, never emoji alone", () => {
    const body = renderDigest({ records: [rec(1, { team: "Power", urgency: "thisWeek" })], ...FRESH })
      .embeds.map((e) => e.description).join("\n");
    expect(body).toContain("🧊 This week");
  });

  it("links the title to the PR", () => {
    const body = renderDigest({ records: [rec(177, { team: "Power", urgency: "soon" })], ...FRESH })
      .embeds.map((e) => e.description).join("\n");
    expect(body).toContain("[PT-177 Some change](https://github.com/paranext/paranext-core/pull/177)");
  });

  it("renders ages as relative timestamps, never as computed strings", () => {
    const body = renderDigest({ records: [rec(1, { team: "Power", urgency: "soon" })], ...FRESH })
      .embeds.map((e) => e.description).join("\n");
    expect(body).toMatch(/<t:\d+:R>/);
    expect(body).not.toMatch(/\b\d+[dh]\b/);
  });

  it("renders the blocking reason inline beneath a 🔥 row", () => {
    const record = rec(1, { team: "Power", urgency: "blocking", note: "blocks the release branch cut" });
    const body = renderDigest({ records: [record], ...FRESH }).embeds.map((e) => e.description).join("\n");
    expect(body).toContain("blocks the release branch cut");
  });

  it("does not render a note on a non-blocking row", () => {
    const record = rec(1, { team: "Power", urgency: "soon", note: "just the CSS bit" });
    const body = renderDigest({ records: [record], ...FRESH }).embeds.map((e) => e.description).join("\n");
    expect(body).not.toContain("just the CSS bit");
  });

  it("marks a draft PR", () => {
    const body = renderDigest({ records: [rec(1, { team: "Power", urgency: "soon", isDraft: true })], ...FRESH })
      .embeds.map((e) => e.description).join("\n");
    expect(body).toContain("draft");
  });

  it("marks sync paused", () => {
    const body = renderDigest({ records: [rec(1, { team: "Power", urgency: "soon", syncPausedSince: NOW - DAY })], ...FRESH })
      .embeds.map((e) => e.description).join("\n");
    expect(body).toContain("sync paused");
  });

  it("marks previously claimed after an auto-clear", () => {
    const record = rec(1, { team: "Power", urgency: "soon", lastClaimedByName: "Ira", claimClearedAt: NOW - HOUR });
    const body = renderDigest({ records: [record], ...FRESH }).embeds.map((e) => e.description).join("\n");
    expect(body).toContain("previously claimed");
  });

  it("renders the PRD as a thread mention that follows renames", () => {
    const body = renderDigest({ records: [rec(1, { team: "Power", urgency: "soon", prdThreadId: "t-9" })], ...FRESH })
      .embeds.map((e) => e.description).join("\n");
    expect(body).toContain("<#t-9>");
  });
});

describe("renderDigest — per-person data stays out", () => {
  const claimed = rec(1, {
    team: "Power",
    urgency: "blocking",
    claimedBy: "u1",
    claimedByName: "Katherine",
    claimedAt: NOW - 4 * DAY,
  });

  it("shows the claimer and the urgency and team they came from", () => {
    const body = renderDigest({ records: [claimed], ...FRESH }).embeds.map((e) => e.description).join("\n");
    expect(body).toContain("Katherine");
    expect(body).toContain("🔥");
    expect(body).toContain("Power");
  });

  it("shows 'someone' when a claimed row's claimer display name is unknown", () => {
    const record = rec(1, { team: "Power", urgency: "soon", claimedBy: "u1", claimedByName: null, claimedAt: NOW - HOUR });
    const body = renderDigest({ records: [record], ...FRESH }).embeds.map((e) => e.description).join("\n");
    expect(body).toContain("someone");
  });

  it("does NOT render the claim age — that is the lateness board", () => {
    const result = renderDigest({ records: [claimed], ...FRESH });
    const claimedSection = result.embeds.map((e) => e.description).join("\n").split("Being reviewed")[1] ?? "";
    expect(claimedSection).not.toContain(String(Math.floor(claimed.claimedAt! / 1000)));
  });

  it("does NOT render re-asked, even after several re-requests", () => {
    const record = rec(1, { team: "Power", urgency: "soon", requestCount: 5, lastRequestedAt: NOW - HOUR });
    const body = renderDigest({ records: [record], ...FRESH }).embeds.map((e) => e.description).join("\n");
    expect(body).not.toContain("re-asked");
  });
});

describe("renderDigest — recently cleared", () => {
  it("renders a row resolved inside the window, distinguishing review from manual", () => {
    const byReview = resolveRecord(rec(1, { team: "Power" }), NOW - 10 * MINUTE, "review by Katherine");
    const byHand = resolveRecord(rec(2, { team: "Power" }), NOW - 20 * MINUTE, "cleared by Jolie");
    const body = renderDigest({ records: [byReview, byHand], ...FRESH }).embeds.map((e) => e.description).join("\n");
    expect(body).toContain("review by Katherine");
    expect(body).toContain("cleared by Jolie");
  });

  it("omits a row resolved outside the one-hour window", () => {
    const old = resolveRecord(rec(1, { team: "Power" }), NOW - 2 * HOUR, "merged");
    const body = renderDigest({ records: [old], ...FRESH }).embeds.map((e) => e.description).join("\n");
    expect(body).not.toContain("Recently cleared");
  });

  it("labels a cleared row 'resolved' when resolvedBy is unknown", () => {
    const resolved = { ...resolveRecord(rec(1, { team: "Power" }), NOW - 10 * MINUTE, "x"), resolvedBy: null };
    const body = renderDigest({ records: [resolved], ...FRESH }).embeds.map((e) => e.description).join("\n");
    expect(body).toContain("— resolved");
  });
});

describe("renderDigest — stale banner", () => {
  it("renders the banner when lastSync is older than the threshold", () => {
    const result = renderDigest({ records: [rec(1, { team: "Power", urgency: "soon" })], lastSync: NOW - 47 * MINUTE, now: NOW, config: baseConfig });
    expect(result.embeds[0]?.description).toContain("Not syncing");
  });

  it("replaces the updated timestamp rather than sitting beside it", () => {
    const result = renderDigest({ records: [rec(1, { team: "Power", urgency: "soon" })], lastSync: NOW - 47 * MINUTE, now: NOW, config: baseConfig });
    expect(result.embeds[0]?.description).not.toContain("updated <t:");
  });

  it("renders the banner on a never-synced store", () => {
    const result = renderDigest({ records: [], lastSync: null, now: NOW, config: baseConfig });
    expect(result.embeds[0]?.description).toContain("Not syncing");
  });

  it("still renders every row when stale — a failed sync aborts mutation, not rendering", () => {
    const result = renderDigest({ records: [rec(1, { team: "Power", urgency: "soon" })], lastSync: NOW - 47 * MINUTE, now: NOW, config: baseConfig });
    expect(result.renderedCount).toBe(1);
  });
});

describe("renderDigest — time independence", () => {
  const records = [
    rec(1, { team: "Power", urgency: "blocking", note: "blocks the cut" }),
    rec(2, { team: "Simple", urgency: "thisWeek" }),
    rec(3, { claimedBy: "u1", claimedByName: "Katherine", claimedAt: NOW - 3 * HOUR }),
  ];

  it("produces the same body hash across an hour boundary", () => {
    // This is the property the whole write-skip depends on: with a dozen rows a
    // computed age would change the body on nearly every tick. lastSync is
    // shifted by the same hour as `now` so the fresh/stale determination
    // (1 minute since sync, in both cases) stays constant — the only thing
    // this test varies is which side of an hour boundary `now` falls on.
    const a = renderDigest({ records, lastSync: NOW - MINUTE, now: NOW, config: baseConfig });
    const b = renderDigest({
      records,
      lastSync: NOW + 60 * MINUTE - MINUTE,
      now: NOW + 61 * MINUTE - MINUTE,
      config: baseConfig,
    });
    expect(a.bodyHash).toBe(b.bodyHash);
  });

  it("changes the body hash when a record changes", () => {
    const a = renderDigest({ records, ...FRESH });
    const b = renderDigest({ records: [...records, rec(4, { team: "Power", urgency: "soon" })], ...FRESH });
    expect(a.bodyHash).not.toBe(b.bodyHash);
  });

  it("changes the body hash when the stale banner appears", () => {
    const fresh = renderDigest({ records, lastSync: NOW - MINUTE, now: NOW, config: baseConfig });
    const stale = renderDigest({ records, lastSync: NOW - 47 * MINUTE, now: NOW, config: baseConfig });
    expect(fresh.bodyHash).not.toBe(stale.bodyHash);
  });

  it("does not churn the body between two ticks inside the same interval", () => {
    const records = [rec(1, { team: "Power", urgency: "soon" })];
    const a = renderDigest({ records, lastSync: NOW, now: NOW, config: baseConfig });
    const b = renderDigest({ records, lastSync: NOW, now: NOW + 1_000, config: baseConfig });
    expect(a.bodyHash).toBe(b.bodyHash);
  });

  it("changes the body hash when a reopen option expires out of the menu", () => {
    // The gap this closes: reopen options are the one time-dependent part of the
    // render, and once a resolved row ages past recentlyClearedMs (1h) it has NO
    // text in the body at all. With only the embed text hashed, the hash settled
    // at T+1h and never moved again, so the tick reported skipped-unchanged
    // forever and the pin kept offering `↩︎ <title>` past the 24h window — an
    // option the interaction handler refuses on every selection.
    //
    // Both renders are well past the recently-cleared window, so the two bodies
    // are character-for-character identical; only the menu differs.
    const resolved = resolveRecord(rec(1, { team: "Power", urgency: "soon" }), NOW - 23 * HOUR, "merged");
    const open = rec(2, { team: "Power", urgency: "soon" });

    const inside = renderDigest({ records: [resolved, open], lastSync: NOW, now: NOW, config: baseConfig });
    const outside = renderDigest({
      records: [resolved, open],
      lastSync: NOW + 2 * HOUR,
      now: NOW + 2 * HOUR,
      config: baseConfig,
    });

    // The header's own "updated" stamp is display-only and deliberately unhashed,
    // so it is stripped before comparing — everything the hash actually covers
    // is identical between the two renders.
    const hashedText = (r: typeof inside): string[] =>
      r.embeds.map((e) => e.description.replace(/ · updated <t:\d+:R>/, ""));

    expect(JSON.stringify(inside.components)).toContain("reopen:");
    expect(JSON.stringify(outside.components)).not.toContain("reopen:");
    expect(hashedText(inside)).toEqual(hashedText(outside));
    expect(inside.bodyHash).not.toBe(outside.bodyHash);
  });

  it("still holds the hash steady for a resolved row that is not near either boundary", () => {
    // The guard on the test above: hashing components must not make the hash
    // move with the clock generally, only when the menu's contents actually
    // change. Two ticks four hours apart, both inside the reopen window and both
    // outside the recently-cleared one, must hash identically.
    const resolved = resolveRecord(rec(1, { team: "Power", urgency: "soon" }), NOW - 10 * HOUR, "merged");
    const records = [resolved, rec(2, { team: "Power", urgency: "soon" })];
    const a = renderDigest({ records, lastSync: NOW, now: NOW, config: baseConfig });
    const b = renderDigest({ records, lastSync: NOW + 4 * HOUR, now: NOW + 4 * HOUR, config: baseConfig });
    expect(a.bodyHash).toBe(b.bodyHash);
  });
});

describe("renderDigest — what capacity drops", () => {
  // config.teams is ["Power", "Simple", "General"], so General is the LAST
  // display section. A cap applied to a flat prefix of the display order drops
  // General's rows first regardless of how urgent they are.
  const lowUrgencyEarlySection = Array.from({ length: 20 }, (_, i) =>
    rec(100 + i, { team: "Power", urgency: "thisWeek", firstRequestedAt: NOW - DAY }),
  );
  const blockingLateSection = Array.from({ length: 3 }, (_, i) =>
    rec(900 + i, { team: "General", urgency: "blocking", note: "blocks the cut", firstRequestedAt: NOW - 9 * DAY }),
  );

  it("drops the lowest-urgency rows, not the last display section", () => {
    const result = renderDigest({
      records: [...lowUrgencyEarlySection, ...blockingLateSection],
      ...FRESH,
    });
    const body = result.embeds.map((e) => e.description).join("\n");

    expect(result.openCount).toBe(23);
    expect(result.droppedCount).toBe(3);
    for (const row of blockingLateSection) {
      expect(body).toContain(`PT-${row.number}`);
    }
    // And the three that made way are 🧊 rows, so exactly 17 of the 20 survive.
    expect(lowUrgencyEarlySection.filter((row) => body.includes(`PT-${row.number}`))).toHaveLength(17);
  });

  it("still displays the survivors grouped by section, in config order", () => {
    const result = renderDigest({
      records: [...lowUrgencyEarlySection, ...blockingLateSection],
      ...FRESH,
    });
    const body = result.embeds.map((e) => e.description).join("\n");
    // Selecting across sections must not reorder the display: Power's heading
    // still precedes General's, even though every General row outranks every
    // Power row.
    expect(body).toContain("__Power__");
    expect(body).toContain("__General__");
    expect(body.indexOf("__Power__")).toBeLessThan(body.indexOf("__General__"));
  });

  it("keeps a dropped-urgency row actionable: the menus follow the same selection", () => {
    // The menus are built from the surviving rows, so a blocking row dropped by
    // a section-first cap is not merely invisible — it cannot be claimed from
    // the digest at all.
    const result = renderDigest({
      records: [...lowUrgencyEarlySection, ...blockingLateSection],
      ...FRESH,
    });
    const options = JSON.stringify(result.components);
    for (const row of blockingLateSection) {
      expect(options).toContain(`paranext/paranext-core/${row.number}:`);
    }
  });

  it("keeps every claimed row when the open backlog exceeds maxRows", () => {
    // R19: claimed rows are exempt from the row-count cap, so a long backlog
    // cannot truncate away the rows people are actively working on. Every
    // existing capacity test asserts only UPPER bounds (<= 4096, <= 6000,
    // droppedCount > 0), which is why removing the exemption outright left the
    // whole suite green. This asserts the section and each claimer by name.
    // The claimed rows are deliberately the ones a SHARED cap would drop: same
    // urgency as the open backlog and the newest of the lot, so age puts them
    // last. Giving them a higher urgency (or an older age) would let them
    // survive the cap on their own merits and the test would pass with the
    // exemption removed — which is the trap the original fixtures fell into.
    const open = Array.from({ length: 25 }, (_, i) =>
      rec(300 + i, { team: "Power", urgency: "thisWeek", firstRequestedAt: NOW - 5 * DAY }),
    );
    const claimed = ["Katherine", "Ira", "Jolie", "Marcus"].map((name, i) =>
      rec(400 + i, {
        team: "Power",
        urgency: "thisWeek",
        firstRequestedAt: NOW - HOUR,
        claimedBy: `u${i}`,
        claimedByName: name,
        claimedAt: NOW - HOUR,
      }),
    );

    const result = renderDigest({ records: [...open, ...claimed], ...FRESH, maxRows: 20 });
    const body = result.embeds.map((e) => e.description).join("\n");

    // Premise: the open backlog really is over the cap, so a shared cap would
    // have had to drop something.
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(body).toContain("Being reviewed");
    for (const row of claimed) {
      expect(body).toContain(row.claimedByName!);
      expect(body).toContain(`PT-${row.number}`);
    }
    // 20 open + 4 claimed: the exemption is on top of the cap, not inside it.
    expect(result.renderedCount).toBe(24);
  });
});

describe("renderDigest — capacity", () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    rec(i + 1, { team: "Power", urgency: "thisWeek", title: `PT-${i} ${"long title ".repeat(6)}` }),
  );

  // A large claimed backlog: claimed rows are exempt from maxRows (an
  // abandoned claim must not silently vanish), so with enough of them this
  // section alone can blow past both the per-embed and the total-across-
  // embeds cap. These two tests need this fixture, plus an explicit maxRows,
  // to actually cross 4096 in a single embed and 6000 across two — with the
  // small default fixture and DEFAULT_MAX_ROWS, both bounds are satisfied by
  // a single ~3.9 KB embed and never truly exercised.
  const manyClaimed = Array.from({ length: 40 }, (_, i) =>
    rec(2000 + i, {
      team: "Power",
      urgency: "soon",
      title: `PT-${2000 + i} ${"claimed title ".repeat(6)}`,
      claimedBy: `u${i}`,
      claimedByName: `Reviewer${i}`,
      claimedAt: NOW - HOUR,
    }),
  );

  function claimedRows(count: number, titleWords = 6): PrRecord[] {
    return Array.from({ length: count }, (_, i) =>
      rec(5000 + i, {
        team: "Power",
        urgency: "soon",
        title: `PT-${5000 + i} ${"claimed title ".repeat(titleWords)}`,
        claimedBy: `u${i}`,
        claimedByName: `Reviewer${i}`,
        claimedAt: NOW - HOUR,
      }),
    );
  }

  it("keeps every embed description inside 4096 characters", () => {
    const result = renderDigest({ records: [...many, ...manyClaimed], ...FRESH, maxRows: 30 });
    for (const embed of result.embeds) {
      expect(embed.description.length).toBeLessThanOrEqual(4096);
    }
  });

  it("keeps the total across embeds inside 6000 characters", () => {
    const result = renderDigest({ records: [...many, ...manyClaimed], ...FRESH, maxRows: 30 });
    const total = result.embeds.reduce((sum, e) => sum + e.description.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
  });

  it("appends an explicit and-N-more rather than truncating silently", () => {
    const result = renderDigest({ records: many, ...FRESH });
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.embeds.map((e) => e.description).join("\n")).toContain(`${result.droppedCount} more`);
  });

  it("moves Being reviewed into a second embed when the first is full", () => {
    const withClaims = [
      ...many,
      rec(99, { team: "Power", urgency: "soon", claimedBy: "u1", claimedByName: "Katherine", claimedAt: NOW - HOUR }),
    ];
    // maxRows is raised explicitly here, not via the DEFAULT_MAX_ROWS constant:
    // 20 is a production capacity budget derived from measured real-row
    // length (150-180 chars), not a knob to tune for this fixture's
    // artificially long titles. Raising it just for this call exercises the
    // second-embed path without changing what a real digest renders.
    const result = renderDigest({ records: withClaims, ...FRESH, maxRows: 30 });
    expect(result.embeds.length).toBeGreaterThan(1);
  });

  it("stays within the 6000 total when both the open and claimed backlogs are large, and reports what could not be shown", () => {
    // The pathological shape: a big open backlog (still bounded by maxRows,
    // so it alone would never overflow two embeds) plus a big claimed
    // backlog (unbounded by design — an abandoned claim must not vanish).
    // Together they exceed even two embeds' worth of space. The total must
    // still respect Discord's 6000-across-all-embeds cap, and whatever had
    // to be cut must be named explicitly rather than silently dropped —
    // under-reporting the list is the one direction it must never lie in.
    const result = renderDigest({ records: [...many, ...manyClaimed], ...FRESH, maxRows: 30 });
    const total = result.embeds.reduce((sum, e) => sum + e.description.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
    const body = result.embeds.map((e) => e.description).join("\n");
    expect(body).toMatch(/more/i);
  });

  it("reserves at least as many characters as the overflow notice can occupy", () => {
    // Guards against the reserve constant drifting out of sync with the
    // notice template it must cover — a hand-counted literal would silently
    // go stale the moment anyone rewords the notice, reproducing the exact
    // cap violation this budgeting exists to prevent.
    for (const n of [1, 9, 10, 99, 100, 999, 1000, 999_999]) {
      expect(overflowNotice(n).length).toBeLessThanOrEqual(OVERFLOW_NOTICE_RESERVE);
    }
  });

  it.each([20, 25, 30, 40, 60, 80])(
    "keeps every embed inside 4096 and the total inside 6000 with %i claimed rows",
    (claimedCount) => {
      // Sweeps the neighbourhood of the cap rather than trying to land exactly
      // on it: a reserve that is short by even a few characters fails
      // somewhere here, since the packing boundary (and therefore how much
      // slack is left before the notice is appended) shifts with every row
      // added.
      const records = [...many, ...claimedRows(claimedCount)];
      const result = renderDigest({ records, ...FRESH, maxRows: 30 });
      for (const embed of result.embeds) {
        expect(embed.description.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_LIMIT);
      }
      const total = result.embeds.reduce((sum, e) => sum + e.description.length, 0);
      expect(total).toBeLessThanOrEqual(EMBED_TOTAL_LIMIT);
    },
  );

  it.each([4, 5, 6, 7, 8, 9, 10])(
    "keeps caps intact across claimed-row title lengths (%i repeated phrases)",
    (titleWords) => {
      // The count sweep above varies where the packing boundary falls by
      // changing how many rows there are; this sweep instead varies each
      // row's own length, covering saturation points the count sweep alone
      // might step over.
      const records = [...many, ...claimedRows(40, titleWords)];
      const result = renderDigest({ records, ...FRESH, maxRows: 30 });
      for (const embed of result.embeds) {
        expect(embed.description.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_LIMIT);
      }
      const total = result.embeds.reduce((sum, e) => sum + e.description.length, 0);
      expect(total).toBeLessThanOrEqual(EMBED_TOTAL_LIMIT);
    },
  );

  it("colors the overflow embed with the stale color too, not just the first", () => {
    // The stale/normal color choice is applied separately when pushing each
    // embed; a bug could easily color only the first and leave the second at
    // the default, which a single-embed stale test could never catch.
    const fresh = renderDigest({ records: many, ...FRESH, maxRows: 30 });
    const stale = renderDigest({ records: many, lastSync: NOW - 47 * MINUTE, now: NOW, config: baseConfig, maxRows: 30 });
    expect(fresh.embeds.length).toBeGreaterThan(1);
    expect(stale.embeds.length).toBeGreaterThan(1);
    expect(stale.embeds[1]?.color).toBe(stale.embeds[0]?.color);
    expect(stale.embeds[1]?.color).not.toBe(fresh.embeds[1]?.color);
  });

  it("matches a stored snapshot", () => {
    const result = renderDigest({
      records: [
        rec(177, { team: "Power", urgency: "blocking", note: "needs a P10 build before Thursday's demo", prdThreadId: "t-1" }),
        rec(2701, { team: "Power", urgency: "soon" }),
        rec(2695, { team: "Simple", urgency: "thisWeek", isDraft: true }),
        rec(3408, { claimedBy: "u1", claimedByName: "Katherine", claimedAt: NOW - 2 * HOUR, team: "Power", urgency: "blocking" }),
      ],
      ...FRESH,
    });
    expect(result.embeds.map((e) => e.description)).toMatchSnapshot();
  });
});

describe("renderDigest — a level with no emoji", () => {
  const noEmoji = {
    ...baseConfig,
    urgencies: baseConfig.urgencies.map((u) => (u.key === "soon" ? { ...u, emoji: null } : u)),
  };
  const FRESH_NO_EMOJI = { lastSync: NOW - MINUTE, now: NOW, config: noEmoji };

  it("renders an open row's urgency as the bare label, with no leading space", () => {
    const result = renderDigest({
      records: [rec(1, { team: "Power", urgency: "soon" })],
      ...FRESH_NO_EMOJI,
    });
    expect(result.embeds[0]?.description).toContain("Soon · [PT-1 Some change]");
    expect(result.embeds[0]?.description).not.toContain(" Soon ·");
  });

  it("omits the urgency from a claimed row rather than printing the label's first word", () => {
    // The emoji-only slot on a claimed row previously came from splitting
    // "Soon" on its first space, which put the WORD "Soon" where an emoji goes.
    const claimed = rec(2, {
      team: "Power",
      urgency: "soon",
      claimedBy: "u-9",
      claimedByName: "Sam",
      claimedAt: NOW - HOUR,
      claimSource: "menu" as const,
    });
    const result = renderDigest({ records: [claimed], ...FRESH_NO_EMOJI });
    const body = result.embeds.map((e) => e.description).join("\n");
    expect(body).toContain("👀 [PT-2 Some change](https://github.com/paranext/paranext-core/pull/2) · Sam · Power");
  });
});
