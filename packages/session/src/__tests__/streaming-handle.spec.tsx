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

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness } from "@agentick/compiler-react";
import { fakeBridges } from "@agentick/compiler";
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
  const compiler = new CompilerHarness("r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("l", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  const elicitation = new ElicitationHarness("t:elicitation", journal, bus, inbox);
  const tools = new ToolExecutorHarness("t", journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
  });
  const executor = new FakeLanguageModelExecutor(
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
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);
  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: "s",
    agent: React.createElement("section", null, "ctx"),
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
  });
  await session.ready;
  await session.mountReady;
  void fakeBridges;
  return session;
}

describe("SessionExecutionHandle — typed streaming events", () => {
  it("yields execution-start → tick-start → content → message-end → tick-end → tick → execution-end → result", async () => {
    const session = await mkSession();
    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });

    const events: StreamEvent[] = [];
    for await (const ev of handle.events()) events.push(ev);
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
    // The union's `progress` variant carries no `sequence` — it is a bus signal,
    // not a sequenced session event — and an in-process handle never yields one.
    // The narrowing is that invariant written down, not a skip.
    for await (const ev of handle.events()) {
      if (ev.type !== "progress") seqs.push(ev.sequence);
    }
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    }
    await session.close();
  });

  it("stamps sessionId + executionId on every event", async () => {
    const session = await mkSession();
    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    for await (const ev of handle.events()) {
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
    for await (const ev of handle.events()) {
      if (ev.type === "content-delta") events.push({ type: ev.type, delta: ev.delta });
      else events.push({ type: ev.type });
    }
    const deltaTypes = events.filter((e) => e.type === "content-delta").map((e) => e.delta);
    expect(deltaTypes).toEqual(["he", "llo"]);
    const types = events.map((e) => e.type);
    expect(types).toContain("message-start");
    expect(types).toContain("content-start");
    expect(types).toContain("content-end");
    expect(types).toContain("message");
    await session.close();
  });

  it("events() yields the stream; .result resolves independently", async () => {
    const session = await mkSession();
    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    const types: string[] = [];
    for await (const ev of handle.events()) types.push(ev.type);
    expect(types).toContain("execution-start");
    expect(types[types.length - 1]).toBe("result");
    // `.result` still resolves after fully iterating via events().
    const result = await handle.result;
    expect(result).toBeDefined();
    await session.close();
  });

  it("non-streaming path: synthesizes summary events; no delta events", async () => {
    const session = await mkSession();
    const handle = await session.send({
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    const types: string[] = [];
    for await (const ev of handle.events()) types.push(ev.type);
    expect(types).not.toContain("content-delta");
    expect(types).toContain("content");
    expect(types).toContain("message-end");
    await session.close();
  });
});
