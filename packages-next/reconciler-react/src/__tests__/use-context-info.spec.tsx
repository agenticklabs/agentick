/**
 * `useContextInfo` (#204 / ADR 54) — the window is a SYNCHRONOUS
 * render-context input; usedTokens is the ASYNC lifecycle bridge.
 * Utilization = usedTokens / window.
 */

import { describe, expect, it } from "vitest";
import React from "react";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { fakeBridges } from "@agentick/reconciler-next";
import { ReconcilerHarness } from "../harness/reconciler-harness.js";
import { useContextInfo, type ContextInfo } from "../react/hooks/use-context-info.js";
import { flush, waitFor } from "../testing/flush.js";

async function makeHarness(id: string) {
  const harness = new ReconcilerHarness(
    id,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

describe("useContextInfo", () => {
  it("window comes from render-context (synchronous), usedTokens from the async lifecycle bridge", async () => {
    const harness = await makeHarness("h_ci_1");
    let latest: ContextInfo | undefined;

    function App() {
      latest = useContextInfo();
      return React.createElement("message", { role: "user" }, "ok");
    }

    // Mount WITH render-context contextInfo — the window is available
    // synchronously to the render, not observed after it.
    await harness.mount({
      mountId: "m_ci",
      sessionId: "s",
      element: React.createElement(App),
      bridges: fakeBridges(),
      renderContext: { contextInfo: { contextWindow: 128000 } },
    });
    await flush();
    // Window present immediately (no tick needed); no usage yet.
    expect(latest?.contextWindow).toBe(128000);
    expect(latest?.usedTokens).toBe(0);

    // usedTokens arrives via the async bridge (tick-end); utilization
    // recomputes against the render-context window.
    await harness.notifyLifecycle({
      mountId: "m_ci",
      event: {
        kind: "tick-end",
        tickId: "t1",
        result: null,
        metadata: { usage: { inputTokens: 64000, outputTokens: 100, totalTokens: 64100 } },
      },
    });
    await waitFor(() => {
      expect(latest).toEqual({ usedTokens: 64000, contextWindow: 128000, utilization: 0.5 });
    });
  });

  it("no render-context window → utilization undefined; usedTokens still tracked from the bridge", async () => {
    const harness = await makeHarness("h_ci_2");
    let latest: ContextInfo | undefined;

    function App() {
      latest = useContextInfo();
      return React.createElement("message", { role: "user" }, "ok");
    }

    await harness.mount({
      mountId: "m_ci2",
      sessionId: "s",
      element: React.createElement(App),
      bridges: fakeBridges(),
      // no renderContext → no window
    });
    await flush();
    expect(latest).toEqual({ usedTokens: 0 });

    await harness.notifyLifecycle({
      mountId: "m_ci2",
      event: {
        kind: "execution-end",
        executionId: "e1",
        outcome: null,
        metadata: { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
      },
    });
    await waitFor(() => {
      expect(latest).toEqual({ usedTokens: 10 });
    });
  });
});
