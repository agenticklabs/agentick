/**
 * LoopExecutorProtocol — the orchestration harness that runs ONE
 * agent execution.
 *
 * Sits between the session harness (Phase 4e) and the lower-level
 * reconciler / executor / tool-executor harnesses. Composes their
 * protocol surfaces into the canonical tick loop:
 *
 *   1. renderTree (reconciler)
 *   2. executor.run    (executor)
 *   3. for each toolCall: toolExecutor.dispatch  (tool-executor)
 *   4. stateApplicator.apply* (session harness's apply commands)
 *   5. continuation policy → continue OR stop
 *   6. repeat (bounded by maxTicks)
 *
 * The loop emits per-phase events even though it delegates work to
 * other harnesses. This makes the execution flow auditable from a
 * single subscriber (`surface: "loop"`).
 *
 * @see docs/proposals/v2/blueprint/05-loop-executor.md
 */

import type { HarnessFx } from "./middleware.js";
import type { Effect } from "effect";
import type { CommandOutcome } from "../data/outcomes.js";
import type { ContentBlock } from "../data/content-blocks.js";
import type { SubstrateError } from "../data/errors.js";
import type { ExecutionTarget } from "../data/execution-target.js";
import type { PromiseView } from "./promise-view.js";
import type {
  ExecutorTerminal,
  LanguageModelExecutionResult,
  LanguageModelStopReason,
  UsageStats,
} from "../data/execution-result.js";
import type { LoopExecutorError } from "../errors/harnesses.js";
import type { StateApplyErrorChannel } from "../errors/lifecycle.js";
import type { FormatterRef } from "../data/formatter.js";
import type { ExecutorProtocol } from "./executor.js";
import type { RegisteredModel } from "./hook-bridges.js";
import type { ReconcilerProtocol } from "./reconciler.js";
import type { RenderContext } from "./render-context.js";
import type { ToolExecutorProtocol } from "./tool-executor.js";

// ============================================================================
// StateApplicator — structural Pick of session harness apply methods
// ============================================================================

/**
 * The slice of session-harness behavior the loop needs to write its
 * results back into session state.
 *
 * Locked in `17-open-questions.md` (A11) as a structural type, not a
 * separate interface. Until the session harness lands (Phase 4e), the
 * loop accepts any object matching these methods — `@agentick/loop-executor-next`
 * ships `NoopStateApplicator` for tests and the example app.
 */
/**
 * The Effect-canonical composable surface of the state applicator (ADR 77,
 * the dual-typed edge). The loop reaches `stateApplicator.fx.apply*(...)`
 * to compose the tick's state writes into one fiber tree (Stage 3); the
 * plain Promise methods on {@link StateApplicator} are the derived edge
 * facades ({@link PromiseView} of this).
 *
 * The reference implementer is the session harness, whose `apply*` are
 * `runHarnessProtocol`-backed (a `runPromise` root that would sever the
 * fiber if the loop awaited the facade). These twins are the un-run
 * inners so the write's exit-normalization stays in the loop's fiber.
 * `appendEntry` has no twin — the loop never calls it (interceptor/
 * middleware surface only).
 */
export interface StateApplicatorFx {
  applyExecutorResult(input: {
    readonly sessionId: string;
    readonly executionId: string;
    readonly tickId: string;
    readonly result: LanguageModelExecutionResult;
  }): Effect.Effect<void, StateApplyErrorChannel | SubstrateError, never>;

  applyToolResults(input: {
    readonly sessionId: string;
    readonly executionId: string;
    readonly tickId: string;
    readonly results: readonly LoopToolResult[];
  }): Effect.Effect<void, StateApplyErrorChannel | SubstrateError, never>;
}

export interface StateApplicator extends PromiseView<StateApplicatorFx> {
  /**
   * The Effect-canonical composable surface (ADR 77) — `fx.apply*` for
   * in-fiber composition by the loop's `Effect.gen` body.
   */
  readonly fx: StateApplicatorFx;

  // `applyExecutorResult` / `applyToolResults` are derived from
  // `PromiseView<StateApplicatorFx>` — the Promise facades of the
  // Effect-canonical twins ({@link StateApplicatorFx.applyExecutorResult}
  // appends the assistant message with the model's output blocks;
  // `applyToolResults` appends tool message(s) so the next tick's render
  // sees them). The implementer exposes the Effect surface as `.fx`.

  /**
   * Append an arbitrary timeline entry. Used by interceptors / middleware
   * that want to record opaque state changes. No fx twin — off the loop's
   * hot path.
   */
  appendEntry(input: {
    readonly sessionId: string;
    readonly entry: { readonly role: string; readonly content: readonly ContentBlock[] };
  }): Promise<void>;
}

