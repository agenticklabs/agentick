/**
 * Streaming Layer 4 — typed `SessionExecutionHandle` events.
 *
 * Validates:
 *   - handle.events() yields typed StreamEvent objects (not raw envelopes)
 *   - sequence numbers are monotonic + start at 1
 *   - execution/tick/message orchestration + summary events fire
 *   - iterator completes after the final `result` event
 *   - `.result` resolves with the same SendResult as the `result` StreamEvent carries
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { MockLanguageModelExecutor } from "@agentick/executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { ReconcilerHarness, stubBridges } from "@agentick/reconciler-react";
import type { ExecutionTarget, StreamEvent } from "@agentick/spec";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

async function mkSession(opts: { withDeltas?: boolean } = {}) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const reconciler = new ReconcilerHarness("r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("l", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  const tools = new ToolExecutorHarness("t", journal, bus, inbox, {
    handlerResolver: resolver,
  });
  const executor = new MockLanguageModelExecutor(
    "e",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "hello" }],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
        ...(opts.withDeltas
          ? {
              deltas: [
                { type: "message-start", role: "assistant" },
                { type: "content-start", blockIndex: 0, blockType: "text" },
                { type: "content-delta", blockIndex: 0, delta: "he" },
                { type: "content-delta", blockIndex: 0, delta: "llo" },
                { type: "content-end", blockIndex: 0 },
                { type: "content", blockIndex: 0, content: { type: "text", text: "hello" } },
                {
                  type: "message-end",
                  stopReason: "end",
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
                {
                  type: "message",
                  message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
                  stopReason: "end",
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ],
            }
          : {}),
      },
    },
  );
  await Promise.all([reconciler.ready, loop.ready, tools.ready, executor.ready]);
  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: "s",
    agent: React.createElement("section", null, "ctx"),
    reconciler,
    loop,
    executor,
    toolExecutor: tools,
    target,
  });
  await session.ready;
  await session.mountReady;
  void stubBridges;
  return session;
}

describe("SessionExecutionHandle — typed streaming events", () => {
  it("yields execution-start → tick-start → content → message-end → tick-end → tick → execution-end → result", async () => {
    const session = await mkSession();
    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });

    const events: StreamEvent[] = [];
    for await (const ev of handle) events.push(ev);
    const result = await handle.result;

    const types = events.map((e) => e.type);
    expect(types).toContain("execution-start");
    expect(types).toContain("tick-start");
    expect(types).toContain("content");
    expect(types).toContain("message-end");
    expect(types).toContain("tick-end");
    expect(types).toContain("tick");
    expect(types).toContain("execution-end");
    expect(types[types.length - 1]).toBe("result");

    // The result event carries the same SendResult that .result resolves with.
    const resultEv = events[events.length - 1];
    if (resultEv?.type !== "result") throw new Error("expected result event");
    expect(resultEv.result).toBe(result);

    await session.close();
  });

  it("assigns monotonic, dense sequence numbers starting at 1", async () => {
    const session = await mkSession();
    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    const seqs: number[] = [];
    for await (const ev of handle) seqs.push(ev.sequence);
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    }
    await session.close();
  });

  it("stamps sessionId + executionId on every event", async () => {
    const session = await mkSession();
    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    for await (const ev of handle) {
      expect(ev.sessionId).toBe("s");
      expect(ev.executionId).toBe(handle.executionId);
    }
    await session.close();
  });

  it("streaming path: forwards adapter AdapterDeltas through onEvent when stream=true", async () => {
    const session = await mkSession({ withDeltas: true });
    const handle = await session.send({
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const events: { type: string; delta?: string }[] = [];
    for await (const ev of handle) {
      if (ev.type === "content-delta") events.push({ type: ev.type, delta: ev.delta });
      else events.push({ type: ev.type });
    }
    const deltaTypes = events
      .filter((e) => e.type === "content-delta")
      .map((e) => e.delta);
    expect(deltaTypes).toEqual(["he", "llo"]);
    const types = events.map((e) => e.type);
    expect(types).toContain("message-start");
    expect(types).toContain("content-start");
    expect(types).toContain("content-end");
    expect(types).toContain("message");
    await session.close();
  });

  it("non-streaming path: synthesizes summary events; no delta events", async () => {
    const session = await mkSession();
    const handle = await session.send({
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    const types: string[] = [];
    for await (const ev of handle) types.push(ev.type);
    expect(types).not.toContain("content-delta");
    expect(types).toContain("content");
    expect(types).toContain("message-end");
    await session.close();
  });
});
