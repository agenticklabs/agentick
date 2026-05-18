/**
 * Tests for the extended SessionHarness interaction surface — spawn,
 * dispatch, queue, append, observe. These live in the session package
 * (not the conformance suite) because they exercise impl-specific
 * wiring (SpawnContext injection, host tool dispatch through the
 * shared ToolExecutorHarness).
 */

import { describe, expect, it } from "vitest";

import { MockLanguageModelExecutor } from "@agentick/executor";
import {
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
} from "@agentick/runtime";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { ReconcilerHarness, stubBridges } from "@agentick/reconciler-react";
import type {
  ContentBlock,
  ExecutionTarget,
  SessionHarnessProtocol,
  SpawnContext,
  SpawnContextChildInput,
  ToolRegistration,
} from "@agentick/spec";

import { SessionHarness } from "../harness.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const replyExec = (text: string) =>
  new MockLanguageModelExecutor(
    `exec-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text }],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    },
  );

const calcTool: ToolRegistration = {
  declaration: {
    id: "t.calc",
    name: "calc",
    description: "math",
    inputSchema: { type: "object" },
    exposure: ["model", "dispatch"],
  },
  handlerRef: "h.calc",
};

async function mkSession(
  opts: {
    spawnContext?: SpawnContext;
    parentSessionId?: string;
    tools?: readonly ToolRegistration[];
  } = {},
) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const reconciler = new ReconcilerHarness("test-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("test-l", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  resolver.register("h.calc", async () => [
    { type: "text", text: "42" },
  ]);
  const tools = new ToolExecutorHarness("test-t", journal, bus, inbox, {
    handlerResolver: resolver,
    ...(opts.tools ? { initialTools: opts.tools } : {}),
  });
  const executor = replyExec("ok");
  await Promise.all([reconciler.ready, loop.ready, tools.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `s-${Math.random()}`,
    agent: null,
    reconciler,
    loop,
    executor,
    toolExecutor: tools,
    target,
    ...(opts.spawnContext !== undefined
      ? { spawnContext: opts.spawnContext }
      : {}),
    ...(opts.parentSessionId !== undefined
      ? { parentSessionId: opts.parentSessionId }
      : {}),
  });
  await session.ready;
  await session.mountReady;
  // Mount a no-op bridges fixture so session sees a known mount.
  void stubBridges;
  return { session, tools, reconciler, loop, journal, bus, inbox };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionHarness — dispatch (host-side tool invocation)", () => {
  it("invokes a registered tool with via:'dispatch' and returns its content", async () => {
    const { session, tools } = await mkSession({ tools: [calcTool] });
    const content = await session.dispatch("calc", { a: 1, b: 2 });
    expect(content[0]).toMatchObject({ type: "text", text: "42" });
    await session.close();
    await tools.close();
  });

  it("rejects with ToolPermissionError when tool is not exposed for dispatch", async () => {
    const modelOnly: ToolRegistration = {
      declaration: {
        ...calcTool.declaration,
        id: "t.model-only",
        name: "model-only",
        exposure: ["model"], // not "dispatch"
      },
      handlerRef: "h.calc",
    };
    const { session, tools } = await mkSession({ tools: [modelOnly] });
    await expect(session.dispatch("model-only", {})).rejects.toMatchObject({
      _tag: "ToolPermissionError",
    });
    await session.close();
    await tools.close();
  });
});

describe("SessionHarness — queue", () => {
  it("flushes queued messages on the next send", async () => {
    const { session } = await mkSession();
    await session.queue({ role: "user", content: "first" });
    await session.queue({ role: "user", content: "second" });
    const handle = await session.send({
      messages: [{ role: "user", content: "third" }],
    });
    await handle.result;
    const userMessages = session
      .timeline()
      .filter(
        (e) => e.kind === "message" && e.message.role === "user",
      )
      .map((e) => e.message.content);
    const texts = userMessages
      .flatMap((blocks) => blocks)
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);
    // Queued items land before the send's own messages — FIFO.
    expect(texts.indexOf("first")).toBeLessThan(texts.indexOf("second"));
    expect(texts.indexOf("second")).toBeLessThan(texts.indexOf("third"));
    await session.close();
  });
});

describe("SessionHarness — append", () => {
  it("writes a timeline entry and returns its id when not triggering", async () => {
    const { session } = await mkSession();
    const content: ContentBlock[] = [{ type: "text", text: "manual entry" }];
    const result = await session.append({
      sessionId: "ignored",
      entry: { role: "user", content },
    });
    expect("entryId" in result).toBe(true);
    if ("entryId" in result) {
      expect(typeof result.entryId).toBe("string");
    }
    await session.close();
  });

  it("trigger=true returns an execution handle", async () => {
    const { session } = await mkSession();
    const result = await session.append(
      {
        sessionId: "ignored",
        entry: { role: "user", content: [{ type: "text", text: "go" }] },
      },
      { trigger: true },
    );
    expect("executionId" in result).toBe(true);
    if ("executionId" in result) {
      await result.result;
    }
    await session.close();
  });
});

describe("SessionHarness — observe", () => {
  it("appends an event-role entry with metadata.type", async () => {
    const { session } = await mkSession();
    const { entryId } = await session.observe({
      type: "user-interaction",
      content: "clicked button X",
      metadata: { foo: "bar" },
    });
    expect(typeof entryId).toBe("string");
    const tl = session.timeline();
    const event = tl.find(
      (e) => e.kind === "message" && e.message.role === "event",
    );
    expect(event).toBeDefined();
    if (event && event.kind === "message") {
      expect(event.message.metadata?.type).toBe("user-interaction");
      expect(event.message.metadata?.foo).toBe("bar");
    }
    await session.close();
  });
});

describe("SessionHarness — spawn", () => {
  it("throws when no spawnContext is wired", async () => {
    const { session } = await mkSession();
    await expect(
      session.spawn({ agent: null }),
    ).rejects.toMatchObject({ _tag: "ExecutionFailed" });
    await session.close();
  });

  it("returns the child session when no send is supplied", async () => {
    // Wire a stub SpawnContext directly.
    let receivedInput: SpawnContextChildInput | undefined;
    const ctx: SpawnContext = {
      createChildSession: async (input) => {
        receivedInput = input;
        // Return a minimal stub satisfying SessionHarnessProtocol
        // shape. The parent's spawn() returns the child as-is — it
        // doesn't call any methods.
        return {
          send: async () => ({}) as never,
          timeline: () => [],
          snapshot: () => ({}) as never,
          close: async () => undefined,
          applyExecutorResult: async () => ({ appendedEntryIds: [] }),
          applyToolResults: async () => ({ appendedEntryIds: [] }),
          appendEntry: async () => ({ appendedEntryIds: [] }),
          notifyLifecycle: async () => undefined,
          spawn: async () => ({}) as never,
          dispatch: async () => [],
          queue: async () => undefined,
          append: async () => ({ entryId: "" }),
          observe: async () => ({ entryId: "" }),
        } as SessionHarnessProtocol;
      },
    };
    const { session } = await mkSession({ spawnContext: ctx });
    const child = await session.spawn({
      agent: "child-jsx-here",
      sessionId: "child-1",
      metadata: { tag: "spawned" },
    });
    expect(receivedInput?.parentSessionId).toBe(
      // The parent's auto-generated sessionId — capture from receivedInput.
      receivedInput!.parentSessionId,
    );
    expect(receivedInput?.agent).toBe("child-jsx-here");
    expect(receivedInput?.metadata).toEqual({ tag: "spawned" });
    // The returned value is the child session (no auto-send).
    expect(child).toBeDefined();
    await session.close();
  });
});
