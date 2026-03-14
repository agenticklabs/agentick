/**
 * useData Tests
 *
 * Tests for the resolve-then-render data hook, focusing on:
 * - Basic fetch and cache
 * - Error handling (fetcher rejects → no render loop)
 * - Deps change → refetch
 */

import { describe, it, expect, vi } from "vitest";
import { createApp } from "../../app.js";
import { System } from "../../jsx/components/messages.js";
import { Timeline } from "../../jsx/components/timeline.js";
import { Section } from "../../jsx/components/primitives.js";
import { createTestAdapter } from "../../testing/index.js";
import { useData } from "../../hooks/index.js";
import { StopReason } from "@agentick/shared";

// ============================================================================
// Helpers
// ============================================================================

const model = createTestAdapter({ defaultResponse: "Done", stopReason: StopReason.STOP });

function send(session: any) {
  return session.send({
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  }).result;
}

// ============================================================================
// Tests
// ============================================================================

describe("useData", () => {
  it("resolves data and renders on second pass", async () => {
    const fetcher = vi.fn().mockResolvedValue({ name: "test" });

    const Agent = () => {
      const data = useData("user", fetcher, []);
      return (
        <>
          <System>You are a test agent</System>
          <Timeline />
          <Section id="data" audience="model" title="Data">
            {data.name}
          </Section>
        </>
      );
    };

    const app = createApp(Agent, { model, maxTicks: 1 });
    const session = await app.session();
    const result = await send(session);
    session.close();

    expect(result.response).toBe("Done");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // Error Handling — the core fix
  // ==========================================================================

  it("fetcher rejection does not cause infinite render loop", async () => {
    const error = new Error("API unavailable");
    const fetcher = vi.fn().mockRejectedValue(error);

    const Agent = () => {
      const _data = useData("broken", fetcher, []);
      return (
        <>
          <System>unreachable</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, { model, maxTicks: 1 });
    const session = await app.session();

    // The key assertion: this completes (doesn't hang) and the fetcher
    // is only called once, not in a loop.
    try {
      await send(session);
    } catch {
      // Error may or may not propagate — depends on session error handling
    }

    expect(fetcher).toHaveBeenCalledTimes(1);
    session.close();
  });

  it("rejected fetcher cleans up pendingFetches", async () => {
    const error = new Error("embed failed");
    const fetcher = vi.fn().mockRejectedValue(error);

    // Directly test the store behavior
    const { createRuntimeStore, storeHasPendingData, storeResolvePendingData } =
      await import("../runtime-context.js");

    const store = createRuntimeStore();

    // Simulate what useData does internally
    const promise = fetcher().then(
      (value: any) => {
        store.dataCache.set("test", { value, tick: 1, deps: [] });
        store.pendingFetches.delete("test");
        return value;
      },
      (err: any) => {
        store.dataCache.set("test", {
          value: Symbol("useData:error"),
          error: err,
          tick: 1,
          deps: [],
          persist: false,
        } as any);
        store.pendingFetches.delete("test");
      },
    );
    store.pendingFetches.set("test", promise);

    expect(storeHasPendingData(store)).toBe(true);

    // After resolution, pendingFetches should be clean
    await storeResolvePendingData(store);

    expect(storeHasPendingData(store)).toBe(false);
    // Error should be cached
    expect(store.dataCache.has("test")).toBe(true);
  });
});
