/**
 * Public types for `@agentick/eval-next`. The `defineEval(...)` factory
 * is the entry point; everything else is the surface the `t` (test
 * context) object exposes to assertion bodies.
 *
 * Shape: `{ description, app, test }`. `app` is a thunk that
 * constructs a FRESH `AppHarness` per eval invocation — every
 * `await myEval()` gets its own app, so session state doesn't leak
 * between runs or matrix-axis cells. The thunk receives the
 * per-invocation overrides (`O`) and decides how to fold them in;
 * eval-next does no option merging itself.
 *
 * @see docs/proposals/v2/blueprint/37-eval-package-sketch.md
 */

import type { CreateAppOptions } from "@agentick/app-next";
import type { AppHarnessProtocol } from "@agentick/spec-next";

// ============================================================================
// App factory + overrides
// ============================================================================

/**
 * Default override shape — every `createApp` slot is optional, plus
 * `rootElement` (which `CreateAppOptions` excludes by design).
 * Adopters who want a domain-shaped override (e.g.
 * `{ profile: "ci" | "prod" }`) parameterize `O` themselves.
 */
export type DefaultAppOverrides = Partial<CreateAppOptions> & {
  readonly rootElement?: unknown;
};

/**
 * Thunk that constructs a fresh `AppHarness` for one eval invocation.
 * Receives the per-invocation overrides; the thunk decides how to
 * compose them with its own defaults. Returning a fresh harness on
 * each call is required — eval-next closes the app after the body
 * finishes.
 */
export type AppFactory<O = DefaultAppOverrides, P = unknown> = (
  overrides?: O,
) => Promise<AppHarnessProtocol<P>>;

// ============================================================================
// Definition + invocation
// ============================================================================

/**
 * The eval body. Adopters write assertions against `t`; the runner
 * builds a fresh app via `definition.app(...)`, executes the body,
 * and collects results.
 *
 * Adopters chain multiple `t.send` calls for multi-turn evals —
 * state carries via the same session inside `t.app`.
 */
export type EvalTest<P = unknown> = (t: EvalContext<P>) => Promise<void> | void;

/**
 * The eval definition supplied to `defineEval(...)`. Three fields:
 *
 *   - `description` — human-readable, surfaces in result reports
 *   - `app` — factory that constructs a fresh `AppHarness` per
 *     invocation, receiving the per-call overrides
 *   - `test` — the eval body, assertions against `t`
 */
export interface EvalDefinition<O = DefaultAppOverrides, P = unknown> {
  readonly description: string;
  readonly app: AppFactory<O, P>;
  readonly test: EvalTest<P>;
}

/**
 * The returned callable. `await myEval()` runs with the factory's
 * defaults; `await myEval(overrides)` passes `overrides` through to
 * the factory unchanged.
 *
 * Future-shipped: `.matrix(axes)` for parameter sweeps. Not in MVP.
 */
export interface CallableEval<O = DefaultAppOverrides, P = unknown> {
  (overrides?: O): Promise<EvalResult>;
  /** The original definition — exposed for tooling that wants to introspect. */
  readonly definition: EvalDefinition<O, P>;
}

// ============================================================================
// Result
// ============================================================================

export type AssertionKind = "completed" | "calledTool" | "notCalledTool" | "noFailedActions";

export interface AssertionResult {
  readonly kind: AssertionKind;
  readonly passed: boolean;
  /** Human-readable explanation — surfaced on failure for debugging. */
  readonly message: string;
  /**
   * Structured details — assertion-specific. For `calledTool` /
   * `notCalledTool`, the tool name; for `noFailedActions`, the list
   * of failed tool calls observed.
   */
  readonly details?: unknown;
}

export interface EvalResult {
  readonly description: string;
  readonly passed: boolean;
  readonly assertions: ReadonlyArray<AssertionResult>;
  /** Every tool call observed during this invocation. */
  readonly toolCalls: ReadonlyArray<ObservedToolCall>;
  /** Wall-clock duration (ms). */
  readonly elapsedMs: number;
  /**
   * The thrown error, if the eval body threw something other than
   * an assertion failure. Adopters might use this for catastrophic
   * eval-construction errors.
   */
  readonly error?: { readonly name: string; readonly message: string };
}

export interface ObservedToolCall {
  readonly name: string;
  readonly input: unknown;
  readonly outcome: "succeeded" | "failed";
  readonly result?: unknown;
  readonly error?: { readonly name: string; readonly message: string };
  /** Timestamp of the terminal event for this call. */
  readonly at: number;
}

// ============================================================================
// Test context (t)
// ============================================================================

/**
 * The argument passed to `test(t)` in {@link EvalDefinition.test}.
 * Drives the agent, asserts on what happened. Methods are sync where
 * possible — assertions are recorded into the result, not thrown,
 * so multiple failures show up in one report.
 *
 * `t.send` IS async — it drives the agent to completion of one
 * exchange.
 *
 * `P` is the per-session-props type, threaded through for typed
 * adopter code; the MVP doesn't use it but the shape is preserved
 * for compatibility with future fixture injection.
 */
export interface EvalContext<P = unknown> {
  /**
   * The app constructed by `definition.app(overrides)` for this
   * invocation. Adopters reach for this when they need primitives
   * the `t` surface doesn't sugar (custom session configuration,
   * multi-session evals, etc.). Use sparingly — the rest of `t` IS
   * the supported surface.
   */
  readonly app: AppHarnessProtocol<P>;

  /**
   * Drive the agent. Creates a fresh session per call (sessions
   * don't persist between `t.send` calls in the MVP; multi-turn
   * evals will get a session-scoped seam in a later iteration).
   * Awaits completion. Returns the final response text.
   */
  send(prompt: string): Promise<string>;

  /**
   * Assert the most-recent `t.send` reached a terminal stop reason
   * (i.e., the model decided it was done, not aborted/errored).
   * Records into the result; does not throw.
   */
  completed(): void;

  /**
   * Assert that a specific tool was called during the run, with the
   * given input shape (deep-equal). `isError: true` requires the
   * call to have failed; `isError: false` requires success.
   * Records into the result.
   */
  calledTool(
    name: string,
    opts?: {
      readonly input?: unknown;
      readonly isError?: boolean;
    },
  ): void;

  /**
   * Assert that a tool was NOT called during the run. Critical for
   * safety evals ("the agent did not call the money-moving tool").
   */
  notCalledTool(name: string): void;

  /**
   * Assert that no tool call observed during the run failed
   * (i.e., every recorded outcome is `"succeeded"`).
   */
  noFailedActions(): void;
}
