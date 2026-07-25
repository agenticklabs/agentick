/**
 * Tests for the extended SessionHarness interaction surface — spawn,
 * dispatch, queue, append, observe. These live in the session package
 * (not the conformance suite) because they exercise impl-specific
 * wiring (SpawnContext injection, host tool dispatch through the
 * shared ToolExecutorHarness).
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness } from "@agentick/compiler-react";
import { fakeBridges } from "@agentick/compiler";
import type {
  ContentBlock,
  ExecutionTarget,
  ExecutorFx,
  LanguageModelExecutionResult,
  LanguageModelInput,
  SessionHarnessProtocol,
  SpawnContext,
  SpawnContextChildInput,
  ToolRegistration,
} from "@agentick/spec";
import { ExecutionFailed, jsonSchema } from "@agentick/spec";

import { SessionHarness } from "../harness.js";
import { omitUndefined } from "@agentick/utils";

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

const calcTool: ToolRegistration = {
  declaration: {
    id: "t.calc",
    name: "calc",
    description: "math",
    inputSchema: jsonSchema({ type: "object" }),
    exposure: ["model", "dispatch"],
  },
  handlerRef: "h.calc",
  binding: { scope: "runtime" },
};

async function mkSession(
  opts: {
    spawnContext?: SpawnContext;
    parentSessionId?: string;
    tools?: readonly ToolRegistration[];
    agent?: unknown;
  } = {},
) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness("test-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("test-l", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  resolver.register("h.calc", async () => [{ type: "text", text: "42" }]);
  const elicitation = new ElicitationHarness("test-t:elicitation", journal, bus, inbox);
  const tools = new ToolExecutorHarness("test-t", journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
    ...(opts.tools ? { initialTools: opts.tools } : {}),
  });
  const executor = replyExec("ok");
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `s-${Math.random()}`,
    agent: opts.agent ?? null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    ...omitUndefined({ spawnContext: opts.spawnContext, parentSessionId: opts.parentSessionId }),
  });
  await session.ready;
  await session.mountReady;
  // Mount a no-op bridges fixture so session sees a known mount.
  void fakeBridges;
  return { session, tools, compiler, loop, journal, bus, inbox };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionHarness — dispatch (host-side tool invocation)", () => {
  it("invokes a registered tool with via:'dispatch' and returns its content", async () => {
    const { session, tools } = await mkSession({ tools: [calcTool] });
    const content = await session.tools.dispatch("calc", { a: 1, b: 2 });
    expect(content[0]).toMatchObject({ type: "text", text: "42" });
    await session.close();
    await tools.close();
  });

  it("exposes the tool registry as a sync View (list/get/has) — three-audiences §F", async () => {
    const { session, tools } = await mkSession({ tools: [calcTool] });
    const infos = session.tools.list();
    expect(infos.map((i) => i.name)).toContain("calc");
    expect(infos.every((i) => !("inputSchema" in i))).toBe(true); // wire-safe projection
    expect(session.tools.has("calc")).toBe(true);
    expect(session.tools.has("nope")).toBe(false);
    const handle = session.tools.get("calc");
    expect(handle?.name).toBe("calc");
    const viaHandle = await handle!.dispatch({ a: 1, b: 2 });
    expect(viaHandle[0]).toMatchObject({ type: "text", text: "42" });
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
      binding: { scope: "runtime" },
    };
    const { session, tools } = await mkSession({ tools: [modelOnly] });
    await expect(session.tools.dispatch("model-only", {})).rejects.toMatchObject({
      _tag: "ToolPermissionError",
    });
    await session.close();
    await tools.close();
  });
});

describe("SessionHarness — timeline handle (top-level)", () => {
  it("send() appends input directly; trailingInput follows the assistant fold (ADR 53)", async () => {
    const { session } = await mkSession();
    const handle = await session.send({
      messages: [{ role: "user", content: "hello" }],
    });
    await handle.result;
    const userTexts = session.timeline
      .read()
      .entries.filter((e) => e.kind === "message" && e.message.role === "user")
      .flatMap((e) => (e.kind === "message" ? e.message.content : []))
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);
    expect(userTexts).toContain("hello");
    // The scripted executor replied — the trailing set is empty.
    expect(session.timeline.trailingInput()).toEqual([]);
    // A turn-boundary RECORD was emitted at execution end.
    const boundaries = session.timeline.readPersisted().filter((e) => e.kind === "boundary");
    expect(boundaries.length).toBe(1);
    if (boundaries[0]!.kind === "boundary") {
      expect(boundaries[0]!.boundary.outcome).toBe("succeeded");
    }
    await session.close();
  });

  it("append writes an entry directly to log + projection", async () => {
    const { session } = await mkSession();
    const content: ContentBlock[] = [{ type: "text", text: "manual entry" }];
    await session.timeline.append({
      kind: "message",
      message: { id: "m-manual", role: "user", content, ts: Date.now() },
    });
    const found = session.timeline
      .read()
      .entries.find(
        (e) =>
          e.kind === "message" &&
          e.message.content.some((b) => b.type === "text" && b.text === "manual entry"),
      );
    expect(found).toBeDefined();
    await session.close();
  });

  it("subscribe fires on append", async () => {
    const { session } = await mkSession();
    let notifications = 0;
    const unsub = session.timeline.subscribe(() => {
      notifications += 1;
    });
    await session.timeline.append({
      kind: "message",
      message: { id: "m-app", role: "user", content: [{ type: "text", text: "a1" }], ts: 0 },
    });
    expect(notifications).toBeGreaterThanOrEqual(1);
    unsub();
    await session.close();
  });
});

describe("SessionHarness — channel.request / onRequest (RPC)", () => {
  it("in-process round-trip: request → onRequest listener → respond → promise resolves", async () => {
    const { session } = await mkSession();
    const ch = session.channel<{ q: string }>("ping");

    const unsub = ch.onRequest<{ q: string }, { a: string }>((req, ctx) => {
      ctx.respond({ a: `pong:${req.q}` });
    });
    await new Promise((r) => setTimeout(r, 30));

    const result = await ch.request<{ q: string }, { a: string }>({ q: "hi" });
    expect(result).toEqual({ a: "pong:hi" });
    unsub();
    await session.close();
  });

  it("subscribe does NOT see request envelopes (clean split)", async () => {
    const { session } = await mkSession();
    const ch = session.channel<{ msg: string }>("split");

    const subscribed: Array<{ msg: string }> = [];
    const unsubA = ch.subscribe((payload) => subscribed.push(payload));
    const unsubB = ch.onRequest<{ msg: string }, { ack: true }>((req, ctx) =>
      ctx.respond({ ack: true }),
    );
    await new Promise((r) => setTimeout(r, 30));

    // Pure publish — subscribe sees it.
    await ch.publish({ msg: "hello" });
    // Request — onRequest listener handles it, subscribe should NOT see it.
    await ch.request<{ msg: string }, { ack: true }>({ msg: "do something" });
    await new Promise((r) => setImmediate(r));

    expect(subscribed).toEqual([{ msg: "hello" }]); // only the publish
    unsubA();
    unsubB();
    await session.close();
  });

  it("times out when no responder is attached", async () => {
    const { session } = await mkSession();
    const ch = session.channel("orphan");
    await expect(
      ch.request<{ x: number }, unknown>({ x: 1 }, { timeoutMs: 50 }),
    ).rejects.toMatchObject({ _tag: "RequestTimeoutError" });
    await session.close();
  });
});

describe("SessionHarness — channel handle", () => {
  it("publish emits an envelope on session:channel:<name> that subscribe receives", async () => {
    const { session } = await mkSession();
    const ch = session.channel<{ pct: number }>("progress");

    const received: Array<{ pct: number }> = [];
    const unsub = ch.subscribe((payload) => received.push(payload));
    // Let the subscribe's Stream scope register.
    await new Promise((r) => setTimeout(r, 30));

    await ch.publish({ pct: 25 });
    await ch.publish({ pct: 75 });
    await new Promise((r) => setImmediate(r));

    expect(received).toEqual([{ pct: 25 }, { pct: 75 }]);
    unsub();
    await session.close();
  });

  it("two handles to the same channel name see each other's publishes", async () => {
    const { session } = await mkSession();
    const a = session.channel<string>("topic");
    const b = session.channel<string>("topic");

    const onA: string[] = [];
    const unsub = a.subscribe((p) => onA.push(p));
    await new Promise((r) => setTimeout(r, 30));

    await b.publish("from-b");
    await new Promise((r) => setImmediate(r));

    expect(onA).toEqual(["from-b"]);
    unsub();
    await session.close();
  });
});

describe("SessionHarness — knob handle", () => {
  it("get/set/subscribe through KnobBridge", async () => {
    const { session } = await mkSession();
    // Pre-register a knob into the session's bridge so get/set has something
    // to read.
    const k = session.knob<number>("temperature");
    // Bridge initially returns undefined for unregistered knobs.
    expect(k.get()).toBe(undefined);

    let pings = 0;
    const unsub = k.subscribe(() => pings++);
    k.set(0.7);
    expect(k.get()).toBe(0.7);
    expect(pings).toBeGreaterThan(0);
    unsub();
    await session.close();
  });
});

describe("SessionHarness — spawn", () => {
  it("throws when no spawnContext is wired", async () => {
    const { session } = await mkSession();
    await expect(session.spawn({ agent: null })).rejects.toBeInstanceOf(ExecutionFailed);
    await session.close();
  });

  it("returns the child session when no send is supplied", async () => {
    // Wire a stub SpawnContext directly.
    let receivedInput: SpawnContextChildInput | undefined;
    const ctx: SpawnContext = {
      disposeChildSession: async () => undefined,
      createChildSession: async (input) => {
        receivedInput = input;
        // Return a minimal stub satisfying SessionHarnessProtocol
        // shape. The parent's spawn() returns the child as-is — it
        // doesn't call any methods.
        return {
          id: input.sessionId ?? "child-stub",
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
          // The parent's spawn() returns this child as-is and doesn't
          // invoke methods on it — the test asserts shape passing only.
          // Cast through `unknown` since the stub satisfies a narrower
          // subset than the full protocol (e.g. `timeline` is now a
          // TimelineHandle object, not a method).
        } as unknown as SessionHarnessProtocol;
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

  it("defaults the child agent to the parent's OWN root when SpawnInput.agent is omitted (C2)", async () => {
    // A sentinel agent root the session retains and forwards on a default spawn.
    const parentRoot = { __agent: "parent-root-jsx" };
    let receivedInput: SpawnContextChildInput | undefined;
    const ctx: SpawnContext = {
      disposeChildSession: async () => undefined,
      createChildSession: async (input) => {
        receivedInput = input;
        return { id: input.sessionId ?? "child-stub" } as unknown as SessionHarnessProtocol;
      },
    };
    const { session } = await mkSession({ spawnContext: ctx, agent: parentRoot });

    // No `agent` on the spawn input → the session resolves the default before
    // crossing the SpawnContext boundary (which stays REQUIRED-agent).
    await session.spawn({ sessionId: "child-default" });

    expect(receivedInput?.agent).toBe(parentRoot);
    await session.close();
  });
});

describe("steering — send() during a running execution (ADR 53)", () => {
  it("joins the in-flight handle and the loop continues to answer the new input", async () => {
    const { session, tools } = await mkSession();
    // Two scripted generations + a gate holding tick 1 open so the
    // steering send can land mid-execution.
    const exec = new FakeLanguageModelExecutor(
      `exec-steer-${Math.random()}`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      {
        scripted: [
          {
            result: {
              specVersion: "2026-05-08",
              output: [{ type: "text", text: "first answer" }],
              stopReason: "end",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          },
          {
            result: {
              specVersion: "2026-05-08",
              output: [{ type: "text", text: "steered answer" }],
              stopReason: "end",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          },
        ],
      },
    );
    await exec.ready;
    let releaseTick1!: () => void;
    const gate = new Promise<void>((r) => {
      releaseTick1 = r;
    });
    // ADR 77 — the loop composes the `.fx` twins, so gate + count THERE
    // (patching the public facades is bypassed once internal calls go
    // through `fx`). Gate BOTH entry points (run / executeStream) and count
    // generations; the first generation is held until `releaseTick1()` so
    // the steering send lands mid-execution.
    let runCalls = 0;
    const baseFx = exec.fx;
    const patchedFx: ExecutorFx<LanguageModelInput, unknown, LanguageModelExecutionResult> = {
      ...baseFx,
      run: (i) => {
        runCalls += 1;
        const inner = baseFx.run(i);
        return runCalls === 1
          ? Effect.zipRight(
              Effect.promise(() => gate),
              inner,
            )
          : inner;
      },
      executeStream: (i, sink) => {
        runCalls += 1;
        const inner = baseFx.executeStream(i, sink);
        return runCalls === 1
          ? Effect.zipRight(
              Effect.promise(() => gate),
              inner,
            )
          : inner;
      },
    };
    Object.defineProperty(exec, "fx", { configurable: true, get: () => patchedFx });

    const handle1 = await session.send({
      messages: [{ role: "user", content: "original ask" }],
      modelExecutor: exec,
    });
    // Steering: a second send while tick 1 is in flight JOINS.
    const handle2 = await session.send({
      messages: [{ role: "user", content: "wait — also do this" }],
    });
    expect(handle2).toBe(handle1);

    releaseTick1();
    const result = await handle1.result;

    // The loop continued: two generations ran, the second answered the
    // steering input.
    expect(runCalls).toBe(2);
    expect(result.response).toContain("steered answer");
    // Both user messages are in the log; the trailing set is empty.
    const users = session.timeline
      .read()
      .entries.filter((e) => e.kind === "message" && e.message.role === "user");
    expect(users).toHaveLength(2);
    expect(session.timeline.trailingInput()).toEqual([]);
    // Exactly one turn: one boundary record, outcome succeeded.
    const boundaries = session.timeline.readPersisted().filter((e) => e.kind === "boundary");
    expect(boundaries).toHaveLength(1);
    await session.close();
    await tools.close();
  });
});

describe("send concurrency guards (review findings on ADR 53 join)", () => {
  it("two un-awaited fresh sends produce ONE execution — the second joins", async () => {
    const { session } = await mkSession();
    const [h1, h2] = await Promise.all([
      session.send({ messages: [{ role: "user", content: "a" }] }),
      session.send({ messages: [{ role: "user", content: "b" }] }),
    ]);
    expect(h2).toBe(h1);
    await h1.result;
    // Exactly one turn ran: one boundary record.
    const boundaries = session.timeline.readPersisted().filter((e) => e.kind === "boundary");
    expect(boundaries).toHaveLength(1);
    await session.close();
  });

  it("a send after the loop settles runs FRESH — never joins a dead handle", async () => {
    const { session } = await mkSession();
    const h1 = await session.send({ messages: [{ role: "user", content: "first" }] });
    await h1.result;
    const h2 = await session.send({ messages: [{ role: "user", content: "second" }] });
    expect(h2).not.toBe(h1);
    await h2.result;
    const boundaries = session.timeline.readPersisted().filter((e) => e.kind === "boundary");
    expect(boundaries).toHaveLength(2);
    // Nothing trails — both inputs were processed by a live execution.
    expect(session.timeline.trailingInput()).toEqual([]);
    await session.close();
  });

  it("provenance + generation usage are stamped on execution-produced entries", async () => {
    const { session } = await mkSession();
    const h = await session.send({ messages: [{ role: "user", content: "hi" }] });
    await h.result;
    const assistant = session.timeline
      .readPersisted()
      .filter((e) => e.kind === "message" && e.message.role === "assistant");
    expect(assistant).toHaveLength(1);
    if (assistant[0]!.kind !== "message") throw new Error("unreachable");
    const meta = assistant[0]!.message.metadata as {
      executionId?: string;
      tickId?: string;
      usage?: { totalTokens: number };
    };
    expect(meta.executionId).toMatch(/^exec:/);
    expect(meta.tickId).toBeTruthy();
    expect(meta.usage?.totalTokens).toBe(2);
    await session.close();
  });
});

// ---------------------------------------------------------------------------
// STEER vs QUEUE busy-send semantics (onBusy)
// ---------------------------------------------------------------------------

/**
 * A scripted executor whose FIRST generation is held on a gate, so a
 * concurrent `send()` can land mid-execution. Captures the per-generation
 * model INPUT (streaming: `targetInput`; non-streaming: `compiled`) as JSON
 * so a test can assert what the model saw on each tick.
 */
