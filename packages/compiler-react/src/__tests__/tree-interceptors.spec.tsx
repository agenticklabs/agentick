/**
 * Tree-side interceptor REGISTRATION + lifecycle (ADR 89 §4) — the
 * compiler-react half. These test the per-mount `CommandInterceptorRegistry`
 * plumbing IN ISOLATION (mount a JSX tree, assert what the session's
 * forwarder would pull via `collectTreeInterceptors`), without a real loop.
 * The end-to-end "a component vetoes the model's tool call" / "transform
 * injects into the projected model input" tests live in
 * `@agentick/session` (which owns the real loop + executors it drives).
 *
 * @see docs/proposals/v2/blueprint/89-model-harness-and-lifecycle-projection.md §4
 */

import { describe, expect, it } from "vitest";
import React from "react";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { fakeBridges } from "@agentick/compiler";
import { CompilerHarness } from "../harness/compiler-harness.js";
import { useGuardToolDispatch } from "../react/hooks/use-guard-tool-dispatch.js";
import { useTransformToolDispatch } from "../react/hooks/use-transform-tool-dispatch.js";
import { useTransformModelInput } from "../react/hooks/use-transform-model-input.js";
import { useCommandInterceptor } from "../react/hooks/use-command-interceptor.js";
import { useOnToolStart } from "../react/hooks/use-on-tool-start.js";
import { System } from "../react/components/index.js";

// Op tags (`ctx.op`) — the PascalCase suffix the commands carry at dispatch
// and the key the registry stores under.
const TOOL_DISPATCH = "ToolDispatch";
const MODEL_GENERATE = "ModelGenerate";
const MODEL_GENERATE_STREAM = "ModelGenerateStream";

