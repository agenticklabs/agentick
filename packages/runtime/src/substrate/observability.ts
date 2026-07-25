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
 * closure allocation, referential identity across ops. `log` is always the
 * callable {@link Log} wrapper (a few closures per scope — the level-method
 * sugar, not the span/metric machinery); off the telemetry path it stamps no
 * trace ids, so the correlation read is skipped entirely.
 *
 * The facet now ALSO lands on the interceptor ctx the cascade hands to
 * middleware/hooks/guards (`InterceptorCtx = RuntimeContext & Observability &
 * Ops`). RuntimeContext stays PURE frozen data — the facets are attached at the
 * `liftMiddleware` boundary via LAZY GETTERS on a per-op value the operation
 * runner builds (`BaseHarness.buildInterceptorCtx` → `InterceptorCtxRef`), never
 * stored closures in the data. The app's `TelemetryProvider` threads through the
 * runner path (a `BaseHarness` slot) so `ctx.metrics` is live there too.
 *
 * The provider threads the WHOLE spine: per-session harnesses (tool executor,
 * session) receive it at construction; the app-shared spine (loop/model/compiler)
 * — constructed before the async `telemetry` switch resolves — receives it late
 * via `BaseHarness.adoptTelemetry` (`AppHarness.adoptSpineTelemetry`), so their
 * interceptor `ctx.metrics` export too. The wire-extension handler ctx gets the
 * same facets: the gateway attaches them in-fiber inside `runWireDispatch` via
 * `BaseHarness.defineOperationFacets` (ambient label `{ method }`).
 *
 * @see docs/proposals/v2/blueprint/78-telemetry-via-runtime-substrate.md
 * @see ./middleware.ts — the span ladder (`annotateOperationSpan`, `spanMiddleware`)
 * @see ./middleware.ts — `InterceptorCtx` / `InterceptorCtxRef` (the facet landing)
 * @verifiedBy packages/runtime/src/__tests__/observability.spec.ts
 * @verifiedBy packages/runtime/src/__tests__/interceptor-ctx-facets.spec.ts
 */

import { Effect, Runtime } from "effect";
import type { Tracer } from "effect";
import { createLog } from "@agentick/spec";
import type { Log, LogLevel, MetricLabels, Metrics, Observability, Span } from "@agentick/spec";
import type { TelemetryLayer } from "@agentick/spec";

// ============================================================================
// Log trace-id stamping
// ============================================================================

/**
 * The active trace/span coordinates stamped onto a `log` event's payload
 * (ADR 64/78 correlation join). Captured SYNCHRONOUSLY at emission — BEFORE
 * the `Effect.runFork` that appends the bus event — from the enclosing op span
 * (default) or, when the log fires inside a `ctx.trace` callback, that child
 * span. Riding the ids on the event is what survives the fork boundary (the
 * fork loses the ambient fiber, so the span is unreadable after it).
 */
export interface LogTraceContext {
  readonly traceId: string;
  readonly spanId: string;
}

/**
 * The raw, trace-aware single-emission primitive a surface hands
 * {@link deriveObservability}. Widens spec's {@link import("@agentick/spec").LogEmit}
 * with the `trace` argument the facet computes at each call: the surface
 * forwards it onto the emitted {@link import("@agentick/spec").LogEventPayload}
 * (`traceId`/`spanId`). `deriveObservability` wraps this into the callable
 * {@link Log} (level methods + `.with`); the surface only implements the bus
 * emit + the trace stamp.
 */
export type LogEmitWithTrace = (
  level: LogLevel,
  data: unknown,
  logger: string | undefined,
  trace: LogTraceContext | undefined,
) => void;

