/**
 * Allowed values for span and metric attributes.
 *
 * Aligned with OpenTelemetry's AttributeValue so providers that wrap OTel
 * (or other observability backends) can pass values through unchanged.
 */
// `Context` is imported as a runtime value for `Telemetry.startSpan` to read
// baggage off the active execution context. There's a small kernel cycle:
// telemetry → context (runtime) → telemetry (type-only via `Span`). The
// type-only side doesn't materialize at runtime, so the cycle is safe.
import { Context } from "./context.js";

export type AttributeValue = string | number | boolean | string[] | number[] | boolean[] | null;

/**
 * Status of a span — overrides the implicit "ok or error" inferred from
 * `recordError`. Useful when a procedure wants to report success despite a
 * non-fatal soft error, or mark itself errored without throwing.
 */
export interface SpanStatus {
  /** `unset` is the default; `ok` is explicit success; `error` marks failure. */
  code: "unset" | "ok" | "error";
  /** Optional human-readable message — typically used with `error`. */
  message?: string;
}

/**
 * A point-in-time event recorded within a span. Useful for sub-step timing
 * inside long-running procedures (e.g., "model_request_sent" then
 * "model_response_received") without spawning nested spans.
 */
export interface SpanEvent {
  name: string;
  attributes?: Record<string, AttributeValue>;
  /** Milliseconds since epoch. Defaults to "now" when omitted. */
  timestamp?: number;
}

/**
 * A span represents a unit of work or operation within a trace.
 * Spans track timing, attributes, and errors for observability.
 *
 * The core methods (`end`, `setAttribute`, `recordError`) are required.
 * The remaining methods are optional so that older `TelemetryProvider`
 * implementations remain valid; callers should invoke them with `?.()` and
 * tolerate `undefined` returns. New providers should implement all of them
 * for full feature support.
 *
 * @example
 * ```typescript
 * const span = Telemetry.startSpan('database-query');
 * try {
 *   span.setAttribute('query', 'SELECT * FROM users');
 *   const result = await db.query(...);
 *   span.setAttribute('rowCount', result.length);
 *   span.setStatus?.({ code: 'ok' });
 * } catch (error) {
 *   span.recordError(error);
 *   throw error;
 * } finally {
 *   span.end();
 * }
 * ```
 *
 * @example Middleware enrichment via `getAttribute`
 * ```typescript
 * // Don't clobber whatever the engine set; only add what's missing.
 * if (span.getAttribute?.('tool.name') === undefined) {
 *   span.setAttribute('tool.name', resolvedName);
 * }
 * ```
 *
 * @example Sub-step events
 * ```typescript
 * span.addEvent?.('llm_request_sent', { model: 'gpt-4' });
 * const response = await llm.invoke(...);
 * span.addEvent?.('llm_response_received', { tokens: response.usage.total });
 * ```
 */
export interface Span {
  // ── Core (required) ───────────────────────────────────────────────────
  /** End the span, recording its duration. */
  end(endTime?: number): void;
  /** Set an attribute on the span for filtering/analysis. */
  setAttribute(key: string, value: any): void;
  /** Record an error that occurred during this span. */
  recordError(error: any): void;

  // ── Identity (optional) ────────────────────────────────────────────────
  /** Trace ID this span belongs to. Used for cross-system log correlation. */
  readonly traceId?: string;
  /** Unique ID for this span. Used for cross-system log correlation. */
  readonly spanId?: string;

  // ── Lifecycle introspection (optional) ─────────────────────────────────
  /**
   * Whether the span is still recording. Returns `false` after `end()`,
   * when the provider sampled the span out, or when the provider is a no-op.
   * Useful for short-circuiting expensive attribute computation.
   */
  isRecording?(): boolean;

  // ── Naming (optional) ──────────────────────────────────────────────────
  /**
   * Refine the span's name. Useful when an initial name is generic (e.g.,
   * `http.request`) and a more specific one is known later (e.g.,
   * `POST /v1/query`).
   */
  updateName?(name: string): void;

