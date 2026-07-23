/**
 * `deriveObservability` (ADR 64/78) — the ONE derivation that turns a
 * telemetry provider (or its absence) into the flat {@link Observability}
 * facet every ctx surface carries. N thin ctx assemblers call this; ONE
 * implementation lives here, next to the span ladder (`annotateOperationSpan`
 * / `spanMiddleware`) it composes with.
 *
 * ## The seam is Effect-native (condition-4 finding)
 *
 * There is NO bespoke "telemetry provider object" in v2 — the span ladder
 * (ADR 78) is Effect's own tracer, opened by `runOperation` via
 * `Effect.withSpan` and enabled by the app's `telemetry` Layer
 * (`ManagedRuntime.make(layer)`). So:
 *
 *   - **`trace` is Effect-native.** It opens a child span with
 *     `Effect.withSpan` on the **captured operation runtime** — the exact
 *     ADR-77 mechanism `liftMiddleware` uses to cross the JS/fiber boundary
 *     while preserving the fiber's world (parent span + tracer). There is
 *     no second parenting path: a `ctx.trace` span nests under the current
 *     operation span because the captured runtime's Context carries it.
 *   - **`metrics` is genuinely new.** The span ladder has no metrics half,
 *     so this module adds a minimal {@link MetricSink} (the meter surface)
 *     to the provider seam. The app fans emissions out by wiring several
 *     backends behind one {@link MetricSink} at construction time.
 *
 * ## Off is free (condition-3)
 *
 * When no telemetry runtime/meter is supplied, `trace` is a passthrough
 * and `metrics` is a no-op, both drawn from process-global frozen
 * singletons ({@link OFF_TRACE} / {@link NOOP_METRICS}) — zero per-op
 * closure allocation, referential identity across ops.
 *
 * TODO(observability-runtime-ctx): land the facet on the RuntimeContext the
 * interceptor cascade hands to middleware/hooks/guards (the `AsyncMiddleware`
 * ctx arg + `getContext`). RuntimeContext is a PURE frozen data carrier
 * spread through `withContext` — so DO NOT extend it with stored closures;
 * decorate the ctx at the `liftMiddleware` boundary via `deriveObservability`
 * with getters (lazy on first touch). Requires threading the app's
 * `TelemetryProvider` through the operation-runner hot path. Deferred: the
 * hot-path/perf + AsyncMiddleware ctx-type change warrant a dedicated slice.
 * TODO(observability-wire-ctx): same landing on the wire-extension handler ctx.
 *
 * @see docs/proposals/v2/blueprint/78-telemetry-via-runtime-substrate.md
 * @see ./middleware.ts — the span ladder (`annotateOperationSpan`, `spanMiddleware`)
 * @verifiedBy packages-next/runtime/src/__tests__/observability.spec.ts
 */

import { Effect, Runtime } from "effect";
import type { Tracer } from "effect";
import type { MetricLabels, Metrics, Observability, Span } from "@agentick/spec-next";
import type { TelemetryLayer } from "@agentick/spec-next";

// ============================================================================
// Provider seam — spans (Effect tracer Layer) + metrics (MetricSink)
// ============================================================================

/**
 * The metrics half of the telemetry provider — the meter surface added
 * here because the ADR-78 span ladder had none. Three verbs mapping to the
 * three instrument kinds; `n`/`value` and the resolved `labels` are always
 * concrete (the facet's optional-arg defaulting happens in
 * {@link deriveObservability} before the sink is called). An adopter
 * implements this over their metrics backend (OTel meter, StatsD,
 * track-API, …).
 */
export interface MetricSink {
  /** Add `n` to a counter (`counter.add`). */
  count(name: string, n: number, labels: MetricLabels): void;
  /** Record a histogram observation (`histogram.record`). */
  record(name: string, value: number, labels: MetricLabels): void;
  /** Record a last-value gauge observation. */
  gauge(name: string, value: number, labels: MetricLabels): void;
}

