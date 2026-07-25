/**
 * Session verb hooks (ADR 80/83). The four public session verbs — `send`,
 * `applyExecutorResult`, `applyToolResults`, `appendEntry` — route through
 * `runOperation` via `sessionOp`, so the derived command-lifecycle hooks fire
 * around them. These tests prove:
 *
 *   1. `onBeforeSessionSend` fires when `send` is called.
 *   2. `onBeforeSessionAppend` fires when `appendEntry` is called.
 *   3. The runtime `deriveHookNames` agrees with the type-level `Pascal`
 *      derivation for `session:command:send`.
 */

import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal, deriveHookNames } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness } from "@agentick/compiler-react";
import type { ExecutionTarget } from "@agentick/spec";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const replyExec = (text: string) =>
  new FakeLanguageModelExecutor(
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

async function mkSession() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness("test-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("test-l", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  const elicitation = new ElicitationHarness("test-t:elicitation", journal, bus, inbox);
  const tools = new ToolExecutorHarness("test-t", journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
  });
  const executor = replyExec("ok");
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `s-${Math.random()}`,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
  });
  await session.ready;
  await session.mountReady;
  return { session, tools };
}

describe("SessionHarness — verb hooks (ADR 83)", () => {
  it("deriveHookNames agrees with the Pascal derivation for session:command:send", () => {
    expect(deriveHookNames("session:command:send")).toEqual([
      "onBeforeSessionSend",
      "onAfterSessionSend",
    ]);
    expect(deriveHookNames("session:command:append")).toEqual([
      "onBeforeSessionAppend",
      "onAfterSessionAppend",
    ]);
  });

  it("onBeforeSessionSend fires when send() is called", async () => {
    const { session, tools } = await mkSession();
    let fired = 0;
    let seenInput: unknown;
    const off = session.hook({
      onBeforeSessionSend: (input) => {
        fired += 1;
        seenInput = input;
      },
    });

    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    await handle.result;

    expect(fired).toBe(1);
    expect(seenInput).toMatchObject({ messages: [{ role: "user", content: "hi" }] });

    off();
    await session.close();
    await tools.close();
  });

  it("onBeforeSessionAppend fires when appendEntry() is called", async () => {
    const { session, tools } = await mkSession();
    let fired = 0;
    const off = session.hooks.onBeforeSessionAppend(() => {
      fired += 1;
    });

    await session.appendEntry({
      sessionId: session.id,
      entry: { role: "user", content: [{ type: "text", text: "manual" }] },
    });

    expect(fired).toBe(1);

    off();
    await session.close();
    await tools.close();
  });

  it("onAfterSessionSend sees the SessionExecutionHandle output", async () => {
    const { session, tools } = await mkSession();
    let seenOutput: unknown;
    const off = session.hook({
      onAfterSessionSend: (output) => {
        seenOutput = output;
      },
    });

    const handle = await session.send({ messages: [{ role: "user", content: "yo" }] });
    await handle.result;

    expect(seenOutput).toBeDefined();
    expect(seenOutput).toHaveProperty("executionId");

    off();
    await session.close();
    await tools.close();
  });
});
