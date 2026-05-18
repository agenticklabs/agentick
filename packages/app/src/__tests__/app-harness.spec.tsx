/**
 * Smoke tests for `AppHarness` / `createApp`.
 *
 * Verifies the user-facing surface end-to-end against the
 * `MockLanguageModelExecutor`: createSession + send + result, runOnce
 * (ephemeral registration that auto-disposes), registry filtering,
 * closeApp.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { MockLanguageModelExecutor } from "@agentick/executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ReconcilerHarness } from "@agentick/reconciler-react";
import { InMemoryHandlerResolver } from "@agentick/tool-executor";
import type { ContentBlock, ExecutionTarget } from "@agentick/spec";

import { AppHarness, createApp } from "../index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function MinimalAgent() {
  // Plain JSX agent — a single user message + an exposed calculator tool.
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "section" as never,
      { id: "system", audience: "model" },
      "You are a helpful agent.",
    ),
    React.createElement("tool" as never, {
      id: "t.calculator",
      name: "calculator",
      description: "Evaluate arithmetic",
      inputSchema: {
        type: "object",
        required: ["expression"],
        properties: { expression: { type: "string" } },
      },
      exposure: ["model"],
      handlerRef: "handlers/calculator",
    }),
    React.createElement("message" as never, { role: "user" }, "47 * 23"),
  );
}

function mkExecutor(
  journal = new MemoryJournal(),
  bus = new LocalEventBus(),
  inbox = new LocalInbox(),
): MockLanguageModelExecutor {
  return new MockLanguageModelExecutor(
    "app-test-exec",
    journal,
    bus,
    inbox,
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [
              {
                type: "tool_use",
                toolUseId: "tc-1",
                name: "calculator",
                input: { expression: "47 * 23" },
              },
            ],
            stopReason: "tool_use",
            toolCalls: [
              { id: "tc-1", name: "calculator", input: { expression: "47 * 23" } },
            ],
            usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
          },
        },
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "47 × 23 = 1081." }],
            stopReason: "end",
            usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
          },
        },
      ],
    },
  );
}

function mkTarget(): ExecutionTarget {
  return {
    kind: "language-model",
    provider: "mock",
    modelId: "mock-v1",
    capabilities: { supportsTools: true, supportsStreaming: true },
  };
}

async function mkApp(opts: { shareSubstrate?: boolean } = {}) {
  // For cross-session-event tests the executor must publish to the
  // app's bus. The simplest path: construct shared substrate, pass it
  // to both the executor and the app.
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = opts.shareSubstrate
    ? mkExecutor(journal, bus, inbox)
    : mkExecutor();
  await executor.ready;
  const toolHandlers = new Map<string, (input: unknown) => Promise<ContentBlock[]>>([
    [
      "handlers/calculator",
      async (input) => {
        const { expression } = input as { expression: string };
        const value = Function(`"use strict"; return (${expression});`)();
        return [{ type: "text", text: String(value) }];
      },
    ],
  ]);
  return createApp(React.createElement(MinimalAgent), {
    executor,
    target: mkTarget(),
    toolHandlers,
    ...(opts.shareSubstrate ? { journal, bus, inbox } : {}),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AppHarness — createSession + send", () => {
  it("registers a session and resolves a SendResult", async () => {
    const app = await mkApp();
    const session = await app.createSession({ metadata: { tenant: "acme" } });
    const handle = await session.send({
      messages: [{ role: "user", content: "What's 47 * 23?" }],
    });
    const result = await handle.result;
    expect(result.response).toContain("1081");
    expect(result.ticks).toBe(2);
    await app.closeApp();
  });

  it("listSessions filters by status + metadata", async () => {
    const app = await mkApp();
    await app.createSession({ sessionId: "s1", metadata: { tier: "free" } });
    await app.createSession({ sessionId: "s2", metadata: { tier: "pro" } });
    const all = app.listSessions();
    expect(all.map((e) => e.id).sort()).toEqual(["s1", "s2"]);
    const pro = app.listSessions({ metadata: { tier: "pro" } });
    expect(pro).toHaveLength(1);
    expect(pro[0]!.id).toBe("s2");
    await app.closeApp();
  });

  it("createSession with duplicate id throws SessionAlreadyExistsError", async () => {
    const app = await mkApp();
    await app.createSession({ sessionId: "dup" });
    await expect(app.createSession({ sessionId: "dup" })).rejects.toMatchObject(
      { _tag: "SessionAlreadyExistsError", sessionId: "dup" },
    );
    await app.closeApp();
  });
});

describe("AppHarness — runOnce", () => {
  it("creates an ephemeral session, runs send, and disposes", async () => {
    const app = await mkApp();
    const { result, sessionId } = await app.runOnce({
      send: { messages: [{ role: "user", content: "calc?" }] },
    });
    expect(result.response).toContain("1081");
    expect(sessionId).toMatch(/^runonce:/);
    // Registry should be empty after dispose.
    expect(app.listSessions()).toHaveLength(0);
    expect(app.getSession(sessionId)).toBeUndefined();
    await app.closeApp();
  });
});

describe("AppHarness — events()", () => {
  it("streams envelopes from every session through the app boundary", async () => {
    const app = await mkApp({ shareSubstrate: true });
    const collected: string[] = [];
    const stopAt = 3; // one dispatch → requested + before + terminal

    const iter = app.events({ surface: "tool" });
    const collect = (async () => {
      for await (const ev of iter) {
        collected.push(`${ev.name}.${ev.phase}`);
        if (collected.length >= stopAt) break;
      }
    })();

    await new Promise((r) => setTimeout(r, 50));
    await app.runOnce({
      send: { messages: [{ role: "user", content: "x" }] },
    });
    await collect;

    // At minimum we expect requested + before + terminal on dispatch.
    expect(
      collected.some((s) => s === "tool:command:dispatch.requested"),
    ).toBe(true);
    expect(
      collected.some((s) => s === "tool:command:dispatch.terminal"),
    ).toBe(true);
    await app.closeApp();
  });

  it("filters by surface — only matching surface flows", async () => {
    const app = await mkApp({ shareSubstrate: true });
    const seen = new Set<string>();
    let count = 0;
    const iter = app.events({ surface: "executor" });
    const collect = (async () => {
      for await (const ev of iter) {
        seen.add(ev.surface);
        if (++count >= 2) break;
      }
    })();

    // Give the Stream fork's scoped subscription time to register.
    await new Promise((r) => setTimeout(r, 50));
    await app.runOnce({
      send: { messages: [{ role: "user", content: "x" }] },
    });
    await collect;

    expect(seen).toEqual(new Set(["executor"]));
    await app.closeApp();
  });

  it("supports multiple independent subscribers", async () => {
    const app = await mkApp({ shareSubstrate: true });
    const a: string[] = [];
    const b: string[] = [];

    const iterA = app.events({ surface: "tool" });
    const iterB = app.events({ surface: "loop" });

    const collectA = (async () => {
      for await (const ev of iterA) {
        a.push(ev.name);
        if (a.length >= 1) break;
      }
    })();
    const collectB = (async () => {
      for await (const ev of iterB) {
        b.push(ev.name);
        if (b.length >= 1) break;
      }
    })();

    await new Promise((r) => setImmediate(r));
    await app.runOnce({
      send: { messages: [{ role: "user", content: "x" }] },
    });
    await Promise.all([collectA, collectB]);

    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a.every((n) => n.startsWith("tool:"))).toBe(true);
    expect(b.every((n) => n.startsWith("loop:"))).toBe(true);
    await app.closeApp();
  });
});

describe("AppHarness — closeApp", () => {
  it("closes registered sessions and rejects subsequent commands", async () => {
    const app = await mkApp();
    await app.createSession({ sessionId: "to-close" });
    await app.closeApp();
    await expect(app.createSession({ sessionId: "after-close" })).rejects.toMatchObject(
      { _tag: "AppClosedError" },
    );
  });
});

describe("AppHarness — slot cascade", () => {
  it("accepts a pre-built reconciler instance via the slot", async () => {
    const executor = mkExecutor();
    await executor.ready;
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const reconciler = new ReconcilerHarness("custom-recon", journal, bus, inbox);
    await reconciler.ready;

    const app = await createApp(React.createElement(MinimalAgent), {
      executor,
      target: mkTarget(),
      reconciler,
      journal,
      bus,
      inbox,
      toolHandlers: new Map([
        [
          "handlers/calculator",
          async (input: unknown) => {
            const { expression } = input as { expression: string };
            const v = Function(`"use strict"; return (${expression});`)();
            return [{ type: "text", text: String(v) } as ContentBlock];
          },
        ],
      ]),
    });
    // Smoke test that the injected reconciler actually runs.
    const { result } = await app.runOnce({
      send: { messages: [{ role: "user", content: "x" }] },
    });
    expect(result.response).toContain("1081");
    await app.closeApp();
  });

  it("longhand `session.defaultMaxTicks` beats shorthand `defaultMaxTicks`", async () => {
    const executor = mkExecutor();
    await executor.ready;
    const app = new AppHarness({
      rootElement: React.createElement(MinimalAgent),
      executor,
      target: mkTarget(),
      defaultMaxTicks: 999,          // shorthand
      session: { defaultMaxTicks: 1 }, // longhand — should win
      toolHandlers: new Map([
        [
          "handlers/calculator",
          async (input: unknown) => {
            const { expression } = input as { expression: string };
            const v = Function(`"use strict"; return (${expression});`)();
            return [{ type: "text", text: String(v) } as ContentBlock];
          },
        ],
      ]),
    });
    await app.appReady;
    // Tick 1 returns tool_use; with maxTicks=1 the loop terminates
    // immediately with max_ticks before tick 2 lands.
    const { result } = await app.runOnce({
      send: { messages: [{ role: "user", content: "x" }] },
    });
    expect(result.ticks).toBe(1);
    expect(result.stopReason).toBe("max_ticks");
    await app.closeApp();
  });

  it("per-call `createSession.maxTicks` beats both shorthand and longhand", async () => {
    const executor = mkExecutor();
    await executor.ready;
    const app = new AppHarness({
      rootElement: React.createElement(MinimalAgent),
      executor,
      target: mkTarget(),
      defaultMaxTicks: 1,            // shorthand
      session: { defaultMaxTicks: 1 }, // longhand
      toolHandlers: new Map([
        [
          "handlers/calculator",
          async (input: unknown) => {
            const { expression } = input as { expression: string };
            const v = Function(`"use strict"; return (${expression});`)();
            return [{ type: "text", text: String(v) } as ContentBlock];
          },
        ],
      ]),
    });
    await app.appReady;
    // Per-call override = 4 → loop runs to completion (2 ticks).
    const { result } = await app.runOnce({
      maxTicks: 4,
      send: { messages: [{ role: "user", content: "x" }] },
    });
    expect(result.ticks).toBe(2);
    expect(result.stopReason).toBe("end");
    await app.closeApp();
  });
});

describe("AppHarness — constructor variant", () => {
  it("direct `new AppHarness(...)` plus appReady is equivalent to createApp", async () => {
    const executor = mkExecutor();
    await executor.ready;
    const app = new AppHarness({
      rootElement: React.createElement(MinimalAgent),
      executor,
      target: mkTarget(),
      toolHandlers: new Map([
        [
          "handlers/calculator",
          async (input: unknown) => {
            const { expression } = input as { expression: string };
            const v = Function(`"use strict"; return (${expression});`)();
            return [{ type: "text", text: String(v) } as ContentBlock];
          },
        ],
      ]),
    });
    await app.appReady;
    const { result } = await app.runOnce({
      send: { messages: [{ role: "user", content: "x" }] },
    });
    expect(result.ticks).toBe(2);
    await app.closeApp();
  });
});
