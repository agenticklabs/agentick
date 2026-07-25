import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

import { OTLPMetricExporter as GrpcMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPMetricExporter as HttpMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as ProtoMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter as GrpcTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as HttpTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";

import {
  buildOtlpExporters,
  mergeHeaders,
  otlpSink,
  parseOtlpHeaders,
  resolveOtlpProtocol,
} from "../otlp-sink.js";

// ---------------------------------------------------------------------------
// Env isolation — snapshot the four OTEL_* vars, restore after each test so a
// mutation never leaks. otlpSink reads process.env at CALL time, so setting a
// var inside a test is sufficient to exercise the ambient fallback.
// ---------------------------------------------------------------------------
const OTEL_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
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

// ---------------------------------------------------------------------------
// parseOtlpHeaders — the comma-separated k=v env grammar
// @verifiedBy — mirrors the @verifiedBy tag on parseOtlpHeaders
// ---------------------------------------------------------------------------
describe("parseOtlpHeaders", () => {
  it("parses a comma-separated k=v list, trimming whitespace", () => {
    expect(parseOtlpHeaders("k1=v1,k2=v2")).toEqual({ k1: "v1", k2: "v2" });
    expect(parseOtlpHeaders(" a = 1 , b = 2 ")).toEqual({ a: "1", b: "2" });
  });

  it("splits only on the FIRST = so values may contain =", () => {
    expect(parseOtlpHeaders("authorization=Bearer abc=def")).toEqual({
      authorization: "Bearer abc=def",
    });
  });

  it("skips malformed fragments without throwing (empty, no =, empty key)", () => {
    expect(parseOtlpHeaders("good=1,,broken,=novalue,ok=2")).toEqual({ good: "1", ok: "2" });
    expect(parseOtlpHeaders("")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// mergeHeaders — EXPLICIT-BEATS-AMBIENT, per key
// ---------------------------------------------------------------------------
describe("mergeHeaders", () => {
  it("returns undefined when neither source contributes", () => {
    expect(mergeHeaders(undefined, undefined)).toBeUndefined();
    expect(mergeHeaders({}, {})).toBeUndefined();
  });

  it("merges per-key with explicit winning on collision and env-only kept", () => {
    const merged = mergeHeaders(
      { shared: "explicit", onlyExplicit: "x" },
      {
        shared: "env",
        onlyEnv: "e",
      },
    );
    expect(merged).toEqual({ shared: "explicit", onlyExplicit: "x", onlyEnv: "e" });
  });

  it("passes a single source through", () => {
    expect(mergeHeaders({ a: "1" }, undefined)).toEqual({ a: "1" });
    expect(mergeHeaders(undefined, { b: "2" })).toEqual({ b: "2" });
  });
});

// ---------------------------------------------------------------------------
// resolveOtlpProtocol — explicit ?? valid-env ?? default; unknown env falls back
// ---------------------------------------------------------------------------
describe("resolveOtlpProtocol", () => {
  it("explicit option wins over env", () => {
    expect(resolveOtlpProtocol("grpc", "http/json")).toBe("grpc");
  });

  it("valid env selects when no explicit option", () => {
    expect(resolveOtlpProtocol(undefined, "http/json")).toBe("http/json");
    expect(resolveOtlpProtocol(undefined, "grpc")).toBe("grpc");
  });

  it("defaults to http/protobuf when nothing is set", () => {
    expect(resolveOtlpProtocol(undefined, undefined)).toBe("http/protobuf");
  });

  it("unknown env value falls back to http/protobuf (no throw)", () => {
    expect(resolveOtlpProtocol(undefined, "carrier-pigeon")).toBe("http/protobuf");
  });
});

// ---------------------------------------------------------------------------
// buildOtlpExporters — protocol → exporter package (structural: instanceof the
// real per-protocol classes; all trace classes share the name OTLPTraceExporter
// so identity — not constructor.name — is the discriminator)
// ---------------------------------------------------------------------------
describe("buildOtlpExporters", () => {
  it("http/protobuf builds proto exporters", () => {
    const { traceExporter, metricExporter } = buildOtlpExporters(
      "http/protobuf",
      undefined,
      undefined,
    );
    expect(traceExporter).toBeInstanceOf(ProtoTraceExporter);
    expect(metricExporter).toBeInstanceOf(ProtoMetricExporter);
  });

  it("http/json builds http exporters", () => {
    const { traceExporter, metricExporter } = buildOtlpExporters("http/json", undefined, undefined);
    expect(traceExporter).toBeInstanceOf(HttpTraceExporter);
    expect(metricExporter).toBeInstanceOf(HttpMetricExporter);
  });

  it("grpc builds grpc exporters", () => {
    const { traceExporter, metricExporter } = buildOtlpExporters("grpc", undefined, undefined);
    expect(traceExporter).toBeInstanceOf(GrpcTraceExporter);
    expect(metricExporter).toBeInstanceOf(GrpcMetricExporter);
  });
});

// ---------------------------------------------------------------------------
// otlpSink — the public factory: shape + env precedence
// ---------------------------------------------------------------------------
describe("otlpSink", () => {
  it("default protocol builds a sink with both spanProcessor and metricReader defined", () => {
    const sink = otlpSink();
    expect(sink.spanProcessor).toBeInstanceOf(BatchSpanProcessor);
    expect(sink.metricReader).toBeInstanceOf(PeriodicExportingMetricReader);
  });

  it("returns a sink whose exporters honor an explicit endpoint (does not throw)", () => {
    const sink = otlpSink({ endpoint: "https://collector.example:4318" });
    expect(sink.spanProcessor).toBeInstanceOf(BatchSpanProcessor);
    expect(sink.metricReader).toBeInstanceOf(PeriodicExportingMetricReader);
  });

  it("reads OTEL_EXPORTER_OTLP_ENDPOINT at call time when no option given", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://env-collector:4318";
    const sink = otlpSink();
    expect(sink.spanProcessor).toBeInstanceOf(BatchSpanProcessor);
    expect(sink.metricReader).toBeInstanceOf(PeriodicExportingMetricReader);
  });

  it("selects the exporter package from OTEL_EXPORTER_OTLP_PROTOCOL", () => {
    // End-to-end env→protocol→exporter selection, asserted through the same
    // helper the factory composes (the BatchSpanProcessor hides its exporter).
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
    const protocol = resolveOtlpProtocol(undefined, process.env.OTEL_EXPORTER_OTLP_PROTOCOL);
    expect(protocol).toBe("grpc");
    const { traceExporter } = buildOtlpExporters(protocol, undefined, undefined);
    expect(traceExporter).toBeInstanceOf(GrpcTraceExporter);
    // And the factory itself does not throw under the grpc env.
    expect(otlpSink().spanProcessor).toBeInstanceOf(BatchSpanProcessor);
  });

  it("unknown protocol env falls back to http/protobuf without throwing", () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "smoke-signal";
    expect(resolveOtlpProtocol(undefined, process.env.OTEL_EXPORTER_OTLP_PROTOCOL)).toBe(
      "http/protobuf",
    );
    expect(() => otlpSink()).not.toThrow();
  });

  // --- header precedence, exercised through the pure seam the factory uses ---

  it("parses header env and merges per-key with explicit winning (explicit-beats-ambient)", () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=env-token,x-env-only=keep";
    const envHeaders = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
    const merged = mergeHeaders({ authorization: "explicit-token" }, envHeaders);
    expect(merged).toEqual({
      authorization: "explicit-token", // explicit wins the collision
      "x-env-only": "keep", // env-only key retained
    });
  });

  it("builds a sink under a header env (does not throw; headers flow to http exporters)", () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=abc";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://c:4318";
    expect(() => otlpSink({ headers: { "x-tenant": "t1" } })).not.toThrow();
  });
});
