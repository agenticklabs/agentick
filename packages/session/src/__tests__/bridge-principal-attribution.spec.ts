/**
 * ADR 48 × create-early-persist-late: every bridge harness carries the
 * session's OWNING principal, so the `StoreCtx` threaded into store data
 * methods attributes the write WITHOUT a session-row join. The failing
 * shape this pins against: a tenant-scoped timeline adapter receiving a
 * first-send append for a session whose durable row does not exist yet —
 * `ctx.principal` must be sufficient on its own.
 */

import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness } from "@agentick/compiler-react";
import { MemoryTimelineStore, type TimelineStore } from "@agentick/timeline";
import type { ExecutionTarget, StoreCtx } from "@agentick/spec";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const replyExec = () =>
  new FakeLanguageModelExecutor(
    `exec-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "ok" }],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    },
  );

/**
 * The real store behind a proxy that records the `StoreCtx` (always the FINAL
 * argument, per the StoreCtx threading contract) of every data-method call.
 */
function spyStore(): { store: TimelineStore; ctxs: { method: string; ctx: StoreCtx }[] } {
  const inner = new MemoryTimelineStore();
  const ctxs: { method: string; ctx: StoreCtx }[] = [];
  const recorded = new Set(["append", "read", "history", "delete"]);
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || !recorded.has(String(prop))) return value;
      return (...args: unknown[]) => {
        ctxs.push({ method: String(prop), ctx: args[args.length - 1] as StoreCtx });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as TimelineStore;
  return { store, ctxs };
}

async function mkSession(opts: { sessionId: string; principal: string; store: TimelineStore }) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness("attr-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("attr-l", journal, bus, inbox);
  const elicitation = new ElicitationHarness("attr-t:elicitation", journal, bus, inbox);
  const tools = new ToolExecutorHarness("attr-t", journal, bus, inbox, {
    handlerResolver: new InMemoryHandlerResolver(),
    elicitation,
  });
  const executor = replyExec();
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: opts.sessionId,
    principal: opts.principal,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    timeline: { store: opts.store },
  });
  await session.ready;
  return { session, tools };
}

describe("bridge principal attribution (ADR 48)", () => {
  it("every timeline store call from a principal-owned session carries ctx.principal", async () => {
    const { store, ctxs } = spyStore();
    const { session, tools } = await mkSession({
      sessionId: "s-attr",
      principal: "tenant-1:user-1",
      store,
    });
    await session.mountReady;

    const handle = await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    await handle.result;

    const appends = ctxs.filter((c) => c.method === "append");
    expect(appends.length).toBeGreaterThan(0);
    for (const { method, ctx } of ctxs) {
      expect({ method, principal: ctx.principal }).toEqual({
        method,
        principal: "tenant-1:user-1",
      });
    }

    await session.close();
    await tools.close();
  });

  it("a principal-less session threads no principal (unstamped stays unstamped)", async () => {
    const { store, ctxs } = spyStore();
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const compiler = new CompilerHarness("attr2-r", journal, bus, inbox);
    const loop = new LoopExecutorHarness("attr2-l", journal, bus, inbox);
    const elicitation = new ElicitationHarness("attr2-t:elicitation", journal, bus, inbox);
    const tools = new ToolExecutorHarness("attr2-t", journal, bus, inbox, {
      handlerResolver: new InMemoryHandlerResolver(),
      elicitation,
    });
    const executor = replyExec();
    await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);
    const session = new SessionHarness(journal, bus, inbox, {
      sessionId: "s-unstamped",
      agent: null,
      compiler,
      loop,
      modelExecutor: executor,
      toolExecutor: tools,
      target,
      timeline: { store },
    });
    await session.ready;
    await session.mountReady;

    expect(ctxs.length).toBeGreaterThan(0);
    for (const { ctx } of ctxs) expect(ctx.principal).toBeUndefined();

    await session.close();
    await tools.close();
  });
});
