/**
 * Gates — knob-backed continuation conditions.
 *
 * Verifies activation, continuation blocking, defer/clear, the rendered
 * `<section>` element, and that the `set_knob` analog (direct knob bridge
 * `set`) does the right thing.
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { HookBridges, LifecycleTickEnd, TickResult, SectionEntry } from "@agentick/spec-next";

import { ReconcilerHarness } from "@agentick/reconciler-react-next";
import { fakeBridges } from "@agentick/reconciler-next";
import { stubKnobsHarness } from "@agentick/knobs-next/testing";
import { flush } from "@agentick/reconciler-react-next/testing";
import { gate } from "../descriptor.js";
import { useGate, type GateState } from "../react/use-gate.js";

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
    const knobs = stubKnobsHarness();
    const bridges: HookBridges = { ...fakeBridges(), knobs };
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
    const knobs = stubKnobsHarness();
    const bridges: HookBridges = { ...fakeBridges(), knobs };
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
    const knobs = stubKnobsHarness();
    const bridges: HookBridges = { ...fakeBridges(), knobs };
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
    const knobs = stubKnobsHarness();
    const continueAfterTick = vi.fn();
    const bridges: HookBridges = {
      ...fakeBridges(),
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
    const knobs = stubKnobsHarness();
    const continueAfterTick = vi.fn();
    const bridges: HookBridges = {
      ...fakeBridges(),
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
    const knobs = stubKnobsHarness();
    const continueAfterTick = vi.fn();
    const bridges: HookBridges = {
      ...fakeBridges(),
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
    const knobs = stubKnobsHarness();
    const bridges: HookBridges = { ...fakeBridges(), knobs };
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
    await knobs.set({ id: "verification", value: "active" });
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
    const knobs = stubKnobsHarness();
    const bridges: HookBridges = { ...fakeBridges(), knobs };
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
    const knobs = stubKnobsHarness();
    const bridges: HookBridges = { ...fakeBridges(), knobs };
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

// ============================================================================
// Verified gates (level-triggered, code-cleared)
// ============================================================================

describe("useGate — verified gates", () => {
  it("engages when unsatisfied and forces continueAfterTick on stop", async () => {
    const knobs = stubKnobsHarness();
    const continueAfterTick = vi.fn();
    const bridges: HookBridges = {
      ...fakeBridges(),
      knobs,
      loop: { continueAfterTick, stopAfterTick: vi.fn() },
    };
    const harness = await makeHarness();
    const { Probe } = captureGate(
      "invariant",
      gate({
        description: "Invariant must hold",
        instructions: "GATE: fix the invariant and resubmit.",
        satisfied: () => false,
      }),
    );

    await harness.mount({
      mountId: "m_v_blk",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });
    await flush();

    await harness.notifyLifecycle({
      mountId: "m_v_blk",
      event: tickEnd(tickResult({ shouldContinue: false })),
    });
    await flush();

    expect(knobs.get("invariant")).toBe("active");
    expect(continueAfterTick).toHaveBeenCalledWith("gate:invariant");
  });

  it("auto-clears when the predicate passes — no clear() involved", async () => {
    const knobs = stubKnobsHarness();
    const bridges: HookBridges = { ...fakeBridges(), knobs };
    const harness = await makeHarness();
    let valid = false;
    const { Probe } = captureGate(
      "invariant",
      gate({
        description: "x",
        instructions: "x",
        satisfied: () => valid,
      }),
    );

    await harness.mount({
      mountId: "m_v_clr",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });
    await flush();

    // Unsatisfied tick → engaged.
    await harness.notifyLifecycle({
      mountId: "m_v_clr",
      event: tickEnd(tickResult({ shouldContinue: true })),
    });
    await flush();
    expect(knobs.get("invariant")).toBe("active");

    // Condition now holds → next tick end auto-clears.
    valid = true;
    await harness.notifyLifecycle({
      mountId: "m_v_clr",
      event: tickEnd(tickResult({ shouldContinue: true })),
    });
    await flush();
    expect(knobs.get("invariant")).toBe("inactive");
  });

  it("re-engages when the condition regresses on a later tick", async () => {
    const knobs = stubKnobsHarness();
    const bridges: HookBridges = { ...fakeBridges(), knobs };
    const harness = await makeHarness();
    let valid = true;
    const { Probe } = captureGate(
      "invariant",
      gate({
        description: "x",
        instructions: "x",
        satisfied: () => valid,
      }),
    );

    await harness.mount({
      mountId: "m_v_regress",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });
    await flush();

    // Satisfied tick → stays inactive.
    await harness.notifyLifecycle({
      mountId: "m_v_regress",
      event: tickEnd(tickResult({ shouldContinue: true })),
    });
    await flush();
    expect(knobs.get("invariant")).toBe("inactive");

    // Regression → re-engages without any activateWhen-style arming.
    valid = false;
    await harness.notifyLifecycle({
      mountId: "m_v_regress",
      event: tickEnd(tickResult({ shouldContinue: true })),
    });
    await flush();
    expect(knobs.get("invariant")).toBe("active");
  });

  it("supports async predicates", async () => {
    const knobs = stubKnobsHarness();
    const bridges: HookBridges = { ...fakeBridges(), knobs };
    const harness = await makeHarness();
    const { Probe } = captureGate(
      "invariant",
      gate({
        description: "x",
        instructions: "x",
        satisfied: async () => {
          await new Promise((r) => setTimeout(r, 1));
          return true;
        },
      }),
    );

    await harness.mount({
      mountId: "m_v_async",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });
    await flush();

    await harness.notifyLifecycle({
      mountId: "m_v_async",
      event: tickEnd(tickResult({ shouldContinue: true })),
    });
    await flush();

    expect(knobs.get("invariant")).toBe("inactive");
  });

  it("fail-closed: a throwing predicate engages the gate", async () => {
    const knobs = stubKnobsHarness();
    const continueAfterTick = vi.fn();
    const bridges: HookBridges = {
      ...fakeBridges(),
      knobs,
      loop: { continueAfterTick, stopAfterTick: vi.fn() },
    };
    const harness = await makeHarness();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { Probe } = captureGate(
      "invariant",
      gate({
        description: "x",
        instructions: "x",
        satisfied: () => {
          throw new Error("broken verifier");
        },
      }),
    );

    await harness.mount({
      mountId: "m_v_throw",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });
    await flush();

    await harness.notifyLifecycle({
      mountId: "m_v_throw",
      event: tickEnd(tickResult({ shouldContinue: false })),
    });
    await flush();

    expect(knobs.get("invariant")).toBe("active");
    expect(continueAfterTick).toHaveBeenCalledWith("gate:invariant");
    errorSpy.mockRestore();
  });

  it("registers a read-only knob with two options", async () => {
    const knobs = stubKnobsHarness();
    const bridges: HookBridges = { ...fakeBridges(), knobs };
    const harness = await makeHarness();
    const { Probe } = captureGate(
      "invariant",
      gate({
        description: "Verified invariant",
        instructions: "x",
        satisfied: () => false,
      }),
    );

    await harness.mount({
      mountId: "m_v_desc",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });
    await flush();

    const invariant = knobs.list().find((k) => k.id === "invariant");
    expect(invariant).toMatchObject({
      id: "invariant",
      value: "inactive",
      description: "Verified invariant",
      valueType: "string",
      group: "gates",
      options: ["inactive", "active"],
      readOnly: true,
    });
  });

  it("the set_knob dispatch pipeline rejects writes to a verified gate's knob", async () => {
    const knobs = stubKnobsHarness();
    const bridges: HookBridges = { ...fakeBridges(), knobs };
    const harness = await makeHarness();
    const { Probe } = captureGate(
      "invariant",
      gate({
        description: "x",
        instructions: "x",
        satisfied: () => false,
      }),
    );

    await harness.mount({
      mountId: "m_v_dispatch",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });
    await flush();

    // Engage the gate.
    await harness.notifyLifecycle({
      mountId: "m_v_dispatch",
      event: tickEnd(tickResult({ shouldContinue: true })),
    });
    await flush();
    expect(knobs.get("invariant")).toBe("active");

    // Model tries to knob itself past verification — dispatch refuses.
    const blocks = await knobs.dispatch({ name: "invariant", value: "inactive" });
    expect((blocks[0] as { text?: string }).text).toContain("read-only");
    expect(knobs.get("invariant")).toBe("active");
  });

  it("defer() is a no-op on verified gates", async () => {
    const knobs = stubKnobsHarness();
    const bridges: HookBridges = { ...fakeBridges(), knobs };
    const harness = await makeHarness();
    const { ref, Probe } = captureGate(
      "invariant",
      gate({
        description: "x",
        instructions: "x",
        satisfied: () => false,
      }),
    );

    await harness.mount({
      mountId: "m_v_defer",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });
    await flush();

    await harness.notifyLifecycle({
      mountId: "m_v_defer",
      event: tickEnd(tickResult({ shouldContinue: true })),
    });
    await flush();
    expect(knobs.get("invariant")).toBe("active");

    ref.current!.defer();
    await flush();

    expect(knobs.get("invariant")).toBe("active");
    expect(ref.current?.deferred).toBe(false);
  });
});

describe("useGate — verified gates with arming (activateWhen + satisfied)", () => {
  it("stays dormant while unarmed: no verification, no blocking", async () => {
    const knobs = stubKnobsHarness();
    const continueAfterTick = vi.fn();
    const bridges: HookBridges = {
      ...fakeBridges(),
      knobs,
      loop: { continueAfterTick, stopAfterTick: vi.fn() },
    };
    const harness = await makeHarness();
    const satisfied = vi.fn(() => false);
    const { Probe } = captureGate(
      "typecheck",
      gate({
        description: "Typecheck must pass after edits",
        instructions: "Run the typecheck and fix errors.",
        activateWhen: (r) => r.toolResults.some((t) => t.toolName === "edit_file"),
        satisfied,
      }),
    );

    await harness.mount({
      mountId: "m_arm_dormant",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });
    await flush();

    // No edit happened; loop wants to stop → gate must not interfere.
    await harness.notifyLifecycle({
      mountId: "m_arm_dormant",
      event: tickEnd(tickResult({ shouldContinue: false })),
    });
    await flush();

    expect(satisfied).not.toHaveBeenCalled();
    expect(knobs.get("typecheck")).toBe("inactive");
    expect(continueAfterTick).not.toHaveBeenCalled();
  });

  it("arms on trigger and verifies the same tick; stays armed after passing", async () => {
    const knobs = stubKnobsHarness();
    const continueAfterTick = vi.fn();
    const bridges: HookBridges = {
      ...fakeBridges(),
      knobs,
      loop: { continueAfterTick, stopAfterTick: vi.fn() },
    };
    const harness = await makeHarness();
    let typecheckPasses = false;
    const { Probe } = captureGate(
      "typecheck",
      gate({
        description: "x",
        instructions: "x",
        activateWhen: (r) => r.toolResults.some((t) => t.toolName === "edit_file"),
        satisfied: () => typecheckPasses,
      }),
    );

    await harness.mount({
      mountId: "m_arm_verify",
      sessionId: "s",
      element: React.createElement(Probe),
      bridges,
    });
    await flush();

    // Edit tick: arms AND verifies same tick → unsatisfied → engaged + blocks.
    await harness.notifyLifecycle({
      mountId: "m_arm_verify",
      event: tickEnd(
        tickResult({
          shouldContinue: false,
          toolResults: [
            {
              toolCallId: "c1",
              toolName: "edit_file",
              succeeded: true,
              content: [],
              durationMs: 1,
            },
          ],
        }),
      ),
    });
    await flush();
    expect(knobs.get("typecheck")).toBe("active");
    expect(continueAfterTick).toHaveBeenCalledWith("gate:typecheck");

    // Typecheck now passes → auto-clears.
    typecheckPasses = true;
    await harness.notifyLifecycle({
      mountId: "m_arm_verify",
      event: tickEnd(tickResult({ shouldContinue: true })),
    });
    await flush();
    expect(knobs.get("typecheck")).toBe("inactive");

    // Regression while STILL ARMED (no new edit needed) → re-engages.
    typecheckPasses = false;
    await harness.notifyLifecycle({
      mountId: "m_arm_verify",
      event: tickEnd(tickResult({ shouldContinue: true })),
    });
    await flush();
    expect(knobs.get("typecheck")).toBe("active");
  });
});
