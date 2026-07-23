/**
 * `spyTelemetrySink()` — a recording {@link TelemetrySink} for tests
 * (Meszaros: a SPY — it records for later assertion). Unlike
 * {@link spyTelemetryProvider} (which records at the Effect edge — a tracer
 * Layer + a raw {@link MetricSink}), THIS spy records at the
 * **standard-OTel edge**: a real OTel {@link SpanProcessor} and a real OTel
 * {@link MetricReader}. Wire it under an app's `telemetry` switch (the
 * standard-OTel form) and it proves the FULL
 * Effect → @effect/opentelemetry → OTel-SDK pipeline end to end — spans that
 * reach an exporter's processor, metrics that a reader collects.
 *
 *   - `.spanProcessor` — feed to `telemetry.spanProcessor` (or any OTel
 *     `TracerProvider`); records each span as it ENDS.
 *   - `.metricReader` — feed to `telemetry.metricReader` (or any OTel
 *     `MeterProvider`); `collectMetrics()` force-collects it.
 *   - `.spans` — every span that ended on the processor, with resolved
 *     parent NAME so a test can assert nesting (mirrors
 *     {@link spyTelemetryProvider}'s `RecordedSpan`).
 *   - `collectMetrics()` — force-collect the reader and flatten every data
 *     point to a {@link RecordedSinkMetric}.
 *
 * @see ../substrate/observability.ts
 * @see ./spy-telemetry-provider.ts — the Effect-edge twin
 * @verifiedBy packages-next/runtime/src/__tests__/spy-telemetry-sink.spec.ts
 */

import { DataPointType, MetricReader } from "@opentelemetry/sdk-metrics";
import type { ResourceMetrics } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { TelemetrySink } from "@agentick/spec-next";
import type { RecordedSpan } from "./spy-telemetry-provider.js";

// Re-export the span-record shape so a test can name it from either spy —
// the standard-OTel edge and the Effect edge record identical `RecordedSpan`s.
export type { RecordedSpan } from "./spy-telemetry-provider.js";

/**
 * One flattened metric data point collected from the recording
 * {@link MetricReader}. `kind` is a best-effort map of the OTel instrument
 * aggregation to the framework's three verbs (`Sum`→`"count"`,
 * `Histogram`→`"record"`, `Gauge`→`"gauge"`); `value` is the data point's
 * aggregated value (the sum for `Sum`/`Histogram`, the last value for
 * `Gauge`); `labels` are the data point's attributes. Named distinctly from
 * {@link spyTelemetryProvider}'s `RecordedMetric` because it carries the
 * raw OTel-attribute label shape, not `MetricLabels`.
 */
export interface RecordedSinkMetric {
  readonly kind: "count" | "record" | "gauge" | string;
  readonly name: string;
  readonly value: number;
  readonly labels: Record<string, unknown>;
}

/** A recording {@link TelemetrySink} plus the assertion accessors. */
export interface SpyTelemetrySink extends TelemetrySink {
  /** A recording OTel {@link SpanProcessor} — records each span as it ends. */
  readonly spanProcessor: SpanProcessor;
  /** A recording OTel {@link MetricReader} — pull-collected by {@link collectMetrics}. */
  readonly metricReader: MetricReader;
  /** Every span that ended on the processor, in end order, with resolved parent name. */
  readonly spans: readonly RecordedSpan[];
  /** Force-collect the reader and flatten every data point to a record. */
  collectMetrics(): Promise<readonly RecordedSinkMetric[]>;
  /** Clear the recorded spans (the reader is pull-based; nothing to clear there). */
  reset(): void;
}

/**
 * A recording OTel {@link SpanProcessor}. `onStart` maps `spanId → name`
 * (so a child can resolve its parent's NAME at `onEnd`); `onEnd` pushes a
 * {@link RecordedSpan} with the span's final attributes. `forceFlush` /
 * `shutdown` are no-ops (nothing to flush — recording is synchronous).
 */
class RecordingSpanProcessor implements SpanProcessor {
  /** `spanId → span name`, maintained across every start (never evicted, so parents resolve). */
  private readonly names = new Map<string, string>();
  readonly recorded: RecordedSpan[] = [];

  onStart(span: Span): void {
    this.names.set(span.spanContext().spanId, span.name);
  }

  onEnd(span: ReadableSpan): void {
    const parentSpanId = span.parentSpanContext?.spanId;
    const parent = parentSpanId !== undefined ? this.names.get(parentSpanId) : undefined;
    const attributes = new Map<string, unknown>(Object.entries(span.attributes));
    this.recorded.push({ name: span.name, parent, attributes });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  reset(): void {
    this.names.clear();
    this.recorded.length = 0;
  }
}

/**
 * A recording OTel {@link MetricReader}. The base class handles collection
 * wiring; the two abstract push-exporter hooks (`onForceFlush` /
 * `onShutdown`) are no-ops since this reader is pull-only. `collectMetrics`
 * force-collects and flattens.
 */
class RecordingMetricReader extends MetricReader {
  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }

  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }

  async collectMetrics(): Promise<RecordedSinkMetric[]> {
    const { resourceMetrics } = await this.collect();
    return flattenResourceMetrics(resourceMetrics);
  }
}

/** Flatten a collected {@link ResourceMetrics} tree to one record per data point. */
function flattenResourceMetrics(rm: ResourceMetrics): RecordedSinkMetric[] {
  const out: RecordedSinkMetric[] = [];
  for (const scope of rm.scopeMetrics) {
    for (const metric of scope.metrics) {
      const name = metric.descriptor.name;
      switch (metric.dataPointType) {
        case DataPointType.SUM:
          // Sum aggregation — monotonic counters are the common case; map to
          // the "count" verb best-effort. `value` is the aggregated sum.
          for (const dp of metric.dataPoints) {
            out.push({ kind: "count", name, value: dp.value, labels: { ...dp.attributes } });
          }
          break;
        case DataPointType.GAUGE:
          for (const dp of metric.dataPoints) {
            out.push({ kind: "gauge", name, value: dp.value, labels: { ...dp.attributes } });
          }
          break;
        case DataPointType.HISTOGRAM:
        case DataPointType.EXPONENTIAL_HISTOGRAM:
          // `value` = the histogram's aggregated sum (fall back to count when
          // no sum was recorded).
          for (const dp of metric.dataPoints) {
            out.push({
              kind: "record",
              name,
              value: dp.value.sum ?? dp.value.count,
              labels: { ...dp.attributes },
            });
          }
          break;
      }
    }
  }
  return out;
}

/** Build a {@link SpyTelemetrySink}. */
export function spyTelemetrySink(): SpyTelemetrySink {
  const spanProcessor = new RecordingSpanProcessor();
  const metricReader = new RecordingMetricReader();

  return {
    spanProcessor,
    metricReader,
    get spans(): readonly RecordedSpan[] {
      return spanProcessor.recorded;
    },
    collectMetrics: () => metricReader.collectMetrics(),
    reset() {
      spanProcessor.reset();
    },
  };
}
