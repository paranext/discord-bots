import { describe, expect, it } from "vitest";
import { applySnapshotWithExit, countsAsReview, exitVerdict, type PrSnapshot, type ReviewEvent } from "../../src/core/exit.js";
import { resolveRecord, type PrRecord } from "../../src/core/record.js";
import { testRecord } from "../../fixtures/records.js";

const T0 = 1_756_000_000_000;
const HOUR = 3_600_000;

function record(overrides: Partial<PrRecord> = {}): PrRecord {
  const base = testRecord({
    pr: { owner: "paranext", repo: "paranext-core", number: 2695 },
    channelId: "chan",
    messageId: "msg",
    messageTimestamp: T0,
    title: "PT-4363",
    prAuthorLogin: "jolie",
    isDraft: false,
  });
  return { ...base, ...overrides };
}

function review(overrides: Partial<ReviewEvent> = {}): ReviewEvent {
  return { submittedAt: T0 + HOUR, state: "APPROVED", authorLogin: "katherine", authorIsBot: false, ...overrides };
}

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    slug: "paranext/paranext-core/2695",
    title: "PT-4363",
    state: "OPEN",
    merged: false,
    isDraft: false,
    authorLogin: "jolie",
    reviews: [],
    mergedAt: null,
    closedAt: null,
    ...overrides,
  };
}

describe("countsAsReview", () => {
  it("counts an APPROVED review by someone else after the request", () => {
    expect(countsAsReview(review(), "jolie", T0)).toBe(true);
  });

  it("counts a COMMENTED review — fifteen line comments is unambiguously a look", () => {
    expect(countsAsReview(review({ state: "COMMENTED" }), "jolie", T0)).toBe(true);
  });

  it("counts CHANGES_REQUESTED", () => {
    expect(countsAsReview(review({ state: "CHANGES_REQUESTED" }), "jolie", T0)).toBe(true);
  });

  it("counts a DISMISSED review — someone reviewed and it was later dismissed", () => {
    // countsAsReview ignores state entirely; the spec says any state counts.
    expect(countsAsReview(review({ state: "DISMISSED" }), "jolie", T0)).toBe(true);
  });

  it("does not count a review older than the request", () => {
    expect(countsAsReview(review({ submittedAt: T0 - HOUR }), "jolie", T0)).toBe(false);
  });

  it("does not count a review exactly at the request time", () => {
    expect(countsAsReview(review({ submittedAt: T0 }), "jolie", T0)).toBe(false);
  });

  it("does not count a PENDING review with a null submittedAt", () => {
    expect(countsAsReview(review({ submittedAt: null, state: "PENDING" }), "jolie", T0)).toBe(false);
  });

  it("rejects a null submittedAt even against a since that a coerced null would satisfy", () => {
    // null <= -1 is false, so if the null check were removed this would fall
    // through to the timestamp comparison and wrongly return true.
    expect(countsAsReview(review({ submittedAt: null, state: "PENDING" }), "jolie", -1)).toBe(false);
  });

  it("positive control: a real timestamp after since does count against that same since", () => {
    // Proves the previous case's `false` comes from the null check, not from
    // some other reason every input against since: -1 returns false.
    expect(countsAsReview(review({ submittedAt: 1 }), "jolie", -1)).toBe(true);
  });

  it("does not count a review whose author login ends in [bot]", () => {
    expect(countsAsReview(review({ authorLogin: "copilot-pull-request-reviewer[bot]" }), "jolie", T0)).toBe(false);
  });

  it("does not count a review flagged as a Bot by __typename even with a plain login", () => {
    expect(countsAsReview(review({ authorLogin: "coderabbitai", authorIsBot: true }), "jolie", T0)).toBe(false);
  });

  it("does not count the PR author reviewing their own PR", () => {
    expect(countsAsReview(review({ authorLogin: "jolie" }), "jolie", T0)).toBe(false);
  });

  it("compares the author case-insensitively, because GitHub logins are", () => {
    expect(countsAsReview(review({ authorLogin: "Jolie" }), "jolie", T0)).toBe(false);
  });

  it("counts a review with a null author when the PR author is known", () => {
    // A deleted account still submitted a real review; dropping it would strand the row.
    expect(countsAsReview(review({ authorLogin: null }), "jolie", T0)).toBe(true);
  });
});

