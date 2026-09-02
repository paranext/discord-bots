import { describe, expect, it } from "vitest";
import { extractPrUrls, isAllowlisted, parsePrUrl, prSlug } from "../../src/core/urls.js";

const ALLOW = ["paranext/paranext-core", "eten-tech-foundation/scripture-editors"];

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

describe("isAllowlisted", () => {
  it("accepts a listed repo", () => {
    expect(isAllowlisted({ owner: "paranext", repo: "paranext-core", number: 1 }, ALLOW)).toBe(true);
  });

  it("rejects an unlisted repo in a listed org", () => {
    expect(isAllowlisted({ owner: "paranext", repo: "some-experiment", number: 1 }, ALLOW)).toBe(false);
  });

  it("matches case-insensitively, because GitHub does", () => {
    expect(isAllowlisted({ owner: "Paranext", repo: "Paranext-Core", number: 1 }, ALLOW)).toBe(true);
  });
});

describe("prSlug", () => {
  it("lowercases so identity is stable across url casing", () => {
    expect(prSlug({ owner: "Paranext", repo: "Paranext-Core", number: 2695 })).toBe(
      "paranext/paranext-core/2695",
    );
  });
});

describe("extractPrUrls", () => {
  it("finds every PR link in a chat message", () => {
    const text =
      "these two need eyes: https://github.com/paranext/paranext-core/pull/177 and " +
      "https://github.com/eten-tech-foundation/scripture-editors/pull/341 thanks!";
    expect(extractPrUrls(text)).toEqual([
      { owner: "paranext", repo: "paranext-core", number: 177 },
      { owner: "eten-tech-foundation", repo: "scripture-editors", number: 341 },
    ]);
  });

  it("deduplicates the same PR mentioned twice", () => {
    const text = "pull/177 again: https://github.com/paranext/paranext-core/pull/177 " +
      "https://github.com/paranext/paranext-core/pull/177/files";
    expect(extractPrUrls(text)).toHaveLength(1);
  });

  it("ignores issue links and returns an empty array for prose", () => {
    expect(extractPrUrls("see https://github.com/paranext/paranext-core/issues/9")).toEqual([]);
    expect(extractPrUrls("no links here")).toEqual([]);
  });

  it("ignores surrounding parentheses", () => {
    expect(extractPrUrls("(https://github.com/paranext/paranext-core/pull/177)")).toEqual([
      { owner: "paranext", repo: "paranext-core", number: 177 },
    ]);
  });

  it.each([
    ["period at end of sentence", "see https://github.com/paranext/paranext-core/pull/177."],
    ["comma in a list", "https://github.com/paranext/paranext-core/pull/177, and the other one"],
    ["semicolon separator", "check this: https://github.com/paranext/paranext-core/pull/177; also that one"],
    ["colon after url", "review https://github.com/paranext/paranext-core/pull/177: thanks"],
    ["exclamation mark", "see https://github.com/paranext/paranext-core/pull/177! now"],
    ["question mark", "look at https://github.com/paranext/paranext-core/pull/177? yes"],
  ])("strips trailing %s", (_label, text) => {
    expect(extractPrUrls(text)).toEqual([
      { owner: "paranext", repo: "paranext-core", number: 177 },
    ]);
  });
});