/**
 * Pairing of a tool call with its dispatch result. The loop records
 * one of these per `toolCall` in the executor's result.
 */
export interface LoopToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly succeeded: boolean;
  readonly content: readonly ContentBlock[];
  readonly durationMs: number;
  readonly error?: unknown;
}

// ============================================================================
// Inputs / outputs
// ============================================================================

export interface RunExecutionInput {
  readonly executionId: string;
  readonly sessionId: string;
  readonly parentExecutionId?: string;

  /** Reconciler harness whose `mountId` the loop will render each tick. */
  readonly reconciler: ReconcilerProtocol;
  /**
   * Resolve the whole {@link RenderContext} envelope for the CURRENT
   * render (ADR 55) — the session's per-render fact producer. It owns
   * `target` + the injected `models` registry (window today via
   * `effectiveModelInfo`) and later folds further slots (active model,
   * budget, principal) into the returned envelope. Called per tick BEFORE
   * render; the loop threads the result straight into
   * `renderTree({ renderContext })` so `useContextInfo` (and future
   * per-slot readers) see it SYNCHRONOUSLY while producing the IR. The
   * loop stays a dumb conduit — no per-fact knowledge.
   * // TODO(trail-per-tick-model): under #169 the active model is
   * // IR-derived (post-render); a model change then forces a re-render
   * // via the stabilization loop. Today the model is construction-bound
   * // (session.target) so this is stable across ticks.
   */
  readonly resolveRenderContext?: () => RenderContext | undefined;
  readonly mountId: string;

  /**
   * Resolve a tree-declared model ref to its run-ready
   * {@link RegisteredModel} (ADR 56) — symmetric with
   * {@link resolveRenderContext}. The session supplies it, closing over
   * the mount's {@link import("./hook-bridges.js").ModelBridge}. When a
   * tick's IR carries `declarations.model`, the loop resolves
   * `modelRef → RegisteredModel` and runs THAT executor + target for the
   * tick (precedence: tick-IR > send > session). Undefined, or a ref that
   * resolves to `undefined`, falls back to {@link modelExecutor} / {@link target}.
   */
  readonly resolveModel?: (modelRef: string) => RegisteredModel | undefined;

  /** Model-executor harness for the model run. */
  readonly modelExecutor: ExecutorProtocol<unknown, unknown, LanguageModelExecutionResult>;
  readonly target: ExecutionTarget;

  /** Tool executor harness for dispatch of `result.toolCalls`. */
  readonly toolExecutor: ToolExecutorProtocol;

  /** Where loop writes results back. Phase 4e session harness will implement. */
  readonly stateApplicator: StateApplicator;

  /** Bound on the number of ticks. Required — no implicit default. */
  /**
   * Tick-end forwarding (ADR 53): the session's continuation predicate.
   * `{ kind: "continue" }` keeps the loop ticking even when the model
   * stopped (steering — new input arrived mid-execution); `stop` forces
   * termination; undefined defers to the default policy.
   */
  readonly notifyTickEnd?: (
    input: import("./session-harness.js").NotifyTickEndInput,
  ) => Promise<import("./session-harness.js").TickEndForwardDecision>;
  readonly maxTicks: number;

  /**
   * Concurrency for dispatching a tick's tool calls (ADR 77 Stage 5).
   * `"unbounded"` (default) runs every `result.toolCalls` entry
   * concurrently — results stay in call-order (`Effect.all` preserves
   * order regardless of concurrency); a positive integer caps in-flight
   * dispatches; `1` is sequential. Abort / timeout tears down all
   * in-flight tool fibers.
   */
  readonly toolConcurrency?: number | "unbounded";

  /**
   * Optional execution timeout in milliseconds (ADR 77 Stage 5). NO
   * default — the framework ships the mechanism, not a policy. On expiry
   * the execution structurally aborts (tearing down the in-flight model
   * call / tool handlers via the same signal machinery) and resolves a
   * `canceled` terminal with `stopReason: "timeout"`.
   */
  readonly timeoutMs?: number;

  /** Optional caller abort. The harness also exposes an inbox `halt` message. */
  readonly signal?: AbortSignal;

  /** Optional default formatter for renderTree calls. */
  readonly defaultFormatter?: FormatterRef;

  /** Optional metadata passed through to per-tick lifecycle events. */
  readonly metadata?: Readonly<Record<string, unknown>>;

  /**
   * App/session-level model-narration switch (default `true`). Threaded
   * straight into the per-tick `project` / `run` call so the projector
   * gates injection of the reserved `TOOL_NARRATION_FIELD` (`_summary`)
   * into each model-facing tool schema. `false` disables narration
   * app-wide — the token-cost off-switch. See `ProjectInput.narrate`.
   */
  readonly narrate?: boolean;

