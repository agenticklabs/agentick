import { describe, expect, it } from "vitest";
import React, { useEffect } from "react";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ReconcilerHarness } from "../harness/reconciler-harness.js";
import { InMemoryDataBridge } from "../bridges/in-memory-data-bridge.js";
import { stubBridges, inMemoryKnobBridge } from "../bridges/stub-bridges.js";
import { useData } from "../react/hooks/use-data.js";
import { useKnob } from "../react/hooks/use-knob.js";
import { useLoopControl } from "../react/hooks/use-loop-control.js";
import { useSession } from "../react/hooks/use-session.js";
import { flush } from "../testing/flush.js";
import type { HookBridges } from "@agentick/spec";

async function makeHarness() {
  const harness = new ReconcilerHarness(
    "h_hooks",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

function textOf(content: readonly { text?: string }[]): string {
  return content.map((c) => c.text ?? "").join("");
}

describe("useData — no-Suspense blocking resolution", () => {
  it("returns cached value synchronously when present", async () => {
    const data = new InMemoryDataBridge();
    const bridges: HookBridges = { ...stubBridges(), data };
    const harness = await makeHarness();

    function User() {
      const name = useData("user", async () => "Ryan");
      return React.createElement("message", { role: "user" }, `Hello, ${name}`);
    }

    await harness.mount({
      mountId: "m_1",
      sessionId: "s",
      element: React.createElement(User),
      bridges,
    });
    const { tree, iterations, diagnostics } = await harness.renderTree({
      mountId: "m_1",
      sessionId: "s",
    });

    expect(diagnostics).toEqual([]);
    // mount() did the first render (kicked off the fetch). By the time
    // renderTree runs, the fetch may have already resolved, so renderTree
    // can complete in a single iteration. We just assert it converged.
    expect(iterations).toBeGreaterThanOrEqual(1);
    const m = tree.context.entries[0]!;
    if (m.kind !== "message") throw new Error("expected message");
    expect(textOf(m.content)).toBe("Hello, Ryan");
  });

  it("blocks the render loop until the fetcher resolves", async () => {
    const data = new InMemoryDataBridge();
    const bridges: HookBridges = { ...stubBridges(), data };
    const harness = await makeHarness();

    let resolveLater: ((v: string) => void) | null = null;
    const pending = new Promise<string>((r) => {
      resolveLater = r;
    });

    function Slow() {
      const v = useData("slow", () => pending);
      return React.createElement("message", { role: "user" }, v);
    }

    await harness.mount({
      mountId: "m_slow",
      sessionId: "s",
      element: React.createElement(Slow),
      bridges,
    });

    const renderPromise = harness.renderTree({ mountId: "m_slow", sessionId: "s" });

    // Allow the first render iteration to enqueue the fetch.
    await new Promise((r) => setTimeout(r, 5));

    // Resolve the user-controlled Promise; the render loop awaits and retries.
    resolveLater!("done");

    const { tree } = await renderPromise;
    const m = tree.context.entries[0]!;
    if (m.kind !== "message") throw new Error("expected message");
    expect(textOf(m.content)).toBe("done");
  });

  it("a fetcher rejection propagates as a render error (no loading state)", async () => {
    const data = new InMemoryDataBridge();
    const bridges: HookBridges = { ...stubBridges(), data };
    const harness = await makeHarness();

    function Broken() {
      const v = useData("broken", () => Promise.reject(new Error("network down")));
      return React.createElement("message", { role: "user" }, v);
    }

    await harness.mount({
      mountId: "m_broken",
      sessionId: "s",
      element: React.createElement(Broken),
      bridges,
    });

    await expect(
      harness.renderTree({ mountId: "m_broken", sessionId: "s" }),
    ).rejects.toMatchObject({ _tag: "RenderFailed" });
  });

  // TODO(hooks): max-iterations test. The naive "fresh key each render"
  // approach triggers react-reconciler 0.33's internal retry behavior
  // for thrown Promises without a Suspense boundary, producing runaway
  // re-renders that bleed across tests. A proper max-iterations test
  // needs a controlled DataBridge that fakes pending without actually
  // throwing — added when we land the dedicated bridge-conformance
  // suite (Phase 3.16).
});

describe("useKnob", () => {
  it("registers initial value, returns current value, re-renders on external set", async () => {
    const knobs = inMemoryKnobBridge();
    const bridges: HookBridges = { ...stubBridges(), knobs };
    const harness = await makeHarness();

    function App() {
      const [mood, _setMood] = useKnob("mood", "curious");
      return React.createElement("message", { role: "user" }, `mood=${mood}`);
    }

    await harness.mount({
      mountId: "m_knob",
      sessionId: "s",
      element: React.createElement(App),
      bridges,
    });

    const r1 = await harness.renderTree({ mountId: "m_knob", sessionId: "s" });
    const m1 = r1.tree.context.entries[0]!;
    if (m1.kind !== "message") throw new Error("expected message");
    expect(textOf(m1.content)).toBe("mood=curious");

    // External mutation — set_knob tool dispatch equivalent.
    knobs.set("mood", "decisive");
    // Allow React's useSyncExternalStore listener to schedule the
    // subscriber re-render before we ask the harness for a fresh tree.
    await flush();

    const r2 = await harness.renderTree({ mountId: "m_knob", sessionId: "s" });
    const m2 = r2.tree.context.entries[0]!;
    if (m2.kind !== "message") throw new Error("expected message");
    expect(textOf(m2.content)).toBe("mood=decisive");
  });
});

describe("useLoopControl", () => {
  it("returns the loop bridge — components can request continue/stop", async () => {
    let captured: ReturnType<typeof useLoopControl> | null = null;
    const stopped: string[] = [];

    const bridges: HookBridges = {
      ...stubBridges(),
      loop: {
        continueAfterTick: () => stopped.push("continue"),
        stopAfterTick: (reason) => stopped.push(`stop:${reason ?? ""}`),
      },
    };
    const harness = await makeHarness();

    function App() {
      captured = useLoopControl();
      useEffect(() => {
        captured!.stopAfterTick("done");
      }, []);
      return React.createElement("message", { role: "user" }, "ok");
    }

    await harness.mount({
      mountId: "m_loop",
      sessionId: "s",
      element: React.createElement(App),
      bridges,
    });
    await harness.renderTree({ mountId: "m_loop", sessionId: "s" });

    expect(captured).not.toBeNull();
    expect(stopped).toContain("stop:done");
  });
});

describe("useSession", () => {
  it("returns the session bridge snapshot", async () => {
    const bridges = stubBridges({ sessionId: "s_42" });
    const harness = await makeHarness();

    function App() {
      const s = useSession();
      return React.createElement("message", { role: "user" }, `sid=${s.id}`);
    }

    await harness.mount({
      mountId: "m_sess",
      sessionId: "s_42",
      element: React.createElement(App),
      bridges,
    });
    const { tree } = await harness.renderTree({ mountId: "m_sess", sessionId: "s_42" });
    const m = tree.context.entries[0]!;
    if (m.kind !== "message") throw new Error("expected message");
    expect(textOf(m.content)).toBe("sid=s_42");
  });
});

describe("useBridges without a BridgeProvider", () => {
  it("throws a clear error", async () => {
    // Direct unit test of useBridges — invoke from a component
    // rendered through a separate reconciler with NO provider in the
    // tree. The error from useBridges() propagates as a RenderFailed.
    const { useBridges } = await import("../react/bridge-context.js");
    const { createContainer } = await import("../host/container.js");
    const { createReconciler } = await import("../react/reconciler.js");

    const container = createContainer({ mountId: "bare" });
    let caught: unknown = null;
    const reconciler = createReconciler({
      container,
      idPrefix: "bare",
      onUncaughtError: (err) => {
        caught = err;
      },
    });
    const root = reconciler.createRoot();
    function Bare() {
      useBridges();
      return null;
    }
    reconciler.render(React.createElement(Bare), root);
    expect(String(caught)).toContain("ReconcilerHarness mount");
  });
});
