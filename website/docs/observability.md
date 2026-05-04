# Observability

Agentick has a pluggable telemetry layer. Every procedure execution emits a span with timing, attributes, and errors. Counters and histograms are available for cumulative and distribution metrics. Plug in OpenTelemetry, build a custom backend, or leave the default no-op in place.

## At a glance

```ts
import { Telemetry, createOTelProvider } from "@agentick/core";

// Anywhere in your bootstrap (once, before app starts)
Telemetry.setProvider(createOTelProvider({ serviceName: "my-agent-service" }));
```

That's it. Every procedure agentick executes — agents, tools, hooks, model calls — automatically opens and closes a span via the configured provider.

## Span anatomy

The engine starts a span for every procedure and stamps it with execution metadata before your code runs:

| Attribute                         | Description                                              |
| --------------------------------- | -------------------------------------------------------- |
| `procedure.pid`                   | Unique ID for this procedure execution                   |
| `procedure.execution_id`          | ID of the surrounding execution boundary                 |
| `procedure.parent_pid`            | Parent procedure's PID, if any                           |
| `procedure.is_execution_boundary` | True for engine entry, fork, spawn, component-tool calls |
| `procedure.execution_type`        | `engine`, `model`, `component_tool`, `fork`, `spawn`, …  |
| `procedure.metadata.*`            | Any keys passed via `.withMetadata({ … })`               |
| `metrics.*`                       | Metrics emitted via `ctx.metrics` during the procedure   |

Errors call `recordError` on the span. Aborts call `recordError` with an `AbortError`. The span is then ended.

## The Span API

```ts
interface Span {
  // Required
  end(endTime?: number): void;
  setAttribute(key: string, value: any): void;
  recordError(error: any): void;

  // Identity (optional)
  readonly traceId?: string;
  readonly spanId?: string;

  // Lifecycle (optional)
  isRecording?(): boolean;
  updateName?(name: string): void;

  // Attributes (optional)
  setAttributes?(attrs: Record<string, AttributeValue>): void;
  getAttribute?(key: string): AttributeValue | undefined;
  getAttributes?(): Readonly<Record<string, AttributeValue>>;

  // Sub-step events (optional)
  addEvent?(name: string, attrs?: Record<string, AttributeValue>, timestamp?: number): void;

  // Status (optional)
  setStatus?(status: { code: "unset" | "ok" | "error"; message?: string }): void;
}
```

The optional members let you build providers incrementally — older providers that only implement the required three remain valid. New providers should implement the whole surface for full feature support.

`AttributeValue` covers `string`, `number`, `boolean`, their array forms, and `null` — aligned with OpenTelemetry's attribute model.

## Enriching the active span

The currently-executing procedure's span is exposed on `KernelContext.activeSpan`. Read it from any code that runs inside a procedure body — middleware, hooks, the procedure itself — and enrich the span without spawning a new one.

```ts
import { Context } from "@agentick/core";

const trackingMiddleware: Middleware = async (args, envelope, next) => {
  const span = Context.tryGet()?.activeSpan;
  span?.setAttributes({
    "tool.args.shape": describeShape(args),
    "tool.user": Context.tryGet()?.user?.email ?? "anonymous",
  });
  span?.addEvent?.("middleware.before");
  try {
    const result = await next();
    span?.addEvent?.("middleware.after");
    return result;
  } catch (err) {
    // Engine already calls recordError; just enrich.
    span?.setAttribute("tool.failed_with", (err as Error)?.name);
    throw err;
  }
};
```

`activeSpan` follows context forking — each procedure sees its own span; nested procedures don't see their parent's. This matches how `traceId`, `procedurePid`, and other context fields propagate.

### Avoid clobbering engine-set values

`getAttribute` lets middleware enrich rather than overwrite:

```ts
if (span?.getAttribute?.("tool.name") === undefined) {
  span?.setAttribute("tool.name", resolveName());
}
```

### Short-circuit when not recording

Expensive serialization shouldn't run if the span is sampled out:

```ts
if (span?.isRecording?.()) {
  span.setAttribute("debug.full_args", JSON.stringify(args));
}
```

## Sub-step timing with `addEvent`

When a span covers a multi-phase operation, mark phases with events instead of nesting spans:

```ts
const span = Telemetry.startSpan("model.call");
span.addEvent?.("request_built", { tokens_in: ctx.estimatedTokens });
const response = await model.invoke(input);
span.addEvent?.("response_received", { tokens_out: response.usage.completion });
span.end();
```

Events render as a timeline within the span in OpenTelemetry-compatible viewers.

## Status overrides

`recordError` implies `error` status. Use `setStatus` to override or to mark explicit success:

```ts
span.recordError(new Error("non-fatal"));
span.setStatus?.({ code: "ok" }); // override — recoverable, treat as success
```

## Counters and histograms

Use `getCounter` for monotonically increasing values, `getHistogram` for distributions:

```ts
const tokenCounter = Telemetry.getCounter("agent.tokens", "count", "Token usage");
tokenCounter.add(150, { model: "gpt-4", direction: "input" });

const latency = Telemetry.getHistogram("agent.latency", "ms", "Response time");
latency.record(250, { route: "/v1/chat" });
```

The kernel itself emits `procedure.<metric>` histograms for every metric written via `ctx.metrics` during a procedure run.

## Writing a custom provider

Implement the `TelemetryProvider` interface and pass it to `Telemetry.setProvider`:

```ts
import type { TelemetryProvider, Span } from "@agentick/core";

const provider: TelemetryProvider = {
  startTrace(name) {
    /* ... */ return traceId;
  },
  startSpan(name) {
    const attrs: Record<string, any> = {};
    return {
      end: () => sendBackend({ name, attrs }),
      setAttribute: (k, v) => {
        attrs[k] = v;
      },
      setAttributes: (next) => {
        Object.assign(attrs, next);
      },
      getAttribute: (k) => attrs[k],
      getAttributes: () => Object.freeze({ ...attrs }),
      recordError: (err) => {
        attrs["error.message"] = err?.message;
      },
      // ...other optional methods
    };
  },
  recordError(err) {
    /* ... */
  },
  endTrace() {
    /* ... */
  },
  getCounter(name, unit, description) {
    /* ... */
  },
  getHistogram(name, unit, description) {
    /* ... */
  },
};

Telemetry.setProvider(provider);
```

The OTel adapter (`createOTelProvider`) is a working reference implementation. See `packages/kernel/src/otel-provider.ts`.

## DevTools

For local development, the [DevTools](/docs/devtools) package provides a UI over the same execution event stream — span timeline, metrics, errors. No telemetry provider configuration needed; it consumes events directly.

## Reference

- [Telemetry class](/api/@agentick/core/classes/Telemetry)
- [Span interface](/api/@agentick/core/interfaces/Span)
- [TelemetryProvider interface](/api/@agentick/core/interfaces/TelemetryProvider)
- [createOTelProvider](/api/@agentick/core/functions/createOTelProvider)
