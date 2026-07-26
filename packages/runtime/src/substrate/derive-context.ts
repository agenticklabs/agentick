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
  OperationCtx,
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

// `OperationCtx` (the trunk + Observability + Ops intersection) is the
// spec-owned spine name (ADR 91 §1); re-imported above rather than re-declared.

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
 * Derive a branded boundary context from a parent trunk + facets (+ optional
 * boundary extras) — the ONLY legal boundary-ctx constructor (ADR 91).
 *
 * Overloads:
 *   - `deriveContext(parent, facets, extras?)` — off-fiber boundaries (MCP
 *     accept, the tool-dispatch/wire crossings, a task's work ctx, a session's
 *     construction identity) pass the parent trunk explicitly. The optional
 *     `extras` (ADR 91 §Phase-2 "brand totalization") composes the boundary's
 *     OWN fields — `toolCallId` / `transport` on a tool ctx, the wire
 *     `session`/`app` handles, a task's `signal`/`onProgress` — INTO the same
 *     branded mint, so the WHOLE composed ctx (`Derived<OperationCtx & X>`)
 *     carries the brand instead of a post-derivation spread that erases it.
 *   - `deriveContext(facets)` — in-fiber Effect callers read the parent trunk
 *     from the ambient FiberRef (`getContext`). Effect-native: a synchronous
 *     ambient read is the `readContext()` trap (a nested `runSync` starts a
 *     fresh root fiber that doesn't inherit the FiberRef), so the ambient form
 *     yields an `Effect` that reads the trunk in-fiber.
 *
 * ## Extras + lazy facets compose without eager forcing
 *
 * `extras` is applied via {@link Object.getOwnPropertyDescriptors} +
 * `Object.defineProperties`, NOT a spread — so an extra defined as a LIVE
 * GETTER (the wire ctx's `session`/`app` handles resolve lazily) is copied as a
 * getter and is NOT forced at derivation time. The five facet getters
 * (`log`/`trace`/`metrics`/`run`/`runner`) are attached LAST, so a facet key
 * always wins over a colliding extra, and they too stay lazy. Precedence:
 * facets ▸ extras ▸ trunk.
 */
export function deriveContext(facets: ContextFacets): Effect.Effect<Derived<OperationCtx>>;
export function deriveContext<X extends object = Record<never, never>>(
  parent: RuntimeContext,
  facets: ContextFacets,
  extras?: X,
): Derived<OperationCtx & X>;
export function deriveContext(
  a: RuntimeContext | ContextFacets,
  b?: ContextFacets,
  c?: object,
): Derived<OperationCtx> | Derived<OperationCtx & object> | Effect.Effect<Derived<OperationCtx>> {
  if (b === undefined) {
    const facets = a as ContextFacets;
    return Effect.map(getContext, (parent) => deriveFrom(parent, facets));
  }
  return deriveFrom(a as RuntimeContext, b, c);
}

/**
 * The branded synchronous core — the single `as Derived` cast lives here.
 * Composition order is precedence order: the trunk copies in first, the
 * boundary `extras` land as descriptors OVER it (getters preserved, never
 * forced), and the facet getters attach LAST so they win any key collision.
 */
function deriveFrom<X extends object = Record<never, never>>(
  parent: RuntimeContext,
  facets: ContextFacets,
  extras?: X,
): Derived<OperationCtx & X> {
  const ctx = { ...parent };
  if (extras !== undefined) {
    Object.defineProperties(ctx, Object.getOwnPropertyDescriptors(extras));
  }
  attachOperationFacets(ctx, facets);
  return ctx as Derived<OperationCtx & X>;
}
