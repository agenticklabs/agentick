/**
 * Gates — knob-backed continuation conditions, exercised through the
 * React `useGate` binding.
 *
 * ADR 67: `useGate` is REGISTRATION-ONLY — it registers the descriptor
 * into the in-scope {@link GatesController} (here transported on the
 * bridge bundle, exactly as the real session does) and reflects the knob
 * value; it does NOT subscribe a tick-end source. Evaluation is DRIVEN by
 * the session's continuation decision, which calls
 * `controller.handleTickEnd(result)`. These tests therefore mount
 * `useGate`, then drive the controller directly — proving the React
 * registration reaches a controller that evaluates correctly (arming,
 * verification, blocking, defer/clear, element rendering, read-only knob).
 * The programmatic half lives in `controller.spec.ts` over the SAME core.
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { HookBridges, TickResult, SectionEntry } from "@agentick/spec-next";

import { CompilerHarness } from "@agentick/compiler-react-next";
import { fakeBridges } from "@agentick/compiler-next";
import { stubKnobsHarness } from "@agentick/knobs-next/testing";
import { flush } from "@agentick/compiler-react-next/testing";
import { gate } from "../descriptor.js";
import { GatesController } from "../controller.js";
import { spyLoopControl, type SpyLoopControl } from "../testing/index.js";
import { useGate, type GateState } from "../react/use-gate.js";

async function makeHarness() {
  const harness = new CompilerHarness(
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

/**
 * Mount a `useGate` over a session-style transported controller (ADR 67):
 * the controller rides `bridges.gates` (the same runtime transport the
 * real session uses), `useGate` registers into it, and the test drives
 * `controller.handleTickEnd(result)` — the seam `session.notifyLifecycle`
 * now owns. The `loop` spy IS the controller's continuation seam, so a
 * blocking gate's `continueAfterTick` is observable via `loop.continueCalls`.
 */
async function mountGate(name: string, opts: Parameters<typeof gate>[0]) {
  const knobs = stubKnobsHarness();
  const loop: SpyLoopControl = spyLoopControl();
  const controller = new GatesController({ knobs, loopControl: loop });
  const bridges = { ...fakeBridges(), knobs } as HookBridges;
  (bridges as { gates?: GatesController }).gates = controller;
  const harness = await makeHarness();
  const { ref, Probe } = captureGate(name, opts);
  const mountId = `m_${Math.random().toString(36).slice(2)}`;
  await harness.mount({
    mountId,
    sessionId: "s",
    element: React.createElement(Probe),
    bridges,
  });
  await flush();
  const tick = async (result: TickResult): Promise<void> => {
    await controller.handleTickEnd(result);
    await flush();
  };
  return { knobs, loop, controller, ref, harness, mountId, tick };
}

// ============================================================================

describe("useGate — activation", () => {
  it("flips inactive → active when activateWhen returns true at tick-end", async () => {
    const { knobs, tick } = await mountGate(
      "verification",
      gate({
        description: "Verification pending",
        instructions: "Run typecheck before completing.",
        activateWhen: (r) => r.toolResults.some((t) => t.toolName === "write_file"),
      }),
    );

    // Tick where a write_file ran → gate should activate.
    await tick(
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
    );

    expect(knobs.get("verification")).toBe("active");
  });

  it("does not activate when activateWhen returns false", async () => {
    const { knobs, tick } = await mountGate(
      "verification",
      gate({
        description: "x",
        instructions: "x",
        activateWhen: () => false,
      }),
    );

    await tick(tickResult({ shouldContinue: true }));

    expect(knobs.get("verification")).toBe("inactive");
  });

  it("does NOT re-activate when state has already been engaged", async () => {
    const activateWhen = vi.fn(() => true);
    const { knobs, ref, tick } = await mountGate(
      "verification",
      gate({ description: "x", instructions: "x", activateWhen }),
    );

    // First tick activates.
    await tick(tickResult({ shouldContinue: true }));
    expect(ref.current?.active).toBe(true);

    // Model defers explicitly.
    ref.current!.defer();
    await flush();
    expect(knobs.get("verification")).toBe("deferred");

    // Subsequent tick: activateWhen should NOT be consulted because
    // state is no longer inactive. State stays as deferred.
    activateWhen.mockClear();
    await tick(tickResult({ shouldContinue: true }));

    expect(activateWhen).not.toHaveBeenCalled();
    expect(knobs.get("verification")).toBe("deferred");
  });
});

