# @agentick/telemetry-otlp

**One call instead of six imports.** `otlpSink()` returns a `TelemetrySink` — a `BatchSpanProcessor` over an OTLP trace exporter plus a `PeriodicExportingMetricReader` over an OTLP metric exporter — with the `OTEL_EXPORTER_OTLP_*` environment variables read at call time under an explicit-beats-ambient law applied per field.

The exporter dependencies live **here**, which is the point of a separate package: [@agentick/app](../app) declares no `@opentelemetry/exporter-*` dependency at all and lazy-imports this one only when you actually want OTLP. Installing the framework does not pull the exporter tree.

## Install

```bash
npm install @agentick/telemetry-otlp
```

## Quick start

Compose the sink into `createTelemetry` and hand the result to `createApp`:

```tsx
import { createApp, createTelemetry } from "@agentick/app/react";
import { otlpSink } from "@agentick/telemetry-otlp";

const app = await createApp(<Agent />, {
  model,
  telemetry: createTelemetry(
    { serviceName: "orders-agent" },
    otlpSink({ endpoint: "https://collector.internal:4318" }),
  ),
});
```

Env-only, no endpoint in code:

```ts
// OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.internal:4318
// OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer abc,x-tenant=acme
// OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
createTelemetry({ serviceName: "orders-agent" }, otlpSink());
```

Or don't name the sink at all. With telemetry enabled and no exporter wired, the app lazy-imports this package and builds an `otlpSink()` for you — **but only when `OTEL_EXPORTER_OTLP_ENDPOINT` is explicitly set**:

```ts
telemetry: {
  serviceName: "orders-agent";
}
```

> [!NOTE]
> That endpoint condition is a deliberate divergence from the OpenTelemetry SDK, which defaults to `localhost:4318` and quietly retries forever against nothing. No endpoint means no exporter here. Pass `autoDiscover: false` to suppress the attempt even when the variable is present.

Constructing a sink performs no I/O and opens no connection.

## Picking a protocol

```ts
otlpSink({ protocol: "grpc", endpoint: "https://collector.internal:4317" });
```

| `protocol`      | Trace exporter                             | Metric exporter                              |
| --------------- | ------------------------------------------ | -------------------------------------------- |
| `http/protobuf` | `@opentelemetry/exporter-trace-otlp-proto` | `@opentelemetry/exporter-metrics-otlp-proto` |
| `http/json`     | `@opentelemetry/exporter-trace-otlp-http`  | `@opentelemetry/exporter-metrics-otlp-http`  |
| `grpc`          | `@opentelemetry/exporter-trace-otlp-grpc`  | `@opentelemetry/exporter-metrics-otlp-grpc`  |

`http/protobuf` is the default, matching the OpenTelemetry specification's own.

> [!WARNING]
> **gRPC does not forward headers.** The gRPC exporter's config has no `headers` field — headers there are gRPC `Metadata`, which would mean depending on `@grpc/grpc-js` and constructing a metadata object. To keep this package dependency-light the gRPC path passes only the endpoint URL, so header-based auth on gRPC has to be wired at the collector or through a hand-built exporter. Both HTTP protocols forward headers normally.

## Env precedence — explicit beats ambient, per field

Environment variables are read when you **call** `otlpSink()`, not when the module loads, so a variable set after import still takes effect. Each field resolves on its own:

| Field      | Variable                      | Resolution                                                                                                                |
| ---------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `endpoint` | `OTEL_EXPORTER_OTLP_ENDPOINT` | the option, else the variable, else the exporter's own default                                                            |
| `headers`  | `OTEL_EXPORTER_OTLP_HEADERS`  | **per-key merge** — parse the `k1=v1,k2=v2` list, then explicit keys win and env-only keys are kept                       |
| `protocol` | `OTEL_EXPORTER_OTLP_PROTOCOL` | the option, else a recognized variable value, else `http/protobuf`. An unrecognized value falls back rather than throwing |

The header merge is genuinely per-key, which is what makes "override the token, keep the tenant tag" work:

```ts
// OTEL_EXPORTER_OTLP_HEADERS=authorization=env,x-env-only=keep
otlpSink({ headers: { authorization: "explicit" } });
// exporter receives { authorization: "explicit", "x-env-only": "keep" }
```

A malformed fragment in the variable — empty, no `=`, an empty key — is skipped, never thrown on. Telemetry wiring must not be the thing that crashes a boot.

