# @agentick/telemetry-otlp

The **OTLP exporter sink** for Agentick v2 telemetry — `otlpSink()` returns a
standard-OpenTelemetry [`TelemetrySink`](../spec/src/protocol/app-harness.ts)
(a `BatchSpanProcessor` + a `PeriodicExportingMetricReader` over the OTLP
`http/protobuf` · `http/json` · `grpc` exporters) with `OTEL_EXPORTER_OTLP_*`
env auto-fill under an explicit-beats-ambient, per-field precedence law.

**This package holds the OTel exporter dependencies** (`@opentelemetry/exporter-*`)
so that [`@agentick/app`](../app) stays exporter-dep-free. The app
lazy-imports this package for env-driven autodiscovery
(`TelemetryOptions.autoDiscover`) — the exporter wiring only loads when an
adopter actually wants OTLP export. Optional install, not bundled into the
metapackage.

## Purpose

A `TelemetrySink` is a telemetry DESTINATION bundle — span processor(s) and/or
metric reader(s) plus optional resource attributes — that `createTelemetry()`
merges into the `createApp({ telemetry })` switch. A raw object literal is
already a valid sink (`{ spanProcessor: new BatchSpanProcessor(exporter) }`);
this package factors out the boilerplate for the single most common
destination: an OTLP collector.

`otlpSink()` does three things the hand-rolled literal makes you repeat:

- **Picks the exporter package by wire protocol** — `http/protobuf` (default),
  `http/json`, or `grpc` — so you name a protocol, not six imports.
- **Reads the `OTEL_EXPORTER_OTLP_*` env vars at call time**, matching the
  OpenTelemetry environment-variable spec, under an explicit-beats-ambient law
  applied **per field** (an explicit option never loses to an env var; an
  absent option falls back).
- **Wraps the exporters in the standard batching primitives** —
  `BatchSpanProcessor` for spans, `PeriodicExportingMetricReader` for metrics.

## Quick Start

Compose the sink into `createTelemetry` and pass the result to `createApp`:

```ts
import { createApp, createTelemetry } from "@agentick/app";
import { otlpSink } from "@agentick/telemetry-otlp";

const app = createApp(MyAgent, {
  model,
  telemetry: createTelemetry(
    { serviceName: "orders-agent" },
    otlpSink({ endpoint: "https://collector.internal:4318" }),
  ),
});
```

Env-only — no code-level endpoint, everything from the environment:

```ts
// OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.internal:4318
// OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer abc,x-tenant=acme
// OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
telemetry: createTelemetry({ serviceName: "orders-agent" }, otlpSink());
```

Autodiscovery — you do not even name the sink. When `telemetry` enrichment is on
and NO exporter is wired, `@agentick/app` lazy-imports this package and
calls `otlpSink()` for you — **but only when `OTEL_EXPORTER_OTLP_ENDPOINT` is
explicitly set** (a deliberate divergence from the OTel SDK's silent-localhost
default: no export spam). Set `autoDiscover: false` to suppress it.

```ts
// endpoint env present ⇒ the app builds an otlpSink() automatically
telemetry: { serviceName: "orders-agent" }; // createApp({ telemetry })
```

## API

### `otlpSink(options?: OtlpSinkOptions): TelemetrySink`

Returns a `TelemetrySink` whose `spanProcessor` is a `BatchSpanProcessor`
wrapping an OTLP trace exporter and whose `metricReader` is a
`PeriodicExportingMetricReader` wrapping an OTLP metric exporter. Never performs
I/O at construction — building the sink opens no connection.

### `OtlpSinkOptions`

| Field      | Type                                          | Default         |
| ---------- | --------------------------------------------- | --------------- |
| `endpoint` | `string`                                      | env / exporter default |
| `headers`  | `Readonly<Record<string, string>>`            | env / none      |
| `protocol` | `"http/protobuf" \| "http/json" \| "grpc"`    | `"http/protobuf"` |

### Protocol → exporter package

| `protocol`      | Trace exporter                                | Metric exporter                                 |
| --------------- | --------------------------------------------- | ----------------------------------------------- |
| `http/protobuf` | `@opentelemetry/exporter-trace-otlp-proto`    | `@opentelemetry/exporter-metrics-otlp-proto`    |
| `http/json`     | `@opentelemetry/exporter-trace-otlp-http`     | `@opentelemetry/exporter-metrics-otlp-http`     |
| `grpc`          | `@opentelemetry/exporter-trace-otlp-grpc`     | `@opentelemetry/exporter-metrics-otlp-grpc`     |