/**
 * A telemetry provider — the pluggable sink bundle the app wires under its
 * `telemetry` switch. Both halves optional: a `tracer` Layer (Effect's
 * tracer, where `Effect.withSpan` spans EXPORT) and/or a {@link MetricSink}
 * meter. `{}` is a valid provider (enrichment on, no export). The app
 * merges multiple span processors / metric readers into ONE provider at
 * construction time (span processors concat, metric readers concat).
 */
export interface TelemetryProvider {
  /**
   * The Effect tracer runtime Layer (exporter wiring) — the same value the
   * `telemetry` switch's {@link TelemetryLayer} form accepts. When present,
   * operation spans AND `ctx.trace` child spans export to it.
   */
  readonly tracer?: TelemetryLayer;
  /** The metrics sink. When present, `ctx.metrics.*` emit to it. */
  readonly meter?: MetricSink;
}

// ============================================================================
// Off-path singletons (condition-3: zero per-op allocation, shared identity)
// ============================================================================

/** No-op span handed to a `trace` callback when telemetry is off. Frozen, shared. */
export const NOOP_SPAN: Span = Object.freeze({
  setAttribute: () => {},
  setAttributes: () => {},
  addEvent: () => {},
  recordException: () => {},
});

/**
 * Passthrough `trace` for the telemetry-off path — runs `fn` with the
 * {@link NOOP_SPAN} and resolves with its value, no span machinery. Frozen,
 * shared across every ctx (the referential-identity target).
 */
export const OFF_TRACE: Observability["trace"] = <T>(
  _name: string,
  fn: (span: Span) => T | Promise<T>,
): Promise<T> => Promise.resolve(fn(NOOP_SPAN));

/** No-op metrics for the telemetry-off path. Frozen, shared. */
export const NOOP_METRICS: Metrics = Object.freeze({
  count: () => {},
  record: () => {},
  gauge: () => {},
});

// ============================================================================
// deriveObservability
// ============================================================================

/**
 * The telemetry runtime a surface captured **in-fiber** (inside the
 * operation body, after `runOperation` opened the op span) to seed
 * {@link deriveObservability}. `runtime` is `Effect.runtime()` — it bundles
 * the parent op span + the tracer, so a `trace` child span nests under the
 * op span (ADR-77 mechanism). `meter` is the metrics sink. Either may be
 * absent; both absent ⇒ `deriveObservability` takes the off path.
 */
export interface TelemetryRuntime {
  /** The captured operation runtime (parent span + tracer in its Context). */
  readonly runtime?: Runtime.Runtime<never>;
  /** The metrics sink from the active {@link TelemetryProvider}. */
  readonly meter?: MetricSink;
}

/** Inputs to {@link deriveObservability}. */
export interface DeriveObservabilityDeps {
  /**
   * The surface's scope-bound `log` emitter (ADR 64) — UNCHANGED behavior,
   * provided by each surface (the tool executor, a harness) since it is a
   * bus emit bound to the dispatch scope, not a telemetry-switched concern.
   * `deriveObservability` only threads it onto the facet.
   */
  readonly log: Observability["log"];
  /**
   * Telemetry-namespace prefix for metric names (never hardcode `agentick`
   * — pass the harness's `telemetryNamespace`). Applied as `<ns>.<name>`.
   */
  readonly namespace: string;
  /**
   * Default metric labels merged under every `ctx.metrics.*` call. The
   * SURFACE supplies these and is responsible for keeping them
   * **low-cardinality** (tool name, op suffix, outcome) — high-cardinality
   * identity (sessionId/executionId) belongs on spans + logs, never here.
   * Per-call labels override on key collision.
   */
  readonly defaultLabels?: MetricLabels;
  /**
   * The captured telemetry runtime + meter. `undefined` (or both fields
   * absent) ⇒ telemetry off ⇒ shared passthrough/no-op singletons.
   */
  readonly telemetry?: TelemetryRuntime;
}

/**
 * Build the {@link Observability} facet for one ctx surface. `log` is
 * threaded through unchanged; `trace`/`metrics` come from the telemetry
 * runtime when present, else from the shared off-path singletons
 * ({@link OFF_TRACE} / {@link NOOP_METRICS}) — zero per-op closure
 * allocation on the hot path.
 */
