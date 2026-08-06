/**
 * The client observability facets, built over the SAME `TelemetryAdapter` the
 * wire extension uses. Every test pins a claim the module's docblock makes.
 */

import { describe, expect, it } from "vitest";
import type { LogLevel, MetricLabels, TelemetryAdapter, TelemetrySpan } from "@agentick/spec";

import { clientObservability } from "../observability.js";

interface StartedSpan {
  name: string;
  parent?: { traceId: string; spanId: string };
  attributes: Record<string, unknown>;
  error?: string;
  ended: boolean;
  traceId: string;
  spanId: string;
}

/** A `TelemetryAdapter` that records — standing in for an adopter's real tracer. */
function recordingAdapter(opts: { reportsIds?: boolean } = {}): TelemetryAdapter & {
  spans: StartedSpan[];
  logs: { level: LogLevel; data: unknown }[];
  seen: { kind: string; name: string; value: number; labels?: MetricLabels }[];
} {
  const spans: StartedSpan[] = [];
  const logs: { level: LogLevel; data: unknown }[] = [];
  const seen: { kind: string; name: string; value: number; labels?: MetricLabels }[] = [];
  let n = 0;

  return {
    spans,
    logs,
    seen,
    startSpan: (name, attributes, parent): TelemetrySpan => {
      n += 1;
      const rec: StartedSpan = {
        name,
        ...(parent ? { parent } : {}),
        attributes: { ...attributes },
        ended: false,
        traceId: parent?.traceId ?? `trace-${n}`,
        spanId: `span-${n}`,
      };
      spans.push(rec);
      const span: TelemetrySpan = {
        setAttribute: (k, v) => void (rec.attributes[k] = v),
        setError: (m) => void (rec.error = m),
        end: () => void (rec.ended = true),
      };
      if (opts.reportsIds !== false) {
        span.spanContext = () => ({ traceId: rec.traceId, spanId: rec.spanId, sampled: true });
      }
      return span;
    },
    currentTraceContext: () => ({}),
    log: (level, data) => void logs.push({ level, data }),
    metrics: {
      count: (name, v = 1, labels) =>
        void seen.push({ kind: "count", name, value: v, ...(labels ? { labels } : {}) }),
      record: (name, v, labels) =>
        void seen.push({ kind: "record", name, value: v, ...(labels ? { labels } : {}) }),
      gauge: (name, v, labels) =>
        void seen.push({ kind: "gauge", name, value: v, ...(labels ? { labels } : {}) }),
    },
  };
}

const bareAdapter: TelemetryAdapter = {
  startSpan: () => ({ setAttribute() {}, setError() {}, end() {} }),
  currentTraceContext: () => ({}),
};

describe("log is always live", () => {
  it("is callable with no adapter at all, and does not throw", () => {
    const obs = clientObservability(undefined);
    expect(() => obs.log.info("hello")).not.toThrow();
    expect(() => obs.log("error", { boom: true })).not.toThrow();
  });

  it("routes through the adapter's log", () => {
    const adapter = recordingAdapter();
    clientObservability(adapter).log.warning("careful");
    expect(adapter.logs).toEqual([{ level: "warning", data: "careful" }]);
  });

  it("`with` binds fields without a second emission", () => {
    const adapter = recordingAdapter();
    clientObservability(adapter).log.with({ reqId: "r1" }).info("done");
    expect(adapter.logs).toHaveLength(1);
    expect(adapter.logs[0]!.data).toMatchObject({ reqId: "r1" });
  });

  it("is live even when the adapter declares no log", () => {
    expect(() => clientObservability(bareAdapter).log.info("x")).not.toThrow();
  });
});

describe("trace is passthrough when off", () => {
  it("runs fn and resolves its value with no adapter", async () => {
    await expect(clientObservability(undefined).trace("work", () => 42)).resolves.toBe(42);
  });

  it("hands the callback a span that accepts every method", async () => {
    await clientObservability(undefined).trace("work", (span) => {
      expect(() => span.setAttribute("k", 1)).not.toThrow();
      expect(() => span.addEvent("e")).not.toThrow();
      expect(() => span.recordException(new Error("x"))).not.toThrow();
    });
  });
});

