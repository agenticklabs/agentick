/**
 * `useCommandInterceptor` — the generic, typed tree-side interceptor
 * registrar (ADR 89 §4). A component registers a REAL, IN-PATH interceptor
 * (ADR 83 `guard` / `transform`) on ANY framework command, closing over its
 * latest render state via a ref. This is the primitive the named hooks
 * (`useGuardToolDispatch`, `useTransformToolDispatch`,
 * `useTransformModelInput`) are one-line typed aliases over — derivation,
 * not enumeration, so a package that augments the `CommandRegistry` with a
 * new command is AUTOMATICALLY tree-hookable with full types, zero new
 * React code.
 *
 * ## THE DISCIPLINE — this runs IN the operation's critical path
 *
 * A `guard` / `transform` registered here is **awaited inside the command's
 * cascade**, before (guard) or around (transform) the op body — NOT the
 * fire-and-forget `observe` posture of the `useOn*` family. So it MUST
 * decide **promptly** from captured render state, or `defer` cleanly — it
 * **cannot hang** the operation. Concretely:
 *
 *   - **decide fast** — read the ref's state and return a verdict / reshaped
 *     input synchronously (the common case: `blocked ? "veto" : "proceed"`).
 *   - **defer, don't stall** — need a human? return `"defer"` (→ the
 *     `deferred` terminal, caller retries) OR `await` an elicitation confirm
 *     and map the reply to `"proceed"` / `"veto"` (the `<ToolGate>`
 *     confirm-dialog pattern — the guard suspends the op on a bounded,
 *     abortable elicitation, never an open-ended wait).
 *   - **observe elsewhere** — pure side-effects (spinners, logging) belong
 *     on `useOnToolStart` / `useOnModelGenerateStart` / … , which project
 *     the SAME commands' hooks fire-and-forget and never sit in the path.
 *
 * The exact same discipline a programmatic `harness.guard(...)` /
 * `session.model.use(...)` interceptor carries — the tree is just declaring
 * it.
 *
 * ## Typing — off the `CommandRegistry` augmentation
 *
 * `commandName` is a typed union of `CommandRegistry` keys; the callback's
 * input/output types FLOW from that command's registry row (a `guard` sees
 * the typed input; a `transform`'s middleware is typed to the row's
 * input→output). An escape hatch (`string & {}` + `unknown` typing) keeps
 * dynamic / not-yet-augmented names reachable, per the open-union
 * precedent.
 *
 * @see docs/proposals/v2/blueprint/89-model-harness-and-lifecycle-projection.md §4
 * @see docs/proposals/v2/blueprint/83-interceptor-collapse.md
 */

import { useEffect, useRef } from "react";
import {
  deriveHookNames,
  getContext,
  liftMiddleware,
  signalFromVerdict,
  tagInterceptor,
  type AsyncMiddleware,
  type CommandRegistry,
  type Middleware,
  type RuntimeContext,
} from "@agentick/runtime";
import type { HandlerVerdict } from "@agentick/spec";
import { Effect } from "effect";
import { useCommandInterceptorRegistry } from "../interceptor-context.js";

// ── registry-row projections ────────────────────────────────────────

/** The input type of the `CommandRegistry` row for `K` (`unknown` if none). */
export type InterceptorInput<K extends keyof CommandRegistry & string> =
  CommandRegistry[K] extends { input: infer I } ? I : unknown;
/** The output type of the `CommandRegistry` row for `K` (`unknown` if none). */
export type InterceptorOutput<K extends keyof CommandRegistry & string> =
  CommandRegistry[K] extends { output: infer O } ? O : unknown;

// ── verdict vocabulary ──────────────────────────────────────────────

/**
 * The ergonomic verdict a tree `guard` returns — the string-sugared twin of
 * the substrate {@link HandlerVerdict} (`grep signalFromVerdict`):
 *
 *   - `"proceed"` / `void` — admit the op (call `next`).
 *   - `"veto"` — deny → terminal `vetoed` (the op body never runs).
 *   - `"defer"` — suspend → terminal `deferred` (caller retries later).
 *   - `{ replace: R }` — short-circuit with a supplied result → `replaced`.
 *
 * The full `HandlerVerdict` object form (`{ kind: "veto", reason }`, …) is
 * also accepted for when you need the extra fields (`reason` / `retryAfter`).
 */
export type GuardDecision<R> =
  | "proceed"
  | "veto"
  | "defer"
  | { readonly replace: R }
  | HandlerVerdict<R>
  | void;

/** A tree guard decider — decides from `input` + the ambient op context. */
export type GuardFn<I, R> = (
  input: I,
  ctx: RuntimeContext,
) => GuardDecision<R> | Promise<GuardDecision<R>>;

