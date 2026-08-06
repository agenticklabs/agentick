/**
 * Observability facet (ADR 64 + 78) — the ONE diagnostic surface every
 * ctx-shaped seam carries: structured `log`, sub-operation `trace`
 * spans, and `metrics`. Defined once here, landed flat on every ctx
 * ({@link ToolHandlerCtx}, the runtime interceptor ctx, the wire-handler
 * ctx, and — by inheritance — the MCP request ctx) so a handler reaches
 * `ctx.log(...)` / `ctx.trace(...)` / `ctx.metrics.count(...)` with the
 * SAME spelling regardless of surface.
 *
 * ## Where `trace` sits on the ladder
 *
 * `ctx.trace(name, fn)` creates a span **OUTSIDE the operation system**:
 * no journal, no hooks, no guards, no idempotent replay. It is rung 2 of
 * the observability→operation ladder — a TIMING / ATTRIBUTION annotation
 * INSIDE a handler, sub-operation granularity only:
 *
 *   count it ({@link Metrics.count}) < see it ({@link Observability.trace})
 *     < run it ({@link import("./ops.js").Ops.run}) < name it (a command).
 *
 * Reach for `ctx.trace` to carve a sub-span out of a handler body's own
 * work (a retrieval, a parse, a fan-out). When the step deserves a durable
 * journal record + guard/hook reach, climb to `ctx.run` (rung 3 — a real
 * operation, minted inline). When the verb is part of the system's
 * contract, register a command (rung 4). Spans opened by `ctx.trace`
 * parent under the current operation span via the SAME ambient-fiber
 * mechanism the ADR-77 span tree uses (`Effect.withSpan` on the captured
 * runtime) — `trace` spans, `run` spans, and command spans share ONE
 * parenting path.
 *
 * ## Absorbed `log` (ADR 64)
 *
 * `log` used to be declared inline on {@link ToolHandlerCtx}; it is now a
 * member of THIS facet (a callable {@link Log} — see its docblock for the
 * RFC-5424 level methods and `.with` child binding) and reaches
 * ToolHandlerCtx via `extends`. Every form emits ONE bus event
 * (`<surface>:signal:log`) that projections forward (MCP →
 * `notifications/message`; the agentick client → `subscribe`/`onLog`).
 * Unlike `trace`/`metrics`, `log` is ALWAYS live (independent of the
 * telemetry switch) because emitting a bus event is always possible.
 *
 * TODO(store-ctx): when a `StoreCtx` surface is introduced, this facet is
 * its first field — data-layer reads/writes want the same log/trace/
 * metrics surface as every other ctx. (No `StoreCtx` exists yet; do not
 * create one for this.)
 *
 * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
 * @see docs/proposals/v2/blueprint/78-telemetry-via-runtime-substrate.md
 * @verifiedBy packages/spec-conformance/src/observability.ts (runObservabilityCtxConformance)
 * @verifiedBy packages/runtime/src/__tests__/observability.spec.ts
 */

import type { LogLevel } from "./signals.js";

// ============================================================================
// Metric labels
// ============================================================================

/**
 * A metric label set — string→string, **low-cardinality only**. Labels
 * become time-series dimensions in the metrics backend; a high-cardinality
 * label (a session id, an execution id, a user id, a free-form message)
 * explodes cardinality and can bankrupt a metrics pipeline. The framework's
 * OWN default labels are strictly bounded (tool name, op suffix, outcome);
 * high-cardinality identity (`sessionId`/`executionId`) rides SPANS and
 * LOGS, never a default metric label. Adopters MAY add their own labels —
 * the framework does not police them (capability, not opinion) — but the
 * default set stays low-cardinality so a naive `ctx.metrics.count(...)`
 * is safe by construction.
 */
export type MetricLabels = Readonly<Record<string, string>>;

// ============================================================================
// Span handle
// ============================================================================

