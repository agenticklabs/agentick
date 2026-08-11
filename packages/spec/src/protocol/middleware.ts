/**
 * Operation middleware — the dual-typed registration surface (ADR 76 + 77).
 *
 * Middleware wraps a harness operation body: call `next(input)` to proceed, or
 * return a value to short-circuit. It comes in TWO forms, registered through
 * the harness's TWO surfaces (the same facade/twin split as every operation —
 * `harness.use : harness.fx.use  ::  harness.run : harness.fx.run`):
 *
 *   - `harness.fx.use(mw)` takes an Effect-native {@link Middleware} — `next`
 *     returns an Effect, composes IN the fiber (telemetry span-nesting +
 *     structured interruption propagate through it).
 *   - `harness.use(mw)` takes a pure-JS {@link AsyncMiddleware} — `next`
 *     returns a Promise, `await` it. No Effect knowledge required.
 *
 * Splitting the two forms across the two surfaces is what lets EACH be a single
 * type, so an inline arrow infers its params cleanly (one union/overloaded
 * surface could not). The type each surface holds is defined here so the `XFx`
 * protocol interfaces can type `fx.use` (via {@link HarnessFx}).
 */

import type { Effect } from "effect";
import type { HandlerVerdict } from "../data/outcomes.js";
import type { RuntimeContext } from "../data/runtime-context.js";
import type { Unsubscribe } from "./inbox.js";

/**
 * Effect-native middleware (registered via `harness.fx.use`). `next(input)`
 * returns an Effect; compose it with `yield*`. Composes IN the fiber: OTel
 * span-nesting and structured interruption propagate through it. Use this form
 * for middleware that must stay in-fiber — a tier-4 timeout/cancel that reaches
 * inner work, or per-op spans that nest through it.
 */
export type Middleware<I = unknown, R = unknown, E = unknown> = (
  input: I,
  next: (input: I) => Effect.Effect<R, E, never>,
) => Effect.Effect<R, E, never>;

// The pure-JS `AsyncMiddleware` form (registered via `harness.use`) lives in
// `@agentick/runtime` — it carries the runtime's `RuntimeContext` as an
// explicit third argument (an async middleware runs OUTSIDE the fiber, so it
// can't read `getContext`), which is a runtime concern, not a spec contract.
// Spec owns only the Effect-native `Middleware` (the `fx.use` contract).

/**
 * Effect-native guard decider (ADR 83) — the Effect twin of the plain
 * `harness.guard` sugar's decider: receives the command's input plus the op's
 * {@link RuntimeContext} and returns a {@link HandlerVerdict} (or `void` ≡
 * `proceed`) on the success channel. Registered via `harness.fx.guard`;
 * desugared to a `guard`-kind interceptor by `BaseHarness.guardEffect`.
 */
export type GuardDecider<I = unknown, R = unknown, E = never> = (
  input: I,
  ctx: RuntimeContext,
) => Effect.Effect<HandlerVerdict<R> | void, E, never>;

/**
 * The base of every harness's `.fx` surface: the Effect-native **primitives**
 * (ADR 96) — `fx.use` (middleware) and `fx.guard` (admission). Each concrete
 * `XFx` (`ExecutorFx`, `LoopExecutorFx`, `KnobsFx`, `ToolExecutorFx`,
 * `CompilerFx`) extends this, so both are universal members alongside the
 * harness's operation twins. The Promise-facade twins are `harness.use` (the
 * `AsyncMiddleware` form) and `harness.guard`.
 *
 * Sugar derived from the command registry (`hook`, `hooks.on*`) lives on the
 * harness surface only: `.fx` carries primitives, and an in-fiber hook is a
 * composition over `fx.use` (ADR 96 §4).
 */
export interface HarnessFx {
  /**
   * Register an Effect-native {@link Middleware} around this harness's ops
   * (tier 2). In-fiber. Returns an `Unsubscribe`. For structural (tier 3) and
   * call-scoped (tier 4) middleware see ADR 76.
   */
  use<I = unknown, R = unknown, E = unknown>(mw: Middleware<I, R, E>): Unsubscribe;
  /**
   * Register an Effect-native {@link GuardDecider} on this harness's ops — the
   * in-fiber twin of `harness.guard(decider)`. Guards compose OUTERMOST of
   * every transform, so this decides before any hook runs. Returns an
   * `Unsubscribe`.
   */
  guard<I = unknown, R = unknown, E = never>(decide: GuardDecider<I, R, E>): Unsubscribe;
}
