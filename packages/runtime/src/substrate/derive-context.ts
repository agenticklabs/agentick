/**
 * `deriveContext` (ADR 91 §2) — the ONE, branded constructor for a boundary
 * context. It is the promotion of `BaseHarness.defineOperationFacets`: it takes
 * a parent {@link RuntimeContext} trunk (the op's `ctxScope`, a connection
 * crossing, a session's construction identity) + the boundary {@link
 * ContextFacets}, attaches the lazy {@link Observability} + {@link Ops} facet
 * getters, and returns the trunk+facets stamped with the {@link Derived} brand.
 *
 * ## Why one deriver
 *
 * Before ADR 91 the facets were hand-assembled at ~six sites (the MCP
 * fabrication trio, the tool-executor dispatch ctx, the interceptor ctx, the
 * gateway wire ctx), each calling `deriveObservability` / `deriveOps` directly.
 * That is the code smell the ADR retires: those raw derivers are now called in
 * exactly ONE place — {@link attachOperationFacets} below — and every boundary
 * ctx routes through {@link deriveContext} (or, for the in-place gateway/
 * interceptor case, `BaseHarness.defineOperationFacets`, which shares the same
 * {@link attachOperationFacets} core). The `verify` grep gate fails the build on
 * any direct `deriveObservability` / `deriveOps` call outside this module.
 *
 * ## The brand
 *
 * {@link deriveContext} is the ONLY producer of the {@link Derived} brand (its
 * symbol is spec-private + unexported). A framework seam-invocation site typed
 * to accept `Derived<…>` — e.g. `InterceptorCtxRef` — therefore rejects a
 * hand-assembled bag at compile time. Adopter handler signatures keep the plain
 * interfaces (a branded value satisfies a plain one — zero adopter friction).
 *
 * ## Lazy facets
 *
 * The five facet properties (`log` / `trace` / `metrics` / `run` / `runner`)
 * are LAZY GETTERS: nothing derives unless a middleware/hook/handler actually
 * touches it. When telemetry is off, `trace`/`metrics` collapse to the shared
 * off-path singletons (referential identity, zero build). This is the
 * perf-conscious pattern absorbed verbatim from `defineOperationFacets`.
 *
 * @see docs/proposals/v2/blueprint/91-ctx-spine.md
 * @see ./observability.ts — `deriveObservability` (the sole caller is here)
 * @see ./ops.ts — `deriveOps` (the sole caller is here)
 */

import { Effect } from "effect";
import type { Runtime } from "effect";
import type {
  Derived,
  EventScope,
  EventSurface,
  MetricLabels,
  Observability,
  Ops,
  RuntimeContext,
} from "@agentick/spec";

import {
  deriveObservability,
  type LogEmitWithTrace,
  type TelemetryRuntime,
} from "./observability.js";
import { deriveOps, type RunOperationFn } from "./ops.js";
import { getContext } from "./runtime-context.js";

/** The facet-derivation inputs a boundary supplies to {@link deriveContext}. */
export interface ContextFacets {
  /**
   * The surface's scope-bound, trace-aware `log` emitter (ADR 64) — the raw
   * bus emit `deriveObservability` wraps into the callable `Log`.
   */
  readonly log: LogEmitWithTrace;
  /** Telemetry-namespace prefix for metric names (the harness's `telemetryNamespace`). */
  readonly namespace: string;
  /** Low-cardinality default metric labels merged under every `ctx.metrics.*` call. */
  readonly defaultLabels?: MetricLabels;
  /** Captured telemetry runtime + meter (the {@link Observability} half). Absent ⇒ off-path. */
  readonly telemetry?: TelemetryRuntime;
  /** The ambient harness's event surface — the `<surface>` in `<surface>:run:<name>`. */
  readonly surface: EventSurface;
  /** The work-path scope stamped on every signal + ad-hoc op this ctx emits. */
  readonly scope: EventScope;
  /** The harness's bound `runOperation` — journals + interceptor fold behind `ctx.run`/`ctx.runner`. */
  readonly runOperation: RunOperationFn;
  /**
   * The operation runtime captured IN-FIBER (parent span + tracer), so
   * `ctx.trace` child spans + `ctx.run` ops parent under the enclosing op.
   * `undefined` on off-fiber surfaces (MCP request ctx) — ad-hoc ops then run
   * as roots on the default runtime.
   */
  readonly runtime?: Runtime.Runtime<never>;
}