describe("exitVerdict", () => {
  it("resolves on a qualifying review, naming the reviewer", () => {
    const v = exitVerdict(record(), snapshot({ reviews: [review()] }));
    expect(v).toMatchObject({ resolve: true, resolvedBy: "review by katherine" });
  });

  it("resolves when merged", () => {
    expect(exitVerdict(record(), snapshot({ state: "MERGED", merged: true }))).toMatchObject({
      resolve: true,
      resolvedBy: "merged",
    });
  });

  it("resolves when closed unmerged", () => {
    expect(exitVerdict(record(), snapshot({ state: "CLOSED" }))).toMatchObject({
      resolve: true,
      resolvedBy: "closed",
    });
  });

  it("does not resolve an open PR with only a bot review", () => {
    const v = exitVerdict(record(), snapshot({ reviews: [review({ authorLogin: "copilot[bot]" })] }));
    expect(v).toEqual({ resolve: false });
  });

  it("does not resolve an open PR with only a self-review", () => {
    const v = exitVerdict(record(), snapshot({ reviews: [review({ authorLogin: "jolie" })] }));
    expect(v).toEqual({ resolve: false });
  });

  it("resolves when a human review sits among bot reviews", () => {
    const v = exitVerdict(
      record(),
      snapshot({ reviews: [review({ authorLogin: "copilot[bot]" }), review({ authorLogin: "ira" })] }),
    );
    expect(v).toMatchObject({ resolve: true, resolvedBy: "review by ira" });
  });

  it("does not resolve a re-requested PR whose only review predates the re-request", () => {
    // The headline workflow: reviewed, changes requested, author pushes, re-requests.
    const rerequested = record({ lastRequestedAt: T0 + 2 * HOUR, requestCount: 2 });
    const v = exitVerdict(rerequested, snapshot({ reviews: [review({ submittedAt: T0 + HOUR })] }));
    expect(v).toEqual({ resolve: false });
  });

  it("resolves a re-requested PR once a new review lands", () => {
    const rerequested = record({ lastRequestedAt: T0 + 2 * HOUR, requestCount: 2 });
    const v = exitVerdict(rerequested, snapshot({ reviews: [review({ submittedAt: T0 + 3 * HOUR })] }));
    expect(v).toMatchObject({ resolve: true, resolvedBy: "review by katherine" });
  });

  it("ignores reviewDecision even when it would imply the opposite verdict", () => {
    // reviews is empty, so the record must NOT resolve. An implementation that
    // read reviewDecision: "APPROVED" would resolve it and fail here.
    const approved = { ...snapshot(), reviewDecision: "APPROVED" } as PrSnapshot;
    expect(exitVerdict(record(), approved)).toEqual({ resolve: false });

    // And the converse: a real review resolves it even though reviewDecision
    // says a review is still required.
    const required = { ...snapshot({ reviews: [review()] }), reviewDecision: "REVIEW_REQUIRED" } as PrSnapshot;
    expect(exitVerdict(record(), required)).toMatchObject({ resolve: true, resolvedBy: "review by katherine" });
  });

  it("picks the earliest of several qualifying reviews, regardless of array order", () => {
    // With a single qualifying review, .sort() never even invokes its
    // comparator (arrays of length <= 1 are already sorted), so this is the
    // only way to exercise the comparator's use of each review's submittedAt.
    const later = review({ submittedAt: T0 + 3 * HOUR, authorLogin: "ira" });
    const earlier = review({ submittedAt: T0 + HOUR, authorLogin: "katherine" });
    const v = exitVerdict(record(), snapshot({ reviews: [later, earlier] }));
    expect(v).toMatchObject({ resolve: true, resolvedBy: "review by katherine" });
  });

  it("falls back to 'someone' when the resolving review has no author login", () => {
    const v = exitVerdict(record(), snapshot({ reviews: [review({ authorLogin: null })] }));
    expect(v).toMatchObject({ resolve: true, resolvedBy: "review by someone" });
  });

  it("uses the snapshot's author when the record has none", () => {
    const noAuthor = record({ prAuthorLogin: null });
    const v = exitVerdict(noAuthor, snapshot({ authorLogin: "jolie", reviews: [review({ authorLogin: "jolie" })] }));
    expect(v).toEqual({ resolve: false });
  });
});