describe("spans go through the adapter", () => {
  it("starts and always ends one, carrying annotations", async () => {
    const adapter = recordingAdapter();
    await clientObservability(adapter).trace("retrieval", (span) => {
      span.setAttribute("query.length", 12);
    });
    expect(adapter.spans).toHaveLength(1);
    expect(adapter.spans[0]!.name).toBe("retrieval");
    expect(adapter.spans[0]!.attributes["query.length"]).toBe(12);
    expect(adapter.spans[0]!.ended).toBe(true);
  });

  it("passes the enclosing span as PARENT — a browser has no ambient context", async () => {
    const adapter = recordingAdapter();
    const obs = clientObservability(adapter);
    await obs.trace("outer", async () => {
      await obs.trace("inner", () => undefined);
    });
    const outer = adapter.spans.find((s) => s.name === "outer")!;
    const inner = adapter.spans.find((s) => s.name === "inner")!;
    expect(inner.parent).toEqual({ traceId: outer.traceId, spanId: outer.spanId });
  });

  it("restores the parent so SIBLINGS share one rather than chaining", async () => {
    const adapter = recordingAdapter();
    const obs = clientObservability(adapter);
    await obs.trace("outer", async () => {
      await obs.trace("a", () => undefined);
      await obs.trace("b", () => undefined);
    });
    const outer = adapter.spans.find((s) => s.name === "outer")!;
    expect(adapter.spans.find((s) => s.name === "a")!.parent?.spanId).toBe(outer.spanId);
    expect(adapter.spans.find((s) => s.name === "b")!.parent?.spanId).toBe(outer.spanId);
  });

  it("records a throw, ends the span, and re-raises", async () => {
    const adapter = recordingAdapter();
    await expect(
      clientObservability(adapter).trace("boom", () => Promise.reject(new Error("nope"))),
    ).rejects.toThrow("nope");
    expect(adapter.spans[0]!.error).toBe("nope");
    expect(adapter.spans[0]!.ended).toBe(true);
  });

  it("recordException annotates without re-throwing", async () => {
    const adapter = recordingAdapter();
    await expect(
      clientObservability(adapter).trace("handled", (span) => {
        span.recordException(new Error("caught"));
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(adapter.spans[0]!.error).toBe("caught");
  });

  it("an adapter that cannot report ids never becomes a parent", async () => {
    // Better than inventing ids it does not know, which would propagate a span
    // nobody has.
    const adapter = recordingAdapter({ reportsIds: false });
    const obs = clientObservability(adapter);
    await obs.trace("outer", async () => {
      expect(obs.activeSpan()).toBeUndefined();
      await obs.trace("inner", () => undefined);
    });
    expect(adapter.spans.find((s) => s.name === "inner")!.parent).toBeUndefined();
  });
});

describe("concurrency", () => {
  it("interleaved traces on SEPARATE instances do not cross-parent", async () => {
    const adapter = recordingAdapter();
    const a = clientObservability(adapter);
    const b = clientObservability(adapter);
    const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

    await Promise.all([
      a.trace("a-outer", async () => {
        await settle(10);
        await a.trace("a-inner", () => undefined);
      }),
      b.trace("b-outer", async () => {
        await settle(5);
        await b.trace("b-inner", () => undefined);
      }),
    ]);

    const by = (n: string) => adapter.spans.find((s) => s.name === n)!;
    expect(by("a-inner").parent?.spanId).toBe(by("a-outer").spanId);
    expect(by("b-inner").parent?.spanId).toBe(by("b-outer").spanId);
  });
});

describe("activeSpan", () => {
  it("is the span in progress, and undefined outside one", async () => {
    const obs = clientObservability(recordingAdapter());
    expect(obs.activeSpan()).toBeUndefined();
    await obs.trace("send", () => {
      expect(obs.activeSpan()).toMatchObject({ sampled: true });
    });
    expect(obs.activeSpan()).toBeUndefined();
  });
});

describe("metrics", () => {
  it("routes the three instrument kinds through the adapter", () => {
    const adapter = recordingAdapter();
    const obs = clientObservability(adapter);
    obs.metrics.count("dispatches");
    obs.metrics.record("latency_ms", 12, { tool: "read" });
    obs.metrics.gauge("pending", 3);
    expect(adapter.seen.map((m) => [m.kind, m.name, m.value])).toEqual([
      ["count", "dispatches", 1],
      ["record", "latency_ms", 12],
      ["gauge", "pending", 3],
    ]);
  });

  it("is a no-op when the adapter declares none", () => {
    expect(() => clientObservability(bareAdapter).metrics.count("x")).not.toThrow();
  });
});
