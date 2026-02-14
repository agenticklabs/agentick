/**
 * A span represents a unit of work or operation within a trace.
 * Spans track timing, attributes, and errors for observability.
 *
 * @example
 * ```typescript
 * const span = Telemetry.startSpan('database-query');
 * try {
 *   span.setAttribute('query', 'SELECT * FROM users');
 *   const result = await db.query(...);
 *   span.setAttribute('rowCount', result.length);
 * } catch (error) {
 *   span.recordError(error);
 *   throw error;
 * } finally {
 *   span.end();
 * }
 * ```
 */
export interface Span {
  /** End the span, recording its duration. */
  end(): void;
  /** Set an attribute on the span for filtering/analysis. */
  setAttribute(key: string, value: any): void;
  /** Record an error that occurred during this span. */
  recordError(error: any): void;
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
    return {
      end: () => {},
      setAttribute: () => {},
      recordError: () => {},
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
   * @param name - Name of the span (e.g., 'model-call', 'tool-execution')
   * @returns A Span object to track the operation
   */
  static startSpan(name: string): Span {
    return this.provider.startSpan(name);
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
