import { describe, expect, it } from "vitest";
import React from "react";
import type { ReactNode } from "react";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ReconcilerHarness } from "../harness/reconciler-harness.js";
import { stubBridges } from "../bridges/stub-bridges.js";
import { useData } from "../react/hooks/use-data.js";

async function makeHarness(scope = `bd-${Math.random()}`) {
  const harness = new ReconcilerHarness(
    scope,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

/**
 * Class-component error boundary — caught errors render `fallback`.
 */
class ErrorBoundary extends React.Component<
  { fallback: ReactNode; children?: ReactNode },
  { caught: boolean }
> {
  state = { caught: false };
  static getDerivedStateFromError(): { caught: boolean } {
    return { caught: true };
  }
  override render(): ReactNode {
    return this.state.caught ? this.props.fallback : this.props.children;
  }
}

function Throws(): ReactNode {
  throw new Error("intentional render failure");
}

describe("boundary diagnostics — baseline", () => {
  it("clean render emits no diagnostics", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_clean",
      sessionId: "s",
      element: React.createElement("message", { role: "user" }, "hi"),
      bridges: stubBridges(),
    });
    const { diagnostics } = await harness.renderTree({
      mountId: "m_clean",
      sessionId: "s",
    });
    expect(diagnostics).toEqual([]);
  });

  it("useData (no boundary in tree) emits no boundary diagnostic", async () => {
    const harness = await makeHarness();
    function App() {
      const v = useData("ok", async () => "Ryan");
      return React.createElement("message", { role: "user" }, v);
    }
    await harness.mount({
      mountId: "m_noboundary",
      sessionId: "s",
      element: React.createElement(App),
      bridges: stubBridges(),
    });
    const { diagnostics } = await harness.renderTree({
      mountId: "m_noboundary",
      sessionId: "s",
    });
    expect(diagnostics).toEqual([]);
  });
});

describe("error-boundary-active diagnostic", () => {
  it("an in-tree ErrorBoundary catching a render error emits an info diagnostic", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_eb",
      sessionId: "s",
      element: React.createElement(
        ErrorBoundary,
        {
          fallback: React.createElement(
            "message",
            { role: "system" },
            "[knowledge base unavailable]",
          ),
        },
        React.createElement(Throws),
      ),
      bridges: stubBridges(),
    });
    const { diagnostics, tree } = await harness.renderTree({
      mountId: "m_eb",
      sessionId: "s",
    });

    expect(diagnostics.some((d) => d.code === "error-boundary-active")).toBe(true);
    const ebDiag = diagnostics.find((d) => d.code === "error-boundary-active")!;
    expect(ebDiag.severity).toBe("info");

    // The fallback content lands in the IR — that's the designed
    // behavior of error boundaries.
    const m = tree.context.entries[0]!;
    if (m.kind !== "message") throw new Error("expected message");
    expect(m.content).toEqual([{ type: "text", text: "[knowledge base unavailable]" }]);
  });

  it("no ErrorBoundary in the tree → render error → RenderFailed (no diagnostic)", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_no_eb",
      sessionId: "s",
      element: React.createElement(Throws),
      bridges: stubBridges(),
    });
    await expect(
      harness.renderTree({ mountId: "m_no_eb", sessionId: "s" }),
    ).rejects.toMatchObject({ _tag: "RenderFailed" });
  });

  it("ErrorBoundary diagnostic is emitted at most once per renderTree", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_eb_once",
      sessionId: "s",
      element: React.createElement(
        ErrorBoundary,
        { fallback: React.createElement("message", { role: "system" }, "x") },
        React.createElement(Throws),
      ),
      bridges: stubBridges(),
    });
    const { diagnostics } = await harness.renderTree({
      mountId: "m_eb_once",
      sessionId: "s",
    });
    const ebDiags = diagnostics.filter((d) => d.code === "error-boundary-active");
    expect(ebDiags).toHaveLength(1);
  });
});