  // ── Attributes (optional convenience + read) ───────────────────────────
  /** Set multiple attributes in a single call. */
  setAttributes?(attrs: Record<string, AttributeValue>): void;
  /**
   * Read back a previously-set attribute. Lets middleware enrich the span
   * without clobbering values stamped by the engine or other middleware.
   */
  getAttribute?(key: string): AttributeValue | undefined;
  /** Read-only snapshot of all attributes set on this span. */
  getAttributes?(): Readonly<Record<string, AttributeValue>>;

  // ── Sub-step events (optional) ─────────────────────────────────────────
  /**
   * Record a point-in-time event within this span. Cheaper than spawning a
   * nested span when only the moment matters, not a duration.
   */
  addEvent?(name: string, attributes?: Record<string, AttributeValue>, timestamp?: number): void;

  // ── Status (optional) ──────────────────────────────────────────────────
  /**
   * Explicitly set the span's status. Overrides the implicit status from
   * `recordError`. Standard OTel pattern.
   */
  setStatus?(status: SpanStatus): void;
}

/**
 * Attributes for metrics, used for filtering and grouping.
 *
 * @example
 * ```typescript
 * counter.add(1, { model: 'gpt-4', status: 'success' });
 * ```
 */
export interface MetricAttributes {
  [key: string]: string | number | boolean;
}

/**
 * A counter metric that only increases (e.g., request count, error count).
 *
 * @example
 * ```typescript
 * const requestCounter = Telemetry.getCounter('requests', 'count', 'Total requests');
 * requestCounter.add(1, { endpoint: '/api/chat' });
 * ```
 */
export interface Counter {
  /** Add a value to the counter. */
  add(value: number, attributes?: MetricAttributes): void;
}

/**
 * A histogram metric for recording distributions (e.g., latency, sizes).
 *
 * @example
 * ```typescript
 * const latencyHistogram = Telemetry.getHistogram('latency', 'ms', 'Request latency');
 * latencyHistogram.record(150, { endpoint: '/api/chat' });
 * ```
 */
export interface Histogram {
  /** Record a value in the histogram. */
  record(value: number, attributes?: MetricAttributes): void;
}

/**
 * Interface for telemetry providers (e.g., OpenTelemetry, DataDog).
 *
 * Implement this interface to integrate with your observability platform.
 *
 * @example
 * ```typescript
 * import { trace, metrics } from '@opentelemetry/api';
 *
 * const otelProvider: TelemetryProvider = {
 *   startTrace(name) { return trace.getTracer('agentick').startSpan(name).spanContext().traceId; },
 *   startSpan(name) { return trace.getTracer('agentick').startSpan(name); },
 *   // ... implement other methods
 * };
 *
 * Telemetry.setProvider(otelProvider);
 * ```
 */
export interface TelemetryProvider {
  /** Start a new trace and return its ID. */
  startTrace(name: string): string;
  /** Start a new span within the current trace. */
  startSpan(name: string): Span;
  /** Record an error in the current trace/span. */
  recordError(error: any): void;
  /** End the current trace. */
  endTrace(): void;
  /** Get or create a counter metric. */
  getCounter(name: string, unit?: string, description?: string): Counter;
  /** Get or create a histogram metric. */
  getHistogram(name: string, unit?: string, description?: string): Histogram;
}

class NoOpProvider implements TelemetryProvider {
  startTrace(_name: string): string {
    return `trace-${crypto.randomUUID()}`;
  }
  startSpan(_name: string): Span {
    // Return an inert span that satisfies the full interface so callers
    // that use the optional methods don't have to null-check `?.()`.
    const empty: Readonly<Record<string, AttributeValue>> = Object.freeze({});
    return {
      traceId: undefined,
      spanId: undefined,
      end: () => {},
      setAttribute: () => {},
      recordError: () => {},
      isRecording: () => false,
      updateName: () => {},
      setAttributes: () => {},
      getAttribute: () => undefined,
      getAttributes: () => empty,
      addEvent: () => {},
      setStatus: () => {},
    };
  }
  recordError(_error: any): void {}
  endTrace(): void {}
  getCounter(_name: string): Counter {
    return { add: () => {} };
  }
  getHistogram(_name: string): Histogram {
    return { record: () => {} };
  }
}