export function deriveObservability(deps: DeriveObservabilityDeps): Observability {
  const runtime = deps.telemetry?.runtime;
  const meter = deps.telemetry?.meter;

  // Off path (condition 3): shared frozen singletons, zero build, zero
  // per-op closure allocation. `trace`/`metrics` are referentially
  // identical across every ctx.
  if (runtime === undefined && meter === undefined) {
    return { log: deps.log, trace: OFF_TRACE, metrics: NOOP_METRICS };
  }

  // On path (condition 3): lazy — the trace/metrics closures are built on
  // FIRST property access and memoized, so an op that never touches
  // telemetry pays nothing beyond the two getters.
  let traceMemo: Observability["trace"] | undefined;
  let metricsMemo: Metrics | undefined;
  return {
    log: deps.log,
    get trace(): Observability["trace"] {
      return (traceMemo ??= runtime !== undefined ? makeTrace(runtime) : OFF_TRACE);
    },
    get metrics(): Metrics {
      return (metricsMemo ??=
        meter !== undefined
          ? makeMetrics(meter, deps.namespace, deps.defaultLabels)
          : NOOP_METRICS);
    },
  };
}

// ============================================================================
// Live implementations
// ============================================================================

/**
 * Live `trace` — opens a child span with `Effect.withSpan` on the captured
 * op runtime so it nests under the current operation span (the ONLY
 * parenting path). The adopter's `fn` runs off-fiber (via `tryPromise`) but
 * receives a {@link Span} wrapping the LIVE tracer span, so
 * `span.setAttribute(...)` writes through synchronously even from the
 * off-fiber body.
 */
function makeTrace(runtime: Runtime.Runtime<never>): Observability["trace"] {
  const run = Runtime.runPromise(runtime);
  return <T>(name: string, fn: (span: Span) => T | Promise<T>): Promise<T> =>
    run(
      Effect.gen(function* () {
        // Inside `withSpan` there is always a current span; wrap it so the
        // (off-fiber) callback can annotate the real span synchronously.
        const span = yield* Effect.currentSpan;
        const handle = wrapSpan(span);
        return yield* Effect.tryPromise({
          try: () => Promise.resolve(fn(handle)),
          catch: (e) => e as unknown,
        });
      }).pipe(Effect.withSpan(name)),
    ) as Promise<T>;
}

/** Adapt an Effect {@link Tracer.Span} to the framework's {@link Span} handle. */
function wrapSpan(span: Tracer.Span): Span {
  return {
    setAttribute: (key, value) => span.attribute(key, value),
    setAttributes: (attributes) => {
      for (const [key, value] of Object.entries(attributes)) span.attribute(key, value);
    },
    addEvent: (name, attributes) =>
      span.event(name, nowNanos(), attributes as Record<string, unknown> | undefined),
    recordException: (error) => {
      const message =
        error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
      const attrs: Record<string, unknown> = { "exception.message": message };
      if (error instanceof Error && error.stack !== undefined) {
        attrs["exception.stacktrace"] = error.stack;
      }
      span.event("exception", nowNanos(), attrs);
    },
  };
}

/** Wall-clock now as nanoseconds (Effect `Tracer.Span.event` startTime is a bigint ns). */
function nowNanos(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

/** Live `metrics` — namespaces metric names and merges the surface's low-cardinality defaults. */
function makeMetrics(
  meter: MetricSink,
  namespace: string,
  defaultLabels: MetricLabels | undefined,
): Metrics {
  const name = (n: string): string => `${namespace}.${n}`;
  const labels = (extra: MetricLabels | undefined): MetricLabels =>
    extra === undefined ? (defaultLabels ?? EMPTY_LABELS) : { ...defaultLabels, ...extra };
  return {
    count: (n, count = 1, extra) => meter.count(name(n), count, labels(extra)),
    record: (n, value, extra) => meter.record(name(n), value, labels(extra)),
    gauge: (n, value, extra) => meter.gauge(name(n), value, labels(extra)),
  };
}

const EMPTY_LABELS: MetricLabels = Object.freeze({});
