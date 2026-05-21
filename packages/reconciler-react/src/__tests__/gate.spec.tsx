/**
 * Gates — knob-backed continuation conditions.
 *
 * Verifies activation, continuation blocking, defer/clear, the rendered
 * `<section>` element, and that the `set_knob` analog (direct knob bridge
 * `set`) does the right thing.
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { HookBridges, LifecycleTickEnd, TickResult, SectionEntry } from "@agentick/spec";

import { ReconcilerHarness } from "../harness/reconciler-harness.js";
import { inMemoryKnobBridge, stubBridges } from "../bridges/stub-bridges.js";
import { gate, useGate, type GateState } from "../react/hooks/use-gate.js";
import { flush } from "../testing/flush.js";

async function makeHarness() {
  const harness = new ReconcilerHarness(
    "h_gate",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

/**
 * Build a `TickResult` shape with sensible defaults — tests override the
 * specific fields they care about.
 */
function tickResult(
  overrides: Partial<TickResult> & Pick<TickResult, "shouldContinue">,
): TickResult {
  return {
    executionId: "e1",
    sessionId: "s1",
    tickId: "t1",
    tickIndex: 0,
    executorTerminal: {
      kind: "complete",
      result: {
        kind: "language-model-result",
        ticks: [],
        usage: { totalTokens: 0 },
      },
    } as unknown as TickResult["executorTerminal"],
    toolResults: [],
    ...overrides,
  };
}

function tickEnd(result: TickResult): LifecycleTickEnd {
  return { kind: "tick-end", tickId: result.tickId, result };
}

// Capture the GateState across renders so tests can imperatively poke it
// (call `clear()` / `defer()`) without needing user-event simulation.
function captureGate(name: string, opts: Parameters<typeof gate>[0]) {
  const ref: { current: GateState | null } = { current: null };
  function Probe() {
    const g = useGate(name, opts);
    ref.current = g;
    return g.element;
  }
  return { ref, Probe };
}

// ============================================================================

describe("useGate — activation", () => {
  it("flips inactive → active when activateWhen returns true at tick-end", async () => {
    const knobs = inMemoryKnobBridge();
    const bridges: HookBridges = { ...stubBridges(), knobs };
    const harness = await makeHarness();
    const verification = gate({
      description: "Verification pending",
      instructions: "Run typecheck before completing.",
      activateWhen: (r) => r.toolResults.some((t) => t.toolName === "write_file"),
    });
    const { Probe } = captureGate("verification", verification);

    await harness.mount({
      mountId: "m_act",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });
    await flush();

    // Tick where a write_file ran → gate should activate.
    await harness.notifyLifecycle({
      mountId: "m_act",
      event: tickEnd(
        tickResult({
          shouldContinue: true,
          toolResults: [
            {
              toolCallId: "c1",
              toolName: "write_file",
              succeeded: true,
              content: [],
              durationMs: 1,
            },
          ],
        }),
      ),
    });
    await flush();

    expect(knobs.get("verification")).toBe("active");
  });

  it("does not activate when activateWhen returns false", async () => {
    const knobs = inMemoryKnobBridge();
    const bridges: HookBridges = { ...stubBridges(), knobs };
    const harness = await makeHarness();
    const { Probe } = captureGate(
      "verification",
      gate({
        description: "x",
        instructions: "x",
        activateWhen: () => false,
      }),
    );

    await harness.mount({
      mountId: "m_noact",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });
    await flush();

    await harness.notifyLifecycle({
      mountId: "m_noact",
      event: tickEnd(tickResult({ shouldContinue: true })),
    });
    await flush();

    expect(knobs.get("verification")).toBe("inactive");
  });

  it("does NOT re-activate when state has already been engaged", async () => {
    const knobs = inMemoryKnobBridge();
    const bridges: HookBridges = { ...stubBridges(), knobs };
    const harness = await makeHarness();
    const activateWhen = vi.fn(() => true);
    const { ref, Probe } = captureGate(
      "verification",
      gate({ description: "x", instructions: "x", activateWhen }),
    );

    await harness.mount({
      mountId: "m_once",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });
    await flush();

    // First tick activates.
    await harness.notifyLifecycle({
      mountId: "m_once",
      event: tickEnd(tickResult({ shouldContinue: true })),
    });
    await flush();
    expect(ref.current?.active).toBe(true);

    // Model defers explicitly.
    ref.current!.defer();
    await flush();
    expect(knobs.get("verification")).toBe("deferred");

    // Subsequent tick: activateWhen should NOT be consulted because
    // state is no longer inactive. State stays as deferred.
    activateWhen.mockClear();
    await harness.notifyLifecycle({
      mountId: "m_once",
      event: tickEnd(tickResult({ shouldContinue: true })),
    });
    await flush();

    expect(activateWhen).not.toHaveBeenCalled();
    expect(knobs.get("verification")).toBe("deferred");
  });
});

