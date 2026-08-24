/**
 * `session:persist` — create early, persist late, and PERSIST IS A COMMAND.
 *
 *   1. The first send earns the durable record by dispatching the op — once;
 *      a second send does not re-dispatch.
 *   2. `eager: true` earns at genesis through the SAME command.
 *   3. Resume adopts the record with NO dispatch — some earlier life already
 *      announced it.
 *   4. `onBeforeSessionPersist` vetoes: the session runs fine and stays
 *      recordless — ephemeral by policy, expressed as an ordinary guard.
 *   5. The op's terminal event carries the record — the payload a connected
 *      list inserts from, no read-back.
 */

import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness } from "@agentick/compiler-react";
import { InMemorySessionStore } from "../session-store.js";
import { stubStoreCtx } from "@agentick/store";
import { waitFor } from "@agentick/utils/testing";
import type { ExecutionTarget, ProtocolEvent, SessionRecord } from "@agentick/spec";

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

async function mkSession(opts: {
  sessionId: string;
  store: InMemorySessionStore;
  eager?: boolean;
}) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness("prs-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("prs-l", journal, bus, inbox);
  const elicitation = new ElicitationHarness("prs-t:elicitation", journal, bus, inbox);
  const tools = new ToolExecutorHarness("prs-t", journal, bus, inbox, {
    handlerResolver: new InMemoryHandlerResolver(),
    elicitation,
  });
  const executor = replyExec();
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const persistEvents: ProtocolEvent[] = [];
  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: opts.sessionId,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    sessionStore: opts.store,
    ...(opts.eager !== undefined ? { eager: opts.eager } : {}),
  });
  const sub = bus.subscribe({ name: { exact: "session:command:persist" } });
  void (async () => {
    const { Stream, Effect } = await import("effect");
    await Effect.runPromise(
      Stream.runForEach(sub, (e: ProtocolEvent) => {
        persistEvents.push(e);
        return Effect.void;
      }),
    ).catch(() => {});
  })();
  await session.ready;
  return { session, tools, persistEvents };
}

const send = (session: SessionHarness) =>
  session
    .send({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
    .then((h) => h.result);

describe("session:persist — the earn moment is a command", () => {
  it("the first send dispatches it ONCE; the second send does not", async () => {
    const store = new InMemorySessionStore();
    const { session, tools, persistEvents } = await mkSession({ sessionId: "s-earn", store });
    await session.mountReady;
    expect(await store.get("s-earn", stubStoreCtx())).toBeUndefined();

    await send(session);
    await waitFor(async () => (await store.get("s-earn", stubStoreCtx())) !== undefined);

    await send(session);
    await session.close();
    await tools.close();

    const terminals = persistEvents.filter((e) => e.phase === "terminal");
    expect(terminals).toHaveLength(1);
  });

  it("eager earns at genesis through the same command — no send required", async () => {
    const store = new InMemorySessionStore();
    const { session, tools, persistEvents } = await mkSession({
      sessionId: "s-eager",
      store,
      eager: true,
    });
    await session.mountReady;

    await waitFor(async () => (await store.get("s-eager", stubStoreCtx())) !== undefined);
    await waitFor(() => persistEvents.some((e) => e.phase === "terminal"));

    await session.close();
    await tools.close();
  });

  it("resume ADOPTS — no dispatch for a record some earlier life announced", async () => {
    const store = new InMemorySessionStore();
    const first = await mkSession({ sessionId: "s-resume", store });
    await first.session.mountReady;
    await send(first.session);
    await waitFor(async () => (await store.get("s-resume", stubStoreCtx())) !== undefined);
    await first.session.close();
    await first.tools.close();

    const second = await mkSession({ sessionId: "s-resume", store, eager: true });
    await second.session.mountReady;
    await send(second.session);
    await second.session.close();
    await second.tools.close();

    expect(second.persistEvents.filter((e) => e.phase === "terminal")).toHaveLength(0);
  });

  it("onBeforeSessionPersist vetoes — the session runs, and stays recordless", async () => {
    const store = new InMemorySessionStore();
    const { session, tools } = await mkSession({ sessionId: "s-ephemeral", store });
    session.hook({
      onBeforeSessionPersist: () => {
        throw new Error("policy: this session is ephemeral");
      },
    });
    await session.mountReady;

    const result = await send(session);
    expect(result.response).toBe("ok");

    await session.close();
    await tools.close();
    expect(await store.get("s-ephemeral", stubStoreCtx())).toBeUndefined();
  });

  it("the terminal event carries the record — the payload a list inserts from", async () => {
    const store = new InMemorySessionStore();
    const { session, tools, persistEvents } = await mkSession({ sessionId: "s-payload", store });
    await session.mountReady;

    await send(session);
    await waitFor(() => persistEvents.some((e) => e.phase === "terminal"));
    await session.close();
    await tools.close();

    const terminal = persistEvents.find((e) => e.phase === "terminal")!;
    const record = (terminal.payload as { result?: SessionRecord })?.result ?? terminal.payload;
    expect(record).toMatchObject({ id: "s-payload" });
  });
});
