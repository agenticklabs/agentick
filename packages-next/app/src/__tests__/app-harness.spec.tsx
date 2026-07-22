/**
 * Smoke tests for `AppHarness` / `createApp`.
 *
 * Verifies the user-facing surface end-to-end against the
 * `FakeLanguageModelExecutor`: createSession + send + result, runOnce
 * (ephemeral registration that auto-disposes), registry filtering,
 * closeApp.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { CompilerHarness, reactCompiler } from "@agentick/compiler-react-next";
import type { ContentBlock, ExecutionTarget, ExecutorFactoryDeps } from "@agentick/spec-next";

import { AppHarness } from "../index.js";
import { createApp } from "../react.js";

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
): FakeLanguageModelExecutor {
  return new FakeLanguageModelExecutor("app-test-exec", journal, bus, inbox, {
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
          toolCalls: [{ id: "tc-1", name: "calculator", input: { expression: "47 * 23" } }],
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
  });
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
  const executor = opts.shareSubstrate ? mkExecutor(journal, bus, inbox) : mkExecutor();
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
    modelExecutor: executor,
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

  it("mirrors lifecycle + execution accounting into the durable SessionRecord (E11)", async () => {
    const app = await mkApp();
    const session = await app.createSession({ sessionId: "acct", title: "My chat" });

    // Construction write — initial record.
    const initial = await app.getSessionRecord("acct");
    expect(initial?.status).toBe("idle");
    expect(initial?.executionCount).toBe(0);
    expect(initial?.currentExecutionId).toBeUndefined();
    expect(initial?.title).toBe("My chat");
    expect(initial?.appId).toBe(app.id);

    const handle = await session.send({ messages: [{ role: "user", content: "47 * 23" }] });
    await handle.result;

    // Execution-boundary write: status back to idle, count bumped, in-flight id
    // cleared, usage aggregated across both ticks (8+10 in / 4+8 out / 12+18).
    const after = await app.getSessionRecord("acct");
    expect(after?.status).toBe("idle");
    expect(after?.executionCount).toBe(1);
    expect(after?.currentExecutionId).toBeUndefined();
    expect(after?.usage.totalTokens).toBe(30);

    // App-owned descriptive slot — the framework STORES, never populates it.
    await app.setSessionMeta("acct", { description: "arithmetic" });
    expect((await app.getSessionRecord("acct"))?.description).toBe("arithmetic");

    // close() lands the record on a terminal status.
    await session.close();
    expect((await app.getSessionRecord("acct"))?.status).toBe("closed");

    await app.closeApp();
  });

  it("listSessions enumerates non-ephemeral sessions from the durable store (E11)", async () => {
    const app = await mkApp();
    await app.createSession({ sessionId: "s1", metadata: { tier: "free" } });
    await app.createSession({ sessionId: "s2", metadata: { tier: "pro" } });
    // Durable store-backed superset — async, returns SessionRecord[].
    const all = await app.listSessions();
    expect(all.map((e) => e.id).sort()).toEqual(["s1", "s2"]);
    // Filter by status (scope/status/tree/recency is the store query).
    const idle = await app.listSessions({ status: "idle" });
    expect(idle.map((e) => e.id).sort()).toEqual(["s1", "s2"]);
    // The adopter metadata bag rides the record's open over-fetch slot.
    const s2 = await app.getSessionRecord("s2");
    expect(s2?.metadata).toEqual({ tier: "pro" });
    expect(s2?.appId).toBe(app.id);
    await app.closeApp();
  });

  it("createSession with a live id is idempotent open — returns the SAME session (ADR 49)", async () => {
    const app = await mkApp();
    const first = await app.createSession({ sessionId: "dup" });
    const second = await app.createSession({ sessionId: "dup" });
    // create AND resume are the same call — stateless-replica deployments
    // open a session by id without knowing whether it's already live.
    expect(second).toBe(first);
    expect((await app.listSessions()).filter((s) => s.id === "dup")).toHaveLength(1);
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
    // Ephemeral runOnce sessions get NO durable store (throwaway), so the
    // durable "list my sessions" superset stays empty.
    expect(await app.listSessions()).toHaveLength(0);
    expect(app.getSession(sessionId)).toBeUndefined();
    await app.closeApp();
  });
});

describe("AppHarness — events()", () => {
  it("streams envelopes from every session through the app boundary", async () => {
    const app = await mkApp({ shareSubstrate: true });
    const collected: string[] = [];

    // Filter by the dispatch op name — the tool surface also carries
    // per-tick `replace-compiler-tools` ops now (slice 4 #138);
    // those legitimately appear in the stream and would race the
    // count-based cutoff. Subscribing to dispatch-specific names
    // sidesteps that observability layering.
    const iter = app.events({
      surface: "tool",
      name: { prefix: "tool:command:dispatch" },
    });
    const collect = (async () => {
      for await (const ev of iter) {
        collected.push(`${ev.name}.${ev.phase}`);
        if (collected.length >= 3) break;
      }
    })();

    await new Promise((r) => setTimeout(r, 50));
    await app.runOnce({
      send: { messages: [{ role: "user", content: "x" }] },
    });
    await collect;

    // At minimum we expect requested + before + terminal on dispatch.
    expect(collected.some((s) => s === "tool:command:dispatch.requested")).toBe(true);
    expect(collected.some((s) => s === "tool:command:dispatch.terminal")).toBe(true);
    await app.closeApp();
  });

  it("filters by surface — only matching surface flows", async () => {
    const app = await mkApp({ shareSubstrate: true });
    const seen = new Set<string>();
    let count = 0;
    // The model executor emits under the "model" surface (the model:generate
    // command namespace, since 6f9b0c17). "executor" is no longer a live
    // surface — filtering it would match nothing and hang.
    const iter = app.events({ surface: "model" });
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

    expect(seen).toEqual(new Set(["model"]));
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

describe("AppHarness — spawn (SpawnContext implementation)", () => {
  it("session.spawn() routes through app.createChildSession and returns a real child", async () => {
    const app = await mkApp();
    const parent = await app.createSession({ sessionId: "parent" });
    const child = await parent.spawn({
      agent: React.createElement(MinimalAgent),
      sessionId: "child-1",
      metadata: { kind: "spawned" },
    });
    expect(child).toBeDefined();
    // Child is also registered in the app's registry.
    expect(app.getSession("child-1")).toBe(child);
    await app.closeApp();
  });

  it("session.spawn({ send }) auto-runs the child to terminal", async () => {
    const app = await mkApp();
    const parent = await app.createSession({ sessionId: "parent-2" });
    const handle = await parent.spawn({
      agent: React.createElement(MinimalAgent),
      send: { messages: [{ role: "user", content: "compute" }] },
    });
    // When `send` is provided, spawn returns a SessionExecutionHandle.
    expect("result" in handle).toBe(true);
    if ("result" in handle) {
      const result = await handle.result;
      expect(result.response).toContain("1081");
    }
    await app.closeApp();
  });
});

describe("AppHarness — closeApp", () => {
  it("closes registered sessions and rejects subsequent commands", async () => {
    const app = await mkApp();
    await app.createSession({ sessionId: "to-close" });
    await app.closeApp();
    await expect(app.createSession({ sessionId: "after-close" })).rejects.toMatchObject({
      _tag: "AppClosedError",
    });
  });
});

describe("AppHarness — middleware on app commands (command refactor)", () => {
  it("app.fx.use(middleware) wraps createSession after the command refactor", async () => {
    const { Effect } = await import("effect");
    const calls: string[] = [];
    const app = await mkApp();
    app.fx.use((input, next) =>
      Effect.gen(function* () {
        calls.push("in");
        const r = yield* next(input);
        calls.push("out");
        return r;
      }),
    );
    await app.createSession({ sessionId: "mw-1" });
    expect(calls).toEqual(["in", "out"]);
    await app.closeApp();
  });

  it("app.fx.use(middleware) wraps runOnce too", async () => {
    const { Effect } = await import("effect");
    const { getContext } = await import("@agentick/runtime-next");
    const ops: string[] = [];
    const app = await mkApp();
    // Registered BEFORE runOnce creates its ephemeral session, so the
    // construction-fold (ADR 76/83) threads this app-level middleware down into
    // that session and its sub-harnesses — app.use wraps not just the app's OWN
    // `run-once` op but every op the fold reaches (session send, tool dispatch).
    app.fx.use((input, next) =>
      Effect.gen(function* () {
        const ctx = yield* getContext;
        ops.push(ctx.op ?? "?");
        return yield* next(input);
      }),
    );
    await app.runOnce({
      send: { messages: [{ role: "user", content: "x" }] },
    });
    // The app's own run-once op is the OUTERMOST wrap (composed first).
    expect(ops[0]).toBe("AppRunOnce");
    // The fold reaches the ephemeral session's ops too (deployment-global reach).
    expect(ops).toContain("SessionSend");
    expect(ops).toContain("ToolDispatch");
    await app.closeApp();
  });

  it("emits app:command envelopes on the bus", async () => {
    const app = await mkApp();
    const names: string[] = [];
    const collect = (async () => {
      let i = 0;
      for await (const ev of app.events({ surface: "app" })) {
        names.push(`${ev.name}.${ev.phase}`);
        if (++i >= 3) break;
      }
    })();
    await new Promise((r) => setTimeout(r, 30));
    await app.createSession({ sessionId: "envelope-1" });
    await collect;
    // After the refactor, createSession emits requested + before +
    // terminal (terminal is journaled per the default policy; before
    // is bus-only).
    expect(names.some((n) => n.startsWith("app:command:create-session"))).toBe(true);
    await app.closeApp();
  });
});

describe("AppHarness — telemetry slot (4f.7 placeholder)", () => {
  it("accepts an Effect Layer in options.telemetry without affecting runtime behavior", async () => {
    // Import Layer lazily — the slot accepts any Layer shape.
    const { Layer } = await import("effect");
    const noopLayer = Layer.empty;
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = mkExecutor(journal, bus, inbox);
    await executor.ready;
    const app = await createApp(React.createElement(MinimalAgent), {
      modelExecutor: executor,
      telemetry: noopLayer,
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
    // Slot is accepted; runtime behavior unchanged. Smoke-check that
    // a normal runOnce still works alongside the telemetry slot.
    const { result } = await app.runOnce({
      send: { messages: [{ role: "user", content: "x" }] },
    });
    expect(result.response).toContain("1081");
    await app.closeApp();
  });
});

describe("AppHarness — services registry (4f.6b)", () => {
  it("register, get, has — round-trip", async () => {
    const app = await mkApp();
    const myService = { ping: () => "pong" };
    expect(app.services.has("ping")).toBe(false);
    const unsub = app.services.register("ping", myService);
    expect(app.services.has("ping")).toBe(true);
    expect(app.services.get<typeof myService>("ping")?.ping()).toBe("pong");
    unsub();
    expect(app.services.has("ping")).toBe(false);
    await app.closeApp();
  });

  it("unsubscribe only removes the original instance (not a re-registration)", async () => {
    const app = await mkApp();
    const a = { v: 1 };
    const b = { v: 2 };
    const unsubA = app.services.register("counter", a);
    app.services.register("counter", b); // overwrites
    unsubA(); // should NOT remove b
    expect(app.services.get<typeof b>("counter")).toBe(b);
    await app.closeApp();
  });
});

describe("AppHarness — onSessionCreate hook", () => {
  it("proceed/void verdict lets the session be created", async () => {
    const app = await mkApp();
    const calls: Array<unknown> = [];
    app.onSessionCreate(async (input) => {
      calls.push(input);
    });
    const session = await app.createSession({ sessionId: "s-ok" });
    expect(session).toBeDefined();
    expect(calls).toHaveLength(1);
    await app.closeApp();
  });

  it("veto verdict rejects createSession", async () => {
    const app = await mkApp();
    app.onSessionCreate(async () => ({ kind: "veto", reason: "policy" }));
    await expect(app.createSession({ sessionId: "s-veto" })).rejects.toMatchObject({
      _tag: "AppExecutionFailed",
    });
    expect(app.getSession("s-veto")).toBeUndefined();
    await app.closeApp();
  });

  it("Unsubscribe removes the hook", async () => {
    const app = await mkApp();
    let count = 0;
    const unsub = app.onSessionCreate(async () => {
      count++;
    });
    await app.createSession({ sessionId: "s-1" });
    unsub();
    await app.createSession({ sessionId: "s-2" });
    expect(count).toBe(1);
    await app.closeApp();
  });
});

describe("AppHarness — onSessionClose / onAppClose hooks", () => {
  it("onSessionClose fires when a session is disposed", async () => {
    const app = await mkApp();
    const closed: string[] = [];
    app.onSessionClose((info) => {
      closed.push(info.sessionId);
    });
    await app.runOnce({
      send: { messages: [{ role: "user", content: "x" }] },
      sessionId: "runonce-s",
    });
    // runOnce auto-disposes when it completes.
    expect(closed).toContain("runonce-s");
    await app.closeApp();
  });

  it("onAppClose fires before sessions are torn down", async () => {
    const app = await mkApp();
    const order: string[] = [];
    app.onAppClose(() => {
      order.push("app-close");
    });
    app.onSessionClose(() => {
      order.push("session-close");
    });
    await app.createSession({ sessionId: "before-close" });
    await app.closeApp();
    // app-close fires before session-close (per the spec — onAppClose
    // sees pre-shutdown state).
    expect(order[0]).toBe("app-close");
    expect(order).toContain("session-close");
  });
});

describe("AppHarness — executor factory slot (FAÇADE.3)", () => {
  it("invokes an ExecutorFactory with the app's substrate", async () => {
    const calls: Array<{ scopeId: string; sharedJournal: boolean; sharedBus: boolean }> = [];
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = mkExecutor(journal, bus, inbox);
    await executor.ready;

    const factory = Object.assign(
      (deps?: ExecutorFactoryDeps) => {
        // The App always supplies deps; this test's contract asserts so.
        // Defensive guard keeps the type contract (deps optional per spec)
        // intact while letting the body assume presence.
        if (!deps) throw new Error("factory invoked without deps");
        calls.push({
          scopeId: deps.scopeId,
          sharedJournal: deps.journal === (journal as unknown),
          sharedBus: deps.bus === (bus as unknown),
        });
        return executor;
      },
      { executorFactory: true as const },
    );

    const app = await createApp(React.createElement(MinimalAgent), {
      modelExecutor: factory,
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

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sharedJournal).toBe(true);
    expect(calls[0]!.sharedBus).toBe(true);
    expect(calls[0]!.scopeId).toMatch(/:executor$/);

    // Sanity check: events flow through because the executor shares
    // the bus with the app — no explicit shareSubstrate flag needed.
    // The executor emits under the "model" surface (model:generate
    // command namespace, since 6f9b0c17), not the legacy "executor" one.
    const seen = new Set<string>();
    const collect = (async () => {
      let i = 0;
      for await (const ev of app.events({ surface: "model" })) {
        seen.add(ev.surface);
        if (++i >= 2) break;
      }
    })();
    await new Promise((r) => setTimeout(r, 50));
    await app.runOnce({
      send: { messages: [{ role: "user", content: "x" }] },
    });
    await collect;
    expect(seen).toEqual(new Set(["model"]));
    await app.closeApp();
  });
});

describe("AppHarness — slot cascade", () => {
  it("accepts a pre-built compiler instance via the slot", async () => {
    const executor = mkExecutor();
    await executor.ready;
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const compiler = new CompilerHarness("custom-recon", journal, bus, inbox);
    await compiler.ready;

    const app = await createApp(React.createElement(MinimalAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      compiler,
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
    // Smoke test that the injected compiler actually runs.
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
      modelExecutor: executor,
      compiler: reactCompiler(),
      target: mkTarget(),
      defaultMaxTicks: 999, // shorthand
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
      modelExecutor: executor,
      compiler: reactCompiler(),
      target: mkTarget(),
      defaultMaxTicks: 1, // shorthand
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
      modelExecutor: executor,
      compiler: reactCompiler(),
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