/**
 * The span handle handed to a {@link Observability.trace} callback. A
 * deliberately minimal, framework-owned surface over the underlying
 * tracer span — adopters annotate the sub-span without importing the
 * tracer SDK. Every method is a no-op when no tracer is wired (telemetry
 * off), so handler code never branches on "is telemetry on."
 */
export interface Span {
  /** Set a single low-cardinality attribute on the span. */
  setAttribute(key: string, value: string | number | boolean): void;
  /** Set several attributes at once (open bag — a new dimension is a new key). */
  setAttributes(attributes: Readonly<Record<string, unknown>>): void;
  /** Record a timestamped event on the span (e.g. a milestone within the sub-op). */
  addEvent(name: string, attributes?: Readonly<Record<string, unknown>>): void;
  /** Record an exception on the span. Does NOT re-throw — annotation only. */
  recordException(error: unknown): void;
}

// ============================================================================
// Metrics surface
// ============================================================================

/**
 * The `metrics` half of the facet — three verbs mapping to the three
 * standard instrument kinds. Every call is a no-op when no meter is wired
 * (telemetry off). `labels` are {@link MetricLabels} (low-cardinality).
 */
export interface Metrics {
  /**
   * Increment a **counter** by `n` (default `1`). Counter semantics:
   * monotonic, summed across calls (`counter.add`). Use for event tallies
   * — dispatches, tool errors, cache misses.
   */
  count(name: string, n?: number, labels?: MetricLabels): void;
  /**
   * Record a **histogram** observation of `value`. Histogram semantics:
   * distribution (buckets/quantiles) over many observations
   * (`histogram.record`). Use for latencies, payload sizes, token counts.
   */
  record(name: string, value: number, labels?: MetricLabels): void;
  /**
   * Record a **gauge** observation of `value`. Gauge semantics chosen here:
   * **last-value** — each call replaces the prior reading; the backend
   * reports the most-recent value at scrape time (asynchronous/observable
   * gauge with last-value aggregation), NOT a sum and NOT a delta. Use for
   * point-in-time levels — queue depth, active sessions, memory in use.
   * (The choice matters: OTel also offers up/down-counters for deltas;
   * this verb is deliberately the last-value instrument.)
   */
  gauge(name: string, value: number, labels?: MetricLabels): void;
}

// ============================================================================
// Log — the callable-object diagnostic surface (ADR 64)
// ============================================================================

/**
 * A structured `log` signal emitter — a CALLABLE OBJECT (ADR 64). Every form
 * below collapses to the SAME single bus emission (`<surface>:signal:log`,
 * one event per call); the level methods and `.with` are pure sugar over that
 * one primitive, so projections (MCP `notifications/message`, the agentick
 * client, an OTel-log bridge) still see exactly one event per call.
 *
 * ## Levels — RFC 5424 syslog severities
 *
 * All eight {@link LogLevel} severities are first-class methods, so
 * `log.warning(x)` and `log("warning", x)` are identical. The everyday four
 * are `debug` / `info` / `warning` / `error`; `notice` / `critical` / `alert`
 * / `emergency` are there for code that maps an external severity scale (a
 * syslog feed, an incident pager) onto ours without translation.
 *
 * `warn` is a documented ALIAS for `warning` — JS-ecosystem muscle memory
 * (`console.warn`, pino, winston) reaches for `warn`, so the method exists,
 * but it emits the canonical RFC-5424 `"warning"` level on the wire (one
 * severity vocabulary, no `"warn"` string ever crosses a boundary). The
 * call-string form is strict: `log("warning", …)` is the spelling;
 * `log("warn", …)` does not typecheck.
 *
 * ## `.with(fields)` — child binding (pino-canonical)
 *
 * `log.with({ reqId })` returns a NEW `Log` that merges `{ reqId }` into every
 * emission's `data`. Chainable — `log.with(a).with(b)` binds both, later wins
 * on key collision; a per-call object overrides bound fields on collision
 * (`log.with({ a: 1 }).info({ a: 2 })` emits `{ a: 2 }`). When the call data is
 * NOT a plain object (a string, number, array), bound fields wrap it as
 * `{ …bound, msg: data }` (pino's `msg` convention). With NO bound fields the
 * data passes through verbatim — the zero-break path every existing call site
 * takes.
 *
 * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
 * @see https://www.rfc-editor.org/rfc/rfc5424#section-6.2.1 (syslog severities)
 */
