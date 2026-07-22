/**
 * CompilerHarness — command-lifecycle hook (ADR 80/83). `compiler:render-tree`
 * (op `compiler:command:render-tree`) routes through `runOperation`, so the
 * `CommandRegistry` augmentation in `compiler-harness.ts` mints
 * `onBeforeCompilerRenderTree` / `onAfterCompilerRenderTree`. This test
 * proves the hook fires when `renderTree()` runs.
 */

import { describe, expect, it } from "vitest";
import React from "react";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { fakeBridges } from "@agentick/compiler-next";

import { CompilerHarness } from "../harness/compiler-harness.js";

async function mounted(): Promise<CompilerHarness> {
  const harness = new CompilerHarness(
    "h_hooks",
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

describe("CompilerHarness — render-tree hook (ADR 83)", () => {
  it("onBeforeCompilerRenderTree fires when renderTree() is called", async () => {
    const harness = await mounted();
    let fired = 0;
    let seenInput: unknown;
    const off = harness.hook({
      onBeforeCompilerRenderTree: (input) => {
        fired += 1;
        seenInput = input;
      },
    });

    const out = await harness.renderTree({ mountId: "m", sessionId: "s" });

    expect(fired).toBe(1);
    expect(seenInput).toMatchObject({ mountId: "m", sessionId: "s" });
    expect(out.iterations).toBe(1);

    off();
  });

  it("onAfterCompilerRenderTree sees the RenderTreeResult output", async () => {
    const harness = await mounted();
    let seenOutput: unknown;
    const off = harness.hooks.onAfterCompilerRenderTree((output) => {
      seenOutput = output;
    });

    await harness.renderTree({ mountId: "m", sessionId: "s" });

    expect(seenOutput).toMatchObject({ iterations: expect.any(Number) });

    off();
  });
});
