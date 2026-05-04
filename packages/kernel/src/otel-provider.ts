/**
 * OpenTelemetry provider for Agentick telemetry.
 *
 * Creates a TelemetryProvider that wraps the standard @opentelemetry/api,
 * eliminating boilerplate for users who already have OTel configured.
 *
 * @module @agentick/kernel/otel-provider
 */

import type {
  TelemetryProvider,
  Span,
  Counter,
  Histogram,
  AttributeValue,
  SpanStatus,
} from "./telemetry.js";

export interface OTelProviderOptions {
  /**
   * Service name for traces and metrics.
   * @default 'agentick'
   */
  serviceName?: string;

  /**
   * Service version for traces and metrics.
   */
  serviceVersion?: string;

  /**
   * Custom tracer name (if different from serviceName).
   */
  tracerName?: string;

  /**
   * Custom meter name (if different from serviceName).
   */
  meterName?: string;
}

/**
 * Create an OpenTelemetry provider from the standard @opentelemetry/api.
 *
 * Requires `@opentelemetry/api` to be installed and configured in your app.
 * This function dynamically imports OTel to avoid hard dependencies.
 *
 * @example
 * ```typescript
 * import { Telemetry, createOTelProvider } from './core';
 *
 * // Basic usage - just works if OTel is configured
 * Telemetry.setProvider(createOTelProvider());
 *
 * // With options
 * Telemetry.setProvider(createOTelProvider({
 *   serviceName: 'my-agent-service',
 *   serviceVersion: '1.0.0',
 * }));
 * ```
 *
 * @param options - Configuration options
 * @returns A TelemetryProvider that wraps OpenTelemetry
 * @throws Error if @opentelemetry/api is not installed
 */
export function createOTelProvider(options: OTelProviderOptions = {}): TelemetryProvider {
  // Dynamic require - fails gracefully if not installed
  let otel: any;
  try {
    otel = require("@opentelemetry/api");
  } catch {
    throw new Error(
      "createOTelProvider requires @opentelemetry/api to be installed. " +
        "Run: pnpm add @opentelemetry/api",
    );
  }

  const serviceName = options.serviceName ?? "agentick";
  const tracerName = options.tracerName ?? serviceName;
  const meterName = options.meterName ?? serviceName;

  const tracer = otel.trace.getTracer(tracerName, options.serviceVersion);
  const meter = otel.metrics.getMeter(meterName, options.serviceVersion);

  // Cache for counters and histograms to avoid recreating them
  const counters = new Map<string, Counter>();
  const histograms = new Map<string, Histogram>();

  return {
    startTrace(name: string): string {
      const span = tracer.startSpan(name);
      const ctx = otel.trace.setSpan(otel.context.active(), span);
      otel.context.with(ctx, () => {});
      return span.spanContext().traceId;
    },

    startSpan(name: string): Span {
      const parentContext = otel.context.active();
      const span = tracer.startSpan(name, undefined, parentContext);

      // OTel SDK doesn't expose attribute readback; mirror locally so the
      // optional `getAttribute`/`getAttributes` API has something to return.
      const attrs: Record<string, AttributeValue> = {};
      let ended = false;
      const spanContext = span.spanContext();

      const wrapped: Span = {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        end(endTime?: number) {
          ended = true;
          if (endTime !== undefined) span.end(endTime);
          else span.end();
        },
        setAttribute(key: string, value: any) {
          attrs[key] = value as AttributeValue;
          span.setAttribute(key, value);
        },
        setAttributes(next: Record<string, AttributeValue>) {
          for (const [k, v] of Object.entries(next)) {
            attrs[k] = v;
          }
          span.setAttributes(next);
        },
        getAttribute(key: string) {
          return attrs[key];
        },
        getAttributes() {
          return Object.freeze({ ...attrs });
        },
        addEvent(eventName: string, attributes?, timestamp?) {
          span.addEvent(eventName, attributes, timestamp);
        },
        setStatus(status: SpanStatus) {
          const code =
            status.code === "ok"
              ? otel.SpanStatusCode.OK
              : status.code === "error"
                ? otel.SpanStatusCode.ERROR
                : otel.SpanStatusCode.UNSET;
          span.setStatus({ code, message: status.message });
        },
        updateName(newName: string) {
          span.updateName(newName);
        },
        isRecording() {
          return !ended && span.isRecording();
        },
        recordError(error: any) {
          span.recordException(error);
          span.setStatus({ code: otel.SpanStatusCode.ERROR, message: error?.message });
        },
      };
      return wrapped;
    },

    recordError(error: any): void {
      const span = otel.trace.getActiveSpan();
      if (span) {
        span.recordException(error);
        span.setStatus({ code: otel.SpanStatusCode.ERROR, message: error?.message });
      }
    },

    endTrace(): void {
      const span = otel.trace.getActiveSpan();
      span?.end();
    },

    getCounter(name: string, unit?: string, description?: string): Counter {
      const key = `${name}:${unit}:${description}`;
      let counter = counters.get(key);
      if (!counter) {
        const otelCounter = meter.createCounter(name, { unit, description });
        counter = {
          add: (value: number, attributes?: Record<string, any>) =>
            otelCounter.add(value, attributes),
        };
        counters.set(key, counter);
      }
      return counter;
    },

    getHistogram(name: string, unit?: string, description?: string): Histogram {
      const key = `${name}:${unit}:${description}`;
      let histogram = histograms.get(key);
      if (!histogram) {
        const otelHistogram = meter.createHistogram(name, { unit, description });
        histogram = {
          record: (value: number, attributes?: Record<string, any>) =>
            otelHistogram.record(value, attributes),
        };
        histograms.set(key, histogram);
      }
      return histogram;
    },
  };
}
