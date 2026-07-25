/**
 * Trial aggregation math — the unbiased `pass@k` estimator + `cellStats`
 * distribution collapse. These are the pieces that make `trials > 1` honest.
 */

import { describe, expect, it } from "vitest";

import { aggregate, cellStats, passAtK } from "../stats.js";
import type { EvalResult } from "../types.js";

describe("passAtK — unbiased Chen et al. estimator", () => {
  it("pass@1 equals the pass rate", () => {
    expect(passAtK(5, 2, 1)).toBeCloseTo(0.4, 10); // 2/5
    expect(passAtK(10, 7, 1)).toBeCloseTo(0.7, 10);
  });

  it("pass@k rises with k (more samples, more chances)", () => {
    // n=5, c=2: 1 - C(3,2)/C(5,2) = 1 - 3/10 = 0.7
    expect(passAtK(5, 2, 2)).toBeCloseTo(0.7, 10);
    // n=5, c=2: 1 - C(3,3)/C(5,3) = 1 - 1/10 = 0.9
    expect(passAtK(5, 2, 3)).toBeCloseTo(0.9, 10);
  });

  it("saturates at the boundaries", () => {
    expect(passAtK(5, 5, 3)).toBe(1); // all pass
    expect(passAtK(5, 0, 2)).toBe(0); // none pass
  });

  it("clamps k to [1, n] and guards n=0", () => {
    expect(passAtK(0, 0, 1)).toBe(0);
    expect(passAtK(3, 1, 99)).toBe(1); // k clamped to 3; any 3-subset of 3 has the pass
    expect(passAtK(4, 1, 4)).toBe(1); // k=n → you sample everything → the one pass is always in
  });
});

describe("aggregate", () => {
  it("mean / population stddev / min / max / n", () => {
    const a = aggregate([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(a.mean).toBe(5);
    expect(a.stddev).toBeCloseTo(2, 10); // population stddev of this classic set
    expect(a.min).toBe(2);
    expect(a.max).toBe(9);
    expect(a.n).toBe(8);
  });

  it("stddev is 0 for a single value; empty is all-zero", () => {
    expect(aggregate([0.9]).stddev).toBe(0);
    expect(aggregate([])).toEqual({ mean: 0, stddev: 0, min: 0, max: 0, n: 0 });
  });
});

describe("cellStats", () => {
  const run = (passed: boolean, quality: number): EvalResult => ({
    description: "t",
    passed,
    elapsedMs: 1,
    assertions: [],
    scores: [{ label: "quality", value: quality }],
    toolCalls: [],
  });

  it("collapses trials into pass rate, pass@k, and per-score aggregates", () => {
    const stats = cellStats([run(true, 0.9), run(false, 0.5), run(true, 0.8), run(true, 0.7)], 1);
    expect(stats.trials).toBe(4);
    expect(stats.passed).toBe(3);
    expect(stats.passRate).toBe(0.75);
    expect(stats.passAtK).toBeCloseTo(0.75, 10); // pass@1 = 3/4
    expect(stats.scores.quality.mean).toBeCloseTo(0.725, 10);
    expect(stats.scores.quality.n).toBe(4);
  });

  it("omits passAtK when no k is given", () => {
    expect(cellStats([run(true, 1)]).passAtK).toBeUndefined();
  });
});
