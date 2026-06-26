/**
 * Public types for `@agentick/eval-next`. The `defineEval(...)` factory
 * is the entry point; everything else is the surface the `t` (test
 * context) object exposes to assertion bodies.
 *
 * @see docs/proposals/v2/blueprint/37-eval-package-sketch.md
 */

import type { CreateAppOptions } from "@agentick/app-next";
import type { AppHarnessProtocol } from "@agentick/spec-next";

// ============================================================================
// Definition + invocation
// ============================================================================

/**
 * The eval body. Adopters write assertions against `t`; the runner
 * builds a fresh app for the invocation, executes the body, and
 * collects results.
 *
 * `t.send(prompt)` drives the agent to completion. Subsequent
 * assertions (`t.calledTool`, `t.notCalledTool`, etc.) inspect what
 * happened during that send. Adopters can chain multiple `t.send`
 * calls for multi-turn evals — state carries via the session.
 */
export type EvalTest<P = unknown> = (t: EvalContext<P>) => Promise<void> | void;

/**
 * The eval definition supplied to `defineEval(...)`. Carries the
 * defaults that bake into the returned callable function. Each
 * field may be overridden per invocation via the
 * {@link EvalInvocationOverrides} arg.
 */
export interface EvalDefinition<P = unknown> extends Omit<CreateAppOptions<P>, "rootElement"> {
  /** Human-readable description — surfaces in result reports. */
  readonly description: string;
  /**
   * Agent root element handed to `createApp`. The reconciler
   * interprets it (React element, custom AST, etc.).
   */
  readonly rootElement: unknown;
  /** The eval body — assertions against `t`. */
  readonly test: EvalTest<P>;
}

/**
 * Per-invocation overrides — what `await myEval({ ... })` accepts.
 * Every `createApp` field is optionally overridable; `rootElement`
 * and `test` cannot be overridden (those are eval identity).
 *
 * Common overrides for matrix runs: `executor` (model swap),
 * `metadata` (tagging the run for downstream reporting).
 */
export type EvalInvocationOverrides<P = unknown> = Partial<
  Omit<CreateAppOptions<P>, "rootElement">
> & {
  readonly rootElement?: unknown;
};

/**
 * The returned callable. `await myEval()` runs with definition
 * defaults; `await myEval({ executor: X })` overrides for one run.
 *
 * Future-shipped: `.matrix(axes)` for parameter sweeps. Not in MVP.
 */
export interface CallableEval<P = unknown> {
  (overrides?: EvalInvocationOverrides<P>): Promise<EvalResult>;
  /** The original definition — exposed for tooling that wants to introspect. */
  readonly definition: EvalDefinition<P>;
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
   * Direct app handle. Adopters reach for this when they need
   * primitives the `t` surface doesn't sugar (custom session
   * configuration, multi-session evals, etc.). Use sparingly —
   * the rest of `t` IS the supported surface.
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
