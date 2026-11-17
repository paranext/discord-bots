import { describe, expect, it } from "vitest";
import { stableHash } from "../../src/core/hash.js";

describe("stableHash", () => {
  it("is stable across calls, so the write-skip is reliable", () => {
    expect(stableHash("Needs review · 4 open")).toBe(stableHash("Needs review · 4 open"));
  });

  it("differs for a one-character change", () => {
    expect(stableHash("4 open")).not.toBe(stableHash("5 open"));
  });

  it("handles emoji and the empty string without throwing", () => {
    expect(stableHash("🔥 Blocking")).toMatch(/^[0-9a-f]{8}$/);
    expect(stableHash("")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is synchronous — the renderer is pure and cannot await crypto.subtle", () => {
    const result: string = stableHash("x");
    expect(typeof result).toBe("string");
  });
});