## Implementing your own destination

**A sink is data, not a subclass.** The port is three optional fields, and a raw object literal is a first-class sink:

| Field           | Type                               | Purpose                                          |
| --------------- | ---------------------------------- | ------------------------------------------------ |
| `spanProcessor` | `SpanProcessor \| SpanProcessor[]` | Standard OpenTelemetry span processors           |
| `metricReader`  | `MetricReader \| MetricReader[]`   | Standard OpenTelemetry metric readers            |
| `attributes`    | `Record<string, unknown>`          | Resource attributes this destination contributes |

Everything in those slots is a standard OpenTelemetry object, passed through untouched — the framework wraps nothing of its own around them. So sampling, filtering, and batching stay expressible exactly as you'd write them against the OTel SDK:

```ts
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import type { TelemetrySink } from "@agentick/spec";

const tuned: TelemetrySink = {
  spanProcessor: new BatchSpanProcessor(
    new OTLPTraceExporter({ url: "https://collector.internal:4318/v1/traces" }),
    { scheduledDelayMillis: 1_000, maxQueueSize: 4_096 },
  ),
  attributes: { "deployment.environment": "staging" },
};
```

`createTelemetry(options, ...sinks)` merges any number of them: span processors concatenate, metric readers concatenate, and attributes merge with the explicit options winning per key over each sink's, which in turn win over `OTEL_RESOURCE_ATTRIBUTES`. So fanning out to two destinations is two arguments:

```ts
createTelemetry({ serviceName: "orders-agent" }, otlpSink(), tuned);
```

Each supplied processor and reader is validated structurally at merge time, so a plain object in the wrong slot fails at wiring rather than silently dropping every span.

**Keep the precedence logic pure.** This package's own resolution is factored into standalone functions — header parsing, the per-key merge, protocol resolution, exporter construction — so the law is tested without touching a network or asserting on a live exporter. Do the same in your own factory: resolve configuration in pure functions, and let the impure part be nothing but construction.

## API

### `otlpSink(options?): TelemetrySink`

| Option     | Type                                       | Default                          |
| ---------- | ------------------------------------------ | -------------------------------- |
| `endpoint` | `string`                                   | env, else the exporter's default |
| `headers`  | `Readonly<Record<string, string>>`         | env, else none                   |
| `protocol` | `"http/protobuf" \| "http/json" \| "grpc"` | `"http/protobuf"`                |

`otlpSink` and `OtlpSinkOptions` are the whole public surface. The resolution helpers are internal.

## Patterns

**Where the switch lives.** [@agentick/app](../app) owns `createTelemetry`, the `createApp({ telemetry })` switch, and autodiscovery. Telemetry is strictly opt-in: omitted or `false` means no runtime, no interceptors, and no overhead.

**The port.** [@agentick/spec](../spec) owns `TelemetrySink`, `TelemetryOptions`, and `TelemetrySetting`.

**What gets instrumented.** Spans and metrics are emitted by the layers that do the work — the session loop, the model executor, the tool executor. This package only decides where they go.

## Roadmap & known gaps

- **gRPC headers are not forwarded.** Per the warning above; wire header auth at the collector or build the exporter by hand.
- **No per-signal endpoint override.** The specification's `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `..._METRICS_ENDPOINT` (and their `_HEADERS` / `_PROTOCOL` siblings) are not read — one `endpoint` drives both exporters.
- **Batching knobs are exporter defaults.** `BatchSpanProcessor` and `PeriodicExportingMetricReader` are constructed with library defaults; no option surfaces `scheduledDelayMillis` or `exportIntervalMillis`. Build the sink by hand to tune them, as shown above.
- **Logs are not covered.** Trace and metric exporters only; there is no OTLP log-record exporter here.
- **The resolution helpers are not exported.** Header parsing, the per-key merge, protocol resolution, and exporter construction are internal, so a factory built on the same precedence law has to re-derive them.

## Verified by

- `src/__tests__/otlp-sink.spec.ts` — the sink shape with both slots populated by the expected batching primitives, an explicit endpoint, the env-endpoint fallback, explicit beating env, header parsing from the env list, the per-key header merge in both directions (explicit wins, env-only kept), protocol-to-exporter selection asserted structurally against the real per-protocol classes, and an unrecognized protocol value falling back instead of throwing.