describe("useGate — continuation blocking", () => {
  it("forces continueAfterTick when active and shouldContinue is false", async () => {
    const knobs = inMemoryKnobBridge();
    const continueAfterTick = vi.fn();
    const bridges: HookBridges = {
      ...stubBridges(),
      knobs,
      loop: { continueAfterTick, stopAfterTick: vi.fn() },
    };
    const harness = await makeHarness();
    const { Probe } = captureGate(
      "verification",
      gate({ description: "x", instructions: "x", activateWhen: () => true }),
    );

    await harness.mount({
      mountId: "m_blk",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });
    await flush();

    // Tick activates AND would stop → gate blocks.
    await harness.notifyLifecycle({
      mountId: "m_blk",
      event: tickEnd(tickResult({ shouldContinue: false })),
    });
    await flush();

    expect(continueAfterTick).toHaveBeenCalledWith("gate:verification");
  });

  it("does NOT block when active but shouldContinue is true", async () => {
    const knobs = inMemoryKnobBridge();
    const continueAfterTick = vi.fn();
    const bridges: HookBridges = {
      ...stubBridges(),
      knobs,
      loop: { continueAfterTick, stopAfterTick: vi.fn() },
    };
    const harness = await makeHarness();
    const { Probe } = captureGate(
      "verification",
      gate({ description: "x", instructions: "x", activateWhen: () => true }),
    );

    await harness.mount({
      mountId: "m_noblk",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });
    await flush();

    await harness.notifyLifecycle({
      mountId: "m_noblk",
      event: tickEnd(tickResult({ shouldContinue: true })),
    });
    await flush();

    expect(continueAfterTick).not.toHaveBeenCalled();
  });

  it("un-defers a deferred gate to active when blocking exit", async () => {
    const knobs = inMemoryKnobBridge();
    const continueAfterTick = vi.fn();
    const bridges: HookBridges = {
      ...stubBridges(),
      knobs,
      loop: { continueAfterTick, stopAfterTick: vi.fn() },
    };
    const harness = await makeHarness();
    const { ref, Probe } = captureGate(
      "verification",
      gate({ description: "x", instructions: "x", activateWhen: () => true }),
    );

    await harness.mount({
      mountId: "m_undef",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });
    await flush();

    // Activate.
    await harness.notifyLifecycle({
      mountId: "m_undef",
      event: tickEnd(tickResult({ shouldContinue: true })),
    });
    await flush();
    ref.current!.defer();
    await flush();
    expect(knobs.get("verification")).toBe("deferred");

    // Next tick would stop → un-defer + force continue.
    await harness.notifyLifecycle({
      mountId: "m_undef",
      event: tickEnd(tickResult({ shouldContinue: false })),
    });
    await flush();

    expect(knobs.get("verification")).toBe("active");
    expect(continueAfterTick).toHaveBeenCalledWith("gate:verification");
  });
});

describe("useGate — element rendering", () => {
  it("renders a <section> with title + instructions only when active", async () => {
    const knobs = inMemoryKnobBridge();
    const bridges: HookBridges = { ...stubBridges(), knobs };
    const harness = await makeHarness();
    const { Probe } = captureGate(
      "verification",
      gate({
        description: "Verification pending",
        instructions: "Run typecheck before completing.",
        activateWhen: () => false,
      }),
    );

    await harness.mount({
      mountId: "m_render",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });

    // Inactive → no section.
    {
      const { tree } = await harness.renderTree({ mountId: "m_render", sessionId: "s" });
      expect(tree.context.entries).toEqual([]);
    }

    // Manually flip the knob to active (simulating the model calling set_knob).
    knobs.set("verification", "active");
    await flush();

    const { tree } = await harness.renderTree({ mountId: "m_render", sessionId: "s" });
    const sections = tree.context.entries.filter((e): e is SectionEntry => e.kind === "section");
    expect(sections).toHaveLength(1);
    expect(sections[0]!.id).toBe("gate:verification");
    expect(sections[0]!.title).toBe("Verification pending");
    const text = (sections[0]!.content[0] as { text?: string }).text;
    expect(text).toBe("Run typecheck before completing.");
  });
});

describe("useGate — knob descriptor", () => {
  it("registers description + group + three-state options on the knob bridge", async () => {
    const knobs = inMemoryKnobBridge();
    const bridges: HookBridges = { ...stubBridges(), knobs };
    const harness = await makeHarness();
    const { Probe } = captureGate(
      "verification",
      gate({
        description: "Verification pending",
        instructions: "Run checks before completing.",
        activateWhen: () => false,
      }),
    );

    await harness.mount({
      mountId: "m_desc",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });
    await flush();

    const verification = knobs.list().find((k) => k.id === "verification");
    expect(verification).toMatchObject({
      id: "verification",
      value: "inactive",
      description: "Verification pending",
      valueType: "string",
      group: "gates",
      options: ["inactive", "active", "deferred"],
    });
  });
});

describe("useGate — clear / defer", () => {
  it("clear() flips state to inactive", async () => {
    const knobs = inMemoryKnobBridge();
    const bridges: HookBridges = { ...stubBridges(), knobs };
    const harness = await makeHarness();
    const { ref, Probe } = captureGate(
      "verification",
      gate({ description: "x", instructions: "x", activateWhen: () => true }),
    );

    await harness.mount({
      mountId: "m_clr",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });
    await flush();

    await harness.notifyLifecycle({
      mountId: "m_clr",
      event: tickEnd(tickResult({ shouldContinue: true })),
    });
    await flush();
    expect(ref.current?.active).toBe(true);

    ref.current!.clear();
    await flush();
    expect(knobs.get("verification")).toBe("inactive");
    expect(ref.current?.active).toBe(false);
    expect(ref.current?.engaged).toBe(false);
  });
});
