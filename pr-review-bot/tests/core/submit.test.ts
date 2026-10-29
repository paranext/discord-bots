import { describe, expect, it } from "vitest";
import { config } from "../../config/config.js";
import { collectValues, parseSubmission, NOTE_MAX_LENGTH, URL_MAX_LENGTH } from "../../src/core/submit.js";

// The shape Discord sends back for a Label-wrapped modal. The parser walks the
// tree rather than indexing it, so it survives Discord wrapping fields
// differently — which it has already done once, moving from action rows to labels.
function submitted(over: Partial<Record<string, string>> = {}) {
  const values = {
    url: "https://github.com/paranext/paranext-core/pull/9",
    team: "Power",
    urgency: "soon",
    note: "",
    ...over,
  };
  return [
    { type: 18, component: { type: 4, custom_id: "url", value: values["url"] } },
    { type: 18, component: { type: 3, custom_id: "team", values: [values["team"]] } },
    { type: 18, component: { type: 3, custom_id: "urgency", values: [values["urgency"]] } },
    { type: 18, component: { type: 4, custom_id: "note", value: values["note"] } },
  ];
}

describe("collectValues", () => {
  it("walks the tree, reading both text `value` and select `values`", () => {
    expect(collectValues(submitted())).toMatchObject({ url: expect.any(String), team: "Power", urgency: "soon" });
  });

  it("reads an action-row-wrapped payload identically", () => {
    const legacy = [{ type: 1, components: [{ type: 4, custom_id: "url", value: "https://x" }] }];
    expect(collectValues(legacy)["url"]).toBe("https://x");
  });

  it("returns an empty map rather than throwing on junk", () => {
    expect(collectValues(null)).toEqual({});
    expect(collectValues("nonsense")).toEqual({});
    expect(collectValues(42)).toEqual({});
  });

  it("does not blow the stack on a cyclic object", () => {
    // A self-referential payload — deliberately not something Discord sends,
    // but the tree walk must not throw (a stack overflow is a throw by another
    // name) on adversarial or corrupted input.
    const cyclic: Record<string, unknown> = { custom_id: "url", value: "https://x" };
    cyclic["component"] = cyclic;
    expect(collectValues(cyclic)).toEqual({ url: "https://x" });
  });

  it("does not blow the stack on a cyclic array", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(collectValues(cyclic)).toEqual({});
  });

  it("skips a component that carries a custom_id but neither a text value nor select values", () => {
    const node = { custom_id: "url" };
    expect(collectValues(node)).toEqual({});
  });

  it("skips a select whose values array is empty or holds a non-string", () => {
    expect(collectValues({ custom_id: "url", values: [] })).toEqual({});
    expect(collectValues({ custom_id: "url", values: [42] })).toEqual({});
  });
});

