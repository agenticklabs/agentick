/**
 * Public types for `@agentick/eval`. The `defineEval(...)` factory
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

import type { CreateAppOptions } from "@agentick/app";
import type { AppHarnessProtocol, SendResult } from "@agentick/spec";

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
  /**
   * Per-eval plugins that extend `t` with extra behaviors (`t.sh`,
   * `t.file`, `t.judge`, …). Each is a factory invoked once per run with
   * an {@link EvalRunContext}; whatever it returns is merged onto `t`.
   * Composes with globally-{@link registerEvalPlugin}ed plugins. Type the
   * added members by augmenting {@link EvalContextExtensions}.
   */
  readonly plugins?: ReadonlyArray<EvalPlugin<P>>;
}

// ============================================================================
// Plugins — the `t` extension seam (ADR 27 install-to-appear, for eval)
// ============================================================================

/**
 * Empty seed for plugin-contributed members on {@link EvalContext} — the
 * eval twin of `ToolHandlerCtxExtensions` / `SessionHandleExtensions`. A
 * plugin package augments this via `declare module "@agentick/eval"` to
 * TYPE its additions, and registers a factory (globally via
 * {@link registerEvalPlugin} or per-eval via {@link EvalDefinition.plugins})
 * to WIRE them. eval-next core declares NO members here.
 *
 * @example
 * // in @agentick/eval/plugins/judge:
 * declare module "@agentick/eval" {
 *   interface EvalContextExtensions {
 *     judge(rubric: string): Promise<boolean>;
 *   }
 * }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EvalContextExtensions {}

/** A labeled boolean a plugin records into the result ledger (like `t.expect`). */
export interface PluginAssertionInput {
  readonly label: string;
  readonly passed: boolean;
  readonly message?: string;
  readonly details?: unknown;
}

/**
 * What a plugin factory receives — the run's internals, so a plugin can read
 * the outcome and record verdicts/scores without reaching through `t.app`.
 * Accessors (`result`) are functions so a plugin method reads LIVE state when
 * called in the test body (after `t.send`), not at build time.
 */
export interface EvalRunContext<P = unknown> {
  /** The app under test for this run. */
  readonly app: AppHarnessProtocol<P>;
  /** The resolved overrides handed to the app factory this run. */
  readonly overrides: unknown;
  /** The most-recent `t.send` result (undefined before the first send). */
  result(): SendResult | undefined;
  /** The live observed tool-call ledger. */
  readonly toolCalls: ReadonlyArray<ObservedToolCall>;
  /** Record a labeled assertion into the result (contributes to `passed`). */
  record(assertion: PluginAssertionInput): void;
  /** Record a numeric score into the result (aggregated across matrix cells). */
  score(label: string, value: number, details?: unknown): void;
}

/**
 * A plugin: a factory invoked once per run with the {@link EvalRunContext}.
 * Returns an object whose members are merged onto `t` (typed via
 * {@link EvalContextExtensions}). Config-carrying plugins are functions that
 * return this factory, e.g. `judge({ model })`.
 */
export type EvalPlugin<P = unknown> = (rc: EvalRunContext<P>) => Record<string, unknown>;

/**
 * The returned callable. `await myEval()` runs with the factory's
 * defaults; `await myEval(overrides)` passes `overrides` through to
 * the factory unchanged.
 *
 * `.matrix(axes, opts?)` runs the cartesian product of axis values,
 * returning one `MatrixCell` per combination. Each cell's `axes` is
 * the resolved override record handed to the factory; `result` is the
 * `EvalResult` for that combination.
 */
export interface CallableEval<O = DefaultAppOverrides, P = unknown> {
  (overrides?: O): Promise<EvalResult>;
  /** The original definition — exposed for tooling that wants to introspect. */
  readonly definition: EvalDefinition<O, P>;
  /**
   * Run the cartesian product of `axes`. Each cell merges into one
   * `O` (one value per axis) and runs the eval once.
   *
   *   - Empty axes (`{}`)         → 1 cell, equivalent to calling `myEval()`
   *   - Any axis with `[]`        → 0 cells (mathematical product)
   *   - Missing axes in `O`       → `undefined` in the cell, factory's
   *                                 `??` defaults take over
   *
   * `opts.concurrency` caps concurrent runs (default `1` — sequential
   * — to avoid surprising rate-limit blowups on real-model evals).
   */
  matrix<K extends keyof O & string>(
    axes: { readonly [P in K]?: ReadonlyArray<O[P]> },
    opts?: MatrixOptions,
  ): Promise<MatrixResult<O>>;
}

// ============================================================================
// Matrix
// ============================================================================

