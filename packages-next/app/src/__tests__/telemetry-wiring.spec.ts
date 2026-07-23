/**
 * `createTelemetry` + `buildTelemetryExport` unit coverage (ADR 78, deliverable
 * de-Effect + autodiscovery). Merge semantics, eager validation, env auto-fill,
 * and the realized export shape (tracer runtime + metrics meter). The
 * end-to-end threading into `ctx.trace` / `ctx.metrics` is proven separately in
 * `telemetry-e2e.spec.tsx`.
 *
 * @verifiedBy this file
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { MetricReader } from "@opentelemetry/sdk-metrics";

import { spyTelemetrySink } from "@agentick/runtime-next/testing";
import type { TelemetryOptions } from "@agentick/spec-next";

import { buildTelemetryExport, createTelemetry } from "../telemetry-wiring.js";
import { normalizeTelemetry } from "../telemetry-defaults.js";

/** Minimal structurally-valid stubs (enough for merge + validation paths). */
const fakeProcessor = (): SpanProcessor =>
  ({
    onStart() {},
    onEnd() {},
    async forceFlush() {},
    async shutdown() {},
  }) as unknown as SpanProcessor;
const fakeReader = (): MetricReader => ({ collect() {} }) as unknown as MetricReader;

const OTEL_KEYS = [
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
] as const;

describe("createTelemetry — merge + validation + env auto-fill", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of OTEL_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of OTEL_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("concats span processors + metric readers from options AND sinks", () => {
    const p1 = fakeProcessor();
    const p2 = fakeProcessor();
    const r1 = fakeReader();
    const out = createTelemetry(
      { spanProcessor: p1 },
      { spanProcessor: p2, metricReader: r1 },
    ) as TelemetryOptions;
    expect(out.spanProcessor).toEqual([p1, p2]);
    expect(out.metricReader).toEqual([r1]);
  });

  it("merges attributes with options winning over sinks", () => {
    const out = createTelemetry(
      { attributes: { tenant: "acme", env: "prod" } },
      { attributes: { tenant: "OVERRIDDEN", region: "us" } },
    ) as TelemetryOptions;
    expect(out.attributes).toEqual({ tenant: "acme", env: "prod", region: "us" });
  });

  it("falls back serviceName ← OTEL_SERVICE_NAME (explicit wins)", () => {
    process.env.OTEL_SERVICE_NAME = "from-env";
    expect((createTelemetry({}) as TelemetryOptions).serviceName).toBe("from-env");
    expect((createTelemetry({ serviceName: "explicit" }) as TelemetryOptions).serviceName).toBe(
      "explicit",
    );
  });

  it("merges OTEL_RESOURCE_ATTRIBUTES under explicit attributes (per-key)", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "tenant=env-tenant,zone=z1";
    const out = createTelemetry({ attributes: { tenant: "explicit" } }) as TelemetryOptions;
    expect(out.attributes).toEqual({ tenant: "explicit", zone: "z1" });
  });

  it("throws eagerly on an invalid processor / reader", () => {
    expect(() => createTelemetry({ spanProcessor: {} as SpanProcessor })).toThrow(/spanProcessor/);
    expect(() => createTelemetry({ metricReader: {} as MetricReader })).toThrow(/metricReader/);
  });
});

describe("buildTelemetryExport — realized runtime + meter", () => {
  const saved = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  beforeEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved;
  });

  it("disabled → empty export (zero overhead)", async () => {
    const built = await buildTelemetryExport(normalizeTelemetry(false));
    expect(built).toEqual({});
  });

  it("a span processor yields a tracer runtime; a metric reader yields a meter + release", async () => {
    const spy = spyTelemetrySink();
    const built = await buildTelemetryExport(
      normalizeTelemetry(createTelemetry({ serviceName: "x" }, spy)),
    );
    expect(built.runtime).toBeDefined();
    expect(built.meter).toBeDefined();
    expect(built.releaseMeter).toBeDefined();
    await built.releaseMeter?.();
    await built.runtime?.dispose();
  });

  it("the SAME readers materialize ONE MeterProvider — a second build does NOT re-bind (multi-app safety)", async () => {
    // Two apps inheriting one gateway setting share reader instances; the
    // second `new MeterProvider({ readers })` would otherwise throw
    // "MetricReader can not be bound to a MeterProvider again".
    const setting = createTelemetry({ serviceName: "shared" }, spyTelemetrySink());
    const a = await buildTelemetryExport(normalizeTelemetry(setting));
    const b = await buildTelemetryExport(normalizeTelemetry(setting)); // must NOT throw
    expect(a.meter).toBeDefined();
    expect(b.meter).toBe(a.meter); // the SHARED sink instance
    // Refcount: releasing the first hold keeps the provider alive for the second.
    await a.releaseMeter?.();
    // Second release is the last one out → shuts the provider down (no throw).
    await b.releaseMeter?.();
  });

  it("enabled with no exporter and no endpoint env → no autodiscovery, no runtime", async () => {
    const built = await buildTelemetryExport(normalizeTelemetry(true));
    expect(built.runtime).toBeUndefined();
    expect(built.meter).toBeUndefined();
  });
});
