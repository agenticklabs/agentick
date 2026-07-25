/**
 * Telemetry EXPORT wiring — the standard-OpenTelemetry edge of the
 * `createApp({ telemetry })` switch.
 *
 * This module turns the de-Effected `TelemetryOptions.spanProcessor` /
 * `metricReader` (standard OTel objects) into the runtime the substrate needs:
 *
 *   - span processors → an Effect tracer **Layer** (via `@effect/opentelemetry`'s
 *     `NodeSdk`), merged ADDITIVELY with any explicit Effect `layer`, then a
 *     `ManagedRuntime` — so `Effect.withSpan` operation spans AND `ctx.trace`
 *     child spans export to them.
 *   - metric readers → an OTel `MeterProvider` behind the framework's
 *     {@link MetricSink} seam — so `ctx.metrics.*` emissions export. Metrics do
 *     NOT ride Effect (no Layer).
 *
 * The framework wraps NOTHING around the adopter's OTel objects: sampling,
 * filtering, and batching stay expressed as the adopter's own `SpanProcessor` /
 * `MetricReader` instances. `createTelemetry` is the sugar that merges a set of
 * {@link TelemetrySink} destinations into one {@link TelemetryOptions}; the app
 * calls {@link buildTelemetryExport} at init to realize the runtime + meter,
 * including env-driven OTLP autodiscovery.
 *
 * @see docs/proposals/v2/guide-observability.md §6
 */

import { Layer, ManagedRuntime } from "effect";
import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { MetricReader } from "@opentelemetry/sdk-metrics";
import type { Attributes } from "@opentelemetry/api";
import type { MetricSink } from "@agentick/runtime";
import type {
  MetricLabels,
  TelemetryLayer,
  TelemetryOptions,
  TelemetrySetting,
  TelemetrySink,
} from "@agentick/spec";
import type { NormalizedTelemetry } from "./telemetry-defaults.js";

/** Default resource service name when the adopter names none. */
const DEFAULT_SERVICE_NAME = "agentick";

function toArray<T>(v: T | readonly T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? [...v] : [v as T];
}

function envOrUndefined(v: string | undefined): string | undefined {
  return v !== undefined && v !== "" ? v : undefined;
}

/**
 * Parse an `OTEL_RESOURCE_ATTRIBUTES`-style value (comma-separated `k=v` pairs)
 * into a record. Malformed fragments are skipped. Empty input → `{}`.
 */
function parseResourceAttributes(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined || raw === "") return out;
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === "") continue;
    out[key] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

// ============================================================================
// createTelemetry — merge destinations into one TelemetryOptions
// ============================================================================

/**
 * Merge {@link TelemetrySink} destinations into one {@link TelemetryOptions}
 * (which IS a valid {@link TelemetrySetting} — the `createApp` slot union does
 * not grow). Span processors concat, metric readers concat, attributes merge
 * UNDER the options' (explicit `options.attributes` win on key collision).
 * Validates eagerly (a bad processor/reader throws here, not at first span).
 *
 * ```ts
 * const telemetry = createTelemetry(
 *   { serviceName: "triage-bot" },
 *   otlpSink(),
 *   { spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()) },
 * );
 * createApp(<Agent />, { name: "triage-bot", telemetry });
 * ```
 *
 * @verifiedBy packages/app/src/__tests__/telemetry-wiring.spec.ts
 */
