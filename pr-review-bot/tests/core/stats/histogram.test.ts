import { describe, expect, it } from "vitest";
import {
  BUCKET_EDGES_MS,
  addHistograms,
  bucketIndex,
  emptyHistogram,
  histogramCount,
  quantile,
} from "../../../src/core/stats/histogram.js";

const H = 3_600_000;

describe("buckets", () => {
  it("has 12 edges and 13 empty buckets", () => {
    expect(BUCKET_EDGES_MS).toHaveLength(12);
    expect(emptyHistogram()).toEqual(new Array(13).fill(0));
  });

  it("puts zero in the first bucket", () => {
    expect(bucketIndex(0)).toBe(0);
  });

  it("treats edges as lower-inclusive", () => {
    expect(bucketIndex(15 * 60_000)).toBe(1);
    expect(bucketIndex(15 * 60_000 - 1)).toBe(0);
  });

  it("puts anything past the last edge in the open bucket", () => {
    expect(bucketIndex(20 * 24 * H)).toBe(12);
  });
});

describe("addHistograms / histogramCount", () => {
  it("adds bucket-wise without mutating inputs", () => {
    const a = emptyHistogram();
    a[1] = 2;
    const b = emptyHistogram();
    b[1] = 3;
    b[4] = 1;
    const sum = addHistograms(a, b);
    expect(sum[1]).toBe(5);
    expect(sum[4]).toBe(1);
    expect(a[1]).toBe(2);
  });

  it("counts all entries", () => {
    const h = emptyHistogram();
    h[bucketIndex(H)] = 10;
    const open = emptyHistogram();
    open[12] = 3;
    expect(histogramCount(addHistograms(h, open))).toBe(13);
  });
});

describe("quantile", () => {
  it("interpolates linearly within the bucket", () => {
    const h = emptyHistogram();
    h[bucketIndex(H)] = 10;
    expect(quantile(h, 0.5)).toBe(1.5 * H);
  });

  it("returns null for an empty histogram", () => {
    expect(quantile(emptyHistogram(), 0.5)).toBeNull();
  });

  it("returns the lower edge for the open-ended bucket", () => {
    const open = emptyHistogram();
    open[12] = 3;
    expect(quantile(open, 0.5)).toBe(14 * 24 * H);
  });

  it("walks past earlier buckets to find the target", () => {
    const h = emptyHistogram();
    h[0] = 5; // [0, 15m)
    h[2] = 5; // [30m, 1h)
    expect(quantile(h, 0.75)).toBe(45 * 60_000);
  });
});