async function makeHarness(id: string): Promise<CompilerHarness> {
  const harness = new CompilerHarness(
    id,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

describe("tree-side interceptor registration (ADR 89 §4)", () => {
  it("useGuardToolDispatch lands ONE interceptor under the tool:dispatch op tag, none elsewhere", async () => {
    const harness = await makeHarness("ti-guard");
    function Agent(): React.ReactElement {
      useGuardToolDispatch(() => "veto");
      return React.createElement(System, null, "a");
    }
    await harness.mount({
      mountId: "m",
      sessionId: "s",
      element: React.createElement(Agent),
      bridges: fakeBridges(),
    });

    expect(harness.collectTreeInterceptors({ mountId: "m", command: TOOL_DISPATCH })).toHaveLength(
      1,
    );
    // Not registered on any other command.
    expect(harness.collectTreeInterceptors({ mountId: "m", command: MODEL_GENERATE })).toHaveLength(
      0,
    );
  });

  it("useTransformModelInput registers on BOTH tick paths (model:generate + model:generate_stream)", async () => {
    const harness = await makeHarness("ti-model");
    function Agent(): React.ReactElement {
      useTransformModelInput(async (input, next) => next(input));
      return React.createElement(System, null, "a");
    }
    await harness.mount({
      mountId: "m",
      sessionId: "s",
      element: React.createElement(Agent),
      bridges: fakeBridges(),
    });

    expect(harness.collectTreeInterceptors({ mountId: "m", command: MODEL_GENERATE })).toHaveLength(
      1,
    );
    expect(
      harness.collectTreeInterceptors({ mountId: "m", command: MODEL_GENERATE_STREAM }),
    ).toHaveLength(1);
  });

  it("the generic useCommandInterceptor targets an arbitrary command by its registry key", async () => {
    const harness = await makeHarness("ti-generic");
    function Agent(): React.ReactElement {
      // Escape-hatch string form — any command the session's forwarder reaches.
      // `tool:dispatch` is not augmented into `CommandRegistry` in THIS
      // package's compilation (compiler-react has no dep on tool-executor), so
      // it hits the escape-hatch overload with erased `unknown` typing — the
      // adopter narrows inside. At a real app (tool-executor imported) the same
      // call is registry-typed.
      useCommandInterceptor(
        "tool:dispatch",
        "transform",
        async (input: unknown, next: (i: unknown) => Promise<unknown>) => next(input),
      );
      return React.createElement(System, null, "a");
    }
    await harness.mount({
      mountId: "m",
      sessionId: "s",
      element: React.createElement(Agent),
      bridges: fakeBridges(),
    });
    expect(harness.collectTreeInterceptors({ mountId: "m", command: TOOL_DISPATCH })).toHaveLength(
      1,
    );
  });

  it("UNMOUNT unregisters: a component removed on rerender drops its interceptor", async () => {
    const harness = await makeHarness("ti-unmount");
    function Guard(): null {
      useGuardToolDispatch(() => "veto");
      return null;
    }
    function App({ show }: { show: boolean }): React.ReactElement {
      return React.createElement(
        React.Fragment,
        null,
        show ? React.createElement(Guard) : null,
        React.createElement(System, null, "a"),
      );
    }
    await harness.mount({
      mountId: "m",
      sessionId: "s",
      element: React.createElement(App, { show: true }),
      bridges: fakeBridges(),
    });
    expect(harness.collectTreeInterceptors({ mountId: "m", command: TOOL_DISPATCH })).toHaveLength(
      1,
    );

    // Rerender without <Guard> — React unmounts it, its useEffect cleanup runs
    // the registry unsubscribe.
    await harness.rerender({ mountId: "m", element: React.createElement(App, { show: false }) });
    expect(harness.collectTreeInterceptors({ mountId: "m", command: TOOL_DISPATCH })).toHaveLength(
      0,
    );
  });

  it("PER-MOUNT isolation: two mounts on ONE harness keep separate registries", async () => {
    const harness = await makeHarness("ti-iso");
    function Guarded(): React.ReactElement {
      useGuardToolDispatch(() => "veto");
      return React.createElement(System, null, "a");
    }
    function Plain(): React.ReactElement {
      return React.createElement(System, null, "b");
    }
    await harness.mount({
      mountId: "mA",
      sessionId: "sA",
      element: React.createElement(Guarded),
      bridges: fakeBridges(),
    });
    await harness.mount({
      mountId: "mB",
      sessionId: "sB",
      element: React.createElement(Plain),
      bridges: fakeBridges(),
    });

    expect(harness.collectTreeInterceptors({ mountId: "mA", command: TOOL_DISPATCH })).toHaveLength(
      1,
    );
    // mB's tree registered NOTHING — mA's guard must not leak.
    expect(harness.collectTreeInterceptors({ mountId: "mB", command: TOOL_DISPATCH })).toHaveLength(
      0,
    );

    // Unmounting mA yields [] for its id (torn-down mount → no stale pull).
    await harness.unmount({ mountId: "mA" });
    expect(harness.collectTreeInterceptors({ mountId: "mA", command: TOOL_DISPATCH })).toHaveLength(
      0,
    );
  });

  it("REGRESSION: an observe hook (useOnToolStart) does NOT leak into the interceptor registry", async () => {
    const harness = await makeHarness("ti-observe");
    function Agent(): React.ReactElement {
      // Both an observe hook AND a guard on the same command.
      useOnToolStart(() => {});
      useGuardToolDispatch(() => "veto");
      return React.createElement(System, null, "a");
    }
    await harness.mount({
      mountId: "m",
      sessionId: "s",
      element: React.createElement(Agent),
      bridges: fakeBridges(),
    });
    // Only the guard is an in-path interceptor; the observe rides the separate
    // LifecycleDispatch push path.
    expect(harness.collectTreeInterceptors({ mountId: "m", command: TOOL_DISPATCH })).toHaveLength(
      1,
    );
  });

  it("multiple interceptors on one command collect in registration order", async () => {
    const harness = await makeHarness("ti-multi");
    function Agent(): React.ReactElement {
      useTransformToolDispatch(async (input, next) => next(input));
      useGuardToolDispatch(() => "proceed");
      return React.createElement(System, null, "a");
    }
    await harness.mount({
      mountId: "m",
      sessionId: "s",
      element: React.createElement(Agent),
      bridges: fakeBridges(),
    });
    expect(harness.collectTreeInterceptors({ mountId: "m", command: TOOL_DISPATCH })).toHaveLength(
      2,
    );
  });
});
