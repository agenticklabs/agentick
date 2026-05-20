/**
 * AppExtension installer plumbing.
 *
 * Verifies the AppHarness's extension lifecycle:
 *   - `install(installer)` runs once per extension at construction
 *   - bridges registered via the installer reach the per-session
 *     HookBridges bundle (under their declared name)
 *   - tool handlers registered via the installer are reachable to
 *     `session.dispatch`
 *   - bus subscriptions registered via the installer receive events
 *   - `uninstall(installer)` runs in reverse on closeApp
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../create-app.js";
import { MockLanguageModelExecutor } from "@agentick/executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type {
  AppExtension,
  AppInstaller,
  ContentBlock,
} from "@agentick/spec";

const Agent = () =>
  React.createElement("message", { role: "user" }, "hello");

async function mkExecutor() {
  const exec = new MockLanguageModelExecutor(
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

describe("AppExtension — install/uninstall lifecycle", () => {
  it("calls install() once per extension at construction", async () => {
    const seen: string[] = [];
    const exts: AppExtension[] = [
      { name: "first", install: () => void seen.push("first") },
      { name: "second", install: () => void seen.push("second") },
    ];
    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      extensions: exts,
    });
    expect(seen).toEqual(["first", "second"]);
    await app.closeApp();
  });

  it("calls uninstall() in reverse order at closeApp", async () => {
    const order: string[] = [];
    const exts: AppExtension[] = [
      {
        name: "one",
        install: () => {},
        uninstall: () => void order.push("one"),
      },
      {
        name: "two",
        install: () => {},
        uninstall: () => void order.push("two"),
      },
    ];
    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      extensions: exts,
    });
    await app.closeApp();
    expect(order).toEqual(["two", "one"]);
  });

  it("awaits async install() before appReady resolves", async () => {
    let done = false;
    const ext: AppExtension = {
      name: "slow",
      async install() {
        await new Promise((r) => setTimeout(r, 10));
        done = true;
      },
    };
    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      extensions: [ext],
    });
    expect(done).toBe(true);
    await app.closeApp();
  });
});

describe("AppExtension — installer surfaces", () => {
  it("registerBridge merges into every session's HookBridges by name", async () => {
    const myBridge = { tag: "sandbox-stub" };
    let captured: AppInstaller | null = null;
    const ext: AppExtension = {
      name: "stub-sandbox",
      install(installer) {
        captured = installer;
        installer.registerBridge("sandbox", myBridge);
      },
    };
    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      extensions: [ext],
    });
    expect(captured).not.toBeNull();
    const session = await app.createSession();
    // The bridge should be on the session's HookBridges under "sandbox"
    const bridges = (
      session as unknown as { readonly bridges: Record<string, unknown> }
    ).bridges;
    expect(bridges.sandbox).toBe(myBridge);
    await app.closeApp();
  });

  it("registerToolHandler pre-registers handlers reachable via dispatch", async () => {
    let dispatched = false;
    const ext: AppExtension = {
      name: "ext-tool",
      install(installer) {
        installer.registerToolHandler("ext.handlers/ping", async () => {
          dispatched = true;
          return [{ type: "text", text: "pong" } as ContentBlock];
        });
      },
    };
    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      extensions: [ext],
    });
    const session = await app.createSession();
    // Register a tool with the ext's handlerRef so the executor can find it
    await session.toolExecutor.register({
      registration: {
        declaration: {
          id: "ping",
          name: "ping",
          description: "ping",
          inputSchema: { type: "object" },
          exposure: ["dispatch"],
        },
        handlerRef: "ext.handlers/ping",
      },
    });
    const content = await session.dispatch("ping", {});
    expect(dispatched).toBe(true);
    expect(content).toEqual([{ type: "text", text: "pong" }]);
    await app.closeApp();
  });

  it("subscribeBus delivers events to the listener", async () => {
    const events: string[] = [];
    const ext: AppExtension = {
      name: "bus-listener",
      install(installer) {
        installer.subscribeBus({}, (event) => {
          events.push(event.name);
        });
      },
    };
    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      extensions: [ext],
    });
    const session = await app.createSession();
    await session.send({ messages: [{ role: "user", content: "ping" }] }).result;
    // Give the bus subscription a tick to drain
    await new Promise((r) => setTimeout(r, 25));
    expect(events.length).toBeGreaterThan(0);
    await app.closeApp();
  });
});
