/**
 * `SendInput.identity` — who a turn acts AS is separate from who owns the
 * session. The owner (ADR 48) stays construction-bound on the harness; an
 * identity on `send` makes its principal the EXECUTION's, which is the scope
 * the model executor is handed. No identity → the owner, as before.
 */
import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness } from "@agentick/compiler-react";
import { MemoryTimelineStore } from "@agentick/timeline";
import type { ExecutionTarget, ProtocolEvent } from "@agentick/spec";
import * as blocks from "@agentick/spec/blocks";
import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

function replyExec() {
  return new FakeLanguageModelExecutor(
    `exec-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [blocks.text("ok")],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    },
  );
}

/** Every `loop:*` envelope's principal — the scope each execution and tick ran under. */
function observePrincipals(bus: LocalEventBus): (string | undefined)[] {
  const seen: (string | undefined)[] = [];
  void Effect.runPromise(
    Stream.runForEach(bus.subscribe({ name: { prefix: "loop:" } }), (e: ProtocolEvent) => {
      seen.push(e.scope.principal);
      return Effect.void;
    }),
  ).catch(() => {});
  return seen;
}

async function mkSession(principal: string) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness("id-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("id-l", journal, bus, inbox);
  const elicitation = new ElicitationHarness("id-t:elicitation", journal, bus, inbox);
  const tools = new ToolExecutorHarness("id-t", journal, bus, inbox, {
    handlerResolver: new InMemoryHandlerResolver(),
    elicitation,
  });
  const principals = observePrincipals(bus);
  const executor = replyExec();
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);
  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: "s-identity",
    principal,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    timeline: { store: new MemoryTimelineStore() },
  });
  await session.ready;
  await session.mountReady;
  return { session, tools, principals };
}

const turn = (session: SessionHarness, identity?: { principal: string }) =>
  session
    .send({
      ...(identity !== undefined ? { identity } : {}),
      messages: [{ role: "user", content: [blocks.text("hi")] }],
    })
    .then((h) => h.result);

describe("SendInput.identity — the execution acts as the initiator", () => {
  it("no identity runs as the owner; an identity runs as itself; the owner stays on the session", async () => {
    const { session, tools, principals } = await mkSession("tenant-1:owner");

    await turn(session);
    expect(new Set(principals)).toEqual(new Set(["tenant-1:owner"]));

    principals.length = 0;
    await turn(session, { principal: "tenant-1:staff" });
    expect(principals.length).toBeGreaterThan(0);
    expect(new Set(principals)).toEqual(new Set(["tenant-1:staff"]));
    expect(session.principal).toBe("tenant-1:owner");

    principals.length = 0;
    await turn(session);
    expect(new Set(principals)).toEqual(new Set(["tenant-1:owner"]));

    await session.close();
    await tools.close();
  });

  it("an identity without a principal changes nothing", async () => {
    const { session, tools, principals } = await mkSession("tenant-1:owner");
    await turn(session, {} as { principal: string });
    expect(new Set(principals)).toEqual(new Set(["tenant-1:owner"]));
    await session.close();
    await tools.close();
  });
});
