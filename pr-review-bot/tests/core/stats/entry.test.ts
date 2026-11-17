import { describe, expect, it } from "vitest";
import { buildEntry } from "../../../src/core/stats/entry.js";
import { testRecord } from "../../../fixtures/records.js";
import type { PrRecord } from "../../../src/core/record.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 3, 12);

function round(overrides: Partial<PrRecord> = {}): PrRecord {
  const base = testRecord({
    pr: { owner: "o", repo: "r", number: 1 },
    channelId: "c",
    messageId: "m",
    messageTimestamp: T0,
    title: "t",
    prAuthorLogin: "a",
    isDraft: false,
  });
  return { ...base, roundStartedAt: T0, ...overrides };
}

describe("buildEntry", () => {
  it("rounds wait and review durations to 5 minutes and sums the total", () => {
    const entry = buildEntry(
      round({ roundFirstClaimedAt: T0 + 62 * MIN }),
      { outcome: "reviewed", doneAt: T0 + 181 * MIN },
      7,
      T0 + 200 * MIN,
    );
    expect(entry).toMatchObject({
      id: 7,
      week: "2026-W45",
      outcome: "reviewed",
      waitToClaimMs: 60 * MIN,
      claimToDoneMs: 120 * MIN,
      totalMs: 180 * MIN,
      claimed: true,
    });
  });

  it("leaves wait and review null for an unclaimed round", () => {
    const entry = buildEntry(
      round(),
      { outcome: "cleared", doneAt: T0 + 30 * MIN },
      0,
      T0 + 30 * MIN,
    );
    expect(entry?.waitToClaimMs).toBeNull();
    expect(entry?.claimToDoneMs).toBeNull();
    expect(entry?.claimed).toBe(false);
  });

  it("caps a claim recorded after the review at the done time, so wait never exceeds total", () => {
    // A reaction claim seen by a tick after the review had already landed.
    const entry = buildEntry(
      round({ roundFirstClaimedAt: T0 + 90 * MIN }),
      { outcome: "reviewed", doneAt: T0 + 30 * MIN },
      0,
      T0 + 120 * MIN,
    );
    expect(entry?.waitToClaimMs).toBe(30 * MIN);
    expect(entry?.totalMs).toBe(30 * MIN);
    expect(entry?.claimToDoneMs).toBe(0);
  });

  it("clamps a done time before the first claim to zero", () => {
    const entry = buildEntry(
      round({ roundFirstClaimedAt: T0 + 60 * MIN }),
      { outcome: "reviewed", doneAt: T0 + 30 * MIN },
      0,
      T0 + 90 * MIN,
    );
    expect(entry?.claimToDoneMs).toBe(0);
  });

  it("falls back to the recording time when doneAt is null or not finite", () => {
    const at = T0 + 60 * MIN;
    expect(
      buildEntry(round(), { outcome: "cleared", doneAt: null }, 0, at)?.totalMs,
    ).toBe(60 * MIN);
    expect(
      buildEntry(round(), { outcome: "cleared", doneAt: Number.NaN }, 0, at)
        ?.totalMs,
    ).toBe(60 * MIN);
  });

  it("returns null for a legacy round with no start time", () => {
    expect(
      buildEntry(
        round({ roundStartedAt: null }),
        { outcome: "cleared", doneAt: T0 },
        0,
        T0,
      ),
    ).toBeNull();
  });

  it("holds exactly the nine anonymous fields", () => {
    const entry = buildEntry(
      round(),
      { outcome: "cleared", doneAt: T0 },
      0,
      T0,
    );
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      [
        "claimToDoneMs",
        "claimed",
        "claimsDropped",
        "id",
        "outcome",
        "reRequests",
        "totalMs",
        "waitToClaimMs",
        "week",
      ].sort(),
    );
  });
});
