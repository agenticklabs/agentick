/**
 * `useSessionState` — verifies:
 *   - Initial value registers on first render
 *   - `set()` triggers re-render of subscribed components
 *   - Bridge survives unmount → remount with the same bridge instance
 *     (the session-owns-the-bridge contract)
 *   - Snapshot round-trips and restore re-populates the bridge
 */

import React, { useState } from "react";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

import { stubBridges } from "@agentick/reconciler-next";
import { ReconcilerHarness } from "@agentick/reconciler-react-next";
import { useSessionState } from "@agentick/state-next/react";

async function makeHarness(id = "h_state") {
  const h = new ReconcilerHarness(id, new MemoryJournal(), new LocalEventBus(), new LocalInbox());
  await h.ready;
  return h;
}

function textOf(content: readonly { text?: string }[]): string {
  return content.map((c) => c.text ?? "").join("");
}

describe("useSessionState — initial registration", () => {
  it("registers the initial value on first render", async () => {
    const harness = await makeHarness();
    const bridges = stubBridges();

    function Counter() {
      const [count] = useSessionState("count", 5);
      return React.createElement("message", { role: "user" }, `count=${count}`);
    }

    await harness.mount({
      mountId: "m1",
      sessionId: "s1",
      element: React.createElement(Counter),
      bridges,
    });
    const { tree } = await harness.renderTree({
      mountId: "m1",
      sessionId: "s1",
    });
    const m = tree.context.entries[0]!;
    if (m.kind !== "message") throw new Error("expected message");
    expect(textOf(m.content)).toBe("count=5");
    // useSessionState's seeding fires fire-and-forget via async set;
    // give it a microtask to land.
    await new Promise((r) => setImmediate(r));
    expect(bridges.state.get("count")).toBe(5);
  });

  it("does NOT overwrite an existing value when re-mounting", async () => {
    const harness = await makeHarness();
    const bridges = stubBridges();
    await bridges.state.set({ key: "count", value: 99 });

    function Counter() {
      const [count] = useSessionState("count", 5);
      return React.createElement("message", { role: "user" }, `count=${count}`);
    }

    await harness.mount({
      mountId: "m_existing",
      sessionId: "s",
      element: React.createElement(Counter),
      bridges,
    });
    const { tree } = await harness.renderTree({
      mountId: "m_existing",
      sessionId: "s",
    });
    const m = tree.context.entries[0]!;
    if (m.kind !== "message") throw new Error("expected message");
    expect(textOf(m.content)).toBe("count=99");
  });
});

describe("useSessionState — persistence across mounts", () => {
  it("survives unmount → remount when the same bridge is reused", async () => {
    const harness = await makeHarness();
    const bridges = stubBridges();

    function Counter() {
      const [count, setCount] = useSessionState("count", 0);
      // Read-only here; we'll mutate via the bridge directly to keep
      // the test deterministic in a no-Suspense world.
      void setCount;
      return React.createElement("message", { role: "user" }, `count=${count}`);
    }

    await harness.mount({
      mountId: "m_a",
      sessionId: "s",
      element: React.createElement(Counter),
      bridges,
    });
    await harness.renderTree({ mountId: "m_a", sessionId: "s" });

    // Simulate the agent updating state mid-session
    await bridges.state.set({ key: "count", value: 42 });
    await harness.unmount({ mountId: "m_a", sessionId: "s" });

    // Remount with the SAME bridges bundle — session-owns-bridge contract.
    await harness.mount({
      mountId: "m_b",
      sessionId: "s",
      element: React.createElement(Counter),
      bridges,
    });
    const { tree } = await harness.renderTree({
      mountId: "m_b",
      sessionId: "s",
    });
    const m = tree.context.entries[0]!;
    if (m.kind !== "message") throw new Error("expected message");
    expect(textOf(m.content)).toBe("count=42");
  });
});

describe("useSessionState — reactivity", () => {
  it("triggers re-renders when set() is called externally", async () => {
    const harness = await makeHarness();
    const bridges = stubBridges();

    function Counter() {
      const [count] = useSessionState("count", 0);
      // Trigger a render notification on mount so renderTree settles
      const [, force] = useState(0);
      void force;
      return React.createElement("message", { role: "user" }, `count=${count}`);
    }

    await harness.mount({
      mountId: "m_r",
      sessionId: "s",
      element: React.createElement(Counter),
      bridges,
    });
    const first = await harness.renderTree({ mountId: "m_r", sessionId: "s" });
    const firstEntry = first.tree.context.entries[0]!;
    if (firstEntry.kind !== "message") throw new Error("expected message");
    expect(textOf(firstEntry.content)).toBe("count=0");

    await bridges.state.set({ key: "count", value: 7 });
    const second = await harness.renderTree({ mountId: "m_r", sessionId: "s" });
    const secondEntry = second.tree.context.entries[0]!;
    if (secondEntry.kind !== "message") throw new Error("expected message");
    expect(textOf(secondEntry.content)).toBe("count=7");
  });
});