/** The trunk+facets a derived boundary ctx carries, before the brand. */
type OperationCtx = RuntimeContext & Observability & Ops;

/**
 * Attach the LAZY {@link Observability} + {@link Ops} facet getters onto
 * `target`, in place. The ONE call site of `deriveObservability` / `deriveOps`
 * in the codebase (the `verify` grep gate enforces it). Shared by
 * {@link deriveContext} (fresh trunk) and `BaseHarness.defineOperationFacets`
 * (the gateway/interceptor in-place attach onto an already-rich ctx object).
 *
 * Reading a facet builds + memoizes its half; an op that never touches
 * telemetry pays only the two thunks.
 */
export function attachOperationFacets(target: object, facets: ContextFacets): void {
  let obsMemo: Observability | undefined;
  const obs = (): Observability =>
    (obsMemo ??= deriveObservability({
      log: facets.log,
      namespace: facets.namespace,
      ...(facets.defaultLabels !== undefined ? { defaultLabels: facets.defaultLabels } : {}),
      ...(facets.telemetry !== undefined ? { telemetry: facets.telemetry } : {}),
    }));
  let opsMemo: Ops | undefined;
  const ops = (): Ops =>
    (opsMemo ??= deriveOps({
      surface: facets.surface,
      scope: facets.scope,
      runOperation: facets.runOperation,
      ...(facets.runtime !== undefined ? { runtime: facets.runtime } : {}),
    }));
  Object.defineProperties(target, {
    log: { get: () => obs().log, enumerable: true, configurable: true },
    trace: { get: () => obs().trace, enumerable: true, configurable: true },
    metrics: { get: () => obs().metrics, enumerable: true, configurable: true },
    run: { get: () => ops().run, enumerable: true, configurable: true },
    runner: { get: () => ops().runner, enumerable: true, configurable: true },
  });
}

/**
 * Derive a branded boundary context from a parent trunk + facets — the ONLY
 * legal boundary-ctx constructor (ADR 91).
 *
 * Two overloads:
 *   - `deriveContext(parent, facets)` — off-fiber boundaries (MCP accept, a
 *     session's construction identity) pass the parent trunk explicitly.
 *   - `deriveContext(facets)` — in-fiber Effect callers read the parent trunk
 *     from the ambient FiberRef (`getContext`). Effect-native: a synchronous
 *     ambient read is the `readContext()` trap (a nested `runSync` starts a
 *     fresh root fiber that doesn't inherit the FiberRef), so the ambient form
 *     yields an `Effect` that reads the trunk in-fiber.
 */
export function deriveContext(facets: ContextFacets): Effect.Effect<Derived<OperationCtx>>;
export function deriveContext(parent: RuntimeContext, facets: ContextFacets): Derived<OperationCtx>;
export function deriveContext(
  a: RuntimeContext | ContextFacets,
  b?: ContextFacets,
): Derived<OperationCtx> | Effect.Effect<Derived<OperationCtx>> {
  if (b === undefined) {
    const facets = a as ContextFacets;
    return Effect.map(getContext, (parent) => deriveFrom(parent, facets));
  }
  return deriveFrom(a as RuntimeContext, b);
}

/** The branded synchronous core — the single `as Derived` cast lives here. */
function deriveFrom(parent: RuntimeContext, facets: ContextFacets): Derived<OperationCtx> {
  const ctx = { ...parent };
  attachOperationFacets(ctx, facets);
  return ctx as Derived<OperationCtx>;
}
