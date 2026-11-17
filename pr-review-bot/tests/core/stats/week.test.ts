import { describe, expect, it } from "vitest";
import { isoWeek, shiftWeek, weekEndMs, weekStartMs } from "../../../src/core/stats/week.js";

describe("isoWeek", () => {
  it("names a mid-week day", () => {
    expect(isoWeek(Date.UTC(2026, 10, 3, 12))).toBe("2026-W45");
  });

  it("starts a week at Monday 00:00 UTC", () => {
    expect(isoWeek(Date.UTC(2026, 10, 2, 0))).toBe("2026-W45");
  });

  it("keeps Sunday night in the previous week", () => {
    expect(isoWeek(Date.UTC(2026, 10, 1, 23, 59))).toBe("2026-W44");
  });

  it("rolls late December into week 1 of the next ISO year", () => {
    expect(isoWeek(Date.UTC(2024, 11, 31))).toBe("2025-W01");
  });

  it("keeps early January in week 53 of a 53-week year", () => {
    expect(isoWeek(Date.UTC(2027, 0, 1))).toBe("2026-W53");
  });
});

describe("weekStartMs / weekEndMs", () => {
  it("starts on Monday 00:00 UTC", () => {
    expect(weekStartMs("2026-W45")).toBe(Date.UTC(2026, 10, 2));
  });

  it("ends seven days after the start", () => {
    expect(weekEndMs("2026-W45")).toBe(Date.UTC(2026, 10, 9));
  });

  it("round-trips through isoWeek", () => {
    expect(isoWeek(weekStartMs("2026-W53"))).toBe("2026-W53");
    expect(isoWeek(weekEndMs("2026-W53") - 1)).toBe("2026-W53");
  });
});

describe("shiftWeek", () => {
  it("crosses a 53-week year forwards", () => {
    expect(shiftWeek("2026-W53", 1)).toBe("2027-W01");
  });

  it("crosses a year boundary backwards", () => {
    expect(shiftWeek("2025-W01", -1)).toBe("2024-W52");
  });

  it("zero-pads so string order is chronological order", () => {
    expect(shiftWeek("2026-W09", 1) > "2026-W09").toBe(true);
  });
});
