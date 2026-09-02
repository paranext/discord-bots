import { describe, expect, it, vi } from "vitest";
import { config } from "../../config/config.js";
import { newScannedRecord, recordId, type PrRecord } from "../../src/core/record.js";
import * as digestModule from "../../src/core/render/digest.js";
import { renderReviewList } from "../../src/handlers/reviewList.js";
import { emptyState } from "../../src/store/apply.js";
import type { StoreState } from "../../src/store/types.js";

const T0 = 1_788_192_000_000; // 2026-08-31T16:00:00Z = 11:00 America/Chicago

function record(number: number, overrides: { title?: string } = {}): PrRecord {
  return {
    ...newScannedRecord({
      pr: { owner: "paranext", repo: "paranext-core", number },
      channelId: "c",
      messageId: `m-${number}`,
      messageTimestamp: T0 - 86_400_000,
      title: overrides.title ?? `PT-${number} A change`,
      prAuthorLogin: "jolie",
      isDraft: false,
    }),
    team: "Power",
    urgency: "soon",
  };
}

function state(records: PrRecord[]): StoreState {
  const base = emptyState();
  return {
    ...base,
    records: Object.fromEntries(records.map((r) => [recordId(r), r])),
    meta: { ...base.meta, lastSync: T0 - 60_000 },
  };
}

/** The whole reply, as a reader sees it — deliberately surface-agnostic, so the
 *  tests below fail on WHAT the reply says rather than on which field it used.
 *  A body() that read only embeds would make every content-based regression
 *  fail vacuously against an empty string. */
function body(response: ReturnType<typeof renderReviewList>): string {
  const embeds = (response.data?.embeds ?? []).map((e) => e.description).join("\n");
  return [response.data?.content ?? "", embeds].filter((part) => part !== "").join("\n");
}

describe("renderReviewList", () => {
  it("is always ephemeral", () => {
    const response = renderReviewList(state([record(1)]), config, T0);
    expect(response.data?.flags).toBe(64);
  });

  it("carries embeds, not a 2000-character plain message", () => {
    // The digest is an embed precisely because plain content caps at 2000. A
    // reply advertised by the digest's own overflow notice as the way to "see
    // everything" cannot be built on the surface the digest had to escape.
    const response = renderReviewList(state([record(1)]), config, T0);
    expect(response.data?.content).toBeUndefined();
    expect(response.data?.embeds?.length).toBeGreaterThan(0);
  });

  it("shows more rows than the digest's own cap, with the same records", () => {
    const many = Array.from({ length: 40 }, (_, i) => record(i + 1));
    const digest = digestModule.renderDigest({ records: many, lastSync: T0 - 60_000, now: T0, config });
    const shown = body(renderReviewList(state(many), config, T0));
    const visible = many.filter((r) => shown.includes(`PT-${r.number} `)).length;

    // Premise: the digest really did have to drop rows for this input.
    expect(digest.droppedCount).toBeGreaterThan(0);
    expect(visible).toBeGreaterThan(digest.renderedCount);
    expect(visible).toBe(40);
  });

  it("never cuts inside a markdown link", () => {
    // The old 2000-character slice landed mid-URL, so the last row rendered as
    // broken syntax. Row-boundary packing means every `[title](url)` in the
    // output is complete.
    const many = Array.from({ length: 200 }, (_, i) => record(i + 1));
    const shown = body(renderReviewList(state(many), config, T0));

    // No dangling `(https://…` at the end of the text, and every opened link is
    // closed. Asserted BEFORE the premise below so a regression fails on the
    // broken link itself rather than on a differently-worded cut notice.
    expect(shown).not.toMatch(/\(https:\/\/[^)]*$/);
    expect(shown.split("](https://github.com/").length - 1).toBe(shown.split("[PT-").length - 1);
    // Premise: this input really does exceed the budget, so something had to be
    // cut and the reply has to say so.
    expect(shown).toMatch(/more|truncated/i);
  });

  it("passes maxRows: 200 to renderDigest so the digest's own 20-row cap cannot hide anything", () => {
    // A string-content assertion cannot prove this: at this render's per-row
    // overhead (a link, a relative timestamp, a repo#number line), 21 rows —
    // one past DEFAULT_MAX_ROWS — already exceeds Discord's 2000-character
    // message limit on its own (confirmed by direct measurement: 21 rows of a
    // one-character title run ~2060 characters). So ANY test built around "more
    // than 20 rows AND under 2000 characters AND no truncation marker" is
    // unsatisfiable regardless of whether the maxRows override is wired up —
    // it would fail (for the wrong reason: message-length truncation, not the
    // digest's row cap) whether or not this handler ever passes an override.
    // Spying on the call is the only assertion that isolates the one thing
    // this handler is responsible for: which maxRows value it hands to
    // renderDigest. Deleting `maxRows: 200` from reviewList.ts makes this fail.
    const spy = vi.spyOn(digestModule, "renderDigest");
    const many = Array.from({ length: 25 }, (_, i) => record(i + 1, { title: "x" }));
    renderReviewList(state(many), config, T0);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ maxRows: 200 }));

    // And confirm the premise: without that override, the digest's own cap
    // really would have dropped rows for this same input.
    const withoutOverride = digestModule.renderDigest({
      records: many,
      lastSync: T0 - 60_000,
      now: T0,
      config,
    });
    expect(withoutOverride.droppedCount).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it("stays inside Discord's embed limits and says what it could not show", () => {
    const many = Array.from({ length: 200 }, (_, i) => record(i + 1));
    const response = renderReviewList(state(many), config, T0);
    const embeds = response.data?.embeds ?? [];
    for (const embed of embeds) {
      expect(embed.description.length).toBeLessThanOrEqual(4096);
    }
    expect(embeds.reduce((sum, e) => sum + e.description.length, 0)).toBeLessThanOrEqual(6000);
    expect(body(response)).toMatch(/more/i);
  });

  it("reports the empty state rather than an empty message", () => {
    const response = renderReviewList(state([]), config, T0);
    expect(body(response)).toContain("nothing waiting");
  });

  it("carries the stale banner when the store is stale", () => {
    const stale = state([record(1)]);
    const response = renderReviewList({ ...stale, meta: { ...stale.meta, lastSync: T0 - 47 * 60_000 } }, config, T0);
    expect(body(response)).toContain("Not syncing");
  });
});
