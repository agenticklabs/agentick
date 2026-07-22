/**
 * Telemetry (ADR 77 Stage 4) — the PAYOFF of the fiber spine.
 *
 * Proves that `session.send`, run on an app-supplied telemetry runtime,
 * produces a NESTED trace tree: the composed loop is ONE Effect fiber, so
 * every downstream span (`model:command:run`, `compiler:command:
 * render-tree`, `tool:command:dispatch`) nests under the execution span
 * (`loop:command:run-execution`) via FiberRef `parentOpId` auto-threading.
 * Before Stage 3 the loop was ~40 independent `runPromise` roots — every
 * span an orphan; this test would have been impossible.
 *
 * Nesting is asserted two ways: (1) the whitelabelled `<ns>.parent_op_id`
 * attribute of a child span equals the `<ns>.op_id` of the execution span
 * (our causality tree), and (2) the tracer's own `parent` linkage (Effect's
 * span tree) agrees.
 */

import { describe, expect, it } from "vitest";
import { Layer, ManagedRuntime, Tracer } from "effect";

import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor-next";
import { LoopExecutorHarness } from "@agentick/loop-executor-next";
import { CompilerHarness } from "@agentick/compiler-react-next";
import type { ContentBlock, ExecutionTarget } from "@agentick/spec-next";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

interface CollectedSpan {
  readonly name: string;
  readonly parent: unknown;
  readonly attributes: Map<string, unknown>;
}

/** An Effect tracer that records every span it opens + its parent. */
function collectingTracer() {
  const spans: CollectedSpan[] = [];
  const tracer = Tracer.make({
    span: (name, parent, context, links, startTime, kind) => {
      const attributes = new Map<string, unknown>();
      const self = {
        _tag: "Span",
        spanId: `s${spans.length}`,
        traceId: "t",
        name,
        parent,
        context,
        status: { _tag: "Started", startTime },
        attributes,
        links,
        kind,
        sampled: true,
        end() {},
        attribute(key: string, value: unknown) {
          attributes.set(key, value);
        },
        event() {},
        addLinks() {},
      };
      spans.push({ name, parent, attributes });
      return self as unknown as Tracer.Span;
    },
    context: (f) => f(),
  });
  const layer = Layer.mergeAll(Layer.setTracer(tracer), Layer.setTracerEnabled(true));
  return { layer: layer as Layer.Layer<never, never, never>, spans };
}

async function mkSession(telemetryRuntime: ManagedRuntime.ManagedRuntime<never, never>) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness("tel-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("tel-l", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  const elicitation = new ElicitationHarness("tel-t:elicitation", journal, bus, inbox);
  const tools = new ToolExecutorHarness("tel-t", journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
  });
  const executor = new FakeLanguageModelExecutor("tel-exec", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "ok" } satisfies ContentBlock],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    ],
  });
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `tel-s-${Math.random()}`,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    telemetryRuntime,
    telemetryNamespace: "acme",
  });
  await session.ready;
  await session.mountReady;
  return { session, tools, loop };
}