export function createTelemetry(
  options: TelemetryOptions = {},
  ...sinks: readonly TelemetrySink[]
): TelemetrySetting {
  const spanProcessors: SpanProcessor[] = [
    ...toArray(options.spanProcessor),
    ...sinks.flatMap((s) => toArray(s.spanProcessor)),
  ];
  const metricReaders: MetricReader[] = [
    ...toArray(options.metricReader),
    ...sinks.flatMap((s) => toArray(s.metricReader)),
  ];
  // Resource attributes: env (ambient) < sinks < explicit options (per-key,
  // explicit wins). `OTEL_RESOURCE_ATTRIBUTES` is a comma-separated `k=v` list.
  const attributes: Record<string, unknown> = {};
  Object.assign(attributes, parseResourceAttributes(process.env.OTEL_RESOURCE_ATTRIBUTES));
  for (const sink of sinks) Object.assign(attributes, sink.attributes ?? {});
  Object.assign(attributes, options.attributes ?? {}); // explicit options win

  // Service name: explicit option beats ambient `OTEL_SERVICE_NAME`.
  const serviceName = options.serviceName ?? envOrUndefined(process.env.OTEL_SERVICE_NAME);

  for (const p of spanProcessors) {
    if (typeof (p as { onEnd?: unknown }).onEnd !== "function") {
      throw new Error(
        "createTelemetry: a supplied spanProcessor is not a valid OTel SpanProcessor",
      );
    }
  }
  for (const r of metricReaders) {
    if (typeof (r as { collect?: unknown }).collect !== "function") {
      throw new Error("createTelemetry: a supplied metricReader is not a valid OTel MetricReader");
    }
  }

  const result: {
    serviceName?: string;
    attributes?: Record<string, unknown>;
    autoDiscover?: boolean;
    layer?: TelemetryLayer;
    spanProcessor?: SpanProcessor[];
    metricReader?: MetricReader[];
  } = {};
  if (serviceName !== undefined) result.serviceName = serviceName;
  if (Object.keys(attributes).length > 0) result.attributes = attributes;
  if (options.autoDiscover !== undefined) result.autoDiscover = options.autoDiscover;
  if (options.layer !== undefined) result.layer = options.layer;
  if (spanProcessors.length > 0) result.spanProcessor = spanProcessors;
  if (metricReaders.length > 0) result.metricReader = metricReaders;
  return result;
}

// ============================================================================
// buildTelemetryExport — realize the tracer runtime + meter (async: autodiscovery)
// ============================================================================

/** The realized export surface built from a {@link NormalizedTelemetry}. */
export interface BuiltTelemetryExport {
  /** The tracer runtime (explicit `layer` + span-processor Layer). Undefined → no span export. */
  readonly runtime?: ManagedRuntime.ManagedRuntime<never, never>;
  /** The metrics sink over the shared OTel `MeterProvider`. Undefined → no metric export. */
  readonly meter?: MetricSink;
  /**
   * Release this caller's hold on the shared `MeterProvider` (call once at app
   * close). Refcounted — the LAST holder's release `shutdown()`s the provider
   * (flushing pending metrics); earlier releases just decrement, so a sibling
   * app that shares the same readers keeps exporting. Undefined → no metric
   * export (nothing to release). See {@link buildTelemetryExport}.
   */
  readonly releaseMeter?: () => Promise<void>;
}

// ============================================================================
// Materialize-once shared meter (multi-app inheritance safety)
//
// An OTel `MetricReader` binds to exactly ONE `MeterProvider` — a second
// `new MeterProvider({ readers })` over the same reader instance throws
// "MetricReader can not be bound to a MeterProvider again". Two apps inheriting
// the SAME gateway `telemetry` setting share the SAME reader instances (the
// recommended multi-app pattern), so we MATERIALIZE the MeterProvider ONCE per
// reader set and hand every inheriting app the SAME `MetricSink` (its
// count/record/gauge are provider-agnostic — sharing is safe). The raw reader
// list is never re-bound.
//
// Keyed by reader identity. Refcounted so the provider is `shutdown()` only
// when the last holder releases (an early-closing app must not kill a sibling's
// export). Keyed on a `Map` (not `WeakMap`) because releases delete entries
// deterministically at refcount zero — no reader is retained past its last app.
// ============================================================================

interface SharedMeter {
  readonly meter: MetricSink;
  readonly meterProvider: MeterProvider;
  readonly readers: readonly MetricReader[];
  refs: number;
}

const sharedMeters = new Map<MetricReader, SharedMeter>();