describe("exitVerdict exit outcome", () => {
  it("a merged PR with a qualifying review is reviewed, done at the review", () => {
    const v = exitVerdict(
      record(),
      snapshot({ state: "MERGED", merged: true, mergedAt: T0 + 3 * HOUR, reviews: [review({ submittedAt: T0 + HOUR })] }),
    );
    expect(v).toEqual({
      resolve: true,
      resolvedBy: "merged",
      exit: { outcome: "reviewed", doneAt: T0 + HOUR },
    });
  });

  it("a merged PR with no qualifying review is merged-unreviewed, done at mergedAt", () => {
    const v = exitVerdict(record(), snapshot({ state: "MERGED", merged: true, mergedAt: T0 + 3 * HOUR }));
    expect(v).toEqual({
      resolve: true,
      resolvedBy: "merged",
      exit: { outcome: "merged-unreviewed", doneAt: T0 + 3 * HOUR },
    });
  });

  it("a merged PR with no mergedAt leaves doneAt null so the recording time is used", () => {
    const v = exitVerdict(record(), snapshot({ state: "MERGED", merged: true, mergedAt: null }));
    expect(v).toMatchObject({ resolve: true, exit: { outcome: "merged-unreviewed", doneAt: null } });
  });

  it("a closed PR with no review is closed-unreviewed, done at closedAt", () => {
    const v = exitVerdict(record(), snapshot({ state: "CLOSED", closedAt: T0 + 2 * HOUR }));
    expect(v).toEqual({
      resolve: true,
      resolvedBy: "closed",
      exit: { outcome: "closed-unreviewed", doneAt: T0 + 2 * HOUR },
    });
  });

  it("a closed PR with a qualifying review is reviewed, done at the review", () => {
    const v = exitVerdict(
      record(),
      snapshot({ state: "CLOSED", closedAt: T0 + 3 * HOUR, reviews: [review({ submittedAt: T0 + HOUR })] }),
    );
    expect(v).toMatchObject({ resolve: true, exit: { outcome: "reviewed", doneAt: T0 + HOUR } });
  });

  it("a merged PR whose only review predates the latest request is merged-unreviewed", () => {
    const v = exitVerdict(
      record({ lastRequestedAt: T0 + 2 * HOUR }),
      snapshot({ state: "MERGED", merged: true, mergedAt: T0 + 3 * HOUR, reviews: [review({ submittedAt: T0 + HOUR })] }),
    );
    expect(v).toMatchObject({ resolve: true, exit: { outcome: "merged-unreviewed", doneAt: T0 + 3 * HOUR } });
  });

  it("an open PR uses the earliest qualifying review as doneAt", () => {
    const v = exitVerdict(
      record(),
      snapshot({
        reviews: [review({ submittedAt: T0 + 2 * HOUR }), review({ submittedAt: T0 + HOUR })],
      }),
    );
    expect(v).toEqual({
      resolve: true,
      resolvedBy: "review by katherine",
      exit: { outcome: "reviewed", doneAt: T0 + HOUR },
    });
  });
});

describe("applySnapshotWithExit", () => {
  it("returns the exit when this call resolved an open record", () => {
    const out = applySnapshotWithExit(record(), snapshot({ reviews: [review()] }), T0 + 5 * HOUR);
    expect(out.record.resolvedBy).toBe("review by katherine");
    expect(out.exit).toEqual({ outcome: "reviewed", doneAt: T0 + HOUR });
  });

  it("returns exit null for an already-resolved record", () => {
    const resolved = resolveRecord(record(), T0 + HOUR, "manual by Jolie");
    const out = applySnapshotWithExit(resolved, snapshot({ reviews: [review()] }), T0 + 5 * HOUR);
    expect(out.exit).toBeNull();
  });

  it("returns exit null when the record stays open", () => {
    expect(applySnapshotWithExit(record(), snapshot(), T0 + HOUR).exit).toBeNull();
  });
});

describe("applySnapshotWithExit record refresh", () => {
  const NOW = T0 + 5 * HOUR;

  it("resolves an open record when the verdict says so", () => {
    const r = applySnapshotWithExit(record(), snapshot({ reviews: [review()] }), NOW).record;
    expect(r.resolvedAt).toBe(NOW);
    expect(r.resolvedBy).toBe("review by katherine");
  });

  it("refreshes the cached title, draft flag and author on every sync", () => {
    const r = applySnapshotWithExit(record(), snapshot({ title: "PT-4363 renamed", isDraft: true, authorLogin: "ira" }), NOW).record;
    expect(r.title).toBe("PT-4363 renamed");
    expect(r.isDraft).toBe(true);
    expect(r.prAuthorLogin).toBe("ira");
    expect(r.lastSyncedAt).toBe(NOW);
  });

  it("clears syncPausedSince on the first successful sync", () => {
    const paused = record({ syncPausedSince: T0 });
    expect(applySnapshotWithExit(paused, snapshot(), NOW).record.syncPausedSince).toBeNull();
  });

  it("keeps the record's own author when the snapshot's author is unknown", () => {
    // A transient GraphQL hiccup (deleted account, permissions blip) must not
    // clobber a known author with null — that null would then make every
    // future review of theirs look like a self-review.
    const known = record({ prAuthorLogin: "jolie" });
    const r = applySnapshotWithExit(known, snapshot({ authorLogin: null }), NOW).record;
    expect(r.prAuthorLogin).toBe("jolie");
  });

  it("leaves an already-resolved record alone rather than restamping it", () => {
    const resolved = resolveRecord(record(), T0 + HOUR, "manual by Jolie");
    const r = applySnapshotWithExit(resolved, snapshot({ reviews: [review()] }), NOW).record;
    expect(r.resolvedAt).toBe(T0 + HOUR);
    expect(r.resolvedBy).toBe("manual by Jolie");
  });
});
