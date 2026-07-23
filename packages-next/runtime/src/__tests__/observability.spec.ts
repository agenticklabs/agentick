/**
 * `deriveObservability` — off-path economics, live trace parenting, and
 * metric fan-out. Verifies the four load-bearing invariants:
 *   1. Off ⇒ `trace`/`metrics` are shared frozen singletons (referential
 *      identity across ops; zero per-op allocation).
 *   2. Off `trace` is a passthrough (runs `fn`, resolves with its value).
 *   3. On `trace` opens a child span that PARENTS under the current op
 *      span (the ADR-77 mechanism), and the callback can annotate it.
 *   4. On `metrics` namespaces names, merges low-cardinality default
 *      labels, and fans out to composed providers.
 */

import { describe, expect, it } from "vitest";
import { Effect, ManagedRuntime } from "effect";
import { NOOP_METRICS, OFF_TRACE, deriveObservability } from "../substrate/observability.js";
import { spyTelemetryProvider } from "../testing/spy-telemetry-provider.js";

const noopLog = (): void => {};

describe("deriveObservability — off path (condition 3)", () => {
  it("returns the shared singletons with referential identity across ops", () => {
    const a = deriveObservability({ log: noopLog, namespace: "agentick" });
    const b = deriveObservability({ log: noopLog, namespace: "agentick" });
    // The trace/metrics FUNCTIONS are shared — no per-op closure allocation.
    expect(a.trace).toBe(OFF_TRACE);
    expect(a.metrics).toBe(NOOP_METRICS);
    expect(a.trace).toBe(b.trace);
    expect(a.metrics).toBe(b.metrics);
  });

  it("wraps the surface emit into the callable Log (call form + level sugar + .with)", () => {
    const emitted: Array<{ level: string; data: unknown; logger?: string }> = [];
    const o = deriveObservability({
      log: (level, data, logger) => emitted.push({ level, data, logger }),
      namespace: "agentick",
    });
    // Call form (zero-break): verbatim (level, data, logger).
    o.log("info", { a: 1 }, "chan");
    // Level sugar collapses to the same emit with the level fixed.
    o.log.warning({ b: 2 });
    // `warn` is the alias — emits the RFC-5424 "warning" level.
    o.log.warn({ c: 3 });
    // `.with` binds fields into the payload (call data wins on collision).
    o.log.with({ reqId: "r1" }).error({ code: "x" });
    expect(emitted).toEqual([
      { level: "info", data: { a: 1 }, logger: "chan" },
      { level: "warning", data: { b: 2 }, logger: undefined },
      { level: "warning", data: { c: 3 }, logger: undefined },
      { level: "error", data: { reqId: "r1", code: "x" }, logger: undefined },
    ]);
  });

  it("off path stamps NO trace ids onto the emit (telemetry off)", () => {
    const traces: Array<unknown> = [];
    const o = deriveObservability({
      log: (_level, _data, _logger, trace) => traces.push(trace),
      namespace: "agentick",
    });
    o.log.info({ hi: true });
    expect(traces).toEqual([undefined]);
  });

  it("trace is a passthrough — runs fn with a no-op span, resolves with its value", async () => {
    const o = deriveObservability({ log: noopLog, namespace: "agentick" });
    let sawSpan = false;
    const result = await o.trace("anything", (span) => {
      span.setAttribute("k", "v"); // no-op, must not throw
      sawSpan = true;
      return 42;
    });
    expect(result).toBe(42);
    expect(sawSpan).toBe(true);
  });

  it("metrics verbs are no-ops (never throw)", () => {
    const o = deriveObservability({ log: noopLog, namespace: "agentick" });
    expect(() => {
      o.metrics.count("x");
      o.metrics.record("y", 1);
      o.metrics.gauge("z", 2);
    }).not.toThrow();
  });
});

