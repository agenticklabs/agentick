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
 * member of THIS facet and reaches ToolHandlerCtx via `extends`. Behavior
 * is unchanged — it emits one bus event (`<surface>:signal:log`) that
 * projections forward (MCP → `notifications/message`; the agentick client
 * → `subscribe`/`onLog`). Unlike `trace`/`metrics`, `log` is ALWAYS live
 * (independent of the telemetry switch) because emitting a bus event is
 * always possible.
 *
 * TODO(store-ctx): when a `StoreCtx` surface is introduced, this facet is
 * its first field — data-layer reads/writes want the same log/trace/
 * metrics surface as every other ctx. (No `StoreCtx` exists yet; do not
 * create one for this.)
 *
 * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
 * @see docs/proposals/v2/blueprint/78-telemetry-via-runtime-substrate.md
 * @verifiedBy packages-next/spec-conformance/src/observability.ts (runObservabilityCtxConformance)
 * @verifiedBy packages-next/runtime/src/__tests__/observability.spec.ts
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
// The facet
// ============================================================================

/**
 * The observability facet — landed flat on every ctx surface. See the
 * module docblock for the ops-boundary rule (`trace` is NOT an operation)
 * and the absorbed-`log` note.
 */
export interface Observability {
  /**
   * Emit a structured `log` signal — an out-of-band diagnostic (ADR 64).
   * ALWAYS present and ALWAYS live (independent of the telemetry switch):
   * emitting a bus event is always possible; whether a wire projects it is
   * the subscriber's concern. Fire-and-forget — NEVER a control path;
   * returns immediately, never throws. Not model-visible content (use the
   * handler's return value for that). The active trace/span id is stamped
   * onto the emitted event when a span is in scope, so logs correlate to
   * their span in the backend.
   *
   * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
   */
  log(level: LogLevel, data: unknown, logger?: string): void;

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