describe("useGate — continuation blocking", () => {
  it("forces continueAfterTick when active and shouldContinue is false", async () => {
    const { loop, tick } = await mountGate(
      "verification",
      gate({ description: "x", instructions: "x", activateWhen: () => true }),
    );

    // Tick activates AND would stop → gate blocks.
    await tick(tickResult({ shouldContinue: false }));

    expect(loop.continueCalls).toContain("gate:verification");
  });

  it("does NOT block when active but shouldContinue is true", async () => {
    const { loop, tick } = await mountGate(
      "verification",
      gate({ description: "x", instructions: "x", activateWhen: () => true }),
    );

    await tick(tickResult({ shouldContinue: true }));

    expect(loop.continueCalls).toEqual([]);
  });

  it("un-defers a deferred gate to active when blocking exit", async () => {
    const { knobs, loop, ref, tick } = await mountGate(
      "verification",
      gate({ description: "x", instructions: "x", activateWhen: () => true }),
    );

    // Activate.
    await tick(tickResult({ shouldContinue: true }));
    ref.current!.defer();
    await flush();
    expect(knobs.get("verification")).toBe("deferred");

    // Next tick would stop → un-defer + force continue.
    await tick(tickResult({ shouldContinue: false }));

    expect(knobs.get("verification")).toBe("active");
    expect(loop.continueCalls).toContain("gate:verification");
  });
});