/** Mutable, FACET-SCOPED (never global) holder of the currently-active span coordinates. */
interface ActiveSpanRef {
  current: LogTraceContext | undefined;
}

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
   * The surface's scope-bound, trace-aware `log` emitter (ADR 64) — the raw
   * bus emit provided by each surface (the tool executor, a harness), since it
   * is a bus append bound to the dispatch scope, not a telemetry-switched
   * concern. `deriveObservability` wraps it into the callable {@link Log}
   * (level methods + `.with`) and supplies the `trace` argument
   * ({@link LogTraceContext}) captured from the active span at each call; the
   * surface stamps those ids onto the emitted event.
   */
  readonly log: LogEmitWithTrace;
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

  // Active-span holder for the log→span correlation join (ADR 64/78). Only
  // meaningful when a telemetry runtime (the enclosing op span) is present —
  // off the telemetry path every log carries no trace ids. `makeTrace`
  // pushes/pops child-span coordinates around a `ctx.trace` body; a log fired
  // OUTSIDE any trace falls back to the op span, read lazily + memoized so an
  // op that never logs pays nothing.
  const spanRef: ActiveSpanRef | undefined =
    runtime !== undefined ? { current: undefined } : undefined;
  let opSpanRead = false;
  let opSpan: LogTraceContext | undefined;
  const activeTrace = (): LogTraceContext | undefined => {
    if (spanRef === undefined) return undefined;
    if (spanRef.current !== undefined) return spanRef.current; // inside a ctx.trace child
    if (!opSpanRead) {
      opSpanRead = true;
      opSpan = runtime !== undefined ? readSpan(runtime) : undefined;
    }
    return opSpan;
  };

  // `log` is ALWAYS the callable Log (level methods + `.with`), independent of
  // the telemetry switch — the wrapper is a few closures, not the span/metric
  // machinery. Trace ids are captured SYNCHRONOUSLY here (before the surface's
  // `Effect.runFork`) and ride the event.
  const log: Log = createLog((level, data, logger) => deps.log(level, data, logger, activeTrace()));

  // Off path (condition 3): `trace`/`metrics` are shared frozen singletons —
  // zero build, referentially identical across every ctx.
  if (runtime === undefined && meter === undefined) {
    return { log, trace: OFF_TRACE, metrics: NOOP_METRICS };
  }

  // On path (condition 3): lazy — the trace/metrics closures are built on
  // FIRST property access and memoized, so an op that never touches
  // telemetry pays nothing beyond the two getters.
  let traceMemo: Observability["trace"] | undefined;
  let metricsMemo: Metrics | undefined;
  return {
    log,
    get trace(): Observability["trace"] {
      return (traceMemo ??= runtime !== undefined ? makeTrace(runtime, spanRef!) : OFF_TRACE);
    },
    get metrics(): Metrics {
      return (metricsMemo ??=
        meter !== undefined
          ? makeMetrics(meter, deps.namespace, deps.defaultLabels)
          : NOOP_METRICS);
    },
  };
}

/**
 * Read the current span's ids off a captured runtime SYNCHRONOUSLY — the op
 * span seeded into `activeTrace`. `Effect.currentSpan` fails when no span is
 * active (telemetry off / no tracer), in which case there are no ids.
 */
function readSpan(runtime: Runtime.Runtime<never>): LogTraceContext | undefined {
  return Runtime.runSync(runtime)(
    Effect.currentSpan.pipe(
      Effect.map((span) => ({ traceId: span.traceId, spanId: span.spanId })),
      Effect.catchAll(() => Effect.succeed<LogTraceContext | undefined>(undefined)),
    ),
  );
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
function makeTrace(
  runtime: Runtime.Runtime<never>,
  spanRef: ActiveSpanRef,
): Observability["trace"] {
  const run = Runtime.runPromise(runtime);
  return <T>(name: string, fn: (span: Span) => T | Promise<T>): Promise<T> =>
    run(
      Effect.gen(function* () {
        // Inside `withSpan` there is always a current span; wrap it so the
        // (off-fiber) callback can annotate the real span synchronously.
        const span = yield* Effect.currentSpan;
        const handle = wrapSpan(span);
        // Publish THIS span's ids as the active trace context for the duration
        // of the callback, so a `ctx.log` fired inside `fn` correlates to the
        // child span (not the enclosing op). Save/restore nests correctly;
        // `ensuring` restores on success AND failure. (Caveat: the ref is
        // facet-scoped mutable state — two SIBLING `ctx.trace` bodies racing
        // concurrently in one dispatch may cross-attribute a log; sequential
        // and nested use is exact.)
        const prev = spanRef.current;
        spanRef.current = { traceId: span.traceId, spanId: span.spanId };
        return yield* Effect.tryPromise({
          try: () => Promise.resolve(fn(handle)),
          catch: (e) => e as unknown,
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              spanRef.current = prev;
            }),
          ),
        );
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
