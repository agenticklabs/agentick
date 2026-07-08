/**
 * `GatesController` — the shared wiring core, exercised programmatically
 * (no React, no mount). Drives `handleTickEnd` directly and asserts via
 * the loop-control spy + the real stub-knobs dispatch pipeline. These
 * are the "programmatic" half of the two front-ends; `gate.spec.tsx`
 * covers the React `useGate` half over the SAME core.
 */

import { describe, expect, it, vi } from "vitest";
import type { TickResult } from "@agentick/spec-next";
import { stubKnobsHarness } from "@agentick/knobs-next/testing";

import { gate } from "../descriptor.js";
import { fakeGatesController } from "../testing/index.js";

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
      result: { kind: "language-model-result", ticks: [], usage: { totalTokens: 0 } },
    } as unknown as TickResult["executorTerminal"],
    toolResults: [],
    ...overrides,
  };
}

const wrote = (tool: string): Pick<TickResult, "toolResults"> => ({
  toolResults: [{ toolCallId: "c1", toolName: tool, succeeded: true, content: [], durationMs: 1 }],
});

// ============================================================================

describe("GatesController — programmatic latch gate", () => {
  it("arms on the trigger tick, blocks the loop, and clear() releases", async () => {
    const { controller, knobs, loop } = fakeGatesController();
    const handle = controller.register(
      "review",
      gate({
        description: "Await review",
        instructions: "Review before finishing.",
        activateWhen: (r) => r.toolResults.some((t) => t.toolName === "write_file"),
      }),
    );

    // Non-trigger tick that wants to stop → gate dormant, no block.
    await controller.handleTickEnd(tickResult({ shouldContinue: false }));
    expect(handle.value).toBe("inactive");
    expect(loop.continueCalls).toEqual([]);

    // Trigger tick that wants to stop → arms + blocks.
    await controller.handleTickEnd(tickResult({ shouldContinue: false, ...wrote("write_file") }));
    expect(handle.value).toBe("active");
    expect(knobs.get("review")).toBe("active");
    expect(loop.continueCalls).toEqual(["gate:review"]);

    // Host clear releases (the equivalent of the model clearing via set_knob).
    handle.clear();
    expect(handle.value).toBe("inactive");
    expect(knobs.get("review")).toBe("inactive");
  });

  it("does not re-arm once engaged; deferred un-defers when blocking", async () => {
    const { controller, loop } = fakeGatesController();
    const activateWhen = vi.fn(() => true);
    const handle = controller.register(
      "g",
      gate({ description: "x", instructions: "x", activateWhen }),
    );

    await controller.handleTickEnd(tickResult({ shouldContinue: true }));
    expect(handle.value).toBe("active");
    handle.defer();
    expect(handle.value).toBe("deferred");

    activateWhen.mockClear();
    await controller.handleTickEnd(tickResult({ shouldContinue: false }));
    // Not consulted (state already engaged), and blocking un-defers → active.
    expect(activateWhen).not.toHaveBeenCalled();
    expect(handle.value).toBe("active");
    expect(loop.continueCalls).toEqual(["gate:g"]);
  });
});

