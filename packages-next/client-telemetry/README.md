# @agentick/client-telemetry-next

Telemetry middleware for `@agentick/client-next` — span per logical
RPC, W3C Trace Context propagation, OpenTelemetry RPC semantic
conventions.

## Prior art

| Library / spec | What it does | Where we match it |
|---|---|---|
| OpenTelemetry JS SDK | `@opentelemetry/api` Tracer + Span; RPC semconv | OTel-shaped `TelemetrySpan` interface; attributes match the semconv (`rpc.system`, `rpc.service`, `rpc.method`, `rpc.jsonrpc.version`, `rpc.jsonrpc.error_code`) |
| W3C Trace Context | `traceparent` / `tracestate` headers | Propagated via the MCP `_meta` slot on every outbound RPC; server extracts to seed its span tree |
| Datadog dd-trace, Sentry, Honeycomb Beeline | Auto-instrument HTTP / fetch | Adopters BYO Tracer; we don't pin a vendor |
| OTel JS Meter | Counters / histograms | Deferred; see roadmap |

## BYO tracer

We do NOT bundle `@opentelemetry/api`. Adopters pass an adapter that
wraps their tracer of choice. This keeps the bundle small and lets
adopters use Datadog / Sentry / Honeycomb / etc. without dragging
opentelemetry-api in.

```ts
import { trace, SpanKind } from "@opentelemetry/api";
import { createClient } from "@agentick/client-next";
import { telemetry, type TelemetryAdapter } from "@agentick/client-telemetry-next";

const tracer = trace.getTracer("@agentick/client-next");

const adapter: TelemetryAdapter = {
  startSpan(name, attributes) {
    const span = tracer.startSpan(name, { kind: SpanKind.CLIENT, attributes });
    return {
      setAttribute: (k, v) => span.setAttribute(k, v),
      setError: (msg) => {
        span.recordException({ message: msg });
        span.setStatus({ code: 2 /* ERROR */, message: msg });
      },
      end: () => span.end(),
    };
  },
  currentTraceContext() {
    const active = trace.getActiveSpan();
    if (!active) return {};
    const ctx = active.spanContext();
    const flags = ctx.traceFlags.toString(16).padStart(2, "0");
    return {
      traceparent: `00-${ctx.traceId}-${ctx.spanId}-${flags}`,
      tracestate: ctx.traceState?.serialize(),
    };
  },
};

const client = await createClient({
  transport: ...,
  extensions: [telemetry({ adapter })],
});
```

For tests / adopters who only want trace context propagation without
observation, use `noopAdapter`:

```ts
import { telemetry, noopAdapter } from "@agentick/client-telemetry-next";
client.extensions = [telemetry({ adapter: noopAdapter })];
```

## Configuration

```ts
telemetry({
  adapter,                       // required — BYO tracer
  sample: (method) => boolean,   // per-method sampler; default sample all
  serviceName: "agentick",       // reported as rpc.service; default "agentick"
});
```

## What's recorded

Per logical RPC (outermost middleware position; one span per send,
NOT per retry attempt):

- **Span name** — `${serviceName}/${method}` (e.g., `agentick/session/send`)
- **Attributes** (per OTel RPC semantic conventions):
  - `rpc.system = "jsonrpc"`
  - `rpc.service` — from `serviceName`
  - `rpc.method` — e.g., `session/send`
  - `rpc.jsonrpc.version = "2.0"`
  - `rpc.duration_ms` — set on completion
  - `rpc.jsonrpc.error_code` — on JSON-RPC errors
- **Error** — `span.setError(message)` for any rejection (transport or RPC)

## What's propagated

Every outbound RPC gets `params._meta.traceparent` (and `_meta.tracestate`
if the adapter supplies one). MCP-compatible servers — including
agentick gateways via the server-side dispatcher — see this in
`req.params._meta` and seed their own span hierarchy from it.

## Status

Phase 33.F of the v2 implementation plan.

## Verified by

| Concern | Test |
|---|---|
| Span opens per RPC with OTel RPC semantic conventions | `src/__tests__/telemetry.spec.ts` |
| W3C Trace Context propagation via `_meta.traceparent` | `src/__tests__/telemetry.spec.ts` |
| Traceparent generation when adapter doesn't supply one | `src/__tests__/telemetry.spec.ts` |
| Errors recorded with message + `rpc.jsonrpc.error_code` | `src/__tests__/telemetry.spec.ts` |
| Per-method sampling skips spans for noisy methods | `src/__tests__/telemetry.spec.ts` |
| Custom serviceName flows into span name + rpc.service | `src/__tests__/telemetry.spec.ts` |
| noopAdapter still propagates trace context | `src/__tests__/telemetry.spec.ts` |
| `generateTraceparent` matches W3C format | `src/__tests__/telemetry.spec.ts` |

## Roadmap & known gaps

- **Meter / counters / duration histogram** — OTel JS Meter exposes
  Counter, Histogram, Gauge. Worth wiring `client.send.count`,
  `client.send.duration` once a real observability backend is in use.
- **`tracestate` propagation from caller context** — handled via the
  adapter's `currentTraceContext()` return value; the middleware doesn't
  parse/manipulate tracestate.
- **Span links** — for retries, the retried-span should link to the
  original. Currently retries collapse into one span (one logical
  call = one span). Worth revisiting if hedging / fan-out land.
- **Baggage propagation** — W3C Baggage header propagation not
  implemented; defer until a concrete adopter needs it.
- **Auto-mapping `rpc.jsonrpc.request_id`** — JSON-RPC request id is
  allocated inside the transport, not visible to the middleware.
  Would require exposing the id back through the middleware chain;
  small but breaking change.
