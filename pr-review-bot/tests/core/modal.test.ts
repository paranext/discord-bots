import { describe, expect, it } from "vitest";
import { config } from "../../config/config.js";
import type { Config } from "../../config/config.js";
import { buildRequestModal } from "../../src/handlers/modal.js";
import { FIELD_IDS, MODAL_ID, NOTE_MAX_LENGTH, URL_MAX_LENGTH } from "../../src/core/submit.js";

// The payload is a nested tree; these read one field out of it by custom_id.
function field(response: ReturnType<typeof buildRequestModal>, id: string) {
  const labels = (response.data?.components ?? []) as { label: string; description?: string; component: Record<string, unknown> }[];
  return labels.find((l) => l.component["custom_id"] === id)!;
}

function customIds(response: ReturnType<typeof buildRequestModal>): unknown[] {
  return ((response.data?.components ?? []) as { component: Record<string, unknown> }[]).map((l) => l.component["custom_id"]);
}

const PREFILL = {
  url: "https://github.com/paranext/paranext-core/pull/9",
  team: "Simple",
  urgency: "blocking",
  note: "just the CSS bit",
};

describe("buildRequestModal", () => {
  it("is a callback type 9 with the modal's custom_id and exactly four components", () => {
    const modal = buildRequestModal(config);
    expect(modal.type).toBe(9);
    expect(modal.data?.custom_id).toBe(MODAL_ID);
    expect(modal.data?.components).toHaveLength(4);
  });

  it("has no PRD field, fresh or prefilled — the PRD forum lived on a server the bot no longer reaches", () => {
    expect(customIds(buildRequestModal(config))).toEqual(["url", "team", "urgency", "note"]);
    expect(customIds(buildRequestModal(config, PREFILL))).toEqual(["url", "team", "urgency", "note"]);
  });

  it("wraps every input in a Label (type 18) — string selects are invalid in an action row in modals", () => {
    const modal = buildRequestModal(config);
    const labels = modal.data?.components as { type: number }[];
    expect(labels.every((l) => l.type === 18)).toBe(true);
  });

  it("puts the note requirement on the blocking urgency OPTION, not on the note field", () => {
    const modal = buildRequestModal(config);
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
    const modal = buildRequestModal(config, PREFILL);
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
  });

  it("declares Discord's own max_length on the URL and note inputs", () => {
    // Discord's text input accepts up to 4000 characters with no cap declared,
    // which is what let a rejection's stashed note or URL threaten the retry
    // stash's 128 KiB Durable Object value and the digest's per-row render
    // budget. This is the client-side half of the fix — the record write in
    // `reviewRequest.ts` is the trust boundary the modal alone cannot be.
    const modal = buildRequestModal(config);
    expect(field(modal, FIELD_IDS.url).component["max_length"]).toBe(URL_MAX_LENGTH);
    expect(field(modal, FIELD_IDS.note).component["max_length"]).toBe(NOTE_MAX_LENGTH);
  });

  it("clamps every string to its documented cap", () => {
    // Drives a genuinely long string into every position that CAN be driven
    // long through the public parameters: config's team/urgency entries feed
    // the Team and Urgency selects' option label/value, and the prefill feeds
    // the text inputs. `title`, every field's Label.label, every
    // Label.description, and the urgency option's "requires a note"
    // description are all fixed literals in the implementation, disconnected
    // from any parameter, so no input can drive THEM over cap — the walk below
    // still asserts their caps so a future change to one of those literals is
    // caught.
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
    const modal = buildRequestModal(longConfig, {
      url: "u".repeat(5000),
      team: "Power",
      urgency: "soon",
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

describe("buildRequestModal — urgency option labels", () => {
  const noEmoji: Config = {
    ...config,
    urgencies: config.urgencies.map((u) => (u.key === "soon" ? { ...u, emoji: null } : u)),
  };

  function urgencyOptions(cfg: Config) {
    return field(buildRequestModal(cfg), FIELD_IDS.urgency).component["options"] as {
      value: string;
      label: string;
    }[];
  }

  it("labels a no-emoji level with its bare label, with no leading space", () => {
    expect(urgencyOptions(noEmoji).find((o) => o.value === "soon")?.label).toBe("Soon");
  });

  it("keeps the emoji on levels that have one", () => {
    expect(urgencyOptions(noEmoji).find((o) => o.value === "blocking")?.label).toBe("🔥 Blocking");
  });

  it("derives the note hint from the level that requires one, rather than hardcoding it", () => {
    // A hardcoded "🔥 Blocking" in the hint goes stale the moment that level's
    // emoji or label changes — which is exactly what this branch does.
    const renamed: Config = {
      ...config,
      urgencies: config.urgencies.map((u) => (u.requiresNote ? { ...u, emoji: "🚨", label: "Urgent" } : u)),
    };
    expect(field(buildRequestModal(renamed), FIELD_IDS.note).description).toContain("🚨 Urgent");
  });
});
