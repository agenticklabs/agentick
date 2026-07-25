/**
 * Extension installer plumbing.
 *
 * Verifies the AppHarness's extension lifecycle (per ADR 26):
 *   - `install(installer)` runs once per extension at construction
 *   - sub-harnesses registered via `installer.registerNamespace` reach the
 *     per-session HookBridges bundle under their declared slot name
 *   - tool handlers registered via the installer are reachable to
 *     `session.dispatch`
 *   - bus subscriptions registered via the installer receive events
 *   - close handlers registered via `installer.onClose(...)` run in
 *     reverse registration order at `closeApp`
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "../react.js";
import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { AppExtension, AppInstaller, ContentBlock } from "@agentick/spec-next";
import type { ToolExecutorProtocol } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

const Agent = () => React.createElement("message", { role: "user" }, "hello");

async function mkExecutor() {
  const exec = new FakeLanguageModelExecutor(
    "app-ext-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "ok" } satisfies ContentBlock],
            stopReason: "end",
          },
        },
      ],
    },
  );
  await exec.ready;
  return exec;
}

describe("AppExtension — install lifecycle", () => {
  it("calls install() once per extension at construction", async () => {
    const seen: string[] = [];
    const exts: AppExtension[] = [
      { name: "first", target: "app", install: () => void seen.push("first") },
      { name: "second", target: "app", install: () => void seen.push("second") },
    ];
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: exts,
    });
    expect(seen).toEqual(["first", "second"]);
    await app.closeApp();
  });

  it("fires installer.onClose handlers in reverse registration order at closeApp", async () => {
    const order: string[] = [];
    const exts: AppExtension[] = [
      {
        name: "one",
        target: "app",
        install: (installer) => {
          installer.onClose(() => void order.push("one"));
        },
      },
      {
        name: "two",
        target: "app",
        install: (installer) => {
          installer.onClose(() => void order.push("two"));
        },
      },
    ];
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: exts,
    });
    await app.closeApp();
    // Reverse registration order: "two" registered last → fires first.
    expect(order).toEqual(["two", "one"]);
  });

  it("awaits async install() before appReady resolves", async () => {
    let done = false;
    const ext: AppExtension = {
      name: "slow",
      target: "app",
      async install() {
        await new Promise((r) => setTimeout(r, 10));
        done = true;
      },
    };
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [ext],
    });
    expect(done).toBe(true);
    await app.closeApp();
  });
});

describe("AppExtension — installer surfaces", () => {
  it("registerNamespace merges into every session's HookBridges by name", async () => {
    const myBridge = { tag: "sandbox-stub" };
    let captured: AppInstaller | null = null;
    const ext: AppExtension = {
      name: "stub-sandbox",
      target: "app",
      install(installer) {
        captured = installer;
        installer.registerNamespace("sandbox", myBridge);
      },
    };
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [ext],
    });
    expect(captured).not.toBeNull();
    expect(captured!.kind).toBe("app");
    expect(captured!.hostId).toBeTruthy();
    const session = await app.createSession();
    // The harness should be on the session's HookBridges under "sandbox"
    const bridges = (session as unknown as { readonly bridges: Record<string, unknown> }).bridges;
    expect(bridges.sandbox).toBe(myBridge);
    await app.closeApp();
  });

  it("getNamespace returns a previously registered harness by name", async () => {
    let observed: unknown;
    const exts: AppExtension[] = [
      {
        name: "first",
        target: "app",
        install(installer) {
          installer.registerNamespace("knobs", { tag: "knobs-stub" });
        },
      },
      {
        name: "second",
        target: "app",
        install(installer) {
          // Composes over the previously installed namespace.
          observed = installer.getNamespace("knobs");
        },
      },
    ];
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: exts,
    });
    expect(observed).toEqual({ tag: "knobs-stub" });
    await app.closeApp();
  });

  it("registerToolHandler pre-registers handlers reachable via dispatch", async () => {
    let dispatched = false;
    const ext: AppExtension = {
      name: "ext-tool",
      target: "app",
      install(installer) {
        installer.registerToolHandler("ext.handlers/ping", async () => {
          dispatched = true;
          return [{ type: "text", text: "pong" } as ContentBlock];
        });
      },
    };
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [ext],
    });
    const session = await app.createSession();
    // Reach the session-internal toolExecutor. The protocol intentionally
    // doesn't expose imperative tool registration (tools come from JSX
    // <Tool>); the class field is `private`, so we escape through
    // `unknown` here.
    // TODO: move this test to @agentick/session-next/__tests__/ where the
    // internals are naturally accessible — see CLAUDE.md "tests live
    // where their dependencies live".
    const internals = session as unknown as { toolExecutor: ToolExecutorProtocol };
    await internals.toolExecutor.register({
      registration: {
        declaration: {
          id: "ping",
          name: "ping",
          description: "ping",
          inputSchema: jsonSchema({ type: "object" }),
          exposure: ["dispatch"],
        },
        handlerRef: "ext.handlers/ping",
        binding: { scope: "runtime" },
      },
    });
    const content = await session.tools.dispatch("ping", {});
    expect(dispatched).toBe(true);
    expect(content).toEqual([{ type: "text", text: "pong" }]);
    await app.closeApp();
  });

  it("subscribeBus delivers events to the listener", async () => {
    const events: string[] = [];
    const ext: AppExtension = {
      name: "bus-listener",
      target: "app",
      install(installer) {
        installer.subscribeBus({}, (event) => {
          events.push(event.name);
        });
      },
    };
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [ext],
    });
    const session = await app.createSession();
    const handle = await session.send({ messages: [{ role: "user", content: "ping" }] });
    await handle.result;
    // Give the bus subscription a tick to drain
    await new Promise((r) => setTimeout(r, 25));
    expect(events.length).toBeGreaterThan(0);
    await app.closeApp();
  });
});

describe("AppExtension — ctx extension threading (ADR 66)", () => {
  // The AppHarness is the single construction site that fills
  // dispatch-resolved `ctx` extensions. It resolves the registered
  // "sandbox" namespace GENERICALLY (opaque value from the bridges bag)
  // and threads it as `ctxExtensions: { sandbox }` — with NO sandbox
  // import. This proves the wiring with a plain stub bridge object.
  async function dispatchCapturingCtx(exts: AppExtension[]): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> = {};
    const probe: AppExtension = {
      name: "ctx-probe",
      target: "app",
      install(installer) {
        installer.registerToolHandler("probe.handlers/ctx", async (_input, { ctx }) => {
          captured = ctx as unknown as Record<string, unknown>;
          return [{ type: "text", text: "ok" } as ContentBlock];
        });
      },
    };
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [...exts, probe],
    });
    const session = await app.createSession();
    const internals = session as unknown as { toolExecutor: ToolExecutorProtocol };
    await internals.toolExecutor.register({
      registration: {
        declaration: {
          id: "probe",
          name: "probe",
          description: "probe",
          inputSchema: jsonSchema({ type: "object" }),
          exposure: ["dispatch"],
        },
        handlerRef: "probe.handlers/ctx",
        binding: { scope: "runtime" },
      },
    });
    await session.tools.dispatch("probe", {});
    await app.closeApp();
    return captured;
  }

  it("threads a registered 'sandbox' namespace onto ctx.sandbox — same reference", async () => {
    const stubSandbox = { tag: "sandbox-bridge-stub" };
    const sandboxExt: AppExtension = {
      name: "stub-sandbox",
      target: "app",
      install(installer) {
        installer.registerNamespace("sandbox", stubSandbox);
      },
    };
    const ctx = await dispatchCapturingCtx([sandboxExt]);
    // Dispatch-resolved from the live bridges bag — the exact object the
    // extension registered, not a copy.
    expect(ctx.sandbox).toBe(stubSandbox);
  });

  it("leaves ctx.sandbox undefined when no sandbox namespace is registered", async () => {
    const ctx = await dispatchCapturingCtx([]);
    expect(ctx.sandbox).toBeUndefined();
  });
});
