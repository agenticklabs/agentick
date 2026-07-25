/**
 * Operation control-signals + interceptor-kind tagging
 * (ADR 83).
 *
 * THE COLLAPSE: the verdict guard is a strictly-weaker special case of the
 * universal `Middleware` interceptor — before-only, short-circuit-only. This
 * module supplies the two pieces that let ONE composed-interceptor seam do
 * everything the separate before-guard phase used to:
 *
 *   1. Typed control-signals — a `guard`-kind interceptor that wants to DENY /
 *      DEFER / REPLACE raises one of these throwable markers (on the composed
 *      chain's failure channel) instead of returning a `HandlerVerdict` to a
 *      separate phase. `runOperation` catches a raised signal and maps it to
 *      the matching terminal (`vetoed` / `deferred` / `replaced`). `proceed`
 *      needs no signal — the interceptor just calls `next`.
 *
 *   2. Interceptor-kind tagging + ordering — every interceptor carries a
 *      `'guard' | 'transform' | 'observe'` tag so the assembled list stays
 *      enumerable, and a stable sort floats guards OUTERMOST so a broad-scope
 *      deny beats a narrow-scope transform (deny-before-transform).
 */

import type { HandlerVerdict, Middleware } from "@agentick/spec";

// ============================================================================
// Control-signals — the interceptor-native encoding of the non-`proceed`
// HandlerVerdict kinds.
// ============================================================================

/** Raised by a guard interceptor to DENY the operation → terminal `vetoed`. */
export class OperationVeto {
  readonly _signal = "veto" as const;
  constructor(readonly reason?: string) {}
}

/** Raised by a guard interceptor to DEFER the operation → terminal `deferred`. */
export class OperationDefer {
  readonly _signal = "defer" as const;
  constructor(readonly retryAfter?: number) {}
}

/**
 * Raised by a guard interceptor to short-circuit with a caller-supplied result
 * → terminal `replaced` (the op resolves successfully with `result`).
 */
export class OperationReplace<R = unknown> {
  readonly _signal = "replace" as const;
  constructor(
    readonly result: R,
    readonly reason?: string,
  ) {}
}

export type OperationSignal<R = unknown> = OperationVeto | OperationDefer | OperationReplace<R>;

/** Structural guard — is `value` one of the operation control-signals? */
export function isOperationSignal(value: unknown): value is OperationSignal {
  if (typeof value !== "object" || value === null || !("_signal" in value)) return false;
  const tag = (value as { _signal: unknown })._signal;
  return tag === "veto" || tag === "defer" || tag === "replace";
}

/**
 * Desugar a non-`proceed` {@link HandlerVerdict} into its control-signal — the
 * bridge from the ergonomic verdict DSL (`guard()` sugar) to the interceptor
 * seam. `proceed` has no signal (it maps to "call next").
 */
export function signalFromVerdict<R>(verdict: HandlerVerdict<R>): OperationSignal<R> {
  switch (verdict.kind) {
    case "veto":
      return new OperationVeto(verdict.reason);
    case "defer":
      return new OperationDefer(verdict.retryAfter);
    case "replace":
      return new OperationReplace<R>(verdict.result, verdict.reason);
    case "proceed":
      throw new Error("signalFromVerdict: `proceed` has no control-signal (call next instead)");
  }
}

// ============================================================================
// Interceptor-kind tagging + ordering.
// ============================================================================

/**
 * The three interceptor archetypes. `guard` decides (deny/defer/replace/proceed)
 * BEFORE the body; `transform` reshapes input/output around the body; `observe`
 * is a pure side-effect (metrics, logging) that never changes the value.
 */
export type InterceptorKind = "guard" | "transform" | "observe";

const INTERCEPTOR_KIND = Symbol.for("agentick.interceptorKind");

/** Tag a middleware with its interceptor kind. Returns the same function. */
export function tagInterceptor<I, R, E>(
  kind: InterceptorKind,
  mw: Middleware<I, R, E>,
): Middleware<I, R, E> {
  (mw as unknown as Record<symbol, unknown>)[INTERCEPTOR_KIND] = kind;
  return mw;
}

/** Read a middleware's kind. Untagged middleware defaults to `"transform"`. */
export function interceptorKind(mw: Middleware<unknown, unknown, unknown>): InterceptorKind {
  const k = (mw as unknown as Record<symbol, unknown>)[INTERCEPTOR_KIND];
  return k === "guard" || k === "observe" ? k : "transform";
}

const KIND_RANK: Record<InterceptorKind, number> = { guard: 0, transform: 1, observe: 2 };

/**
 * Stable-sort an assembled interceptor list so `guard`-kind interceptors compose
 * OUTERMOST (run before transforms). Deny-before-transform: a broad-scope guard
 * denies before a narrower-scope transform reshapes the input. STABLE —
 * equal-kind interceptors keep their assembled (tier) order, so the tier-4 →
 * tier-3 → tier-2 → hooks composition order is preserved within each kind.
 */
export function orderInterceptors(
  list: readonly Middleware<unknown, unknown, unknown>[],
): Middleware<unknown, unknown, unknown>[] {
  return list
    .map((mw, index) => ({ mw, index }))
    .sort(
      (a, b) =>
        KIND_RANK[interceptorKind(a.mw)] - KIND_RANK[interceptorKind(b.mw)] || a.index - b.index,
    )
    .map((e) => e.mw);
}
