/**
 * `spyTelemetryProvider()` — a recording {@link TelemetryProvider} for
 * tests (Meszaros: a SPY — it records calls for later assertion). Wire it
 * under an app's `telemetry` switch (or hand its runtime to
 * `deriveObservability`) and assert the spans + metrics your handlers
 * emit.
 *
 *   - `.spans` — every span opened on the recording tracer (operation
 *     spans AND `ctx.trace` child spans), with resolved parent name so a
 *     test can assert nesting.
 *   - `.metrics` — every `ctx.metrics.*` emission (kind, name, value,
 *     labels).
 *   - `.tracer` — the recording Effect tracer Layer (feeds a
 *     `ManagedRuntime`).
 *   - `.meter` — the recording {@link MetricSink}.
 *
 * @see ../substrate/observability.ts
 */

import { Layer, Option, Tracer } from "effect";
import type { MetricLabels } from "@agentick/spec-next";
import type { MetricSink, TelemetryProvider } from "../substrate/observability.js";

/** One recorded `ctx.metrics.*` call. */
export interface RecordedMetric {
  readonly kind: "count" | "record" | "gauge";
  readonly name: string;
  readonly value: number;
  readonly labels: MetricLabels;
}

/** One recorded span. `parent` is the parent span's name (or spanId), `undefined` at the root. */
export interface RecordedSpan {
  readonly name: string;
  readonly parent: string | undefined;
  /** Live attribute map — reflects `span.setAttribute(...)` calls made after creation. */
  readonly attributes: ReadonlyMap<string, unknown>;
}

/** A recording {@link TelemetryProvider} plus the assertion accessors. */
export interface SpyTelemetryProvider extends TelemetryProvider {
  readonly tracer: TelemetryProvider["tracer"];
  readonly meter: MetricSink;
  /** All spans opened on the recording tracer, in creation order. */
  readonly spans: readonly RecordedSpan[];
  /** All metric emissions, in call order. */
  readonly metrics: readonly RecordedMetric[];
  /** Clear both recordings. */
  reset(): void;
}

/** Build a {@link SpyTelemetryProvider}. */
export function spyTelemetryProvider(): SpyTelemetryProvider {
  const spans: RecordedSpan[] = [];
  const metrics: RecordedMetric[] = [];
  let spanCounter = 0;

  const tracer = Tracer.make({
    span(name, parent, context, links, startTime, kind) {
      const attributes = new Map<string, unknown>();
      const parentName = Option.isSome(parent)
        ? ((parent.value as { name?: string }).name ?? parent.value.spanId)
        : undefined;
      spans.push({ name, parent: parentName, attributes });
      return {
        _tag: "Span",
        name,
        spanId: `spy-span-${++spanCounter}`,
        traceId: "spy-trace",
        parent,
        context,
        status: { _tag: "Started", startTime },
        attributes,
        links,
        sampled: true,
        kind,
        attribute: (key, value) => {
          attributes.set(key, value);
        },
        event: () => {},
        end: () => {},
        addLinks: () => {},
      };
    },
    context: (f) => f(),
  });

  const meter: MetricSink = {
    count: (name, value, labels) => metrics.push({ kind: "count", name, value, labels }),
    record: (name, value, labels) => metrics.push({ kind: "record", name, value, labels }),
    gauge: (name, value, labels) => metrics.push({ kind: "gauge", name, value, labels }),
  };

  return {
    tracer: Layer.setTracer(tracer),
    meter,
    spans,
    metrics,
    reset() {
      spans.length = 0;
      metrics.length = 0;
    },
  };
}