export interface MatrixOptions {
  /** Max concurrent eval runs (spans cells × trials). Default `1` (sequential). */
  readonly concurrency?: number;
  /**
   * Runs per cell. Default `1`. Agents are stochastic — a single run's
   * pass/fail and score value are noise; `trials > 1` collapses each cell into
   * a distribution (mean ± stddev, pass rate, `pass@k`).
   */
  readonly trials?: number;
  /** `pass@k` to report per cell (unbiased estimator). Omit to skip it. */
  readonly k?: number;
}

/** Aggregate of one score label across a cell's trials. */
export interface ScoreAgg {
  readonly mean: number;
  readonly stddev: number;
  readonly min: number;
  readonly max: number;
  readonly n: number;
}

/** A cell's `trials` runs collapsed into a distribution. */
export interface CellStats {
  readonly trials: number;
  /** Number of trials whose `result.passed` was true. */
  readonly passed: number;
  /** `passed / trials` — i.e. `pass@1`. */
  readonly passRate: number;
  /** Unbiased `pass@k` for the `MatrixOptions.k` (present only when `k` set). */
  readonly passAtK?: number;
  /** Per-score-label aggregate across the trials. */
  readonly scores: Readonly<Record<string, ScoreAgg>>;
}

export interface MatrixCell<O = DefaultAppOverrides> {
  /** The resolved override record handed to the factory for this cell. */
  readonly axes: O;
  /** Every trial's result for this cell (length === `stats.trials`). */
  readonly trials: ReadonlyArray<EvalResult>;
  /** The trials collapsed into a distribution. */
  readonly stats: CellStats;
}

export interface MatrixResult<O = DefaultAppOverrides> {
  readonly cells: ReadonlyArray<MatrixCell<O>>;
  /** True iff every cell passed a MAJORITY of its trials (`passRate > 0.5`). */
  readonly passed: boolean;
  /** Wall-clock duration (ms) of the whole sweep. */
  readonly elapsedMs: number;
}

// ============================================================================
// Result
// ============================================================================

export type AssertionKind =
  | "completed"
  | "calledTool"
  | "notCalledTool"
  | "noFailedActions"
  | "expect";

export interface AssertionResult {
  readonly kind: AssertionKind;
  /** Caller-supplied label for `expect` / plugin assertions. */
  readonly label?: string;
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

/**
 * A numeric score recorded via `t.score(label, value)` (or a plugin like
 * `t.judge`). Conventionally `0..1`. Unlike assertions, scores do NOT gate
 * `passed` — they are graded signal the matrix reporter aggregates
 * (mean / pass-rate / pass@k) across cells and trials.
 */
export interface ScoreResult {
  readonly label: string;
  readonly value: number;
  readonly details?: unknown;
}

export interface EvalResult {
  readonly description: string;
  readonly passed: boolean;
  readonly assertions: ReadonlyArray<AssertionResult>;
  /** Numeric scores recorded via `t.score` / plugins (do not gate `passed`). */
  readonly scores: ReadonlyArray<ScoreResult>;
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
export interface EvalContext<P = unknown> extends EvalContextExtensions {
  /**
   * The app constructed by `definition.app(overrides)` for this
   * invocation. Adopters reach for this when they need primitives
   * the `t` surface doesn't sugar (custom session configuration,
   * multi-session evals, etc.). Use sparingly — the rest of `t` IS
   * the supported surface.
   */
  readonly app: AppHarnessProtocol<P>;

  /**
   * The most-recent `t.send` result — the full {@link SendResult}
   * (`response`, `output` blocks, `toolResults`, `usage` tokens, `ticks`,
   * `stopReason`). `undefined` before the first send. This is the raw run
   * the sugar assertions and plugins read from.
   */
  readonly result: SendResult | undefined;

  /**
   * Drive the agent. Creates a fresh session per call (sessions
   * don't persist between `t.send` calls in the MVP; multi-turn
   * evals will get a session-scoped seam in a later iteration).
   * Awaits completion. Returns the final response text.
   */
  send(prompt: string): Promise<string>;

  /**
   * Record a labeled boolean assertion — the generic scoring escape hatch.
   * `t.expect("typechecks", (await t.sh("tsc")).ok)`. Contributes to
   * `passed`; records into the ledger, does not throw.
   */
  expect(label: string, passed: boolean, details?: unknown): void;

  /**
   * Record a numeric score (conventionally `0..1`). Unlike assertions, scores
   * do NOT gate `passed` — they are graded signal the matrix reporter
   * aggregates across cells/trials. `t.score("quality", 0.8)`.
   */
  score(label: string, value: number, details?: unknown): void;

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
