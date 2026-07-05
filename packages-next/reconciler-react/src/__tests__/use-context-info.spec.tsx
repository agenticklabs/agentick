/**
 * `useContextInfo` (#204) — reads context-window utilization from the
 * lifecycle `metadata` carrier and computes the `[0,1]` ratio inline.
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
  it("reports usedTokens + contextWindow + utilization from tick-end metadata", async () => {
    const harness = await makeHarness("h_ci_1");
    let latest: ContextInfo | undefined;

    function App() {
      latest = useContextInfo();
      return React.createElement("message", { role: "user" }, "ok");
    }

    await harness.mount({
      mountId: "m_ci",
      sessionId: "s",
      element: React.createElement(App),
      bridges: fakeBridges(),
    });
    await flush();
    // Before any tick-end: honest empty reading, no fabricated window.
    expect(latest).toEqual({ usedTokens: 0 });

    await harness.notifyLifecycle({
      mountId: "m_ci",
      event: {
        kind: "tick-end",
        tickId: "t1",
        result: null,
        metadata: {
          usage: { inputTokens: 64000, outputTokens: 100, totalTokens: 64100 },
          contextWindow: 128000,
        },
      },
    });

    await waitFor(() => {
      expect(latest).toEqual({ usedTokens: 64000, contextWindow: 128000, utilization: 0.5 });
    });
  });

  it("no contextWindow in metadata → utilization undefined; usedTokens from execution-end", async () => {
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
    });
    await flush();

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