export interface Log {
  /**
   * The verbatim call form — `log(level, data, logger?)`. The zero-break
   * signature every existing call site already uses. Fire-and-forget: returns
   * immediately, never throws, never a control path.
   */
  (level: LogLevel, data: unknown, logger?: string): void;
  /** `debug` — fine-grained developer diagnostics. */
  debug(data: unknown, logger?: string): void;
  /** `info` — normal operational events (one of the everyday four). */
  info(data: unknown, logger?: string): void;
  /** `notice` — normal but significant; more than info, less than warning. */
  notice(data: unknown, logger?: string): void;
  /** `warning` — a concern that did not stop the work (one of the everyday four). */
  warning(data: unknown, logger?: string): void;
  /** Alias for {@link Log.warning} (`console.warn` / pino muscle memory); emits `"warning"`. */
  warn(data: unknown, logger?: string): void;
  /** `error` — the operation failed (one of the everyday four). */
  error(data: unknown, logger?: string): void;
  /** `critical` — a failure that threatens the surrounding subsystem. */
  critical(data: unknown, logger?: string): void;
  /** `alert` — action must be taken immediately. */
  alert(data: unknown, logger?: string): void;
  /** `emergency` — the system is unusable. */
  emergency(data: unknown, logger?: string): void;
  /**
   * Bind `fields` into every subsequent emission's payload (pino child
   * binding). Returns a NEW `Log`; chainable — see the interface docblock for
   * the merge rules.
   */
  with(fields: Readonly<Record<string, unknown>>): Log;
}

/** The raw single-emission primitive a {@link Log} wraps — one bus event per call. */
export type LogEmit = (level: LogLevel, data: unknown, logger?: string) => void;

/**
 * Merge a {@link Log}'s bound fields into one call's `data`. Plain object →
 * shallow spread with the call winning on collision; primitive/array →
 * `{ …bound, msg: data }` (pino's `msg`); `undefined` data → just the bound
 * fields. Pure — the single place the `.with` merge semantics live.
 */
function mergeBoundFields(bound: Readonly<Record<string, unknown>>, data: unknown): unknown {
  if (data === undefined) return { ...bound };
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return { ...bound, ...(data as Record<string, unknown>) };
  }
  return { ...bound, msg: data };
}

/**
 * Build a {@link Log} callable object around a raw {@link LogEmit}. The single
 * constructor for the log surface — used by the runtime's `deriveObservability`
 * (wrapping a trace-aware bus emitter) and by test doubles (wrapping a no-op or
 * recorder). Pure: the eight level methods + `warn` alias forward to `emit`
 * with the level fixed; `.with` re-invokes `createLog` with merged bindings.
 * `bound` (when present) is applied to every emission via {@link mergeBoundFields}.
 */
export function createLog(emit: LogEmit, bound?: Readonly<Record<string, unknown>>): Log {
  const call: LogEmit = (level, data, logger) =>
    emit(level, bound === undefined ? data : mergeBoundFields(bound, data), logger);
  const log = ((level: LogLevel, data: unknown, logger?: string) =>
    call(level, data, logger)) as Log;
  log.debug = (data, logger) => call("debug", data, logger);
  log.info = (data, logger) => call("info", data, logger);
  log.notice = (data, logger) => call("notice", data, logger);
  log.warning = (data, logger) => call("warning", data, logger);
  log.warn = (data, logger) => call("warning", data, logger);
  log.error = (data, logger) => call("error", data, logger);
  log.critical = (data, logger) => call("critical", data, logger);
  log.alert = (data, logger) => call("alert", data, logger);
  log.emergency = (data, logger) => call("emergency", data, logger);
  log.with = (fields) => createLog(emit, bound === undefined ? fields : { ...bound, ...fields });
  return log;
}

