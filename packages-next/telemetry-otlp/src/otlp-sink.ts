import { PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";

import { OTLPMetricExporter as GrpcMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPMetricExporter as HttpMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as ProtoMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter as GrpcTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as HttpTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";

import type { TelemetrySink } from "@agentick/spec-next";

/**
 * The three OTLP wire protocols this sink can target. Mirrors the OpenTelemetry
 * spec's `OTEL_EXPORTER_OTLP_PROTOCOL` value set.
 */
export type OtlpProtocol = "http/protobuf" | "http/json" | "grpc";

export interface OtlpSinkOptions {
  readonly endpoint?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly protocol?: OtlpProtocol;
}

/** The wire default when neither an explicit option nor a valid env var picks one. */
const DEFAULT_PROTOCOL: OtlpProtocol = "http/protobuf";

const KNOWN_PROTOCOLS: readonly OtlpProtocol[] = ["http/protobuf", "http/json", "grpc"];

// ============================================================================
// Pure helpers — env parsing + precedence (unit-tested directly)
// ============================================================================

/**
 * Parse an `OTEL_EXPORTER_OTLP_HEADERS`-style value — a comma-separated list of
 * `key=value` pairs — into a record. Whitespace around keys/values is trimmed.
 * The value may itself contain `=` (only the FIRST `=` splits). Malformed
 * fragments (empty, no `=`, empty key) are skipped, never thrown on.
 *
 * @verifiedBy packages-next/telemetry-otlp/src/__tests__/otlp-sink.spec.ts
 */
export function parseOtlpHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === "") continue;
    out[key] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Per-key merge of explicit headers over env-parsed headers under the
 * EXPLICIT-BEATS-AMBIENT law: an explicitly-passed key wins on collision; an
 * env-only key is kept. Returns `undefined` when neither source contributes
 * anything (so callers can omit `headers` from the exporter config entirely).
 *
 * @verifiedBy packages-next/telemetry-otlp/src/__tests__/otlp-sink.spec.ts
 */
export function mergeHeaders(
  explicit: Readonly<Record<string, string>> | undefined,
  envParsed: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (explicit === undefined && envParsed === undefined) return undefined;
  const merged = { ...envParsed, ...explicit };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Resolve the wire protocol under EXPLICIT-BEATS-AMBIENT: an explicit option
 * wins; otherwise a recognized `OTEL_EXPORTER_OTLP_PROTOCOL` env value is used;
 * an UNRECOGNIZED env value falls back to {@link DEFAULT_PROTOCOL} (never
 * throws — a typo must not crash telemetry wiring).
 *
 * @verifiedBy packages-next/telemetry-otlp/src/__tests__/otlp-sink.spec.ts
 */
export function resolveOtlpProtocol(
  explicit: OtlpProtocol | undefined,
  env: string | undefined,
): OtlpProtocol {
  if (explicit !== undefined) return explicit;
  if (env !== undefined && (KNOWN_PROTOCOLS as readonly string[]).includes(env)) {
    return env as OtlpProtocol;
  }
  return DEFAULT_PROTOCOL;
}

// ============================================================================
// Exporter construction — protocol → exporter package (unit-tested via instanceof)
// ============================================================================

export interface OtlpExporterPair {
  readonly traceExporter: SpanExporter;
  readonly metricExporter: PushMetricExporter;
}

/**
 * Construct the trace + metric exporter pair for the given protocol.
 *
 * Protocol → exporter package:
 *   - `http/protobuf` → `@opentelemetry/exporter-{trace,metrics}-otlp-proto`
 *   - `http/json`     → `@opentelemetry/exporter-{trace,metrics}-otlp-http`
 *   - `grpc`          → `@opentelemetry/exporter-{trace,metrics}-otlp-grpc`
 *
 * HTTP exporters take `{ url, headers }`. The gRPC exporter config type OMITS
 * `headers` (headers map to gRPC `Metadata`, which requires importing
 * `@grpc/grpc-js` and constructing a `Metadata` object). To keep this package
 * dependency-light and its config uniform, gRPC receives ONLY `{ url }` — header
 * auth on the gRPC path is a documented gap (wire it via the collector or a
 * custom exporter). See README "Roadmap & known gaps".
 *
 * @verifiedBy packages-next/telemetry-otlp/src/__tests__/otlp-sink.spec.ts
 */
export function buildOtlpExporters(
  protocol: OtlpProtocol,
  endpoint: string | undefined,
  headers: Record<string, string> | undefined,
): OtlpExporterPair {
  const url = endpoint !== undefined ? { url: endpoint } : {};
  const httpConfig = { ...url, ...(headers !== undefined ? { headers } : {}) };

  switch (protocol) {
    case "grpc": {
      // headers unsupported on grpc — pass url only (see doc comment above).
      return {
        traceExporter: new GrpcTraceExporter(url),
        metricExporter: new GrpcMetricExporter(url),
      };
    }
    case "http/json": {
      return {
        traceExporter: new HttpTraceExporter(httpConfig),
        metricExporter: new HttpMetricExporter(httpConfig),
      };
    }
    case "http/protobuf": {
      return {
        traceExporter: new ProtoTraceExporter(httpConfig),
        metricExporter: new ProtoMetricExporter(httpConfig),
      };
    }
  }
}

// ============================================================================
// otlpSink — the public factory
// ============================================================================

/**
 * Build a standard-OpenTelemetry {@link TelemetrySink} that exports over OTLP: a
 * `BatchSpanProcessor` wrapping an OTLP trace exporter + a
 * `PeriodicExportingMetricReader` wrapping an OTLP metric exporter.
 *
 * Every field is resolved under the EXPLICIT-BEATS-AMBIENT law, PER FIELD, with
 * env read at CALL time (not module load):
 *
 *   - `endpoint` ← option ?? `OTEL_EXPORTER_OTLP_ENDPOINT`
 *   - `headers`  ← option PER-KEY over `OTEL_EXPORTER_OTLP_HEADERS` (explicit
 *                  key wins; env-only keys kept)
 *   - `protocol` ← option ?? valid `OTEL_EXPORTER_OTLP_PROTOCOL` ?? `http/protobuf`
 *
 * @verifiedBy packages-next/telemetry-otlp/src/__tests__/otlp-sink.spec.ts
 */
export function otlpSink(options: OtlpSinkOptions = {}): TelemetrySink {
  const env = process.env;

  const endpoint = options.endpoint ?? env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const envHeadersRaw = env.OTEL_EXPORTER_OTLP_HEADERS;
  const envHeaders =
    envHeadersRaw !== undefined && envHeadersRaw !== ""
      ? parseOtlpHeaders(envHeadersRaw)
      : undefined;
  const headers = mergeHeaders(options.headers, envHeaders);

  const protocol = resolveOtlpProtocol(options.protocol, env.OTEL_EXPORTER_OTLP_PROTOCOL);

  const { traceExporter, metricExporter } = buildOtlpExporters(protocol, endpoint, headers);

  return {
    spanProcessor: new BatchSpanProcessor(traceExporter),
    metricReader: new PeriodicExportingMetricReader({ exporter: metricExporter }),
  };
}
