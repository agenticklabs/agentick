/**
 * ADR 56 — `useModelRegistration` (the tool pattern, for models).
 *
 * Isolates THE crux: a render-time hook contributes
 * `declarations.model` to the synchronous IR via the SAME path
 * `declarations.tools` uses (a rendered host intrinsic the collector
 * walks) AND registers the run-ready `RegisteredModel` on the
 * `ModelBridge`. No loop, no adapter — this proves the emission +
 * registration mechanism in isolation. The real-loop resolution +
 * precedence is proven end-to-end in
 * `@agentick/session-next`'s `model-bridge.spec.tsx`.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { InMemoryModelBridge, fakeBridges } from "@agentick/compiler-next";
import type { HookBridges, RegisteredModel } from "@agentick/spec-next";

import { useModelRegistration } from "../react/hooks/use-model-registration.js";
import { CompilerHarness } from "../harness/compiler-harness.js";

// Inert `RegisteredModel` — the model-executor is NEVER invoked in this
// test (no loop runs). We only assert the ref reaches the bridge and the
// IR. The session integration test uses the real `FakeLanguageModelExecutor`.
const inertModel: RegisteredModel = {
  modelExecutor: {} as RegisteredModel["modelExecutor"],
  target: { kind: "language-model", provider: "mock", modelId: "m1-model" },
};

async function makeHarness() {
  const harness = new CompilerHarness(
    "h_model_reg",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

describe("compiler-react useModelRegistration — render-time wiring (ADR 56)", () => {
  it("contributes declarations.model AND registers on the ModelBridge", async () => {
    const models = new InMemoryModelBridge();
    const bridges: HookBridges = { ...fakeBridges(), models };

    function Agent() {
      return useModelRegistration("m1", inertModel);
    }

    const harness = await makeHarness();
    await harness.mount({
      mountId: "m1",
      sessionId: "s1",
      element: React.createElement(Agent),
      bridges,
    });
    const { tree, diagnostics } = await harness.renderTree({
      mountId: "m1",
      sessionId: "s1",
    });

    // IR side — same mechanism as declarations.tools (host intrinsic →
    // contributor → fold).
    expect(diagnostics).toEqual([]);
    expect(tree.declarations?.model?.modelRef).toBe("m1");

    // Live side — the effect registered the run-ready model on the bridge.
    expect(models.resolve("m1")).toBe(inertModel);
  });

  it("still emits declarations.model when no ModelBridge is wired", async () => {
    // Drop the `models` slot — the hook's registration effect no-ops, but
    // the IR contribution (a rendered host intrinsic) is independent of
    // the bridge, exactly like the <tool> declaration.
    const { models: _dropped, ...rest } = fakeBridges() as HookBridges & {
      models?: unknown;
    };
    const bridges = rest as HookBridges;

    function Agent() {
      return useModelRegistration("m2", inertModel);
    }

    const harness = await makeHarness();
    await harness.mount({
      mountId: "m2",
      sessionId: "s2",
      element: React.createElement(Agent),
      bridges,
    });
    const { tree, diagnostics } = await harness.renderTree({
      mountId: "m2",
      sessionId: "s2",
    });

    expect(diagnostics).toEqual([]);
    expect(tree.declarations?.model?.modelRef).toBe("m2");
  });

  it("warns when modelRef is empty (contributor diagnostic)", async () => {
    const bridges: HookBridges = { ...fakeBridges(), models: new InMemoryModelBridge() };

    function Agent() {
      return useModelRegistration("", inertModel);
    }

    const harness = await makeHarness();
    await harness.mount({
      mountId: "m3",
      sessionId: "s3",
      element: React.createElement(Agent),
      bridges,
    });
    const { tree, diagnostics } = await harness.renderTree({
      mountId: "m3",
      sessionId: "s3",
    });

    expect(tree.declarations?.model).toBeUndefined();
    expect(diagnostics.some((d) => d.code === "MISSING_MODEL_REF")).toBe(true);
  });
});