describe("parseSubmission", () => {
  it("accepts a well-formed submission on an allowlisted repo", () => {
    const result = parseSubmission(submitted(), config);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pr).toEqual({ owner: "paranext", repo: "paranext-core", number: 9 });
  });

  it("rejects a URL that is not a GitHub PR, carrying the specific parse failure", () => {
    const result = parseSubmission(submitted({ url: "https://github.com/paranext/paranext-core/issues/9" }), config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection).toEqual({ reason: "not-a-pr", detail: "is-issue" });
  });

  it("rejects a repo that is not on the allowlist, naming it", () => {
    const result = parseSubmission(submitted({ url: "https://github.com/someone/else/pull/1" }), config);
    if (!result.ok) expect(result.rejection).toEqual({ reason: "not-allowlisted", slug: "someone/else" });
    else expect.unreachable();
  });

  it("rejects a team no longer in config, rather than casting it through", () => {
    // Reachable with no forgery involved: a modal held open across a config
    // deploy that dropped or renamed a team, or (see the empty-string case
    // below) a select that never got a value at all.
    const result = parseSubmission(submitted({ team: "Retired Team" }), config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection).toEqual({ reason: "invalid-team" });
  });

  it("rejects an empty-string team the same way — a select with nothing chosen", () => {
    const result = parseSubmission(submitted({ team: "" }), config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection).toEqual({ reason: "invalid-team" });
  });

  it("rejects an urgency no longer in config, rather than silently skipping the note-required check", () => {
    const result = parseSubmission(submitted({ urgency: "yesterday" }), config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection).toEqual({ reason: "invalid-urgency" });
  });

  it("rejects blocking urgency with an empty note", () => {
    const result = parseSubmission(submitted({ urgency: "blocking" }), config);
    if (!result.ok) expect(result.rejection).toEqual({ reason: "note-required" });
    else expect.unreachable();
  });

  it("rejects blocking urgency with a whitespace-only note", () => {
    const result = parseSubmission(submitted({ urgency: "blocking", note: "   \n  " }), config);
    if (!result.ok) expect(result.rejection).toEqual({ reason: "note-required" });
    else expect.unreachable();
  });

  it("accepts blocking urgency with a real note", () => {
    expect(parseSubmission(submitted({ urgency: "blocking", note: "demo Thursday" }), config).ok).toBe(true);
  });

  it("defaults every field when the submission carries none of them", () => {
    const result = parseSubmission([], config);
    expect(result.ok).toBe(false);
    expect(result.values).toEqual({ url: "", team: "", urgency: "", note: "" });
  });

  it("returns the raw submitted values on every rejection, so the prefill hands back what was typed", () => {
    const result = parseSubmission(submitted({ url: "  not a url  ", note: "keep me" }), config);
    expect(result.ok).toBe(false);
    expect(result.values.url).toBe("  not a url  ");
    expect(result.values.note).toBe("keep me");
  });

  it("ignores a stray `prd` field from a modal opened before the PRD field was removed", () => {
    // A form opened on the old build and submitted on the new one still carries
    // the PRD select. The parser reads fields by key, so the extra one must make
    // no difference at all — not a rejection, and not an extra value.
    const stray = [
      ...submitted(),
      { type: 18, component: { type: 3, custom_id: "prd", values: ["1075535230087221248"] } },
    ];
    const withStray = parseSubmission(stray, config);
    const without = parseSubmission(submitted(), config);
    expect(withStray).toEqual(without);
    expect(withStray.ok).toBe(true);
    expect(Object.keys(withStray.values)).toEqual(["url", "team", "urgency", "note"]);
  });
});

/**
 * The caps the module comment calls "the trust boundary a stale or modified
 * client can't cross". The modal's `max_length` binds a well-behaved client;
 * these assert the parser binds every other one — and specifically that it binds
 * `values`, the copy `reject()` stashes in the single Durable Object state key.
 */
describe("parseSubmission — the length caps", () => {
  const longQuery = `?utm=${"x".repeat(URL_MAX_LENGTH)}`;

  it("rejects a URL over the cap rather than clamping and parsing it", () => {
    // Clamping first is the dangerous version: `.../pull/12345` cut to
    // `.../pull/1234` is a valid link to a DIFFERENT PR, so the bot would track
    // the wrong one and tell the user it worked.
    const url = `https://github.com/paranext/paranext-core/pull/9${longQuery}`;
    expect(url.length).toBeGreaterThan(URL_MAX_LENGTH);

    const result = parseSubmission(submitted({ url }), config);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.rejection).toEqual({ reason: "url-too-long" });
  });

  it("clamps the echoed URL to the cap, so the stash cannot carry the long one", () => {
    const url = `https://github.com/paranext/paranext-core/pull/9${longQuery}`;
    const result = parseSubmission(submitted({ url }), config);
    expect(result.values.url).toHaveLength(URL_MAX_LENGTH);
    expect(url.startsWith(result.values.url)).toBe(true);
  });

  it("clamps an over-long note on the REJECTED path, not only on the accepted one", () => {
    // The path that persists: a rejection stashes `values` verbatim. The
    // accepted path clamped the note already; this one did not, which is the
    // only path where an unbounded string reached storage.
    const note = "n".repeat(NOTE_MAX_LENGTH + 500);
    const result = parseSubmission(submitted({ url: "not a url", note }), config);
    expect(result.ok).toBe(false);
    expect(result.values.note).toHaveLength(NOTE_MAX_LENGTH);
  });

  it("leaves a URL and note at exactly the cap untouched", () => {
    // The boundary the two clamps must not eat into: `>` not `>=`.
    const pad = "x".repeat(URL_MAX_LENGTH - "https://github.com/paranext/paranext-core/pull/9?u=".length);
    const url = `https://github.com/paranext/paranext-core/pull/9?u=${pad}`;
    const note = "n".repeat(NOTE_MAX_LENGTH);
    expect(url).toHaveLength(URL_MAX_LENGTH);

    const result = parseSubmission(submitted({ url, note }), config);
    expect(result.ok).toBe(true);
    expect(result.values.url).toBe(url);
    expect(result.values.note).toBe(note);
  });
});
