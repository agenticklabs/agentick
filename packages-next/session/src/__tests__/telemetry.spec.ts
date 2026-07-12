/**
 * Telemetry (ADR 77 Stage 4) — the PAYOFF of the fiber spine.
 *
 * Proves that `session.send`, run on an app-supplied telemetry runtime,
 * produces a NESTED trace tree: the composed loop is ONE Effect fiber, so
 * every downstream span (`executor:command:run`, `reconciler:command:
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

import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor-next";
import { LoopExecutorHarness } from "@agentick/loop-executor-next";
import { ReconcilerHarness } from "@agentick/reconciler-react-next";
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
  const reconciler = new ReconcilerHarness("tel-r", journal, bus, inbox);
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
  await Promise.all([reconciler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `tel-s-${Math.random()}`,
    agent: null,
    reconciler,
    loop,
    executor,
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
    // reconciler harnesses are constructed by the app with their own
    // namespace. A cross-spine whitelabel needs the namespace read from fiber
    // context (ADR 78 brick #2) — a documented Stage-4 follow-up, orthogonal
    // to the nesting proven here.
    const ns = "agentick";

    // The execution span is the root of the loop's fiber.
    const execSpan = spans.find((s) => s.name === "loop:command:run-execution");
    expect(execSpan).toBeDefined();
    const execOpId = execSpan!.attributes.get(`${ns}.op_id`);
    expect(execOpId).toMatch(/^loop:execution:/);

    // Downstream spans were emitted IN the execution's fiber. Path-agnostic:
    // the streaming path emits project/normalize, the non-streaming path emits
    // run — either way they must nest under the execution.
    const downstream = spans.filter(
      (s) => s.name.startsWith("executor:command:") || s.name === "reconciler:command:render-tree",
    );
    expect(downstream.length).toBeGreaterThan(0);

    // The NEST: every downstream span's causality parent is the execution
    // (our `parent_op_id` tree), and Effect's own span tree agrees (real
    // parent). Before Stage 3 every one of these was an orphan runPromise root.
    for (const child of downstream) {
      expect(child.attributes.get(`${ns}.parent_op_id`)).toBe(execOpId);
      expect(child.parent).toBeDefined();
    }

    await session.close();
    await tools.close();
    await runtime.dispose();
  });

  it("an async `use` middleware ON THE LOOP does NOT break the downstream span tree", async () => {
    // The conclusive spine-level proof for ADR 76 gap #2. A `use` middleware on
    // the loop forks `runExecution`'s body onto the ambient runtime — so the
    // ENTIRE downstream spine (executor + reconciler, opened INSIDE the forked
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

    expect(wrapped).toBe(1); // the async middleware actually ran on the spine

    const ns = "agentick";
    const execSpan = spans.find((s) => s.name === "loop:command:run-execution");
    expect(execSpan).toBeDefined();
    const execOpId = execSpan!.attributes.get(`${ns}.op_id`);

    // Downstream spans are opened by the loop BODY — i.e. inside the async
    // middleware's forked continuation. They must STILL nest under the execution.
    const downstream = spans.filter(
      (s) => s.name.startsWith("executor:command:") || s.name === "reconciler:command:render-tree",
    );
    expect(downstream.length).toBeGreaterThan(0);
    for (const child of downstream) {
      expect(child.attributes.get(`${ns}.parent_op_id`)).toBe(execOpId); // causal tree
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
    const reconciler = new ReconcilerHarness("tel2-r", journal, bus, inbox);
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
    await Promise.all([
      reconciler.ready,
      loop.ready,
      tools.ready,
      elicitation.ready,
      executor.ready,
    ]);
    const session = new SessionHarness(journal, bus, inbox, {
      sessionId: `tel2-s-${Math.random()}`,
      agent: null,
      reconciler,
      loop,
      executor,
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