/**
 * Acquire a `MetricSink` for `readers`, materializing the backing
 * `MeterProvider` at most once per reader set (see the module note). Returns the
 * shared sink + a `release` that drops this hold (last one out shuts down).
 */
function acquireMeter(
  readers: readonly MetricReader[],
  serviceName: string | undefined,
): { meter: MetricSink; release: () => Promise<void> } {
  const existing = sharedMeters.get(readers[0]);
  const shared =
    existing !== undefined && readers.every((r) => sharedMeters.get(r) === existing)
      ? existing
      : materializeSharedMeter(readers, serviceName);
  shared.refs += existing === shared ? 1 : 0; // fresh materialization starts at refs=1
  return { meter: shared.meter, release: () => releaseSharedMeter(shared) };
}

function materializeSharedMeter(
  readers: readonly MetricReader[],
  serviceName: string | undefined,
): SharedMeter {
  const built = meterFromReaders(readers, serviceName);
  const shared: SharedMeter = { ...built, readers, refs: 1 };
  for (const r of readers) sharedMeters.set(r, shared);
  return shared;
}

function releaseSharedMeter(shared: SharedMeter): Promise<void> {
  shared.refs -= 1;
  if (shared.refs > 0) return Promise.resolve();
  for (const r of shared.readers) {
    if (sharedMeters.get(r) === shared) sharedMeters.delete(r);
  }
  return shared.meterProvider.shutdown();
}

/**
 * Realize the export runtime + meter from a normalized telemetry config.
 * Async because env-driven OTLP autodiscovery lazily imports the optional
 * `@agentick/telemetry-otlp` package.
 *
 * Autodiscovery (a DELIBERATE divergence from the OTel SDK's silent-localhost
 * default): only when enrichment is on AND no exporter is wired
 * (`layer`/`spanProcessor`/`metricReader` all absent) AND `autoDiscover` is not
 * `false` AND `OTEL_EXPORTER_OTLP_ENDPOINT` is explicitly set. A missing sink
 * package logs one line and returns no exporter — never crashes.
 *
 * @verifiedBy packages/app/src/__tests__/telemetry-wiring.spec.ts
 */
export async function buildTelemetryExport(n: NormalizedTelemetry): Promise<BuiltTelemetryExport> {
  if (!n.enabled) return {};

  const spanProcessors: SpanProcessor[] = [...n.spanProcessors];
  const metricReaders: MetricReader[] = [...n.metricReaders];

  const noExporter =
    spanProcessors.length === 0 && metricReaders.length === 0 && n.layer === undefined;
  if (noExporter && n.autoDiscover !== false && hasOtlpEndpointEnv()) {
    const sink = await tryAutodiscoverOtlp();
    if (sink !== undefined) {
      spanProcessors.push(...toArray(sink.spanProcessor));
      metricReaders.push(...toArray(sink.metricReader));
    }
  }

  // Tracer runtime: explicit Effect layer + a span-processor Layer, merged
  // ADDITIVELY (every exporter sees every span — the dropped composeProviders'
  // fan-out semantic, inlined). `NodeSdk.layer` provides `Resource.Resource`;
  // that ROut is incidental (the tracer is set on the runtime regardless), so
  // it is erased at the boundary — running Effects that require `never` on the
  // runtime is sound because the Resource service is present at runtime.
  const layers: TelemetryLayer[] = [];
  if (n.layer !== undefined) layers.push(n.layer);
  if (spanProcessors.length > 0)
    layers.push(tracerLayerFromProcessors(spanProcessors, n.serviceName));

  let runtime: ManagedRuntime.ManagedRuntime<never, never> | undefined;
  if (layers.length === 1) runtime = ManagedRuntime.make(layers[0]);
  else if (layers.length > 1) {
    runtime = ManagedRuntime.make(Layer.mergeAll(layers[0], layers[1], ...layers.slice(2)));
  }

  // Metrics: acquire the SHARED sink (materialized once per reader set) so two
  // apps inheriting the same readers do NOT re-bind them (see the module note).
  let meter: MetricSink | undefined;
  let releaseMeter: (() => Promise<void>) | undefined;
  if (metricReaders.length > 0) {
    const acquired = acquireMeter(metricReaders, n.serviceName);
    meter = acquired.meter;
    releaseMeter = acquired.release;
  }

  const result: BuiltTelemetryExport = {};
  if (runtime !== undefined) (result as { runtime?: unknown }).runtime = runtime;
  if (meter !== undefined) (result as { meter?: unknown }).meter = meter;
  if (releaseMeter !== undefined)
    (result as { releaseMeter?: unknown }).releaseMeter = releaseMeter;
  return result;
}

