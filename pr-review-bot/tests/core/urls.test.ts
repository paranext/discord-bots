import { describe, expect, it } from "vitest";
import { parsePrUrl, prSlug } from "../../src/core/urls.js";

describe("parsePrUrl", () => {
  it("parses a plain PR url", () => {
    expect(parsePrUrl("https://github.com/paranext/paranext-core/pull/2695")).toEqual({
      ok: true,
      pr: { owner: "paranext", repo: "paranext-core", number: 2695 },
    });
  });

  it.each([
    ["/files suffix", "https://github.com/paranext/paranext-core/pull/2695/files"],
    ["#discussion fragment", "https://github.com/paranext/paranext-core/pull/2695#discussion_r123"],
    ["trailing slash", "https://github.com/paranext/paranext-core/pull/2695/"],
    ["query string", "https://github.com/paranext/paranext-core/pull/2695?w=1"],
    ["commits tab", "https://github.com/paranext/paranext-core/pull/2695/commits/abc123"],
    ["http scheme", "http://github.com/paranext/paranext-core/pull/2695"],
    ["www host", "https://www.github.com/paranext/paranext-core/pull/2695"],
  ])("parses despite %s", (_label, url) => {
    const result = parsePrUrl(url);
    expect(result).toEqual({ ok: true, pr: { owner: "paranext", repo: "paranext-core", number: 2695 } });
  });

  it("rejects an issue url distinctly from a non-PR url", () => {
    expect(parsePrUrl("https://github.com/paranext/paranext-core/issues/2695")).toEqual({
      ok: false,
      reason: "is-issue",
    });
  });

  it.each([
    ["a repo root", "https://github.com/paranext/paranext-core", "not-a-pr"],
    ["a non-github host", "https://gitlab.com/paranext/core/-/merge_requests/7", "not-github"],
    ["prose", "please review my branch", "not-a-url"],
    ["an empty string", "", "not-a-url"],
    ["a non-numeric number", "https://github.com/paranext/paranext-core/pull/abc", "bad-number"],
    ["a bare owner with no repo segment", "https://github.com/paranext", "not-a-pr"],
    ["a pull path with no number segment", "https://github.com/paranext/paranext-core/pull", "not-a-pr"],
  ])("rejects %s as %s", (_label, url, reason) => {
    expect(parsePrUrl(url)).toEqual({ ok: false, reason });
  });
});

describe("prSlug", () => {
  it("lowercases so identity is stable across url casing", () => {
    expect(prSlug({ owner: "Paranext", repo: "Paranext-Core", number: 2695 })).toBe(
      "paranext/paranext-core/2695",
    );
  });
});
