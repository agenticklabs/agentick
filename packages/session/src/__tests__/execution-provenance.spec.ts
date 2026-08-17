/**
 * A user turn carries the execution it opened (ADR 53 §2.1).
 *
 * The framework already stamped `executionId` on everything an execution
 * PRODUCED — the assistant entry, each tool result, the turn boundary — and on
 * nothing it was given. That made an open turn underivable from the log alone:
 * the input arrives, and until the first tick settles there is no entry naming
 * the execution it started, so a reader reloading mid-turn sees a user message
 * with no evidence anything is running.
 */

import { describe, expect, it } from "vitest";

import { CompilerHarness } from "@agentick/compiler-react";
import { ElicitationHarness } from "@agentick/elicitation";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { ExecutionTarget, SessionMessage, TimelineEntry } from "@agentick/spec";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

async function mkSession(sessionId: string) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness(`${sessionId}-r`, journal, bus, inbox);
  const loop = new LoopExecutorHarness(`${sessionId}-l`, journal, bus, inbox);
  const elicitation = new ElicitationHarness(`${sessionId}:elicitation`, journal, bus, inbox);
  const tools = new ToolExecutorHarness(`${sessionId}-t`, journal, bus, inbox, {
    handlerResolver: new InMemoryHandlerResolver(),
    elicitation,
  });
  const executor = new FakeLanguageModelExecutor(`${sessionId}-x`, journal, bus, inbox, {
    scripted: {
      result: {
        specVersion: "2026-05-08",
        output: [{ type: "text", text: "ok" }],
        stopReason: "end",
      },
    },
  });
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
  });
  await session.ready;
  return { session, tools };
}

const messages = (entries: readonly TimelineEntry[]): readonly SessionMessage[] =>
  entries
    .filter((e): e is Extract<TimelineEntry, { kind: "message" }> => e.kind === "message")
    .map((e) => e.message);

describe("execution provenance on a user turn", () => {
  it("the input entry carries the executionId the handle reports", async () => {
    const { session, tools } = await mkSession("prov-1");
    await session.mountReady;

    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    await handle.result;

    const all = messages(session.timeline.readPersisted());
    const user = all.find((m) => m.role === "user");
    const assistant = all.find((m) => m.role === "assistant");

    expect(user?.metadata?.executionId).toBe(handle.executionId);
    // Same key, same place on the entry — the reader that segments a turn by
    // the assistant's stamp needs no second rule for the input that opened it.
    expect(assistant?.metadata?.executionId).toBe(handle.executionId);

    await session.close();
    await tools.close();
  });

  it("adopter metadata survives the stamp", async () => {
    const { session, tools } = await mkSession("prov-2");
    await session.mountReady;

    const handle = await session.send({
      messages: [{ role: "user", content: "hi", metadata: { source: "cli" } }],
    });
    await handle.result;

    const user = messages(session.timeline.readPersisted()).find((m) => m.role === "user");
    expect(user?.metadata).toMatchObject({ source: "cli", executionId: handle.executionId });

    await session.close();
    await tools.close();
  });

  it("an entry appended outside an execution carries none", async () => {
    const { session, tools } = await mkSession("prov-3");
    await session.mountReady;

    await session.appendEntry({
      sessionId: "prov-3",
      entry: { role: "user", content: [{ type: "text", text: "seed" }] },
    });

    const user = messages(session.timeline.readPersisted()).find((m) => m.role === "user");
    expect(user?.metadata?.executionId).toBeUndefined();

    await session.close();
    await tools.close();
  });
});