describe("GatesController — programmatic verified gate", () => {
  it("engages when unsatisfied, auto-clears on pass, re-engages on regression", async () => {
    const { controller, loop } = fakeGatesController();
    let ok = false;
    const handle = controller.register(
      "inv",
      gate({ description: "x", instructions: "x", satisfied: () => ok }),
    );

    await controller.handleTickEnd(tickResult({ shouldContinue: false }));
    expect(handle.value).toBe("active");
    expect(loop.continueCalls).toEqual(["gate:inv"]);

    ok = true;
    await controller.handleTickEnd(tickResult({ shouldContinue: true }));
    expect(handle.value).toBe("inactive");

    ok = false;
    await controller.handleTickEnd(tickResult({ shouldContinue: true }));
    expect(handle.value).toBe("active");
  });

  it("fail-closed: a throwing predicate engages the gate", async () => {
    const { controller, loop } = fakeGatesController();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    controller.register(
      "inv",
      gate({
        description: "x",
        instructions: "x",
        satisfied: () => {
          throw new Error("broken verifier");
        },
      }),
    );

    await controller.handleTickEnd(tickResult({ shouldContinue: false }));
    expect(controller.get("inv")!.value).toBe("active");
    expect(loop.continueCalls).toEqual(["gate:inv"]);
    errorSpy.mockRestore();
  });

  it("arming scope keeps a verified gate dormant until the trigger", async () => {
    const { controller, loop } = fakeGatesController();
    const satisfied = vi.fn(() => false);
    controller.register(
      "typecheck",
      gate({
        description: "x",
        instructions: "x",
        activateWhen: (r) => r.toolResults.some((t) => t.toolName === "edit_file"),
        satisfied,
      }),
    );

    await controller.handleTickEnd(tickResult({ shouldContinue: false }));
    expect(satisfied).not.toHaveBeenCalled();
    expect(controller.get("typecheck")!.value).toBe("inactive");
    expect(loop.continueCalls).toEqual([]);

    await controller.handleTickEnd(tickResult({ shouldContinue: false, ...wrote("edit_file") }));
    expect(satisfied).toHaveBeenCalled();
    expect(controller.get("typecheck")!.value).toBe("active");
    expect(loop.continueCalls).toEqual(["gate:typecheck"]);
  });

  it("registers a read-only two-state knob the MODEL cannot clear (adversarial)", async () => {
    // Share ONE real stub-knobs harness so the dispatch pipeline (the
    // model's set_knob path) sees the read-only descriptor the controller
    // registered.
    const knobs = stubKnobsHarness();
    const { controller } = fakeGatesController(knobs);
    controller.register(
      "inv",
      gate({ description: "x", instructions: "x", satisfied: () => false }),
    );

    await controller.handleTickEnd(tickResult({ shouldContinue: true }));
    expect(knobs.get("inv")).toBe("active");

    const desc = knobs.list().find((k) => k.id === "inv");
    expect(desc).toMatchObject({ readOnly: true, options: ["inactive", "active"], group: "gates" });

    // Model tries to knob past verification — dispatch refuses; value holds.
    const blocks = await knobs.dispatch({ name: "inv", value: "inactive" });
    expect((blocks[0] as { text?: string }).text).toContain("read-only");
    expect(knobs.get("inv")).toBe("active");
  });
});

describe("GatesController — host override (verified, audited)", () => {
  it("releases a verified gate AND emits an audit envelope; not a model path", async () => {
    const knobs = stubKnobsHarness();
    const { controller, audits } = fakeGatesController(knobs);
    const handle = controller.register(
      "inv",
      gate({ description: "x", instructions: "x", satisfied: () => false }),
    );

    await controller.handleTickEnd(tickResult({ shouldContinue: true }));
    expect(handle.value).toBe("active");

    // The model path (dispatch) is refused — the knob is read-only.
    const refused = await knobs.dispatch({ name: "inv", value: "inactive" });
    expect((refused[0] as { text?: string }).text).toContain("read-only");
    expect(handle.value).toBe("active");

    // The trusted-host escape releases it AND audits.
    handle.override("inactive", "manual unblock");
    expect(handle.value).toBe("inactive");
    expect(knobs.get("inv")).toBe("inactive");
    expect(audits).toEqual([
      expect.objectContaining({
        kind: "gate:override",
        name: "inv",
        value: "inactive",
        reason: "manual unblock",
      }),
    ]);
  });

  it("override() throws on a latch gate (use clear there)", () => {
    const { controller } = fakeGatesController();
    const handle = controller.register(
      "latch",
      gate({ description: "x", instructions: "x", activateWhen: () => true }),
    );
    expect(() => handle.override("inactive")).toThrow(/verified-gate escape/);
  });
});

describe("GatesController — unified registry", () => {
  it("list() shows every registered gate with its species + value", async () => {
    const { controller } = fakeGatesController();
    controller.register(
      "latch",
      gate({ description: "L", instructions: "x", activateWhen: () => false }),
    );
    controller.register(
      "verified",
      gate({ description: "V", instructions: "x", satisfied: () => true }),
    );

    const info = controller.list();
    expect(info).toHaveLength(2);
    expect(info.find((g) => g.name === "latch")).toMatchObject({
      verified: false,
      description: "L",
    });
    expect(info.find((g) => g.name === "verified")).toMatchObject({
      verified: true,
      description: "V",
    });
  });

  it("attach is ref-counted — the tick-end source subscribes once", () => {
    const { controller } = fakeGatesController();
    let subs = 0;
    let unsubs = 0;
    const seam = () => {
      subs += 1;
      return () => {
        unsubs += 1;
      };
    };
    const d1 = controller.attach(seam);
    const d2 = controller.attach(seam);
    expect(subs).toBe(1);
    expect(controller.wired).toBe(true);
    d1();
    expect(unsubs).toBe(0);
    d2();
    expect(unsubs).toBe(1);
    expect(controller.wired).toBe(false);
  });
});
