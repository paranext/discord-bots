import { describe, expect, it } from "vitest";
import { config } from "../../config/config.js";
import type { Config } from "../../config/config.js";
import { buildRequestModal } from "../../src/handlers/modal.js";
import { FIELD_IDS, MODAL_ID, NOTE_MAX_LENGTH, PRD_NONE, URL_MAX_LENGTH } from "../../src/core/submit.js";
import type { PrdCache } from "../../src/core/prd.js";

const T0 = 1_756_000_000_000;

function cache(count: number, truncated = false): PrdCache {
  return {
    options: Array.from({ length: count }, (_, i) => ({ id: `t-${i}`, name: `PRD ${i}` })),
    truncated,
    refreshedAt: T0,
  };
}

// The payload is a nested tree; these read one field out of it by custom_id.
function field(response: ReturnType<typeof buildRequestModal>, id: string) {
  const labels = (response.data?.components ?? []) as { label: string; description?: string; component: Record<string, unknown> }[];
  return labels.find((l) => l.component["custom_id"] === id)!;
}

describe("buildRequestModal", () => {
  it("is a callback type 9 with the modal's custom_id and exactly five components", () => {
    const modal = buildRequestModal(config, cache(3));
    expect(modal.type).toBe(9);
    expect(modal.data?.custom_id).toBe(MODAL_ID);
    expect(modal.data?.components).toHaveLength(5);
  });

  it("wraps every input in a Label (type 18) — string selects are invalid in an action row in modals", () => {
    const modal = buildRequestModal(config, cache(3));
    const labels = modal.data?.components as { type: number }[];
    expect(labels.every((l) => l.type === 18)).toBe(true);
  });

  it("offers None plus the cached threads, never more than 25 options in total", () => {
    const prd = field(buildRequestModal(config, cache(24, true)), FIELD_IDS.prd);
    const options = prd.component["options"] as { value: string }[];
    expect(options).toHaveLength(25);
    expect(options[0]!.value).toBe(PRD_NONE);
  });

  it("says the list is truncated in the PRD label's description", () => {
    const prd = field(buildRequestModal(config, cache(24, true)), FIELD_IDS.prd);
    expect(prd.description).toContain("most recent");
  });

  it("offers only None on a cold cache and says the list is still loading", () => {
    const prd = field(buildRequestModal(config, null), FIELD_IDS.prd);
    expect(prd.component["options"]).toHaveLength(1);
    expect(prd.description).toContain("still loading");
  });

  it("puts the note requirement on the blocking urgency OPTION, not on the note field", () => {
    const modal = buildRequestModal(config, cache(3));
    const urgency = field(modal, FIELD_IDS.urgency);
    const blocking = (urgency.component["options"] as { value: string; description?: string }[]).find(
      (o) => o.value === "blocking",
    );
    expect(blocking?.description).toContain("note");
    // `required` is static in the payload Discord renders before any choice is
    // made, so the note field itself must stay optional and the rule is enforced
    // on submit.
    expect(field(modal, FIELD_IDS.note).component["required"]).toBe(false);
  });

  it("prefills the text inputs and marks the chosen select options default", () => {
    const modal = buildRequestModal(config, cache(3), {
      url: "https://github.com/paranext/paranext-core/pull/9",
      team: "Simple",
      urgency: "blocking",
      prdThreadId: "t-1",
      note: "just the CSS bit",
    });
    expect(field(modal, FIELD_IDS.url).component["value"]).toBe("https://github.com/paranext/paranext-core/pull/9");
    expect(field(modal, FIELD_IDS.note).component["value"]).toBe("just the CSS bit");
    const team = (field(modal, FIELD_IDS.team).component["options"] as { value: string; default?: boolean }[]).find(
      (o) => o.value === "Simple",
    );
    expect(team?.default).toBe(true);
    const urgency = (
      field(modal, FIELD_IDS.urgency).component["options"] as { value: string; default?: boolean }[]
    ).find((o) => o.value === "blocking");
    expect(urgency?.default).toBe(true);
    const prd = (field(modal, FIELD_IDS.prd).component["options"] as { value: string; default?: boolean }[]).find(
      (o) => o.value === "t-1",
    );
    expect(prd?.default).toBe(true);
  });

  it("carries a prefilled PRD back even when it has dropped out of the cache", () => {
    // The retry path promises every field comes back exactly as typed. A thread
    // that fell below the 24-option cap (or a cache that went cold) between the
    // rejection and the button press used to match no option at all: nothing was
    // defaulted, None was the only thing left to pick, and the PRD was silently
    // lost on a form the user was told was prefilled.
    const prd = field(buildRequestModal(config, cache(3), {
      url: "https://github.com/paranext/paranext-core/pull/9",
      team: "Simple",
      urgency: "soon",
      prdThreadId: "t-gone",
      note: "",
    }), FIELD_IDS.prd);
    const options = prd.component["options"] as { value: string; default?: boolean }[];
    expect(options.find((o) => o.value === "t-gone")?.default).toBe(true);
  });

  it("stays inside Discord's 25-option limit when a dropped PRD is carried back onto a full cache", () => {
    const prd = field(buildRequestModal(config, cache(24, true), {
      url: "https://github.com/paranext/paranext-core/pull/9",
      team: "Simple",
      urgency: "soon",
      prdThreadId: "t-gone",
      note: "",
    }), FIELD_IDS.prd);
    const options = prd.component["options"] as { value: string; default?: boolean }[];
    expect(options).toHaveLength(25);
    // The carried-back thread survives; the least recently active cached one is
    // what gives up its slot, because it is the one nobody in this interaction
    // has chosen.
    expect(options.map((o) => o.value)).toContain("t-gone");
    expect(options.map((o) => o.value)).not.toContain("t-23");
  });

  it("marks None default when the prefill carries no PRD thread", () => {
    const modal = buildRequestModal(config, cache(3), {
      url: "https://github.com/paranext/paranext-core/pull/9",
      team: "Simple",
      urgency: "soon",
      prdThreadId: null,
      note: "",
    });
    const none = (field(modal, FIELD_IDS.prd).component["options"] as { value: string; default?: boolean }[]).find(
      (o) => o.value === PRD_NONE,
    );
    expect(none?.default).toBe(true);
  });

  it("declares Discord's own max_length on the URL and note inputs", () => {
    // Discord's text input accepts up to 4000 characters with no cap declared,
    // which is what let a rejection's stashed note or URL threaten the retry
    // stash's 128 KiB Durable Object value and the digest's per-row render
    // budget. This is the client-side half of the fix — the record write in
    // `reviewRequest.ts` is the trust boundary the modal alone cannot be.
    const modal = buildRequestModal(config, cache(3));
    expect(field(modal, FIELD_IDS.url).component["max_length"]).toBe(URL_MAX_LENGTH);
    expect(field(modal, FIELD_IDS.note).component["max_length"]).toBe(NOTE_MAX_LENGTH);
  });

  it("clamps every string to its documented cap", () => {
    // Drives a genuinely long string into every position that CAN be driven
    // long through the public parameters: config's team/urgency entries feed
    // the Team and Urgency selects' option label/value, and the PRD cache
    // feeds the PRD select's option label/value directly (id is never
    // reclamped upstream — this builder is the only place that caps it).
    // `title`, every field's Label.label, every Label.description, and the
    // urgency option's "requires a note" description are all fixed literals
    // in the implementation, disconnected from any parameter, so no input can
    // drive THEM over cap — the walk below still asserts their caps so a
    // future change to one of those literals is caught, even though it can't
    // be produced by deleting a clamp() call in this test run.
    const longConfig: Config = {
      ...config,
      teams: ["T".repeat(400) as unknown as Config["teams"][number]],
      urgencies: [
        {
          key: "blocking",
          emoji: "🔥",
          label: "L".repeat(400),
          rank: 0,
          requiresNote: true,
        },
      ],
    };
    const longPrd: PrdCache = {
      options: [{ id: "i".repeat(400), name: "n".repeat(400) }],
      truncated: false,
      refreshedAt: T0,
    };
    const modal = buildRequestModal(longConfig, longPrd, {
      url: "u".repeat(5000),
      team: "Power",
      urgency: "soon",
      prdThreadId: null,
      note: "x".repeat(5000),
    });

    expect((modal.data?.title ?? "").length).toBeLessThanOrEqual(45);

    const labels = (modal.data?.components ?? []) as {
      label: string;
      description?: string;
      component: Record<string, unknown>;
    }[];
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) {
      expect(l.label.length).toBeLessThanOrEqual(45);
      expect((l.description ?? "").length).toBeLessThanOrEqual(100);

      const options = l.component["options"] as
        | { label: string; value: string; description?: string }[]
        | undefined;
      if (options) {
        expect(options.length).toBeGreaterThan(0);
        for (const o of options) {
          expect(o.label.length).toBeLessThanOrEqual(100);
          expect(o.value.length).toBeLessThanOrEqual(100);
          expect((o.description ?? "").length).toBeLessThanOrEqual(100);
        }
      }

      const value = l.component["value"];
      if (typeof value === "string") {
        expect(value.length).toBeLessThanOrEqual(4000);
      }
    }
  });
});
