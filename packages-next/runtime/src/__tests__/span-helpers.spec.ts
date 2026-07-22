/**
 * Telemetry rung 3 — the span-annotation helpers (`annotateOperationSpan`,
 * `spanAttributes`, `spanMiddleware`).
 *
 * Every op already runs inside an `Effect.withSpan` (ADR 78); these helpers
 * ENRICH that ambient span. We assert against a collecting tracer (the same
 * shape the app/session telemetry specs use) run on a `ManagedRuntime`:
 *
 *   - rung 3a — `annotateOperationSpan(attrs)` inside a command body annotates
 *     the op's own span (the per-moment seam).
 *   - rung 3b — `spanAttributes(fn)` registered via `fx.use` annotates every
 *     op from its input; the registration is an Unsubscribe LEASE (removing it
 *     stops the annotation — dynamic tracing).
 *   - rung 3b — `spanMiddleware(name, fn)` opens a NAMED CHILD span nested
 *     under the op span.
 */

import { Effect, Layer, ManagedRuntime, Tracer } from "effect";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import {
  annotateOperationSpan,
  BaseHarness,
  spanAttributes,
  spanMiddleware,
  type Middleware,
} from "@agentick/runtime-next";
import type { MessageEnvelope, MessageHandlerError, Operation } from "@agentick/spec-next";
import { HandlerError } from "@agentick/spec-next";

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
      spans.push({ name, parent, attributes });
      return {
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
      } as unknown as Tracer.Span;
    },
    context: (f) => f(),
  });
  const layer = Layer.mergeAll(Layer.setTracer(tracer), Layer.setTracerEnabled(true));
  return { layer: layer as Layer.Layer<never, never, never>, spans };
}

/** Minimal harness exposing an un-run `runOperation` Effect. */
class SpanHarness extends BaseHarness<"tool"> {
  constructor() {
    super("tool", "span-h", new MemoryJournal(), new LocalEventBus(), new LocalInbox(), {
      autoRegisterInbox: false,
    });
  }

  /** Run a plain op whose body returns its input `n`. */
  opFx(n: number): Effect.Effect<number, unknown, never> {
    const op: Operation<{ n: number }, number> = {
      opId: `tool:op:${n}`,
      surface: "tool",
      name: "tool:command:op",
      scope: {},
      input: { n },
    };
    return this.runOperation(op, (i) => Effect.succeed(i.n));
  }

  /** Run an op whose body annotates its OWN span mid-execution (rung 3a). */
  momentFx(): Effect.Effect<number, unknown, never> {
    const op: Operation<{ n: number }, number> = {
      opId: "tool:moment:1",
      surface: "tool",
      name: "tool:command:moment",
      scope: {},
      input: { n: 1 },
    };
    return this.runOperation(op, () =>
      Effect.gen(function* () {
        yield* annotateOperationSpan({ "test.moment": 42 });
        return 1;
      }),
    );
  }

  register<I, R>(mw: Middleware<I, R, unknown>): () => void {
    return this.fx.use(mw as Middleware<unknown, unknown, unknown>);
  }

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: new Error("n/a") }));
  }
}

describe("Telemetry rung 3 — span-annotation helpers", () => {
  it("annotateOperationSpan (3a) stamps the op's own span from inside the body", async () => {
    const { layer, spans } = collectingTracer();
    const runtime = ManagedRuntime.make(layer);
    const h = new SpanHarness();

    await runtime.runPromise(h.momentFx());

    const span = spans.find((s) => s.name === "tool:command:moment");
    expect(span).toBeDefined();
    expect(span!.attributes.get("test.moment")).toBe(42);

    await h.close();
    await runtime.dispose();
  });

  it("spanAttributes (3b) via fx.use annotates every op; unsubscribe is a lease", async () => {
    const { layer, spans } = collectingTracer();
    const runtime = ManagedRuntime.make(layer);
    const h = new SpanHarness();

    const stop = h.register(spanAttributes<{ n: number }>((input) => ({ "test.n": input.n })));

    await runtime.runPromise(h.opFx(7));
    const first = spans.filter((s) => s.name === "tool:command:op");
    expect(first).toHaveLength(1);
    expect(first[0]!.attributes.get("test.n")).toBe(7);

    // Lease released — the next op must NOT carry the attribute (dynamic tracing).
    stop();
    await runtime.runPromise(h.opFx(9));
    const second = spans.filter((s) => s.name === "tool:command:op");
    expect(second).toHaveLength(2);
    expect(second[1]!.attributes.get("test.n")).toBeUndefined();

    await h.close();
    await runtime.dispose();
  });

  it("spanMiddleware (3b) with a name opens a NAMED CHILD span nested under the op", async () => {
    const { layer, spans } = collectingTracer();
    const runtime = ManagedRuntime.make(layer);
    const h = new SpanHarness();

    h.register(spanMiddleware<{ n: number }>("test.child", (input) => ({ "test.c": input.n })));

    await runtime.runPromise(h.opFx(3));

    const child = spans.find((s) => s.name === "test.child");
    expect(child).toBeDefined();
    expect(child!.attributes.get("test.c")).toBe(3);
    // Nested under the op span (Effect's own parent linkage).
    expect(child!.parent).toBeDefined();

    await h.close();
    await runtime.dispose();
  });
});
