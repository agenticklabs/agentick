/**
 * The client's `log` / `trace` / `metrics` facets — the same {@link Observability}
 * contract the server ctx carries, so an adopter writing both sides reads one
 * shape.
 *
 * Built over the {@link TelemetryAdapter} the adopter already wires for
 * `@agentick/client-extensions`' `telemetry()` extension. ONE object, wired
 * once, consumed twice: the extension opens per-RPC spans through it, and these
 * facets open adopter-code spans through it. Because it is the same instance,
 * `currentTraceContext()` reports a span opened by either side and nothing needs
 * bridging between them.
 *
 * Two properties of the server's implementation are preserved verbatim:
 *
 *   - **`log` is always present and always live**, independent of the telemetry
 *     switch. No `ctx.log?.()` at a call site, ever.
 *   - **`trace` is passthrough when off** — runs `fn` with `NOOP_SPAN` and zero
 *     span machinery, so authors write traced code unconditionally and pay
 *     nothing when no adapter is wired.
 *
 * ## Parenting is EXPLICIT
 *
 * The server parents through the ADR 77 ambient-fiber mechanism — that is
 * `AsyncLocalStorage`, absent in a browser. A module-level "current span" stack
 * looks equivalent and silently misparents the moment two async handlers
 * interleave, which is the normal case with several tabs. Misparented spans are
 * worse than flat ones because they read as truth.
 *
 * So the active span is tracked per instance and passed to
 * `adapter.startSpan(name, attrs, parent)`. This mirrors the server rather than
 * diverging: its `activeTrace()` checks an explicit `spanRef.current` FIRST and
 * only falls back to the ambient read. The client keeps the primary path and
 * drops the fallback.
 */

import {
  NOOP_METRICS,
  OFF_TRACE,
  createLog,
  type Log,
  type Observability,
  type Span,
  type SpanContext,
  type TelemetryAdapter,
} from "@agentick/spec";

/** `Observability` plus the span context a caller may propagate. */
export interface ClientObservability extends Observability {
  /** The innermost span in progress, or `undefined` outside any `trace`. */
  activeSpan(): SpanContext | undefined;
}

/**
 * Build the client's observability facets over a telemetry adapter.
 *
 * `parent` seeds the trace so a context derived for one execution continues it
 * rather than starting a new one.
 */
export function clientObservability(
  adapter: TelemetryAdapter | undefined,
  parent?: SpanContext,
): ClientObservability {
  // Explicit, per-instance. NOT module-level: two concurrent handlers each hold
  // their own instance, and a shared stack would cross them.
  let active: SpanContext | undefined = parent;

  // Built unconditionally — a few closures, not span machinery. The active
  // trace is read at emit time so a log inside a `trace` correlates to its span.
  const log: Log = createLog((level, data, logger) => {
    const emit = adapter?.log;
    if (emit === undefined) return;
    emit(level, data, logger);
  });

  const metrics = adapter?.metrics ?? NOOP_METRICS;

  if (adapter === undefined) {
    return { log, trace: OFF_TRACE, metrics, activeSpan: () => active };
  }

  const trace: Observability["trace"] = async <T>(
    name: string,
    fn: (span: Span) => T | Promise<T>,
  ): Promise<T> => {
    const parentSpan = active;
    const started = adapter.startSpan(
      name,
      {},
      parentSpan ? { traceId: parentSpan.traceId, spanId: parentSpan.spanId } : undefined,
    );

    // An adapter that cannot report ids does not become a parent — better than
    // inventing ids it does not know, which would propagate a span nobody has.
    const reported = started.spanContext?.();
    if (reported !== undefined) active = reported;

    // `Span` (spec) and `TelemetrySpan` (adapter) differ: the adapter's is
    // OTel-shaped (`setError`, `end`), the ctx's is the annotation surface
    // handler authors already know from the server. Adapt rather than leak.
    const span: Span = {
      setAttribute: (k, v) => started.setAttribute(k, v),
      setAttributes: (attrs) => {
        for (const [k, v] of Object.entries(attrs)) {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            started.setAttribute(k, v);
          }
        }
      },
      addEvent: (n) => started.setAttribute(`event.${n}`, Date.now()),
      // Annotation only — never re-thrown, matching the server's contract.
      recordException: (e) => started.setError(messageOf(e)),
    };

    try {
      return await fn(span);
    } catch (thrown) {
      started.setError(messageOf(thrown));
      throw thrown;
    } finally {
      // Restore rather than clear: a sibling `trace` after this one must parent
      // under the same span this one did, not under nothing.
      active = parentSpan;
      started.end();
    }
  };

  return { log, trace, metrics, activeSpan: () => active };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