describe("deriveObservability — live trace (condition 1: parenting)", () => {
  it("opens a child span that parents under the current operation span", async () => {
    const spy = spyTelemetryProvider();
    const rt = ManagedRuntime.make(spy.tracer!);
    try {
      // Simulate an operation: open an op span, capture the runtime INSIDE it
      // (exactly as the tool-executor does), then run a ctx.trace child.
      await rt.runPromise(
        Effect.gen(function* () {
          const runtime = yield* Effect.runtime<never>();
          const o = deriveObservability({
            log: noopLog,
            namespace: "agentick",
            telemetry: { runtime },
          });
          yield* Effect.promise(() =>
            o.trace("retrieval", (span) => {
              span.setAttribute("query.length", 3);
            }),
          );
        }).pipe(Effect.withSpan("tool:command:dispatch")),
      );
    } finally {
      await rt.dispose();
    }

    const op = spy.spans.find((s) => s.name === "tool:command:dispatch");
    const child = spy.spans.find((s) => s.name === "retrieval");
    expect(op).toBeDefined();
    expect(child).toBeDefined();
    // The child nests under the op span — the SINGLE parenting path.
    expect(child!.parent).toBe("tool:command:dispatch");
    // The (off-fiber) callback annotated the live span synchronously.
    expect(child!.attributes.get("query.length")).toBe(3);
  });
});

describe("deriveObservability — log↔span correlation (trace-id stamping)", () => {
  it("stamps the op span on logs outside trace and the child span on logs inside it", async () => {
    const spy = spyTelemetryProvider();
    const rt = ManagedRuntime.make(spy.tracer!);
    const recorded: Array<{ where: string; trace: unknown }> = [];
    try {
      await rt.runPromise(
        Effect.gen(function* () {
          // Capture the runtime INSIDE the op span, exactly as a harness does.
          const runtime = yield* Effect.runtime<never>();
          const o = deriveObservability({
            log: (_level, data, _logger, trace) =>
              recorded.push({ where: (data as { where: string }).where, trace }),
            namespace: "agentick",
            telemetry: { runtime },
          });
          // A log OUTSIDE any ctx.trace correlates to the enclosing OP span.
          o.log.info({ where: "outside" });
          // A log INSIDE ctx.trace correlates to that CHILD span (not the op).
          yield* Effect.promise(() =>
            o.trace("child", () => {
              o.log.info({ where: "inside" });
            }),
          );
          // After the trace body exits, correlation restores to the op span.
          o.log.info({ where: "after" });
        }).pipe(Effect.withSpan("enclosing.op")),
      );
    } finally {
      await rt.dispose();
    }
    const traceOf = (where: string): unknown => recorded.find((r) => r.where === where)?.trace;
    // The spy tracer stamps traceId "spy-trace" and increments spanId per span:
    // the op span (enclosing.op) is spy-span-1; the ctx.trace child is spy-span-2.
    expect(traceOf("outside")).toEqual({ traceId: "spy-trace", spanId: "spy-span-1" });
    expect(traceOf("inside")).toEqual({ traceId: "spy-trace", spanId: "spy-span-2" });
    expect(traceOf("after")).toEqual({ traceId: "spy-trace", spanId: "spy-span-1" });
  });
});

describe("deriveObservability — live metrics (condition 4: meter seam)", () => {
  it("namespaces names, merges low-cardinality default labels, per-call overrides", () => {
    const spy = spyTelemetryProvider();
    const o = deriveObservability({
      log: noopLog,
      namespace: "acme",
      defaultLabels: { tool: "search", op: "ToolDispatch" },
      telemetry: { meter: spy.meter },
    });
    o.metrics.count("dispatch");
    o.metrics.record("latency_ms", 12, { outcome: "ok" });
    o.metrics.gauge("queue_depth", 5, { tool: "override" });

    expect(spy.metrics).toEqual([
      {
        kind: "count",
        name: "acme.dispatch",
        value: 1,
        labels: { tool: "search", op: "ToolDispatch" },
      },
      {
        kind: "record",
        name: "acme.latency_ms",
        value: 12,
        labels: { tool: "search", op: "ToolDispatch", outcome: "ok" },
      },
      {
        kind: "gauge",
        name: "acme.queue_depth",
        value: 5,
        labels: { tool: "override", op: "ToolDispatch" },
      },
    ]);
  });
});
