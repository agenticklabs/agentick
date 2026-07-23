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
import {
  NOOP_METRICS,
  OFF_TRACE,
  composeProviders,
  deriveObservability,
} from "../substrate/observability.js";
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

  it("threads the surface's log through unchanged", () => {
    const log = (): void => {};
    const o = deriveObservability({ log, namespace: "agentick" });
    expect(o.log).toBe(log);
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

describe("composeProviders (condition 4: fan-out)", () => {
  it("empty ⇒ {}", () => {
    expect(composeProviders()).toEqual({});
  });

  it("single provider passes through unchanged", () => {
    const spy = spyTelemetryProvider();
    const only = { meter: spy.meter };
    expect(composeProviders(only)).toBe(only);
  });

  it("fans a metric emission out to every composed meter", () => {
    const a = spyTelemetryProvider();
    const b = spyTelemetryProvider();
    const composed = composeProviders({ meter: a.meter }, { meter: b.meter });
    composed.meter!.count("acme.hit", 1, { op: "X" });
    expect(a.metrics).toHaveLength(1);
    expect(b.metrics).toHaveLength(1);
    expect(a.metrics[0]).toEqual(b.metrics[0]);
  });
});
