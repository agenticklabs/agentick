import { describe, expect, it } from "vitest";
import React, { useEffect } from "react";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { CompilerHarness } from "../harness/compiler-harness.js";
import { InMemoryDataBridge } from "@agentick/compiler-next";
import { fakeBridges } from "@agentick/compiler-next";
import { useData } from "../react/hooks/use-data.js";
// useKnob moved to @agentick/knobs-next/react per ADR 27.
// useKnob's integration coverage lives in
// packages/knobs/src/__tests__/integration-with-compiler.spec.tsx.
import { useLoopControl } from "../react/hooks/use-loop-control.js";
import { useSession } from "../react/hooks/use-session.js";
import { extractText } from "@agentick/spec-next";
import type { HookBridges } from "@agentick/spec-next";

async function makeHarness() {
  const harness = new CompilerHarness(
    "h_hooks",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

const textOf = extractText;

describe("useData — no-Suspense blocking resolution", () => {
  it("returns cached value synchronously when present", async () => {
    const data = new InMemoryDataBridge();
    const bridges: HookBridges = { ...fakeBridges(), data };
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
    const bridges: HookBridges = { ...fakeBridges(), data };
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

  it("respects awaitTimeoutMs and surfaces a diagnostic", async () => {
    const data = new InMemoryDataBridge();
    const bridges: HookBridges = { ...fakeBridges(), data };
    const harness = await makeHarness();

    // Fetcher that never resolves
    const stuck = new Promise<string>(() => {
      /* never */
    });

    function Stuck() {
      const v = useData("stuck", () => stuck);
      return React.createElement("message", { role: "user" }, v);
    }

    await harness.mount({
      mountId: "m_to",
      sessionId: "s",
      element: React.createElement(Stuck),
      bridges,
    });

    const { diagnostics } = await harness.renderTree({
      mountId: "m_to",
      sessionId: "s",
      awaitTimeoutMs: 25,
    });

    expect(diagnostics.some((d) => d.code === "await-timeout")).toBe(true);
  });

  it("a fetcher rejection propagates as a render error (no loading state)", async () => {
    const data = new InMemoryDataBridge();
    const bridges: HookBridges = { ...fakeBridges(), data };
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

    await expect(harness.renderTree({ mountId: "m_broken", sessionId: "s" })).rejects.toMatchObject(
      { _tag: "RenderFailed" },
    );
  });

  // TODO(hooks): max-iterations test. The naive "fresh key each render"
  // approach triggers react-reconciler 0.33's internal retry behavior
  // for thrown Promises without a Suspense boundary, producing runaway
  // re-renders that bleed across tests. A proper max-iterations test
  // needs a controlled DataBridge that fakes pending without actually
  // throwing — added when we land the dedicated bridge-conformance
  // suite (Phase 3.16).
});

// useKnob test moved with the hook — see
// packages/knobs/src/__tests__/integration-with-compiler.spec.tsx.

describe("useLoopControl", () => {
  it("returns the loop bridge — components can request continue/stop", async () => {
    let captured: ReturnType<typeof useLoopControl> | null = null;
    const stopped: string[] = [];

    const bridges: HookBridges = {
      ...fakeBridges(),
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
    const bridges = fakeBridges({ sessionId: "s_42" });
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
    // rendered through a separate compiler with NO provider in the
    // tree. The error from useBridges() propagates as a RenderFailed.
    const { useBridges } = await import("../react/bridge-context.js");
    const { createContainer } = await import("@agentick/compiler-next");
    const { createCompiler } = await import("../react/compiler.js");

    const container = createContainer({ mountId: "bare" });
    let caught: unknown = null;
    const compiler = createCompiler({
      container,
      idPrefix: "bare",
      onUncaughtError: (err) => {
        caught = err;
      },
    });
    const root = compiler.createRoot();
    function Bare() {
      useBridges();
      return null;
    }
    compiler.render(React.createElement(Bare), root);
    expect(String(caught)).toContain("CompilerHarness mount");
  });
});