// ── the hook ────────────────────────────────────────────────────────

/**
 * Register a `guard` on `commandName` — a decider run BEFORE the op body
 * that admits / denies / defers / replaces it, from the component's latest
 * render state.
 */
export function useCommandInterceptor<K extends keyof CommandRegistry & string>(
  commandName: K,
  kind: "guard",
  decide: GuardFn<InterceptorInput<K>, InterceptorOutput<K>>,
): void;
/**
 * Register a `transform` on `commandName` — an in-path middleware
 * (`(input, next, ctx) => output`) that reshapes the op's input and/or
 * output around the body, from render state.
 */
export function useCommandInterceptor<K extends keyof CommandRegistry & string>(
  commandName: K,
  kind: "transform",
  fn: AsyncMiddleware<InterceptorInput<K>, InterceptorOutput<K>>,
): void;
/**
 * Escape hatch — a dynamic / not-yet-augmented command name. Input/output
 * are `unknown`; you narrow inside the callback (the open-union precedent).
 */
export function useCommandInterceptor(
  commandName: string & {},
  kind: "guard" | "transform",
  fn: GuardFn<unknown, unknown> | AsyncMiddleware<unknown, unknown>,
): void;
export function useCommandInterceptor(
  commandName: string,
  kind: "guard" | "transform",
  fn: GuardFn<unknown, unknown> | AsyncMiddleware<unknown, unknown>,
): void {
  const registry = useCommandInterceptorRegistry();
  // Ref-freshness: the middleware reads `ref.current` at DISPATCH, so a
  // re-render swaps the closed-over state without re-registering — the guard
  // always sees the LATEST render (the same move `useOnToolEnd` makes).
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    // The op tag the command carries at dispatch (`ctx.op`) — the PascalCase
    // suffix `runOperation` stamps. Derived from the registry key EXACTLY as
    // the typed `CommandHooks` mint it, so registration + collection agree.
    const command = deriveHookNames(commandName)[0].slice("onBefore".length);
    const middleware =
      kind === "guard"
        ? buildGuardMiddleware(ref as { current: GuardFn<unknown, unknown> })
        : buildTransformMiddleware(ref as { current: AsyncMiddleware<unknown, unknown> });
    return registry.register(command, middleware);
  }, [registry, commandName, kind]);
}

// ── middleware builders (ref-fresh) ─────────────────────────────────

/**
 * Build the Effect `guard` middleware — reads the ref's decider IN-FIBER,
 * desugars the verdict, and (for a non-`proceed` verdict) raises the
 * matching {@link import("@agentick/runtime").OperationSignal} on the
 * failure channel, which `runOperation`'s settle maps to the
 * `vetoed`/`deferred`/`replaced` terminal. Mirrors `SessionModelFacade.guard`.
 */
function buildGuardMiddleware(ref: {
  current: GuardFn<unknown, unknown>;
}): Middleware<unknown, unknown, unknown> {
  const mw: Middleware<unknown, unknown, unknown> = (input, next) =>
    Effect.gen(function* () {
      const ctx = yield* getContext;
      const raw = ref.current(input, ctx);
      const decision = isThenable(raw)
        ? ((yield* Effect.promise(() => raw)) as GuardDecision<unknown>)
        : (raw as GuardDecision<unknown>);
      const verdict = toVerdict(decision);
      if (verdict.kind === "proceed") return yield* next(input);
      return yield* Effect.fail(signalFromVerdict(verdict));
    });
  return tagInterceptor("guard", mw);
}

/**
 * Build the `transform` middleware — the ref's {@link AsyncMiddleware}
 * lifted onto the Effect channel (in-fiber `next`, span/ctx preserved). No
 * op-scoping check needed: the registry is keyed by command, so the session
 * only ever composes this for its own op.
 */
function buildTransformMiddleware(ref: {
  current: AsyncMiddleware<unknown, unknown>;
}): Middleware<unknown, unknown, unknown> {
  const scoped: AsyncMiddleware<unknown, unknown> = (input, next, ctx) =>
    ref.current(input, next, ctx);
  return tagInterceptor("transform", liftMiddleware(scoped));
}

/** Desugar the ergonomic {@link GuardDecision} into a substrate {@link HandlerVerdict}. */
function toVerdict<R>(decision: GuardDecision<R>): HandlerVerdict<R> {
  if (decision === undefined || decision === "proceed") return { kind: "proceed" };
  if (decision === "veto") return { kind: "veto" };
  if (decision === "defer") return { kind: "defer" };
  if ("kind" in decision) return decision;
  return { kind: "replace", result: decision.replace };
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
