/**
 * Framework lifecycle-verb hooks (ADR 80/83) — the EXECUTION path.
 *
 * `loop:run-execution` (op `loop:command:run-execution`) routes through
 * `runOperation`, so the `CommandRegistry` augmentation in
 * `@agentick/loop-executor-next` mints `onBeforeLoopRunExecution`. This test
 * drives a real execution (`session.send` → `loop.runExecution`) and asserts
 * the hook, registered by the typed name on the loop harness, fires once.
 */

import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor-next";
import { LoopExecutorHarness } from "@agentick/loop-executor-next";
import { ReconcilerHarness } from "@agentick/reconciler-react-next";
import type { ExecutionTarget } from "@agentick/spec-next";

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

async function mkSession() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const reconciler = new ReconcilerHarness("test-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("test-l", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  const elicitation = new ElicitationHarness("test-t:elicitation", journal, bus, inbox);
  const tools = new ToolExecutorHarness("test-t", journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
  });
  const executor = replyExec();
  await Promise.all([reconciler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `s-${Math.random()}`,
    agent: null,
    reconciler,
    loop,
    executor,
    toolExecutor: tools,
    target,
  });
  await session.ready;
  await session.mountReady;
  return { session, loop, tools };
}

describe("execution lifecycle — loop:run-execution hook (ADR 83)", () => {
  it("onBeforeLoopRunExecution fires when an execution runs", async () => {
    const { session, loop, tools } = await mkSession();
    let fired = 0;
    let seenInput: unknown;
    const off = loop.hook({
      onBeforeLoopRunExecution: (input) => {
        fired += 1;
        seenInput = input;
      },
    });

    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    await handle.result;

    expect(fired).toBe(1);
    expect(seenInput).toHaveProperty("executionId");

    off();
    await session.close();
    await tools.close();
  });
});