  /**
   * When true (and `executor.executeStream` exists + the target's
   * `capabilities.supportsStreaming` is not explicitly false), the
   * loop uses streaming execution and forwards every `AdapterDelta`
   * through `onEvent` as `ModelStreamEvent`s.
   *
   * When false (or undefined → falls back to the default), the loop
   * uses the non-streaming `executor.execute` path; only summary-level
   * events flow to `onEvent`.
   *
   * Default: resolved by the caller (SessionHarness) from the
   * SendInput / CreateSessionInput / AppHarnessOptions cascade.
   */
  readonly stream?: boolean;

  /**
   * Optional event sink. The loop calls this with PARTIAL
   * `StreamEvent`s — the consumer (typically the session harness)
   * stamps the missing context fields (id, sequence, sessionId,
   * timestamp) and pushes onto the handle's event queue.
   *
   * Events emitted via this callback are IN-BAND data flow — direct
   * call chain from loop → consumer. Bus envelopes (via emitDeltaLazy)
   * still fire in parallel for observability subscribers (devtools,
   * telemetry). The two paths are independent.
   *
   * When `onEvent` is undefined, the loop simply doesn't pump events
   * — observability via bus is still available.
   */
  readonly onEvent?: (event: LoopEmittedEvent) => void;
}

/**
 * Events the loop emits through {@link RunExecutionInput.onEvent}.
 *
 * The session-side consumer stamps the missing context fields (`id`,
 * `sequence`, `timestamp`, `sessionId`, `executionId`, `spawnPath`)
 * when converting into the public `StreamEvent` shape. The loop owns
 * `tick` since it controls tick boundaries.
 */
export type LoopEmittedEvent =
  // Model layer — passthrough of the executor's AdapterDelta stream
  | {
      readonly kind: "model";
      readonly tick: number;
      readonly delta: import("../data/streaming.js").AdapterDelta;
    }
  // Orchestration layer — loop's own lifecycle + tool dispatch lifecycle
  | { readonly kind: "tick-start"; readonly tick: number; readonly tickIndex: number }
  | {
      readonly kind: "tick-end";
      readonly tick: number;
      readonly tickIndex: number;
      readonly stopReason?: string;
      readonly shouldContinue: boolean;
      readonly usage?: UsageStats;
    }
  | {
      readonly kind: "tick";
      readonly tick: number;
      readonly tickIndex: number;
      readonly stopReason: string;
      readonly usage: UsageStats;
      readonly durationMs: number;
    }
  | {
      readonly kind: "execution-start";
      readonly tick: 0;
      readonly rootExecutionId?: string;
    }
  | {
      readonly kind: "execution-end";
      readonly tick: number;
      readonly stopReason: string;
      readonly aborted?: boolean;
      readonly error?: { readonly message: string; readonly name: string };
    }
  | {
      readonly kind: "tool-dispatch-start";
      readonly tick: number;
      readonly callId: string;
      readonly name: string;
      readonly via: "model" | "dispatch";
    }
  | {
      readonly kind: "tool-dispatch-end";
      readonly tick: number;
      readonly callId: string;
      readonly name: string;
      readonly outcome: "succeeded" | "failed" | "vetoed" | "aborted";
      readonly durationMs: number;
    }
  | {
      readonly kind: "tool-dispatch";
      readonly tick: number;
      readonly callId: string;
      readonly name: string;
      readonly content: readonly import("../data/content-blocks.js").ContentBlock[];
      readonly succeeded: boolean;
      readonly durationMs: number;
      readonly executedBy?: string;
      readonly isError?: boolean;
    };

export interface ExecutionRunResult {
  readonly executionId: string;
  readonly ticks: number;
  readonly usage: UsageStats;
  readonly stopReason:
    | LanguageModelStopReason
    | "max_ticks"
    | "aborted"
    | "vetoed"
    | "executor_failed"
    | "timeout";
  /** Canonical content stream — concatenated `output` from each tick's executor result. */
  readonly output: readonly ContentBlock[];
  /** Tool dispatch results accumulated across ticks. */
  readonly toolResults: readonly LoopToolResult[];
  /** Optional output extractions (Phase 4f `OutputDeclaration`s; not used in 4d). */
  readonly outputs?: Readonly<Record<string, unknown>>;
}

export interface ExecutionTerminal {
  readonly outcome: CommandOutcome;
  readonly result?: ExecutionRunResult;
  readonly reason?: string;
  readonly error?: LoopExecutorError;
}

// ============================================================================
// Tick types — passed to lifecycle handlers
// ============================================================================

export interface TickInfo {
  readonly executionId: string;
  readonly sessionId: string;
  readonly tickId: string;
  readonly tickIndex: number;
}