function hasOtlpEndpointEnv(): boolean {
  const v = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return typeof v === "string" && v.length > 0;
}

/**
 * Lazily import the optional OTLP sink package. Absent package → one-line
 * message naming the install, `undefined` (never throws). The specifier is a
 * variable so the compiler does not require `@agentick/telemetry-otlp` as
 * a build dependency of `@agentick/app` (it is an OPTIONAL install).
 */
async function tryAutodiscoverOtlp(): Promise<TelemetrySink | undefined> {
  const specifier = "@agentick/telemetry-otlp";
  try {
    const mod = (await import(specifier)) as { otlpSink: () => TelemetrySink };
    return mod.otlpSink();
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[agentick] telemetry: OTEL_EXPORTER_OTLP_ENDPOINT is set but " +
        "`@agentick/telemetry-otlp` is not installed — no OTLP export. " +
        "Install it, or wire `spanProcessor` / `metricReader` explicitly.",
    );
    return undefined;
  }
}

/** span processors → an Effect tracer Layer (via `@effect/opentelemetry`). */
function tracerLayerFromProcessors(
  processors: readonly SpanProcessor[],
  serviceName: string | undefined,
): TelemetryLayer {
  const layer = NodeSdk.layer(() => ({
    resource: { serviceName: serviceName ?? DEFAULT_SERVICE_NAME },
    spanProcessor: [...processors],
  }));
  // Erase the incidental `Resource.Resource` ROut — see the caller's note.
  return layer as unknown as TelemetryLayer;
}

/** metric readers → an OTel `MeterProvider` adapted to the framework's {@link MetricSink}. */
function meterFromReaders(
  readers: readonly MetricReader[],
  serviceName: string | undefined,
): { meter: MetricSink; meterProvider: MeterProvider } {
  const meterProvider = new MeterProvider({
    resource: resourceFromAttributes({ "service.name": serviceName ?? DEFAULT_SERVICE_NAME }),
    readers: [...readers],
  });
  const otelMeter = meterProvider.getMeter(DEFAULT_SERVICE_NAME);

  // Instrument caches — OTel instruments are created lazily by name and reused
  // (creating a new instrument per emission would leak + reset aggregation).
  const counters = new Map<string, ReturnType<typeof otelMeter.createCounter>>();
  const histograms = new Map<string, ReturnType<typeof otelMeter.createHistogram>>();
  const gauges = new Map<string, ReturnType<typeof otelMeter.createGauge>>();
  const attrs = (labels: MetricLabels): Attributes => labels as unknown as Attributes;

  const meter: MetricSink = {
    count(name, n, labels) {
      let c = counters.get(name);
      if (c === undefined) {
        c = otelMeter.createCounter(name);
        counters.set(name, c);
      }
      c.add(n, attrs(labels));
    },
    record(name, value, labels) {
      let h = histograms.get(name);
      if (h === undefined) {
        h = otelMeter.createHistogram(name);
        histograms.set(name, h);
      }
      h.record(value, attrs(labels));
    },
    gauge(name, value, labels) {
      let g = gauges.get(name);
      if (g === undefined) {
        g = otelMeter.createGauge(name);
        gauges.set(name, g);
      }
      g.record(value, attrs(labels));
    },
  };
  return { meter, meterProvider };
}