// ============================================================================
// The facet
// ============================================================================

/**
 * The observability facet — landed flat on every ctx surface. See the
 * module docblock for the ops-boundary rule (`trace` is NOT an operation)
 * and the absorbed-`log` note.
 */
export interface Observability {
  /**
   * The structured `log` signal surface — a callable {@link Log} (ADR 64).
   * ALWAYS present and ALWAYS live (independent of the telemetry switch):
   * emitting a bus event is always possible; whether a wire projects it is
   * the subscriber's concern. `ctx.log(level, data)` is the verbatim call
   * form; `ctx.log.info(data)` / `ctx.log.warning(data)` are level sugar;
   * `ctx.log.with({ reqId })` binds fields — all collapse to ONE bus event
   * per call. Fire-and-forget — NEVER a control path; returns immediately,
   * never throws. Not model-visible content (use the handler's return value
   * for that). The active trace/span id is stamped onto the emitted event
   * when a span is in scope, so logs correlate to their span in the backend.
   *
   * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
   */
  readonly log: Log;

  /**
   * Open a named child span around `fn`, nested under the current
   * operation's span, and return `fn`'s result. `fn` receives a {@link Span}
   * to annotate. A TIMING / ATTRIBUTION annotation for sub-operation work
   * INSIDE a handler — NOT an operation (no journal / hooks / guards /
   * retry). For a durable, guard/hook-reachable step, climb to
   * {@link import("./ops.js").Ops.run}; for a system-contract verb, register
   * a command.
   *
   * Passthrough when telemetry is off: `trace(name, fn)` just runs `fn`
   * with a no-op span and resolves with its value — zero span machinery.
   * When on, the span parents under the current op span via the ADR-77
   * ambient-fiber mechanism (the ONLY parenting path).
   *
   * ```ts
   * const rows = await ctx.trace("retrieval", async (span) => {
   *   span.setAttribute("query.length", q.length);
   *   return db.search(q);
   * });
   * ```
   *
   * @see docs/proposals/v2/blueprint/78-telemetry-via-runtime-substrate.md
   */
  trace<T>(name: string, fn: (span: Span) => T | Promise<T>): Promise<T>;

  /**
   * Emit metrics — counters, histograms, gauges. No-op when no meter is
   * wired. Default labels are low-cardinality (see {@link MetricLabels}).
   */
  readonly metrics: Metrics;
}

// ============================================================================
// Off-path singletons
// ============================================================================
//
// Here rather than in `@agentick/runtime` because both sides need them and
// neither should reach across for a no-op: the server's telemetry-off path
// and the browser client both hand these out. Frozen and shared, so a ctx
// that never touches telemetry allocates nothing and referential identity
// holds across every ctx.

/** No-op span handed to a `trace` callback when telemetry is off. */
export const NOOP_SPAN: Span = Object.freeze({
  setAttribute: () => {},
  setAttributes: () => {},
  addEvent: () => {},
  recordException: () => {},
});

/**
 * Passthrough `trace` for the telemetry-off path — runs `fn` with the
 * {@link NOOP_SPAN} and resolves with its value, no span machinery.
 */
export const OFF_TRACE: Observability["trace"] = <T>(
  _name: string,
  fn: (span: Span) => T | Promise<T>,
): Promise<T> => Promise.resolve(fn(NOOP_SPAN));

/** No-op metrics for the telemetry-off path. */
export const NOOP_METRICS: Metrics = Object.freeze({
  count: () => {},
  record: () => {},
  gauge: () => {},
});