/**
 * Global telemetry service for tracing, spans, and metrics.
 *
 * By default, uses a no-op provider. Call `Telemetry.setProvider()` to integrate
 * with your observability platform (OpenTelemetry, DataDog, etc.).
 *
 * ## Traces and Spans
 *
 * Traces represent end-to-end operations. Spans are units of work within a trace.
 *
 * ```typescript
 * const traceId = Telemetry.startTrace('agent-execution');
 * const span = Telemetry.startSpan('model-call');
 * try {
 *   // ... do work
 *   span.setAttribute('model', 'gpt-4');
 * } finally {
 *   span.end();
 * }
 * Telemetry.endTrace();
 * ```
 *
 * ## Metrics
 *
 * Counters track cumulative values. Histograms track distributions.
 *
 * ```typescript
 * const tokenCounter = Telemetry.getCounter('tokens', 'count', 'Token usage');
 * tokenCounter.add(150, { model: 'gpt-4', type: 'input' });
 *
 * const latency = Telemetry.getHistogram('latency', 'ms', 'Response time');
 * latency.record(250);
 * ```
 *
 * @see {@link TelemetryProvider} - Implement this to add a custom provider
 */
export class Telemetry {
  private static provider: TelemetryProvider = new NoOpProvider();

  /**
   * Set the telemetry provider for all Agentick operations.
   * @param provider - The telemetry provider implementation
   */
  static setProvider(provider: TelemetryProvider): void {
    this.provider = provider;
  }

  /**
   * Reset to the default no-op provider.
   */
  static resetProvider(): void {
    this.provider = new NoOpProvider();
  }

  /**
   * Start a new trace.
   * @param name - Name of the trace (e.g., 'agent-execution')
   * @returns The trace ID
   */
  static startTrace(name: string = "operation"): string {
    return this.provider.startTrace(name);
  }

  /**
   * Start a new span within the current trace.
   *
   * If the active `KernelContext` carries `baggage`, every key/value is
   * applied to the new span via `setAttributes` before returning. This is
   * how `Context.withBaggage(...)` and `proc.withBaggage(...)` propagate
   * ambient attributes onto every span in their scope without callers
   * having to pass anything through.
   *
   * @param name - Name of the span (e.g., 'model-call', 'tool-execution')
   * @returns A Span object to track the operation
   */
  static startSpan(name: string): Span {
    const span = this.provider.startSpan(name);
    const baggage = Context.tryGet()?.baggage;
    if (baggage) {
      // `setAttributes` is optional on the Span interface; older providers
      // may only implement `setAttribute`. Fall back to per-key calls.
      if (span.setAttributes) {
        span.setAttributes(baggage);
      } else {
        for (const [key, value] of Object.entries(baggage)) {
          span.setAttribute(key, value);
        }
      }
    }
    return span;
  }

  /**
   * Record an error in the current trace/span.
   * @param error - The error to record
   */
  static recordError(error: any): void {
    this.provider.recordError(error);
  }

  /**
   * End the current trace.
   */
  static endTrace(): void {
    this.provider.endTrace();
  }

  /**
   * Get or create a counter metric.
   * @param name - Metric name (e.g., 'agentick.tokens')
   * @param unit - Unit of measurement (e.g., 'count', 'bytes')
   * @param description - Human-readable description
   * @returns A Counter instance
   */
  static getCounter(name: string, unit?: string, description?: string): Counter {
    return this.provider.getCounter(name, unit, description);
  }

  /**
   * Get or create a histogram metric.
   * @param name - Metric name (e.g., 'agentick.latency')
   * @param unit - Unit of measurement (e.g., 'ms', 'bytes')
   * @param description - Human-readable description
   * @returns A Histogram instance
   */
  static getHistogram(name: string, unit?: string, description?: string): Histogram {
    return this.provider.getHistogram(name, unit, description);
  }
}
