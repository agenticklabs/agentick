/**
 * `runDetached` — the one sanctioned fire-and-forget runner (#315).
 * A failure reaches the sink; it never becomes an unhandled rejection.
 */

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { runDetached } from "../substrate/run-detached.js";

describe("runDetached", () => {
  it("runs the effect", async () => {
    let ran = false;
    runDetached(
      Effect.sync(() => {
        ran = true;
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toBe(true);
  });

  it("routes failure to the sink, never the process", async () => {
    const sink = vi.fn();
    runDetached(Effect.fail(new Error("boom")), sink);
    await new Promise((r) => setTimeout(r, 10));
    expect(sink).toHaveBeenCalledTimes(1);
    // Vitest fails the test if the rejection had leaked unhandled.
  });

  it("default sink is loud but non-throwing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      runDetached(Effect.fail(new Error("boom")));
      await new Promise((r) => setTimeout(r, 10));
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
