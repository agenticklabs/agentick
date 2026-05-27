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

import type { CommandOutcome } from "../data/outcomes.js";
import type { ContentBlock } from "../data/content-blocks.js";
import type { ExecutionTarget } from "../data/execution-target.js";
import type {
  ExecutorTerminal,
  LanguageModelExecutionResult,
  LanguageModelStopReason,
  UsageStats,
} from "../data/execution-result.js";
import type { FormatterRef } from "../data/formatter.js";
import type { ExecutorProtocol } from "./executor.js";
import type { ReconcilerProtocol } from "./reconciler.js";
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
 * loop accepts any object matching these methods — `@agentick/loop-executor`
 * ships `NoopStateApplicator` for tests and the example app.
 */
export interface StateApplicator {
  /**
   * Apply an executor's normalized result to session state — typically
   * appending an assistant message to the timeline with the model's
   * output blocks (and updating usage / stop reason).
   */
  applyExecutorResult(input: {
    readonly sessionId: string;
    readonly executionId: string;
    readonly tickId: string;
    readonly result: LanguageModelExecutionResult;
  }): Promise<void>;

  /**
   * Apply tool dispatch results to session state — typically appending
   * tool message(s) to the timeline so the next tick's render sees them.
   */
  applyToolResults(input: {
    readonly sessionId: string;
    readonly executionId: string;
    readonly tickId: string;
    readonly results: readonly LoopToolResult[];
  }): Promise<void>;

  /**
   * Append an arbitrary timeline entry. Used by interceptors / middleware
   * that want to record opaque state changes.
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
  readonly mountId: string;

  /** Executor harness for the model run. */
  readonly executor: ExecutorProtocol<unknown, unknown, LanguageModelExecutionResult>;
  readonly target: ExecutionTarget;

  /** Tool executor harness for dispatch of `result.toolCalls`. */
  readonly toolExecutor: ToolExecutorProtocol;

  /** Where loop writes results back. Phase 4e session harness will implement. */
  readonly stateApplicator: StateApplicator;

  /** Bound on the number of ticks. Required — no implicit default. */
  readonly maxTicks: number;

  /** Optional caller abort. The harness also exposes an inbox `halt` message. */
  readonly signal?: AbortSignal;

  /** Optional default formatter for renderTree calls. */
  readonly defaultFormatter?: FormatterRef;

  /** Optional metadata passed through to per-tick lifecycle events. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ExecutionRunResult {
  readonly executionId: string;
  readonly ticks: number;
  readonly usage: UsageStats;
  readonly stopReason:
    | LanguageModelStopReason
    | "max_ticks"
    | "aborted"
    | "vetoed"
    | "executor_failed";
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

export type LoopExecutorError =
  | { readonly _tag: "ExecutionError"; readonly cause: unknown }
  | {
      readonly _tag: "TickError";
      readonly tick: number;
      readonly phase: "compile" | "execute" | "tool-dispatch" | "ingest" | "continuation";
      readonly cause: unknown;
    }
  | { readonly _tag: "LoopCanceledError"; readonly reason?: string }
  | { readonly _tag: "MaxTicksExceeded"; readonly maxTicks: number };

// ============================================================================
// Protocol
// ============================================================================

/**
 * Methods every loop executor MUST provide. Promise-typed at the public
 * surface (matching the other harness protocols). Implementations
 * wrap their bodies with `runHarnessProtocol(Effect.suspend(...))`.
 *
 * @throws {LoopExecutorError}
 */
export interface LoopExecutorProtocol {
  /**
   * Run one agent execution from start to terminal. The terminal
   * envelope carries the outcome (succeeded / failed / canceled /
   * vetoed); the `result` field carries the assembled
   * `ExecutionRunResult` on success.
   */
  runExecution(input: RunExecutionInput): Promise<ExecutionTerminal>;

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
    typeof v === "function" &&
    (v as { loopExecutorFactory?: unknown }).loopExecutorFactory === true
  );
}
