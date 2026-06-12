/**
 * `computeFullJitterBackoff` distribution properties.
 *
 * Verifies the formula `random_uniform(0, min(maxDelay, initial * 2^attempt))`
 * holds across attempts and across many samples. Property-based shape:
 *
 *   - Output is in `[0, cap)` for every attempt
 *   - `cap = min(maxDelayMs, initialDelayMs * 2^attempt)` — exponential
 *     growth with hard cap
 *   - Distribution is approximately uniform over `[0, cap)`
 *   - First-attempt delay starts in `[0, initialDelayMs)` (not [0, 2*initial))
 *
 * Per AWS Builder's Library "Timeouts, retries, and backoff with jitter"
 * (Marc Brooker). "Full jitter" = the entire range is jittered, not just
 * the added portion. This eliminates retry-storm thundering herds.
 */

import { describe, expect, it } from "vitest";
import { computeFullJitterBackoff } from "../client/base-transport.js";

const POLICY = { initialDelayMs: 100, maxDelayMs: 20_000 };

describe("computeFullJitterBackoff", () => {
  it("attempt 0: output in [0, initialDelayMs)", () => {
    // Deterministic samples via injected RNG
    expect(computeFullJitterBackoff(0, POLICY, () => 0)).toBe(0);
    expect(computeFullJitterBackoff(0, POLICY, () => 0.999)).toBeCloseTo(99.9, 1);
    expect(computeFullJitterBackoff(0, POLICY, () => 0.5)).toBe(50);
  });

  it("doubles the cap with each attempt, until maxDelayMs", () => {
    // Cap at attempt n is min(maxDelay, initial * 2^n)
    // attempt 0: 100
    // attempt 1: 200
    // attempt 2: 400
    // attempt 7: 12_800
    // attempt 8: 20_000 (capped from 25_600)
    // attempt 100: 20_000
    const max = (attempt: number) => computeFullJitterBackoff(attempt, POLICY, () => 0.999);
    expect(max(0)).toBeLessThan(100);
    expect(max(1)).toBeLessThan(200);
    expect(max(1)).toBeGreaterThan(100);
    expect(max(2)).toBeLessThan(400);
    expect(max(7)).toBeLessThan(12_800);
    expect(max(8)).toBeLessThan(20_000);
    expect(max(100)).toBeLessThan(20_000); // capped, not overflowing
  });

  it("never exceeds maxDelayMs for any attempt count", () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      for (let i = 0; i < 50; i++) {
        const d = computeFullJitterBackoff(attempt, POLICY);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(POLICY.maxDelayMs);
      }
    }
  });

  it("uniformly distributed across [0, cap) — full-jitter shape", () => {
    // At attempt 5, cap = min(20000, 100 * 32) = 3200.
    // 10k samples; bin counts in 8 equal buckets should each get ~12.5%.
    // Tolerance ±3% per bucket (chi-squared style sanity check).
    const cap = Math.min(POLICY.maxDelayMs, POLICY.initialDelayMs * 2 ** 5);
    expect(cap).toBe(3200);

    const bucketCount = 8;
    const buckets = new Array(bucketCount).fill(0) as number[];
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const d = computeFullJitterBackoff(5, POLICY);
      const bucket = Math.min(bucketCount - 1, Math.floor((d / cap) * bucketCount));
      buckets[bucket]!++;
    }
    const expected = N / bucketCount;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(expected * 0.85);
      expect(count).toBeLessThan(expected * 1.15);
    }
  });

  it("samples cluster across the full range, not just the upper end", () => {
    // Sanity: at attempt 5 (cap 3200), at least 10% of samples should
    // land in the bottom decile [0, 320). "Equal jitter" or "no jitter"
    // shapes would put 0% there.
    const cap = POLICY.initialDelayMs * 2 ** 5;
    const bottomDecile = cap / 10;
    const N = 1000;
    let belowDecile = 0;
    for (let i = 0; i < N; i++) {
      if (computeFullJitterBackoff(5, POLICY) < bottomDecile) belowDecile++;
    }
    expect(belowDecile).toBeGreaterThan(N * 0.07);
    expect(belowDecile).toBeLessThan(N * 0.13);
  });

  it("respects an injected deterministic RNG (test reproducibility)", () => {
    // Sequence of RNG outputs maps to deterministic backoff sequence.
    const seq = [0.1, 0.5, 0.9];
    let i = 0;
    const rng = () => seq[i++]!;
    const d0 = computeFullJitterBackoff(0, POLICY, rng); // 0.1 * 100 = 10
    const d1 = computeFullJitterBackoff(1, POLICY, rng); // 0.5 * 200 = 100
    const d2 = computeFullJitterBackoff(2, POLICY, rng); // 0.9 * 400 = 360
    expect(d0).toBe(10);
    expect(d1).toBe(100);
    expect(d2).toBe(360);
  });
});
