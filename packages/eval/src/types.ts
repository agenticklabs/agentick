/**
 * Public types for `@agentick/eval` (v1). The `defineEval(...)` factory
 * is the entry point; everything else is the surface the `t` (test
 * context) object exposes to assertion bodies.
 *
 * Shape: `{ description, app, test }`. `app` is a thunk that constructs
 * a FRESH agentick app (the value returned by `createApp(...)`) per eval
 * invocation — every `await myEval()` gets its own app, so session state
 * doesn't leak between runs or matrix-axis cells. The thunk receives the
 * per-invocation overrides (`O`) and decides how to fold them in; the
 * eval package does no option merging itself.
 *
 * Ported from `@agentick/eval-next` (packages-next/eval) with two v1
 * extensions:
 *   - `t.send` accepts content blocks, not just a string — evals over
 *     documents/images need to attach media to the user message.
 *   - `t.expect(name, passed, opts?)` records a custom assertion —
 *     the seam for comparing an output against an expected fixture
 *     (field-level extraction scoring, etc.) without the package
 *     prescribing a scorer framework.
 */

// ============================================================================
// App factory + overrides
// ============================================================================

/**
 * The minimal surface the runner needs from a v1 agentick app (the
 * value `createApp(...)` returns). Structural on purpose — the eval
 * package works with anything session-shaped.
 */
export interface EvalApp {
  session(): Promise<EvalSession>;
}

export interface EvalSession {
  /**
   * v1 session.send returns a thenable whose resolution is the full
   * handle (with `.events`); the runner awaits it either way.
   */
  send(input: { messages: EvalMessage[] }): EvalSendHandle | PromiseLike<EvalSendHandle>;
  close(): void;
}

export interface EvalMessage {
  role: string;
  content: Array<Record<string, unknown>>;
}

/** The handle `session.send` returns: awaitable result + event stream. */
export interface EvalSendHandle {
  result: Promise<unknown>;
  events?: AsyncIterable<Record<string, unknown>>;
  abort?(reason?: string): void;
}

/**
 * Default override shape — a free-form record. Adopters who want a
 * domain-shaped override (e.g. `{ model: string }`) parameterize `O`
 * themselves; the factory owns interpreting it.
 */
export type DefaultAppOverrides = Record<string, unknown>;

/**
 * Thunk that constructs a fresh app for one eval invocation. Receives
 * the per-invocation overrides; the thunk decides how to compose them
 * with its own defaults. Returning a fresh app on each call is
 * required — the runner closes sessions after the body finishes.
 */
export type AppFactory<O = DefaultAppOverrides> = (overrides?: O) => Promise<EvalApp> | EvalApp;

// ============================================================================
// Definition + invocation
// ============================================================================

/** The eval body. Assertions against `t` record into the result. */
export type EvalTest = (t: EvalContext) => Promise<void> | void;

export interface EvalDefinition<O = DefaultAppOverrides> {
  /** Human-readable; surfaces in result reports. */
  readonly description: string;
  /** Factory constructing a fresh app per invocation. */
  readonly app: AppFactory<O>;
  /** The eval body. */
  readonly test: EvalTest;
}

/**
 * The returned callable. `await myEval()` runs with the factory's
 * defaults; `await myEval(overrides)` passes `overrides` through to
 * the factory unchanged.
 *
 * `.matrix(axes, opts?)` runs the cartesian product of axis values,
 * returning one `MatrixCell` per combination — the multi-model /
 * multi-fixture comparison surface.
 */
export interface CallableEval<O = DefaultAppOverrides> {
  (overrides?: O): Promise<EvalResult>;
  /** The original definition — exposed for tooling. */
  readonly definition: EvalDefinition<O>;
  /**
   * Run the cartesian product of `axes`. Each cell merges into one
   * `O` (one value per axis) and runs the eval once.
   *
   *   - Empty axes (`{}`)   → 1 cell, equivalent to `myEval()`
   *   - Any axis with `[]`  → 0 cells (mathematical product)
   *
   * `opts.concurrency` caps concurrent runs (default `1` — sequential
   * — to avoid rate-limit blowups on real-model evals).
   */
  matrix<K extends keyof O & string>(
    axes: { readonly [A in K]?: ReadonlyArray<O[A]> },
    opts?: MatrixOptions,
  ): Promise<MatrixResult<O>>;
}

// ============================================================================
// Matrix
// ============================================================================

export interface MatrixOptions {
  /** Max concurrent eval runs. Default `1` (sequential). */
  readonly concurrency?: number;
}

export interface MatrixCell<O = DefaultAppOverrides> {
  /** The resolved override record handed to the factory for this cell. */
  readonly axes: O;
  readonly result: EvalResult;
}

export interface MatrixResult<O = DefaultAppOverrides> {
  readonly cells: ReadonlyArray<MatrixCell<O>>;
  /** True iff every cell's `result.passed` is true. */
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
  /** For `expect` assertions, the adopter-supplied name. */
  readonly name?: string;
  readonly passed: boolean;
  /** Human-readable explanation — surfaced on failure for debugging. */
  readonly message: string;
  /** Structured details — assertion-specific. */
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
  /** Thrown error, if the eval body threw. */
  readonly error?: { readonly name: string; readonly message: string };
}

export interface ObservedToolCall {
  readonly name: string;
  readonly input: unknown;
  readonly outcome: "succeeded" | "failed";
  readonly result?: unknown;
  /** Timestamp the call was observed. */
  readonly at: number;
}

// ============================================================================
// Test context (t)
// ============================================================================

/** Content a `t.send` accepts: plain text or full content blocks. */
export type EvalSendInput = string | Array<Record<string, unknown>>;

/**
 * The argument passed to `test(t)`. Drives the agent, asserts on what
 * happened. Assertions are recorded into the result, not thrown, so
 * multiple failures show up in one report.
 */
export interface EvalContext {
  /**
   * The app constructed by `definition.app(overrides)` for this
   * invocation — the escape hatch for primitives `t` doesn't sugar.
   */
  readonly app: EvalApp;

  /**
   * Drive the agent: creates a fresh session, sends one user message
   * (string or content blocks — attach documents/images as blocks),
   * awaits completion, records observed tool calls, and returns the
   * final response text.
   */
  send(input: EvalSendInput): Promise<string>;

  /** Assert the most-recent `t.send` completed without an error event. */
  completed(): void;

  /**
   * Assert a tool was called during the run. `input` deep-equals the
   * call's input when provided; `isError` pins the outcome.
   */
  calledTool(name: string, opts?: { readonly input?: unknown; readonly isError?: boolean }): void;

  /** Assert a tool was NOT called (safety evals). */
  notCalledTool(name: string): void;

  /** Assert no observed tool call failed. */
  noFailedActions(): void;

  /**
   * Record a custom assertion — the seam for comparing outputs against
   * expected fixtures (e.g. field-level extraction scoring). `details`
   * lands on the assertion result for reporting.
   */
  expect(name: string, passed: boolean, opts?: { message?: string; details?: unknown }): void;

  /**
   * The most recent tool call observed with the given name (from any
   * `t.send` in this invocation) — convenient for reading a submit
   * tool's payload to score against an expected fixture.
   */
  lastToolCall(name: string): ObservedToolCall | undefined;
}
