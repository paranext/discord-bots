import { describe, expect, it } from "vitest";
import { config } from "../../../config/config.js";
import { renderRejection, RETRY_PREFIX, retryCustomId } from "../../../src/core/render/rejection.js";
import { URL_MAX_LENGTH, type SubmittedValues } from "../../../src/core/submit.js";

const values: SubmittedValues = {
  url: "https://github.com/someone/else/pull/1",
  team: "Power",
  urgency: "blocking",
  note: "demo Thursday",
};

function render(rejection: Parameters<typeof renderRejection>[0]["rejection"], stashKey: string | null = "i-1") {
  return renderRejection({ rejection, values, stashKey, config });
}

describe("renderRejection", () => {
  it("names the unlisted repo and points at the file that would allow it", () => {
    const { content } = render({ reason: "not-allowlisted", slug: "someone/else" });
    expect(content).toContain("someone/else");
    expect(content).toContain("config/config.ts");
  });

  it("shows the expected URL shape when the link is not a PR", () => {
    expect(render({ reason: "not-a-pr", detail: "is-issue" }).content).toContain(
      "https://github.com/owner/repo/pull/123",
    );
  });

  it("says which of merged and closed happened", () => {
    expect(render({ reason: "merged" }).content).toContain("merged");
    expect(render({ reason: "closed" }).content).toContain("closed");
    expect(render({ reason: "merged" }).content).not.toContain("closed");
  });

  it("distinguishes a credential failure from a missing PR, since the fixes differ", () => {
    const missing = render({ reason: "not-found", slug: "paranext/paranext-core" }).content;
    const credential = render({ reason: "credential", slug: "paranext/paranext-core" }).content;
    expect(missing).not.toBe(credential);
    expect(credential).toContain("credential");
  });

  it("does not promise to tell apart a private PR from a missing one", () => {
    // GitHub returns NOT_FOUND for both; a message that guessed would be worse
    // than one that names both fixes.
    const { content } = render({ reason: "not-found", slug: "paranext/paranext-core" });
    expect(content).toContain("does not exist");
    expect(content).toContain("cannot see");
  });

  it("lists the current teams when the chosen one is gone, since the form may predate the change", () => {
    const { content } = render({ reason: "invalid-team" });
    for (const team of config.teams) expect(content).toContain(team);
  });

  it("lists the current urgencies, with their emoji, when the chosen one is gone", () => {
    const { content } = render({ reason: "invalid-urgency" });
    for (const level of config.urgencies) expect(content).toContain(level.label);
    expect(content).toContain(config.urgencies[0]!.emoji);
  });

  it("names the URL cap and says the link was not shortened for the user", () => {
    // The "not shortened" half is the part that matters: a truncated link can
    // still resolve to a real but different PR, so the parser refuses rather
    // than guessing, and the message has to explain why it did not just fix it.
    const { content } = render({ reason: "url-too-long" });
    expect(content).toContain(String(URL_MAX_LENGTH));
    expect(content).toContain("different");
  });

  it("says the note is required for blocking, and why the modal could not", () => {
    expect(render({ reason: "note-required" }).content).toContain("🔥");
  });

  it("echoes the submitted values inline so a late-returning user can copy them", () => {
    const { content } = render({ reason: "merged" });
    expect(content).toContain("https://github.com/someone/else/pull/1");
    expect(content).toContain("demo Thursday");
    expect(content).toContain("Power");
  });

  it("omits the Note line when the note is blank, but still echoes link, team and urgency", () => {
    const { content } = renderRejection({
      rejection: { reason: "merged" },
      values: { ...values, note: "" },
      stashKey: "i-1",
      config,
    });
    expect(content).not.toContain("**Note:**");
    expect(content).toContain("https://github.com/someone/else/pull/1");
    expect(content).toContain("Power");
    expect(content).toContain("blocking");
  });

  it("omits the Note line when the note is whitespace-only", () => {
    const { content } = renderRejection({
      rejection: { reason: "merged" },
      values: { ...values, note: "   \n  " },
      stashKey: "i-1",
      config,
    });
    expect(content).not.toContain("**Note:**");
    expect(content).toContain("https://github.com/someone/else/pull/1");
    expect(content).toContain("Power");
    expect(content).toContain("blocking");
  });

  it("carries a Fix and retry button whose custom_id is the stash key", () => {
    const { components } = render({ reason: "merged" }, "abc123");
    const row = components[0] as { components: { custom_id: string; label: string; type: number }[] };
    expect(row.components[0]!.custom_id).toBe(`${RETRY_PREFIX}abc123`);
    expect(row.components[0]!.label).toBe("Fix and retry");
    expect(row.components[0]!.custom_id.length).toBeLessThanOrEqual(100);
  });

  it("omits the button entirely when nothing was stashed", () => {
    expect(render({ reason: "merged" }, null).components).toEqual([]);
  });

  it("is an alarm if a field clamp is raised or a field is added to the echo", () => {
    // Every echoed field (url, team, urgency, note) is clamped individually at
    // the source in rejection.ts — these per-field clamps are what keep the
    // message under Discord's 2000-character limit. Every field below is driven
    // past its own clamp so that widening or dropping any single clamp would
    // move content.length and trip this test. WORST_CASE_BOUND is the measured
    // worst case (1565 with all clamps applied, since one echoed field was
    // removed) plus a margin — it is the alarm if a field clamp is raised,
    // a field is added to the echo, or the headline is significantly expanded.
    const WORST_CASE_BOUND = 1645;
    const { content } = renderRejection({
      rejection: { reason: "not-allowlisted", slug: "x".repeat(900) },
      values: {
        url: "u".repeat(900),
        team: "t".repeat(900),
        urgency: "g".repeat(900),
        note: "n".repeat(900),
      },
      stashKey: "i-1",
      config,
    });
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content.length).toBeLessThanOrEqual(WORST_CASE_BOUND);
  });
});

describe("retryCustomId", () => {
  it("prefixes the interaction id", () => {
    expect(retryCustomId("i-1")).toBe("request:retry:i-1");
  });
});

describe("renderRejection — a level with no emoji", () => {
  const noEmoji = {
    ...config,
    urgencies: config.urgencies.map((u) => (u.key === "soon" ? { ...u, emoji: null } : u)),
  };

  it("lists a no-emoji level by its bare label, with no leading space", () => {
    const { content } = renderRejection({
      rejection: { reason: "invalid-urgency" },
      values,
      stashKey: "i-1",
      config: noEmoji,
    });
    expect(content).toContain("🔥 Blocking, Soon, 🧊");
  });
});