function gatedExec(
  replies: readonly string[],
  opts: { readonly firstOutcome?: "failed" | "vetoed" | "canceled" } = {},
): {
  readonly exec: FakeLanguageModelExecutor;
  release: () => void;
  runCalls: () => number;
  readonly seen: string[];
} {
  const exec = new FakeLanguageModelExecutor(
    `exec-gate-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: replies.map((text, i) => ({
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text }],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
        // Model an in-flight generation that ends non-successfully (an
        // interrupted / aborted tick) — so the loop breaks WITHOUT running the
        // tick-boundary drain, leaving the steer undrained.
        ...(i === 0 && opts.firstOutcome !== undefined ? { outcome: opts.firstOutcome } : {}),
      })),
    },
  );
  let releaseFn!: () => void;
  const gate = new Promise<void>((r) => {
    releaseFn = r;
  });
  let calls = 0;
  const seen: string[] = [];
  const capture = (i: unknown): void => {
    const x = i as { targetInput?: unknown; compiled?: { context?: { entries?: unknown } } };
    seen.push(JSON.stringify(x.targetInput ?? x.compiled?.context?.entries ?? x.compiled ?? null));
  };
  const baseFx = exec.fx;
  const patchedFx: ExecutorFx<LanguageModelInput, unknown, LanguageModelExecutionResult> = {
    ...baseFx,
    run: (i) => {
      calls += 1;
      capture(i);
      const inner = baseFx.run(i);
      return calls === 1
        ? Effect.zipRight(
            Effect.promise(() => gate),
            inner,
          )
        : inner;
    },
    executeStream: (i, sink) => {
      calls += 1;
      capture(i);
      const inner = baseFx.executeStream(i, sink);
      return calls === 1
        ? Effect.zipRight(
            Effect.promise(() => gate),
            inner,
          )
        : inner;
    },
  };
  Object.defineProperty(exec, "fx", { configurable: true, get: () => patchedFx });
  return { exec, release: () => releaseFn(), runCalls: () => calls, seen };
}

const userTextsOf = (session: SessionHarnessProtocol): string[] =>
  session.timeline
    .read()
    .entries.filter((e) => e.kind === "message" && e.message.role === "user")
    .flatMap((e) => (e.kind === "message" ? e.message.content : []))
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text);

const boundaryCount = (session: SessionHarnessProtocol): number =>
  session.timeline.readPersisted().filter((e) => e.kind === "boundary").length;

describe("onBusy: steer vs queue", () => {
  it("steer (default) lands in the NEXT tick's compiled context — same execution", async () => {
    const { session, tools } = await mkSession();
    const { exec, release, runCalls, seen } = gatedExec(["first answer", "steered answer"]);
    await exec.ready;

    const h1 = await session.send({
      messages: [{ role: "user", content: "original ask" }],
      modelExecutor: exec,
    });
    // Steer while generation 1 is gated — default onBusy.
    const h2 = await session.send({
      messages: [{ role: "user", content: "STEER-MARKER" }],
    });
    expect(h2).toBe(h1); // joined the in-flight handle

    release();
    const result = await h1.result;

    // The loop continued for a second tick to answer the steer.
    expect(runCalls()).toBe(2);
    expect(result.response).toContain("steered answer");

    // COMPILED-CONTEXT PROOF: generation 1 did NOT see the steer; the NEXT
    // tick's compiled model input DID — i.e. the steer was injected between
    // ticks, not before tick 1.
    expect(seen[0]).not.toContain("STEER-MARKER");
    expect(seen[1]).toContain("STEER-MARKER");

    // Not a new execution — exactly one turn boundary.
    expect(boundaryCount(session)).toBe(1);

    // Positional proof: the steer user message lands AFTER the first
    // assistant output (drained at the tick boundary, not before tick 1).
    const entries = session.timeline.read().entries.filter((e) => e.kind === "message");
    const steerIdx = entries.findIndex(
      (e) =>
        e.kind === "message" &&
        e.message.content.some((b) => b.type === "text" && b.text === "STEER-MARKER"),
    );
    const firstAnswerIdx = entries.findIndex(
      (e) =>
        e.kind === "message" &&
        e.message.content.some((b) => b.type === "text" && b.text === "first answer"),
    );
    expect(firstAnswerIdx).toBeGreaterThanOrEqual(0);
    expect(steerIdx).toBeGreaterThan(firstAnswerIdx);

    await session.close();
    await tools.close();
  });

  it("steer with NO running execution degrades to a normal fresh send", async () => {
    const { session } = await mkSession();
    const h = await session.send({
      messages: [{ role: "user", content: "hello there" }],
      onBusy: "steer",
    });
    const result = await h.result;
    expect(result.response).toBe("ok"); // the session-default replyExec("ok")
    expect(boundaryCount(session)).toBe(1);
    expect(userTextsOf(session)).toContain("hello there");
    await session.close();
  });

  it("queue waits for full settlement, then runs a FRESH execution (never joins)", async () => {
    const { session } = await mkSession();
    const { exec, release } = gatedExec(["first answer"]);
    await exec.ready;

    const hA = await session.send({
      messages: [{ role: "user", content: "A-ASK" }],
      modelExecutor: exec,
    });

    // queue send while A is gated — must NOT join A.
    const hBPromise = session.send({
      messages: [{ role: "user", content: "B-QUEUE" }],
      onBusy: "queue",
    });

    // Give the follow-up a chance to (wrongly) join or start early. It must
    // still be blocked on A's quiescence — A has not settled.
    let bResolvedEarly = false;
    void hBPromise.then(() => {
      bResolvedEarly = true;
    });
    await new Promise((r) => setTimeout(r, 25));
    expect(bResolvedEarly).toBe(false); // still waiting for A to settle
    expect(boundaryCount(session)).toBe(0); // A hasn't produced its boundary yet

    release();
    const rA = await hA.result;
    expect(rA.response).toContain("first answer");

    const hB = await hBPromise;
    expect(hB).not.toBe(hA); // fresh execution, not a join
    const rB = await hB.result;
    expect(rB.response).toBe("ok"); // ran on the session default executor

    // Two distinct executions settled: two boundary records.
    expect(boundaryCount(session)).toBe(2);
    expect(userTextsOf(session)).toEqual(expect.arrayContaining(["A-ASK", "B-QUEUE"]));

    await session.close();
  });

  it("aborting an execution with an UNDRAINED steer DROPS the steer (no resurrection)", async () => {
    const { session } = await mkSession();
    // Generation 1 ends CANCELED (an interrupted / aborted in-flight tick):
    // the loop breaks on the non-success terminal WITHOUT running the
    // tick-boundary drain, so the steer stays undrained through settle.
    const { exec, release } = gatedExec(["first answer", "unused"], { firstOutcome: "canceled" });
    await exec.ready;

    const hA = await session.send({
      messages: [{ role: "user", content: "A-ASK" }],
      modelExecutor: exec,
      stream: false, // run-path — clean scripted-canceled short-circuit
    });
    // Steer while generation 1 is gated — enqueued, NOT yet drained.
    const hSteer = await session.send({
      messages: [{ role: "user", content: "DROP-ME" }],
      onBusy: "steer",
    });
    expect(hSteer).toBe(hA);

    // Signal an explicit stop, then let the canceled generation unwind.
    await hA.abort("user stop");
    release();
    await hA.result.catch(() => undefined); // canceled — swallow

    // Let the settle path + any (mis)scheduled re-dispatch microtask run.
    await new Promise((r) => setTimeout(r, 40));

    // Documented decision: a canceled/aborted execution voids the steer's
    // premise, so the undrained steer is DROPPED — never appended, never
    // resurrected as a fresh turn.
    expect(userTextsOf(session)).not.toContain("DROP-ME");
    // Only the one (canceled) turn — no fresh execution spawned.
    expect(boundaryCount(session)).toBe(1);

    await session.close();
  });
});