// ============================================================================
// TelemetryAdapter — the CLIENT's telemetry seam
// ============================================================================
//
// Distinct from `TelemetrySink` (app-harness), which hands OpenTelemetry SDK
// processors and readers to the server's Effect layer. A browser deliberately
// does not bundle the OTel SDK, so the client seam is BYO: the adopter wraps
// whatever tracer they have behind these few methods.
//
// ONE object, wired once, consumed twice — `createClient({ telemetry })` builds
// the ctx facets over it, and `@agentick/client-extensions`' `telemetry()`
// extension opens its per-RPC spans through the same instance. Because it is
// the same instance, `currentTraceContext()` naturally reports a span opened by
// either side, and no bridge between them is needed.

/**
 * The subset of OpenTelemetry's `Span` a client adapter must expose.
 * Adopters wrap a real OTel span or supply their own.
 */
/**
 * A span's W3C identity — the triple a child parents under and a `traceparent`
 * carries. One type for the whole seam: what a span reports, what a caller
 * propagates, and what a wire header parses to are the same three fields, and
 * spelling them separately invites them to drift.
 */
export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
  /** The W3C sampled bit — whether the span was actually recorded. */
  readonly sampled: boolean;
}

export interface TelemetrySpan {
  setAttribute(key: string, value: string | number | boolean): void;
  /** Set status to "error" with the given message. */
  setError(message: string): void;
  end(): void;
  /**
   * This span's W3C ids, when the adapter can report them.
   *
   * OTel spans have `spanContext()`; an adapter that cannot answer returns
   * `undefined` and the span simply does not become a parent for propagation.
   */
  spanContext?(): SpanContext;
}

/**
 * BYO tracer. `startSpan` and `currentTraceContext` are the wire extension's
 * long-standing contract; `log` and `metrics` are optional additions so the
 * ctx facets have somewhere to go without a second seam to wire.
 */
export interface TelemetryAdapter {
  startSpan(
    name: string,
    attributes: Record<string, string | number | boolean>,
    /**
     * Parent for the new span. Supplied by callers that track their own active
     * span — a browser has no ambient context to infer one from. An adapter
     * over a runtime that DOES have ambient context may ignore it.
     */
    parent?: Pick<SpanContext, "traceId" | "spanId">,
  ): TelemetrySpan;
  /** The W3C Trace Context to propagate on the wire. */
  currentTraceContext(): { traceparent?: string; tracestate?: string };
  /** Where `ctx.log` goes. Absent, logs are dropped (still never throw). */
  log?: LogEmit;
  /** Where `ctx.metrics` goes. Absent, metrics are no-ops. */
  metrics?: Metrics;
}

/** No-op adapter — trace context propagation only, no local recording. */
export const NOOP_TELEMETRY_ADAPTER: TelemetryAdapter = Object.freeze({
  startSpan: (): TelemetrySpan => ({
    setAttribute() {},
    setError() {},
    end() {},
  }),
  currentTraceContext: () => ({}),
});

/**
 * `createClient({ telemetry })` — the client's telemetry switch, the twin of
 * `createApp({ telemetry })`.
 *
 * Named `Client…` because spec already has a server-side `TelemetryOptions`
 * (OTel SDK processors and an Effect layer). Different worlds, so different
 * names rather than one type that means two things.
 *
 * ONE object, wired once. `@agentick/client-core` reads `adapter` to build the
 * ctx facets; `@agentick/client` additionally installs the wire-span extension
 * from the SAME object, so `sample` / `serviceName` reach it without the
 * adopter passing an adapter twice — and the two span trees cannot diverge.
 */
export interface ClientTelemetryOptions {
  readonly adapter: TelemetryAdapter;
  /**
   * Per-method sampler for wire spans. Return `false` to skip span creation for
   * noisy methods; trace context still propagates. Default: sample all.
   */
  readonly sample?: (method: string) => boolean;
  /** Reported as `rpc.service`. Defaults to `agentick`. */
  readonly serviceName?: string;
}