export interface TickResult extends TickInfo {
  /** The executor's terminal for this tick. */
  readonly executorTerminal: ExecutorTerminal<LanguageModelExecutionResult>;
  /** Tool dispatch results from this tick. */
  readonly toolResults: readonly LoopToolResult[];
  /**
   * Whether the loop will continue past this tick (subject to lifecycle
   * handler verdicts that may override).
   */
  readonly shouldContinue: boolean;
  readonly stopReason?:
    | LanguageModelStopReason
    | "max_ticks"
    | "aborted"
    | "vetoed"
    | "executor_failed";
}

/**
 * Decision returned by `onTickEnd` lifecycle handlers. The loop merges
 * verdicts per the standard handler-verdict rules
 * (`veto > replace > defer > proceed`).
 */
export type TickEndDecision =
  | { readonly kind: "continue" }
  | { readonly kind: "stop"; readonly reason?: string }
  | undefined;

// ============================================================================
// Errors
// ============================================================================

/** Migrated to class hierarchy (ADR 41). Re-exports from `../errors/harnesses.js`. */
export {
  ExecutionError,
  LoopCanceledError,
  LoopExecutorError,
  type LoopExecutorErrorChannel,
  MaxTicksExceeded,
  TickError,
} from "../errors/harnesses.js";

// ============================================================================
// Protocol
// ============================================================================

/**
 * The loop executor's **canonical** composable surface: the Effect twins
 * of its operations (ADR 77, the dual-typed edge). The session harness
 * reaches `loop.fx.runExecution(...)` to compose an execution into one
 * fiber tree (Stage 3); the plain Promise method on
 * {@link LoopExecutorProtocol} is the derived edge facade
 * ({@link PromiseView} of this), `runHarnessProtocol` at the boundary.
 *
 * Like the executor, `runExecution` is not a registry command — the input
 * carries live object refs (ADR 51 §1.2, in-process only) — so `.fx` is
 * hand-exposed (the `runOperation(op, body)` Effect the harness already
 * builds), not `fxProxy`-derived.
 */
export interface LoopExecutorFx extends HarnessFx {
  /**
   * Run one agent execution from start to terminal. The terminal
   * envelope carries the outcome (succeeded / failed / canceled /
   * vetoed); the `result` field carries the assembled
   * `ExecutionRunResult` on success. Substrate/loop failures inhabit
   * the `E` channel; non-success outcomes ride the success channel as
   * the terminal.
   */
  runExecution(
    input: RunExecutionInput,
  ): Effect.Effect<ExecutionTerminal, LoopExecutorError | SubstrateError, never>;
}

/**
 * Methods every loop executor MUST provide. Promise-typed at the public
 * surface (matching the other harness protocols). Implementations
 * wrap their bodies with `runHarnessProtocol(Effect.suspend(...))`.
 *
 * `runExecution` is derived from `PromiseView<LoopExecutorFx>` — the
 * Promise facade of the Effect-canonical twin; the concrete harness
 * exposes the Effect surface as `loop.fx`.
 *
 * @throws {LoopExecutorError}
 */
export interface LoopExecutorProtocol extends PromiseView<Omit<LoopExecutorFx, "use">> {
  /**
   * The Effect-canonical composable surface (ADR 77) — `fx.runExecution`
   * for in-fiber composition by the session harness. On the protocol so a
   * protocol-typed ref composes without severing the fiber.
   */
  readonly fx: LoopExecutorFx;

  /**
   * Abort the named execution. The in-flight `runExecution` for this
   * id MUST terminate with `outcome: "canceled"`. No-op for unknown
   * ids.
   */
  abort(input: { readonly executionId: string; readonly reason?: string }): Promise<void>;
}

// ============================================================================
// LoopExecutorFactory — deferred construction with shared substrate
// ============================================================================

export interface LoopExecutorFactoryDeps {
  readonly scopeId: string;
  readonly journal: import("./journal.js").OperationJournal;
  readonly bus: import("./bus.js").EventBus;
  readonly inbox: import("./inbox.js").MessageInbox;
}

/**
 * Deferred-construction form of `LoopExecutorProtocol`. Parent harnesses
 * (`AppHarness`) call this factory with their own substrate so the
 * loop's events flow through the shared bus/journal.
 *
 * Marker symbol `loopExecutorFactory` disambiguates a factory from a
 * pre-constructed instance.
 */
export interface LoopExecutorFactory {
  readonly loopExecutorFactory: true;
  (deps: LoopExecutorFactoryDeps): LoopExecutorProtocol;
}

/** Type guard. */
export function isLoopExecutorFactory(v: unknown): v is LoopExecutorFactory {
  return (
    typeof v === "function" && (v as { loopExecutorFactory?: unknown }).loopExecutorFactory === true
  );
}
