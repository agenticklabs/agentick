/**
 * `spyTelemetrySink()` — the standard-OTel-edge recording spy. Verifies the
 * two halves directly, WITHOUT the full app, against real OTel SDK objects:
 *   1. The recording `SpanProcessor`, registered on a real
 *      `BasicTracerProvider`, records spans as they END with a resolved
 *      parent NAME (proving the spanId→name resolution).
 *   2. The recording `MetricReader`, attached to a real `MeterProvider`,
 *      collects counter / histogram / gauge instruments and flattens each
 *      data point (kind, name, value, labels).
 *
 * @verifiedBy packages/runtime/src/testing/spy-telemetry-sink.ts
 */

import { describe, expect, it } from "vitest";
import { context, trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { spyTelemetrySink } from "../testing/spy-telemetry-sink.js";

describe("spyTelemetrySink — recording SpanProcessor", () => {
  it("records a span as it ends, with its final attributes", async () => {
    const sink = spyTelemetrySink();
    const provider = new BasicTracerProvider({ spanProcessors: [sink.spanProcessor] });
    const tracer = provider.getTracer("test");

    const span = tracer.startSpan("retrieval");
    span.setAttribute("query.length", 3);
    // Not recorded until it ends.
    expect(sink.spans).toHaveLength(0);
    span.end();

    expect(sink.spans).toHaveLength(1);
    expect(sink.spans[0]!.name).toBe("retrieval");
    expect(sink.spans[0]!.parent).toBeUndefined();
    expect(sink.spans[0]!.attributes.get("query.length")).toBe(3);

    await provider.shutdown();
  });

  it("resolves a child span's parent by NAME", async () => {
    const sink = spyTelemetrySink();
    const provider = new BasicTracerProvider({ spanProcessors: [sink.spanProcessor] });
    const tracer = provider.getTracer("test");

    // Open a parent, then a child in the parent's context, end child then parent.
    const parent = tracer.startSpan("tool:command:dispatch");
    const child = tracer.startSpan("retrieval", undefined, trace.setSpan(context.active(), parent));
    child.end();
    parent.end();

    const recordedChild = sink.spans.find((s) => s.name === "retrieval");
    const recordedParent = sink.spans.find((s) => s.name === "tool:command:dispatch");
    expect(recordedParent).toBeDefined();
    expect(recordedChild).toBeDefined();
    expect(recordedChild!.parent).toBe("tool:command:dispatch");
    expect(recordedParent!.parent).toBeUndefined();

    await provider.shutdown();
  });

  it("reset() clears the recorded spans", async () => {
    const sink = spyTelemetrySink();
    const provider = new BasicTracerProvider({ spanProcessors: [sink.spanProcessor] });
    provider.getTracer("test").startSpan("s").end();
    expect(sink.spans).toHaveLength(1);
    sink.reset();
    expect(sink.spans).toHaveLength(0);
    await provider.shutdown();
  });
});

describe("spyTelemetrySink — recording MetricReader", () => {
  it("collects a counter as a 'count' record with its labels", async () => {
    const sink = spyTelemetrySink();
    const provider = new MeterProvider({ readers: [sink.metricReader] });
    const meter = provider.getMeter("test");

    const counter = meter.createCounter("acme.dispatch");
    counter.add(2, { tool: "search" });
    counter.add(3, { tool: "search" });

    const metrics = await sink.collectMetrics();
    const dispatch = metrics.find((m) => m.name === "acme.dispatch");
    expect(dispatch).toBeDefined();
    expect(dispatch!.kind).toBe("count");
    expect(dispatch!.value).toBe(5); // cumulative sum
    expect(dispatch!.labels).toEqual({ tool: "search" });

    await provider.shutdown();
  });

  it("collects a histogram as a 'record' (value = sum) and a gauge as a 'gauge' (last value)", async () => {
    const sink = spyTelemetrySink();
    const provider = new MeterProvider({ readers: [sink.metricReader] });
    const meter = provider.getMeter("test");

    const hist = meter.createHistogram("acme.latency_ms");
    hist.record(10, { outcome: "ok" });
    hist.record(30, { outcome: "ok" });

    const gauge = meter.createGauge("acme.queue_depth");
    gauge.record(7, { tool: "search" });

    const metrics = await sink.collectMetrics();

    const latency = metrics.find((m) => m.name === "acme.latency_ms");
    expect(latency).toBeDefined();
    expect(latency!.kind).toBe("record");
    expect(latency!.value).toBe(40); // sum of observations
    expect(latency!.labels).toEqual({ outcome: "ok" });

    const depth = metrics.find((m) => m.name === "acme.queue_depth");
    expect(depth).toBeDefined();
    expect(depth!.kind).toBe("gauge");
    expect(depth!.value).toBe(7);
    expect(depth!.labels).toEqual({ tool: "search" });

    await provider.shutdown();
  });
});
