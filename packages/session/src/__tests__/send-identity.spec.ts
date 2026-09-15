/**
 * `SendInput.identity` — who a turn acts AS is separate from who owns the
 * session. The owner (ADR 48) stays construction-bound on the harness; an
 * identity on `send` makes its principal the EXECUTION's, which is the scope
 * the loop, the model executor, and every tool are handed. No identity → the
 * owner, as before. A spawn's first turn inherits it; a crash resume reads it
 * back off the durable record.
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
import type {
  ExecutionTarget,
  ProtocolEvent,
  SessionRecord,
  SpawnContext,
  StoreCtx,
  ToolHandler,
} from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";
import * as blocks from "@agentick/spec/blocks";
import { SessionHarness } from "../harness.js";
import { InMemorySessionStore } from "../session-store.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const endResult = {
  specVersion: "2026-05-08",
  output: [blocks.text("ok")],
  stopReason: "end",
  usage,
} as const;

/** One reply, or — given a tool name — one call to it and then a reply. */
function replyExec(callTool?: string) {
  const scripted =
    callTool === undefined
      ? { result: endResult }
      : [
          {
            result: {
              specVersion: "2026-05-08" as const,
              output: [blocks.text("calling")],
              toolCalls: [{ id: "t1", name: callTool, input: {} }],
              stopReason: "tool_use" as const,
              usage,
            },
          },
          { result: endResult },
        ];
  return new FakeLanguageModelExecutor(
    `exec-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { scripted },
  );
}

/** Every `loop:*` envelope's identity pair — the scope each execution and tick ran under. */
type Seen = { principal: string | undefined; actor: string | undefined; hasActorKey: boolean };
function observeIdentity(bus: LocalEventBus): Seen[] {
  const seen: Seen[] = [];
  void Effect.runPromise(
    Stream.runForEach(bus.subscribe({ name: { prefix: "loop:" } }), (e: ProtocolEvent) => {
      seen.push({
        principal: e.scope.principal,
        actor: e.scope.actor,
        hasActorKey: "actor" in e.scope,
      });
      return Effect.void;
    }),
  ).catch(() => {});
  return seen;
}
const principalsOf = (seen: Seen[]) => new Set(seen.map((s) => s.principal));
const actorsOf = (seen: Seen[]) => new Set(seen.map((s) => s.actor));

async function mkSession(
  principal: string,
  opts: {
    sessionId?: string;
    handlers?: Record<string, ToolHandler>;
    callTool?: string;
    spawnContext?: SpawnContext;
    sessionStore?: InMemorySessionStore;
  } = {},
) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness("id-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("id-l", journal, bus, inbox);
  const elicitation = new ElicitationHarness("id-t:elicitation", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  for (const [ref, handler] of Object.entries(opts.handlers ?? {})) resolver.register(ref, handler);
  const tools = new ToolExecutorHarness("id-t", journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
  });
  const seen = observeIdentity(bus);
  const executor = replyExec(opts.callTool);
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);
  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: opts.sessionId ?? "s-identity",
    principal,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    timeline: { store: new MemoryTimelineStore() },
    ...(opts.spawnContext !== undefined ? { spawnContext: opts.spawnContext } : {}),
    ...(opts.sessionStore !== undefined ? { sessionStore: opts.sessionStore } : {}),
  });
  await session.ready;
  await session.mountReady;
  return { session, tools, seen };
}

const turn = (session: SessionHarness, identity?: { principal: string }, tools?: string[]) =>
  session
    .send({
      ...(identity !== undefined ? { identity } : {}),
      messages: [{ role: "user", content: [blocks.text("hi")] }],
      ...(tools !== undefined ? { tools: tools.map(decl) } : {}),
    })
    .then((h) => h.result);

function decl(name: string) {
  return {
    id: name,
    name,
    description: name,
    inputSchema: jsonSchema({ type: "object" }),
    exposure: ["model" as const],
    handlerRef: `h.${name}`,
  };
}

/** A spawn context whose child only records what it was sent. */
function recordingSpawnContext() {
  const sends: { identity?: { principal: string } }[] = [];
  const ctx: SpawnContext = {
    disposeChildSession: async () => undefined,
    abortSubtree: async () => 0,
    createChildSession: async (input) =>
      ({
        id: input.sessionId ?? "child",
        send: async (sendInput: { identity?: { principal: string } }) => {
          sends.push(sendInput);
          return { result: Promise.resolve(endResult) } as never;
        },
      }) as never,
  };
  return { ctx, sends };
}

describe("SendInput.identity — the execution acts as the initiator, the owner stays the scope key", () => {
  it("no identity stamps no actor; an identity stamps the actor on every nested op while principal stays the owner", async () => {
    const { session, tools, seen } = await mkSession("tenant-1:owner");

    await turn(session);
    expect(seen.length).toBeGreaterThan(0);
    expect(principalsOf(seen)).toEqual(new Set(["tenant-1:owner"]));
    expect(seen.every((s) => !s.hasActorKey)).toBe(true);

    seen.length = 0;
    await turn(session, { principal: "tenant-1:staff" });
    expect(seen.length).toBeGreaterThan(0);
    expect(principalsOf(seen)).toEqual(new Set(["tenant-1:owner"]));
    expect(actorsOf(seen)).toEqual(new Set(["tenant-1:staff"]));
    expect(session.principal).toBe("tenant-1:owner");

    seen.length = 0;
    await turn(session);
    expect(principalsOf(seen)).toEqual(new Set(["tenant-1:owner"]));
    expect(seen.every((s) => !s.hasActorKey)).toBe(true);

    await session.close();
    await tools.close();
  });

  it("an identity equal to the owner, or without a principal, stamps nothing", async () => {
    const { session, tools, seen } = await mkSession("tenant-1:owner");
    await turn(session, { principal: "tenant-1:owner" });
    await turn(session, {} as { principal: string });
    expect(principalsOf(seen)).toEqual(new Set(["tenant-1:owner"]));
    expect(seen.every((s) => !s.hasActorKey)).toBe(true);
    await session.close();
    await tools.close();
  });

  it("a tool handler's ctx carries actor beside principal, inherited from the execution root", async () => {
    const ctxs: { principal?: string; actor?: string }[] = [];
    const probe: ToolHandler = async (_input, { ctx }) => {
      ctxs.push({ principal: ctx.principal, actor: (ctx as { actor?: string }).actor });
      return [blocks.text("probed")];
    };
    const { session, tools } = await mkSession("tenant-1:owner", {
      callTool: "probe",
      handlers: { "h.probe": probe },
    });
    await turn(session, { principal: "tenant-1:staff" }, ["probe"]);
    expect(ctxs).toEqual([{ principal: "tenant-1:owner", actor: "tenant-1:staff" }]);
    await session.close();
    await tools.close();
  });
});

describe("spawn — the child's first turn acts as the parent turn's initiator", () => {
  const spawnFrom =
    (get: () => SessionHarness, send: Record<string, unknown> = {}): ToolHandler =>
    async () => {
      await get().spawn({
        agent: null,
        send: { messages: [{ role: "user", content: [blocks.text("go")] }], ...send },
      });
      return [blocks.text("spawned")];
    };

  it("inherits the identity of the turn that spawned it", async () => {
    const { ctx, sends } = recordingSpawnContext();
    let current!: SessionHarness;
    const { session, tools } = await mkSession("tenant-1:owner", {
      spawnContext: ctx,
      callTool: "spawner",
      handlers: { "h.spawner": spawnFrom(() => current) },
    });
    current = session;
    await turn(session, { principal: "tenant-1:staff" }, ["spawner"]);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.identity).toEqual({ principal: "tenant-1:staff" });
    await session.close();
    await tools.close();
  });

  it("carries no identity when the parent turn had none, and an explicit one wins", async () => {
    const { ctx, sends } = recordingSpawnContext();
    let current!: SessionHarness;
    const { session, tools } = await mkSession("tenant-1:owner", {
      spawnContext: ctx,
      callTool: "spawner",
      handlers: {
        "h.spawner": spawnFrom(() => current, { identity: { principal: "tenant-1:named" } }),
      },
    });
    current = session;
    await turn(session, undefined, ["spawner"]);
    expect(sends[0]?.identity).toEqual({ principal: "tenant-1:named" });
    await session.close();
    await tools.close();
  });
});

describe("resumeExecution — a crashed turn re-drives as the person who started it", () => {
  const ctx = {} as StoreCtx;
  const crashed = (id: string, principal: string | undefined): SessionRecord =>
    ({
      id,
      createdAt: 1000,
      updatedAt: 2000,
      status: "running",
      principal: "tenant-1:owner",
      currentExecutionId: "exec:crashed",
      ...(principal !== undefined ? { currentExecutionActor: principal } : {}),
      executionCount: 1,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }) as unknown as SessionRecord;

  it("reads the initiator off the durable record", async () => {
    const store = new InMemorySessionStore();
    await store.put(crashed("s-resume-staff", "tenant-1:staff"), ctx);
    const { session, tools, seen } = await mkSession("tenant-1:owner", {
      sessionId: "s-resume-staff",
      sessionStore: store,
    });
    const handle = await session.resumeExecution("exec:crashed");
    await handle.result;
    expect(seen.length).toBeGreaterThan(0);
    expect(principalsOf(seen)).toEqual(new Set(["tenant-1:owner"]));
    expect(actorsOf(seen)).toEqual(new Set(["tenant-1:staff"]));
    await session.close();
    await tools.close();
  });

  it("falls back to the owner when the record carries none", async () => {
    const store = new InMemorySessionStore();
    await store.put(crashed("s-resume-owner", undefined), ctx);
    const { session, tools, seen } = await mkSession("tenant-1:owner", {
      sessionId: "s-resume-owner",
      sessionStore: store,
    });
    const handle = await session.resumeExecution("exec:crashed");
    await handle.result;
    expect(principalsOf(seen)).toEqual(new Set(["tenant-1:owner"]));
    expect(seen.every((s) => !s.hasActorKey)).toBe(true);
    await session.close();
    await tools.close();
  });

  it("the settle clears the slot, and an owner-initiated turn never writes one", async () => {
    const store = new InMemorySessionStore();
    const { session, tools } = await mkSession("tenant-1:owner", {
      sessionId: "s-slot",
      sessionStore: store,
    });
    await turn(session, { principal: "tenant-1:staff" });
    await session.flushRecordWrites();
    expect((await store.get("s-slot", ctx))?.currentExecutionActor).toBeUndefined();
    await turn(session);
    await session.flushRecordWrites();
    expect((await store.get("s-slot", ctx))?.currentExecutionActor).toBeUndefined();
    await session.close();
    await tools.close();
  });
});
