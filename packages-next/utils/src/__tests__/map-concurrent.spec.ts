/**
 * `mapConcurrent` — bounded-concurrency map preserving input order
 * with at most `concurrency` in flight at any moment.
 */

import { describe, expect, it } from "vitest";

import { mapConcurrent } from "../map-concurrent.js";

describe("mapConcurrent", () => {
  it("empty input yields empty output", async () => {
    const out = await mapConcurrent([], 4, async (x) => x);
    expect(out).toEqual([]);
  });

  it("preserves input order regardless of completion order", async () => {
    // Items with longer durations finish later, but their result
    // still lands at their input index.
    const items = [50, 10, 30];
    const out = await mapConcurrent(items, 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return { i, ms };
    });
    expect(out).toEqual([
      { i: 0, ms: 50 },
      { i: 1, ms: 10 },
      { i: 2, ms: 30 },
    ]);
  });

  it("respects the concurrency cap (never exceeds N in flight)", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapConcurrent(items, 4, async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peakInFlight).toBeLessThanOrEqual(4);
  });

  it("concurrency=1 runs sequentially", async () => {
    const order: number[] = [];
    await mapConcurrent([0, 1, 2, 3], 1, async (i) => {
      order.push(i * 10);
      await new Promise((r) => setTimeout(r, 5));
      order.push(i * 10 + 1);
    });
    // Each item's "enter" and "exit" markers are adjacent — no
    // interleaving — proves sequential execution.
    expect(order).toEqual([0, 1, 10, 11, 20, 21, 30, 31]);
  });

  it("propagates the first rejection", async () => {
    const err = new Error("boom");
    await expect(
      mapConcurrent([1, 2, 3], 2, async (i) => {
        if (i === 2) throw err;
        await new Promise((r) => setTimeout(r, 10));
        return i;
      }),
    ).rejects.toBe(err);
  });

  it("concurrency<=0 clamps to 1", async () => {
    const order: number[] = [];
    await mapConcurrent([0, 1], 0, async (i) => {
      order.push(i);
      await new Promise((r) => setTimeout(r, 2));
      order.push(i + 100);
    });
    expect(order).toEqual([0, 100, 1, 101]);
  });
});
