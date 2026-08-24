/**
 * The durable {@link SessionRecord} across a kill → resume cycle (E11 + ADR 49).
 *
 * A second `SessionHarness` over the SAME id and the SAME `SessionStore` is a
 * RESUME: its genesis reads the persisted record before it writes one. What is
 * pinned here is that the read actually happens and that the adoption survives
 * the next write-through — the app-owned `title` / `description` an app-side
 * titler wrote, the session's `createdAt`, and the cumulative accounting. The
 * regression this guards (#290) is a resumed session persisting a BLANK record
 * over a live one on its first status transition.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { CompilerHarness } from "@agentick/compiler-react";
import { ElicitationHarness } from "@agentick/elicitation";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import type { ExecutionTarget, SessionRecord } from "@agentick/spec";

import { SessionHarness } from "../harness.js";
import { InMemorySessionStore } from "../session-store.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

function Agent() {
  return React.createElement("message" as never, { role: "user" }, "hi");
}

interface Rig {
  readonly session: SessionHarness;
  close(): Promise<void>;
}

/** A full harness stack over the injected store — one "process". */
async function mkSession(
  sessionId: string,
  store: InMemorySessionStore,
  title?: string,
): Promise<Rig> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness(`rr-c-${Math.random()}`, journal, bus, inbox);
  const loop = new LoopExecutorHarness(`rr-l-${Math.random()}`, journal, bus, inbox);
  const elicitation = new ElicitationHarness(`rr-e-${Math.random()}`, journal, bus, inbox);
  const tools = new ToolExecutorHarness(`rr-t-${Math.random()}`, journal, bus, inbox, {
    handlerResolver: new InMemoryHandlerResolver(),
    elicitation,
  });
  const executor = new FakeLanguageModelExecutor(`rr-x-${Math.random()}`, journal, bus, inbox, {
    scripted: {
      result: {
        specVersion: "2026-05-08",
        output: [{ type: "text", text: "ok" }],
        stopReason: "end",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    },
  });
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId,
    agent: React.createElement(Agent),
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    sessionStore: store,
    // Persistence is execution's to trigger; these rigs are ABOUT the record,
    // so they earn one at creation.
    eager: true,
    ...(title !== undefined ? { title } : {}),
  });
  await session.ready;
  await session.mountReady;

  return {
    session,
    close: async () => {
      await session.close();
      await tools.close();
    },
  };
}

const send = async (session: SessionHarness): Promise<unknown> =>
  (await session.send({ messages: [{ role: "user", content: "go" }] })).result;

describe("SessionRecord resume (#290)", () => {
  it("adopts the persisted record — the app-owned slots survive the resume AND the next status transition", async () => {
    const store = new InMemorySessionStore();
    const sessionId = "rr-adopt";

    const p1 = await mkSession(sessionId, store);
    p1.session.setMeta({ title: "Weekly report", description: "the Q3 numbers" });
    await send(p1.session);
    const killed = (await store.get(sessionId, {})) as SessionRecord;
    expect(killed.title).toBe("Weekly report");
    await p1.close();

    // ── A fresh harness, same id, same durable backing. ──
    const p2 = await mkSession(sessionId, store);
    const resumed = (await store.get(sessionId, {})) as SessionRecord;
    expect(resumed.title).toBe("Weekly report");
    expect(resumed.description).toBe("the Q3 numbers");
    // Identity + cumulative accounting are the session's, not this process's.
    expect(resumed.createdAt).toBe(killed.createdAt);
    expect(resumed.executionCount).toBe(1);
    expect(resumed.usage.totalTokens).toBe(killed.usage.totalTokens);

    // THE regression: a status transition re-writes the whole record, so a
    // resume that never read the durable one persists a title-less record here.
    await send(p2.session);
    const afterTransition = (await store.get(sessionId, {})) as SessionRecord;
    expect(afterTransition.title).toBe("Weekly report");
    expect(afterTransition.description).toBe("the Q3 numbers");
    expect(afterTransition.createdAt).toBe(killed.createdAt);
    expect(afterTransition.executionCount).toBe(2);
    expect(afterTransition.usage.totalTokens).toBe(killed.usage.totalTokens * 2);

    await p2.close();
  });

  it("does not resurrect the previous process's in-flight execution", async () => {
    const store = new InMemorySessionStore();
    const sessionId = "rr-crash";
    await store.put(
      {
        id: sessionId,
        createdAt: 1_000,
        updatedAt: 2_000,
        status: "running",
        currentExecutionId: "exec:died-with-the-process",
        executionCount: 3,
        usage: {
          inputTokens: 9,
          outputTokens: 9,
          totalTokens: 18,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
        },
        title: "crashed mid-turn",
      },
      {},
    );

    const rig = await mkSession(sessionId, store);
    const record = (await store.get(sessionId, {})) as SessionRecord;
    expect(record.status).toBe("idle");
    expect(record.currentExecutionId).toBeUndefined();
    expect(record.title).toBe("crashed mid-turn");
    expect(record.executionCount).toBe(3);

    await rig.close();
  });

  it("a construction-supplied title overrides the persisted one", async () => {
    const store = new InMemorySessionStore();
    const sessionId = "rr-override";

    const p1 = await mkSession(sessionId, store);
    p1.session.setMeta({ title: "old", description: "kept" });
    await p1.close();

    const p2 = await mkSession(sessionId, store, "new");
    const record = (await store.get(sessionId, {})) as SessionRecord;
    expect(record.title).toBe("new");
    expect(record.description).toBe("kept");

    await p2.close();
  });
});