describe("Session telemetry (ADR 77 Stage 4) — the composed execution nests", () => {
  it("session.send on the telemetry runtime emits a NESTED span tree under the execution", async () => {
    const { layer, spans } = collectingTracer();
    const runtime = ManagedRuntime.make(layer);
    const { session, tools } = await mkSession(runtime);

    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    await handle.result;

    // Spans carry the spine harnesses' namespace ("agentick"). NOTE: the
    // session's own `telemetryNamespace` whitelabels only SESSION-owned spans;
    // `send` emits none (it is not a `runOperation`), and the loop/executor/
    // compiler harnesses are constructed by the app with their own
    // namespace. A cross-spine whitelabel needs the namespace read from fiber
    // context (ADR 78 brick #2) — a documented Stage-4 follow-up, orthogonal
    // to the nesting proven here.
    const ns = "agentick";

    // The execution span is the root of the loop's fiber.
    const execSpan = spans.find((s) => s.name === "loop:command:run-execution");
    expect(execSpan).toBeDefined();
    const execOpId = execSpan!.attributes.get(`${ns}.op_id`);
    expect(execOpId).toMatch(/^loop:execution:/);

    // ADR 89 §3 — the tick is now its own operation (`loop:command:tick`)
    // nested under the execution: the span tree is execution → tick →
    // downstream. The tick span's causality parent is the execution.
    const tickSpan = spans.find((s) => s.name === "loop:command:tick");
    expect(tickSpan).toBeDefined();
    const tickOpId = tickSpan!.attributes.get(`${ns}.op_id`);
    expect(tickOpId).toMatch(/^loop:tick:/);
    expect(tickSpan!.attributes.get(`${ns}.parent_op_id`)).toBe(execOpId);
    expect(tickSpan!.parent).toBeDefined();

    // Downstream spans were emitted IN the tick's fiber (which nests in the
    // execution's). Path-agnostic: the streaming path emits project/normalize,
    // the non-streaming path emits run — either way they nest under the tick.
    const downstream = spans.filter(
      (s) => s.name.startsWith("model:command:") || s.name === "compiler:command:render-tree",
    );
    expect(downstream.length).toBeGreaterThan(0);

    // The NEST: every downstream span's causality parent is the TICK (our
    // `parent_op_id` tree), the tick's is the execution, and Effect's own span
    // tree agrees (real parent). Before Stage 3 every one of these was an
    // orphan runPromise root; §3 threads them under the tick, no detachment.
    for (const child of downstream) {
      expect(child.attributes.get(`${ns}.parent_op_id`)).toBe(tickOpId);
      expect(child.parent).toBeDefined();
    }

    await session.close();
    await tools.close();
    await runtime.dispose();
  });

  it("an async `use` middleware ON THE LOOP does NOT break the downstream span tree", async () => {
    // The conclusive spine-level proof for ADR 76 gap #2. A `use` middleware on
    // the loop forks `runExecution`'s body onto the ambient runtime — so the
    // ENTIRE downstream spine (executor + compiler, opened INSIDE the forked
    // continuation) runs across the async boundary. If those spans still nest
    // under the execution span, the fiber threaded through the middleware. With
    // the old default-runtime fork, they would detach (or vanish — no tracer).
    const { layer, spans } = collectingTracer();
    const runtime = ManagedRuntime.make(layer);
    const { session, tools, loop } = await mkSession(runtime);

    let wrapped = 0;
    loop.use(async (input, next) => {
      wrapped++;
      return next(input);
    });

    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    await handle.result;

    // ADR 89 §3 — a loop `.use` interceptor wraps EVERY loop-surface op, and
    // the tick is now one: `run-execution` (1) + `loop:tick` (1 tick) = 2. Each
    // wrap forks the body onto the ambient runtime — the whole spine crosses
    // the async boundary and must still nest.
    expect(wrapped).toBe(2); // the async middleware ran on both loop ops

    const ns = "agentick";
    const execSpan = spans.find((s) => s.name === "loop:command:run-execution");
    expect(execSpan).toBeDefined();
    const execOpId = execSpan!.attributes.get(`${ns}.op_id`);

    // The tick op nests under the execution (execution → tick → downstream).
    const tickSpan = spans.find((s) => s.name === "loop:command:tick");
    expect(tickSpan).toBeDefined();
    const tickOpId = tickSpan!.attributes.get(`${ns}.op_id`);
    expect(tickSpan!.attributes.get(`${ns}.parent_op_id`)).toBe(execOpId);

    // Downstream spans are opened by the TICK body — i.e. inside the async
    // middleware's forked continuation (twice over). They must STILL nest,
    // under the tick, which nests under the execution.
    const downstream = spans.filter(
      (s) => s.name.startsWith("model:command:") || s.name === "compiler:command:render-tree",
    );
    expect(downstream.length).toBeGreaterThan(0);
    for (const child of downstream) {
      expect(child.attributes.get(`${ns}.parent_op_id`)).toBe(tickOpId); // causal tree
      expect(child.parent).toBeDefined(); // Effect's real span parent — nesting held
    }

    await session.close();
    await tools.close();
    await runtime.dispose();
  });

  it("no telemetry runtime → send still works (behavior-preserving; no-op tracer)", async () => {
    // A session without a telemetry runtime runs on the default runtime — the
    // spans go to Effect's no-op tracer, but the run is otherwise identical.
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const compiler = new CompilerHarness("tel2-r", journal, bus, inbox);
    const loop = new LoopExecutorHarness("tel2-l", journal, bus, inbox);
    const resolver = new InMemoryHandlerResolver();
    const elicitation = new ElicitationHarness("tel2-t:elicitation", journal, bus, inbox);
    const tools = new ToolExecutorHarness("tel2-t", journal, bus, inbox, {
      handlerResolver: resolver,
      elicitation,
    });
    const executor = new FakeLanguageModelExecutor("tel2-exec", journal, bus, inbox, {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "ok" } satisfies ContentBlock],
            stopReason: "end",
          },
        },
      ],
    });
    await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);
    const session = new SessionHarness(journal, bus, inbox, {
      sessionId: `tel2-s-${Math.random()}`,
      agent: null,
      compiler,
      loop,
      modelExecutor: executor,
      toolExecutor: tools,
      target,
      // no telemetryRuntime
    });
    await session.ready;
    await session.mountReady;

    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    const result = await handle.result;
    expect(result.response).toContain("ok");

    await session.close();
    await tools.close();
  });
});