describe("useGate — element rendering", () => {
  it("renders a <section> with title + instructions only when active", async () => {
    const { knobs, harness, mountId } = await mountGate(
      "verification",
      gate({
        description: "Verification pending",
        instructions: "Run typecheck before completing.",
        activateWhen: () => false,
      }),
    );

    // Inactive → no section.
    {
      const { tree } = await harness.renderTree({ mountId, sessionId: "s" });
      expect(tree.context.entries).toEqual([]);
    }

    // Manually flip the knob to active (simulating the model calling knob_set).
    await knobs.set({ id: "verification", value: "active" });
    await flush();

    const { tree } = await harness.renderTree({ mountId, sessionId: "s" });
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
    const { knobs } = await mountGate(
      "verification",
      gate({
        description: "Verification pending",
        instructions: "Run checks before completing.",
        activateWhen: () => false,
      }),
    );

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
    const { knobs, ref, tick } = await mountGate(
      "verification",
      gate({ description: "x", instructions: "x", activateWhen: () => true }),
    );

    await tick(tickResult({ shouldContinue: true }));
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
    const { knobs, loop, tick } = await mountGate(
      "invariant",
      gate({
        description: "Invariant must hold",
        instructions: "GATE: fix the invariant and resubmit.",
        satisfied: () => false,
      }),
    );

    await tick(tickResult({ shouldContinue: false }));

    expect(knobs.get("invariant")).toBe("active");
    expect(loop.continueCalls).toContain("gate:invariant");
  });

  it("auto-clears when the predicate passes — no clear() involved", async () => {
    let valid = false;
    const { knobs, tick } = await mountGate(
      "invariant",
      gate({
        description: "x",
        instructions: "x",
        satisfied: () => valid,
      }),
    );

    // Unsatisfied tick → engaged.
    await tick(tickResult({ shouldContinue: true }));
    expect(knobs.get("invariant")).toBe("active");

    // Condition now holds → next tick end auto-clears.
    valid = true;
    await tick(tickResult({ shouldContinue: true }));
    expect(knobs.get("invariant")).toBe("inactive");
  });

  it("re-engages when the condition regresses on a later tick", async () => {
    let valid = true;
    const { knobs, tick } = await mountGate(
      "invariant",
      gate({
        description: "x",
        instructions: "x",
        satisfied: () => valid,
      }),
    );

    // Satisfied tick → stays inactive.
    await tick(tickResult({ shouldContinue: true }));
    expect(knobs.get("invariant")).toBe("inactive");

    // Regression → re-engages without any activateWhen-style arming.
    valid = false;
    await tick(tickResult({ shouldContinue: true }));
    expect(knobs.get("invariant")).toBe("active");
  });

  it("supports async predicates", async () => {
    const { knobs, tick } = await mountGate(
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

    await tick(tickResult({ shouldContinue: true }));

    expect(knobs.get("invariant")).toBe("inactive");
  });

  it("fail-closed: a throwing predicate engages the gate", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { knobs, loop, tick } = await mountGate(
      "invariant",
      gate({
        description: "x",
        instructions: "x",
        satisfied: () => {
          throw new Error("broken verifier");
        },
      }),
    );

    await tick(tickResult({ shouldContinue: false }));

    expect(knobs.get("invariant")).toBe("active");
    expect(loop.continueCalls).toContain("gate:invariant");
    errorSpy.mockRestore();
  });

  it("registers a read-only knob with two options", async () => {
    const { knobs } = await mountGate(
      "invariant",
      gate({
        description: "Verified invariant",
        instructions: "x",
        satisfied: () => false,
      }),
    );

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

  it("the knob_set dispatch pipeline rejects writes to a verified gate's knob", async () => {
    const { knobs, tick } = await mountGate(
      "invariant",
      gate({
        description: "x",
        instructions: "x",
        satisfied: () => false,
      }),
    );

    // Engage the gate.
    await tick(tickResult({ shouldContinue: true }));
    expect(knobs.get("invariant")).toBe("active");

    // Model tries to knob itself past verification — dispatch refuses.
    const blocks = await knobs.dispatch({ name: "invariant", value: "inactive" });
    expect((blocks[0] as { text?: string }).text).toContain("read-only");
    expect(knobs.get("invariant")).toBe("active");
  });

  it("defer() is a no-op on verified gates", async () => {
    const { knobs, ref, tick } = await mountGate(
      "invariant",
      gate({
        description: "x",
        instructions: "x",
        satisfied: () => false,
      }),
    );

    await tick(tickResult({ shouldContinue: true }));
    expect(knobs.get("invariant")).toBe("active");

    ref.current!.defer();
    await flush();

    expect(knobs.get("invariant")).toBe("active");
    expect(ref.current?.deferred).toBe(false);
  });
});

describe("useGate — verified gates with arming (activateWhen + satisfied)", () => {
  it("stays dormant while unarmed: no verification, no blocking", async () => {
    const satisfied = vi.fn(() => false);
    const { knobs, loop, tick } = await mountGate(
      "typecheck",
      gate({
        description: "Typecheck must pass after edits",
        instructions: "Run the typecheck and fix errors.",
        activateWhen: (r) => r.toolResults.some((t) => t.toolName === "edit_file"),
        satisfied,
      }),
    );

    // No edit happened; loop wants to stop → gate must not interfere.
    await tick(tickResult({ shouldContinue: false }));

    expect(satisfied).not.toHaveBeenCalled();
    expect(knobs.get("typecheck")).toBe("inactive");
    expect(loop.continueCalls).toEqual([]);
  });

  it("arms on trigger and verifies the same tick; stays armed after passing", async () => {
    let typecheckPasses = false;
    const { knobs, loop, tick } = await mountGate(
      "typecheck",
      gate({
        description: "x",
        instructions: "x",
        activateWhen: (r) => r.toolResults.some((t) => t.toolName === "edit_file"),
        satisfied: () => typecheckPasses,
      }),
    );

    // Edit tick: arms AND verifies same tick → unsatisfied → engaged + blocks.
    await tick(
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
    );
    expect(knobs.get("typecheck")).toBe("active");
    expect(loop.continueCalls).toContain("gate:typecheck");

    // Typecheck now passes → auto-clears.
    typecheckPasses = true;
    await tick(tickResult({ shouldContinue: true }));
    expect(knobs.get("typecheck")).toBe("inactive");

    // Regression while STILL ARMED (no new edit needed) → re-engages.
    typecheckPasses = false;
    await tick(tickResult({ shouldContinue: true }));
    expect(knobs.get("typecheck")).toBe("active");
  });
});