### Env precedence — EXPLICIT-BEATS-AMBIENT, per field

Env is read at **call time** (not module load), so a var set after import still
takes effect. Each field resolves independently:

| Field      | Env var                        | Resolution                                                                                     |
| ---------- | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `endpoint` | `OTEL_EXPORTER_OTLP_ENDPOINT`  | `options.endpoint ?? env`                                                                       |
| `headers`  | `OTEL_EXPORTER_OTLP_HEADERS`   | **per-key merge**: parse the env's `k1=v1,k2=v2` list, then explicit keys win; env-only kept    |
| `protocol` | `OTEL_EXPORTER_OTLP_PROTOCOL`  | `options.protocol ?? valid-env ?? "http/protobuf"`; an **unrecognized** env value falls back (no throw) |

The header merge is genuinely per-key, not all-or-nothing: with
`OTEL_EXPORTER_OTLP_HEADERS=authorization=env,x-env-only=keep` and
`otlpSink({ headers: { authorization: "explicit" } })`, the exporter receives
`{ authorization: "explicit", "x-env-only": "keep" }`.

## Patterns

- **The exporter deps live HERE, not in the app.** `@agentick/app` declares
  zero `@opentelemetry/exporter-*` dependencies; it lazy-imports this package
  only when autodiscovery fires. Installing the app does not pull the OTLP
  exporter tree unless you opt into OTLP.
- **A sink is just data.** `otlpSink()` returns the same `TelemetrySink` shape a
  hand-written `{ spanProcessor, metricReader }` literal produces — the
  framework wraps nothing proprietary around the OTel objects. Sampling /
  filtering / batching stay expressible as standard OTel objects if you build
  the sink by hand instead.
- **Pure, testable seams.** Protocol resolution and header parsing/merge are
  exported pure functions (`resolveOtlpProtocol`, `parseOtlpHeaders`,
  `mergeHeaders`) so the precedence law is unit-tested without constructing
  exporters or hitting a network.

## Status

Shipped: `otlpSink()` + the three OTLP protocols + full `OTEL_EXPORTER_OTLP_*`
env auto-fill with per-field explicit-beats-ambient precedence and per-key
header merge. All exporter construction is I/O-free.

## Roadmap & known gaps

- **gRPC headers are not forwarded.** The gRPC exporter config type omits HTTP
  `headers` (headers map to gRPC `Metadata`, which requires importing
  `@grpc/grpc-js` and building a `Metadata` object). To keep this package
  dependency-light, the `grpc` path passes **only** the endpoint URL — header
  auth on gRPC must be wired at the collector or via a custom exporter. HTTP
  protocols (`http/protobuf`, `http/json`) forward headers normally.
  <!-- TODO(telemetry-phase-2): map headers → grpc Metadata when a consumer needs gRPC header auth. -->
- **No per-signal endpoint override.** The OTel spec's per-signal
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `..._METRICS_ENDPOINT` (and the
  matching `_HEADERS` / `_PROTOCOL`) are not read yet — a single `endpoint`
  drives both trace and metric exporters. <!-- TODO(telemetry-phase-2): honor per-signal OTEL_EXPORTER_OTLP_{TRACES,METRICS}_* overrides. -->
- **Batching / interval knobs are exporter defaults.** `BatchSpanProcessor` and
  `PeriodicExportingMetricReader` are constructed with library defaults; no
  option surfaces `scheduledDelayMillis` / `exportIntervalMillis` yet. Build the
  sink by hand for now if you need to tune them.

## Verified by

- `src/__tests__/otlp-sink.spec.ts` — the sink shape (both `spanProcessor` and
  `metricReader` defined as the expected batching primitives), explicit endpoint,
  env endpoint fallback, explicit-beats-env, header env parsing, per-key header
  merge (explicit wins / env-only kept), protocol→exporter selection (structural
  `instanceof` against the real per-protocol classes), and unknown-protocol-env
  fallback.
- The `TelemetrySink` contract this package implements lives in
  [`packages/spec/src/protocol/app-harness.ts`](../spec/src/protocol/app-harness.ts).
