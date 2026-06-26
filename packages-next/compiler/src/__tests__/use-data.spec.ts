/**
 * `useData` smoke — verifies the suspend-via-throw contract works
 * standalone (no React, no walker abstraction) when the caller drives
 * the compile-until-stable loop themselves.
 *
 * The test simulates what a framework adapter's runtime would do:
 *   1. set RenderContext
 *   2. invoke user code synchronously
 *   3. on thrown Promise, await it
 *   4. retry until no throw
 */

import { describe, expect, it } from "vitest";

import { createRenderContext, isThenable, useData, withRenderContext } from "../index.js";

async function driveUntilStable<T>(work: () => T): Promise<T> {
  const ctx = createRenderContext();
  for (let i = 0; i < 50; i++) {
    let result: T | undefined;
    let pending: PromiseLike<unknown> | undefined;
    let error: unknown;

    withRenderContext(ctx, () => {
      try {
        result = work();
      } catch (err) {
        if (isThenable(err)) pending = err;
        else error = err;
      }
    });

    if (error !== undefined) throw error;
    if (pending) {
      await pending.then(
        () => undefined,
        () => undefined,
      );
      continue;
    }
    return result as T;
  }
  throw new Error("driveUntilStable: exceeded iterations");
}

describe("useData", () => {
  it("returns cached value on second call after Promise resolves", async () => {
    let fetcherCalls = 0;
    const fetcher = async () => {
      fetcherCalls++;
      return "hello";
    };
    const out = await driveUntilStable(() => useData("greeting", fetcher));
    expect(out).toBe("hello");
    expect(fetcherCalls).toBe(1);
  });

  it("de-duplicates concurrent calls on the same key (one fetcher per render)", async () => {
    let fetcherCalls = 0;
    const fetcher = async () => {
      fetcherCalls++;
      return 42;
    };
    const out = await driveUntilStable(() => {
      const a = useData("k", fetcher);
      const b = useData("k", fetcher);
      const c = useData("k", fetcher);
      return [a, b, c];
    });
    expect(out).toEqual([42, 42, 42]);
    expect(fetcherCalls).toBe(1);
  });

  it("isolates caches across compile invocations", async () => {
    let fetcherCalls = 0;
    const fetcher = async () => {
      fetcherCalls++;
      return "x";
    };
    await driveUntilStable(() => useData("k", fetcher));
    await driveUntilStable(() => useData("k", fetcher));
    // Two compiles → two RenderContexts → fetcher fired twice.
    expect(fetcherCalls).toBe(2);
  });

  it("propagates fetcher rejection on retry", async () => {
    const fetcher = async () => {
      throw new Error("boom");
    };
    await expect(driveUntilStable(() => useData("k", fetcher))).rejects.toThrow("boom");
  });

  it("throws if called outside a withRenderContext scope", () => {
    expect(() => useData("k", async () => 1)).toThrow(/outside a compiler render scope/);
  });
});
