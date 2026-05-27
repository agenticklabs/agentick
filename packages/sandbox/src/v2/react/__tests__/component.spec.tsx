/**
 * `<Sandbox>` + `useSandbox()` integration with reconciler-react.
 *
 * Verifies:
 *   - Mounting `<Sandbox provider={...}>` constructs a harness and
 *     registers it with the bridge from `bridges.sandbox`.
 *   - Descendants reading `useSandbox()` see the harness.
 *   - Unmounting calls `provider`'s destroy path.
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ReconcilerHarness } from "@agentick/reconciler-react";
import { stubBridges } from "@agentick/reconciler";
import type { HookBridges, SandboxHandle, SandboxProvider } from "@agentick/spec";

import { inMemorySandboxBridge, type SandboxBridge } from "../../bridge.js";
import { Sandbox } from "../component.js";
import { useSandbox } from "../hook.js";

function makeHandle(): SandboxHandle {
  return {
    id: "h",
    workspacePath: "/tmp/h",
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0, signaled: false, durationMs: 0 };
    },
    async readFile() {
      return "";
    },
    async writeFile() {},
    async destroy() {},
  };
}

function makeProvider(opts: { onDestroy?: () => void } = {}): SandboxProvider {
  const handle: SandboxHandle = {
    ...makeHandle(),
    async destroy() {
      opts.onDestroy?.();
    },
  };
  return {
    name: "test",
    async create() {
      return handle;
    },
  };
}

async function makeHarness() {
  const h = new ReconcilerHarness(
    "h_sb",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await h.ready;
  return h;
}

describe("<Sandbox> — mount/unmount lifecycle", () => {
  it("registers a SandboxHarness with the bridge on mount", async () => {
    const bridge: SandboxBridge = inMemorySandboxBridge();
    const bridges: HookBridges = {
      ...stubBridges(),
      sandbox: bridge,
    } as HookBridges;

    function Inner() {
      const sandbox = useSandbox();
      return React.createElement(
        "message",
        { role: "user" },
        sandbox ? `sb:${sandbox.workspacePath}` : "no-sandbox",
      );
    }

    const harness = await makeHarness();
    await harness.mount({
      mountId: "m1",
      sessionId: "s1",
      element: React.createElement(
        Sandbox,
        { id: "primary", provider: makeProvider() },
        React.createElement(Inner),
      ),
      bridges,
    });
    const { tree } = await harness.renderTree({ mountId: "m1", sessionId: "s1" });

    // The descendant read useSandbox() and emitted the workspace path
    const entry = tree.context.entries[0];
    if (!entry || entry.kind !== "message") throw new Error("expected message");
    const text = (entry.content[0] as { text: string }).text;
    expect(text).toBe("sb:/tmp/h");

    // The bridge has the harness registered
    const registered = bridge.list();
    expect(registered).toHaveLength(1);
    expect(registered[0]!.id).toBe("primary");
    expect(registered[0]!.workspacePath).toBe("/tmp/h");
  });

  it("calls provider's destroy when the sandbox unmounts via harness.destroy()", async () => {
    const onDestroy = vi.fn();
    const bridge = inMemorySandboxBridge();
    const bridges: HookBridges = {
      ...stubBridges(),
      sandbox: bridge,
    } as HookBridges;

    const harness = await makeHarness();
    await harness.mount({
      mountId: "m2",
      sessionId: "s2",
      element: React.createElement(Sandbox, {
        id: "x",
        provider: makeProvider({ onDestroy }),
      }),
      bridges,
    });
    await harness.renderTree({ mountId: "m2", sessionId: "s2" });

    const registered = bridge.get("x");
    expect(registered).toBeDefined();
    await registered!.destroy();
    expect(onDestroy).toHaveBeenCalledTimes(1);
  });
});
