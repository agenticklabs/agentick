/**
 * `ReconcilerHarness.fx.renderTree` — the dual-typed edge on the real
 * React reconciler (ADR 77 Stage 2). `renderTree` builds its Operation
 * inline (hand-built by registry shape, not a declared command), so `.fx`
 * hand-exposes the `runOperation(op, body)` Effect the facade builds. Its
 * `E` channel is the reconciler taxonomy (`NotMounted` / `RenderFailed`).
 */

import { describe, expect, it } from "vitest";
import React from "react";
import { Effect } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { fakeBridges } from "@agentick/reconciler-next";

import { ReconcilerHarness } from "../harness/reconciler-harness.js";

async function mounted() {
  const harness = new ReconcilerHarness(
    "h_fx",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  const Agent = () =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement("message", { role: "system" }, "hi"),
    );
  await harness.mount({
    mountId: "m",
    sessionId: "s",
    element: React.createElement(Agent),
    bridges: fakeBridges({ sessionId: "s" }),
    defaultFormatter: { id: "markdown", format: "markdown" },
  });
  return harness;
}

describe("ReconcilerHarness — .fx.renderTree dual-typed edge", () => {
  it("fx.renderTree returns a composable Effect that renders", async () => {
    const harness = await mounted();
    const eff = harness.fx.renderTree({ mountId: "m", sessionId: "s" });

    expect(Effect.isEffect(eff)).toBe(true);
    expect(eff).not.toBeInstanceOf(Promise);

    const out = await Effect.runPromise(eff);
    expect(out.iterations).toBe(1);
    expect(out.diagnostics).toEqual([]);
  });

  it("the plain renderTree() is the Promise facade", async () => {
    const harness = await mounted();
    const p = harness.renderTree({ mountId: "m", sessionId: "s" });

    expect(p).toBeInstanceOf(Promise);
    expect(Effect.isEffect(p)).toBe(false);
    expect((await p).iterations).toBe(1);
  });

  it("fx.renderTree fails on the E channel with NotMounted for an unknown mount", async () => {
    const harness = await mounted();
    const exit = await Effect.runPromiseExit(
      harness.fx.renderTree({ mountId: "missing", sessionId: "s" }),
    );
    expect(exit._tag).toBe("Failure");
  });
});
