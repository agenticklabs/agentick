/**
 * `GatesController` — the shared wiring core, exercised programmatically
 * (no React, no mount). Drives `handleTickEnd` directly and asserts via
 * the loop-control spy + the real stub-knobs dispatch pipeline. These
 * are the "programmatic" half of the two front-ends; `gate.spec.tsx`
 * covers the React `useGate` half over the SAME core.
 */

import { describe, expect, it, vi } from "vitest";
import type { TickResult } from "@agentick/spec";
import { stubKnobsHarness } from "@agentick/knobs/testing";

import { gate } from "../descriptor.js";
import { GatesController } from "../controller.js";
import { fakeGatesController, spyLoopControl } from "../testing/index.js";

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

    // Host clear releases (the equivalent of the model clearing via knob_set).
    await handle.clear();
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
    await handle.defer();
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
    // model's knob_set path) sees the read-only descriptor the controller
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
    await handle.override("inactive", "manual unblock");
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

  it("override() rejects on a latch gate (use clear there)", async () => {
    const { controller } = fakeGatesController();
    const handle = controller.register(
      "latch",
      gate({ description: "x", instructions: "x", activateWhen: () => true }),
    );
    // Mutations are async now; the verified-only rule surfaces as a rejection.
    await expect(handle.override("inactive")).rejects.toThrow(/verified-gate escape/);
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

  it("list()/get() unify over a parent layer; self shadows parent by name", () => {
    const parent = fakeGatesController();
    parent.controller.register(
      "parent-only",
      gate({ description: "P", instructions: "x", activateWhen: () => false }),
    );
    parent.controller.register(
      "shared",
      gate({ description: "parent-shared", instructions: "x", activateWhen: () => false }),
    );

    const child = new GatesController({
      knobs: stubKnobsHarness(),
      loopControl: spyLoopControl(),
      parent: parent.controller,
    });
    child.register(
      "child-only",
      gate({ description: "C", instructions: "x", satisfied: () => true }),
    );
    child.register(
      "shared",
      gate({ description: "child-shared", instructions: "x", satisfied: () => true }),
    );

    const byName = new Map(child.list().map((g) => [g.name, g]));
    expect([...byName.keys()].sort()).toEqual(["child-only", "parent-only", "shared"]);
    // Self shadows the parent's `shared` row entirely (child's species + description win).
    expect(byName.get("shared")).toMatchObject({ verified: true, description: "child-shared" });
    // Parent-only rows fall through.
    expect(byName.get("parent-only")).toMatchObject({ verified: false, description: "P" });

    // get(): self shadows, else falls through to the parent's handle.
    expect(child.get("shared")!.verified).toBe(true);
    expect(child.get("parent-only")).toBe(parent.controller.get("parent-only"));
  });

  it("an inherited (parent) gate still evaluates against the child's tick", async () => {
    const parent = fakeGatesController();
    // Verified, never satisfied → engages + blocks when evaluated.
    parent.controller.register(
      "inherited-inv",
      gate({ description: "x", instructions: "x", satisfied: () => false }),
    );

    const childLoop = spyLoopControl();
    const child = new GatesController({
      knobs: stubKnobsHarness(),
      loopControl: childLoop,
      parent: parent.controller,
    });

    await child.handleTickEnd(tickResult({ shouldContinue: false }));

    // Evaluated in the PARENT's own layer — its knob + its loop, not the child's.
    expect(parent.knobs.get("inherited-inv")).toBe("active");
    expect(parent.loop.continueCalls).toEqual(["gate:inherited-inv"]);
    expect(childLoop.continueCalls).toEqual([]);
  });

  it("a self gate shadows a same-named parent gate during evaluation (parent skipped)", async () => {
    const parent = fakeGatesController();
    // Would engage + block if it ran.
    parent.controller.register(
      "shared",
      gate({ description: "P", instructions: "x", satisfied: () => false }),
    );

    const childKnobs = stubKnobsHarness();
    const childLoop = spyLoopControl();
    const child = new GatesController({
      knobs: childKnobs,
      loopControl: childLoop,
      parent: parent.controller,
    });
    // The effective (self) gate by that name is satisfied → does not block.
    child.register("shared", gate({ description: "C", instructions: "x", satisfied: () => true }));

    await child.handleTickEnd(tickResult({ shouldContinue: false }));

    expect(childKnobs.get("shared")).toBe("inactive");
    // The shadowed parent gate was SKIPPED — never engaged, never blocked.
    expect(parent.knobs.get("shared")).toBe("inactive");
    expect(parent.loop.continueCalls).toEqual([]);
  });
});
