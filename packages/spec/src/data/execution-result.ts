/**
 * Execution result types — produced by the executor harness, consumed by
 * the loop executor and session.
 *
 * `ExecutionResult` is the minimum success shape across all executor
 * families. Family-specific results extend it. The terminal envelope
 * ({@link ExecutorTerminal}) carries the same outcome vocabulary as
 * {@link CommandOutcome} but with strongly-typed payloads.
 *
 * @see docs/proposals/v2/blueprint/02-data-model.md §Execution result types
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

import type { ContentBlock } from "./content-blocks.js";

// ============================================================================
// UsageStats — `[V1-INHERITED]` from packages/shared/src/models.ts
// ============================================================================

export interface UsageStats {
  /**
   * ALL prompt tokens the model read — NORMATIVE (#186): cache reads
   * and cache writes are SUBSETS of this number, never additional to
   * it. Adapters whose provider reports them disjointly (Anthropic)
   * fold them in during normalization; cost accounting depends on it.
   */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** Anthropic extended thinking, OpenAI o1, etc. */
  readonly reasoningTokens?: number;
  /** Prompt-cache reads — a SUBSET of `inputTokens` (#186). */
  readonly cachedInputTokens?: number;
  /** Prompt-cache writes — a SUBSET of `inputTokens` (#186). */
  readonly cacheCreationTokens?: number;
  /** Engine-level tick count (optional for raw model usage). */
  readonly ticks?: number;
}

// ============================================================================
// ExecutionResult — protocol success payload
// ============================================================================

export interface ExecutionResult {
  readonly specVersion: string;
  /** Canonical output blocks (includes tool_use blocks when present). */
  readonly output: readonly ContentBlock[];
  readonly usage?: UsageStats;
  readonly finishMetadata?: Record<string, unknown>;
}

// ============================================================================
// Executor error taxonomy
// ============================================================================

/**
 * Tagged-union executor errors. Carried by `ExecutorTerminal.failed`.
 *
 * Migrated to class hierarchy (ADR 41). `ExecutorError` is now an alias
 * for `ExecutorErrorChannel` (union of concrete `AgentickError`
 * subclasses); old POJO consumers should construct instances via
 * `new ProviderRejected({...})` etc.
 */
import type { ExecutorErrorChannel } from "../errors/harnesses.js";
export type ExecutorError = ExecutorErrorChannel;
export {
  NormalizationFailed,
  ProjectionFailed,
  ProviderAborted,
  ProviderRejected,
  ProviderTimeout,
  StreamFailed,
  UnknownExecutorError,
} from "../errors/harnesses.js";

// ============================================================================
// ExecutorTerminal — terminal envelope
// ============================================================================

/**
 * Terminal outcome carried in the executor's `terminal`-phase event. Mirrors
 * {@link CommandOutcome} but with strongly typed payloads. Note: `deferred`
 * does not appear here — defer is a pre-execution handler verdict, not a
 * terminal outcome.
 */
export type ExecutorTerminal<R extends ExecutionResult = ExecutionResult> =
  | { readonly outcome: "succeeded"; readonly result: R }
  | { readonly outcome: "failed"; readonly error: ExecutorError }
  | { readonly outcome: "canceled"; readonly reason?: unknown }
  | { readonly outcome: "vetoed"; readonly reason?: string }
  | { readonly outcome: "replaced"; readonly result: R; readonly reason?: string };

// ============================================================================
// StopCause — WHY a run stopped badly
// ============================================================================

/**
 * Why an execution stopped badly, typed so the two bad endings cannot be
 * mistaken for one another.
 *
 * The pair to read this with is `stopReason`, which names WHAT stopped the run
 * (`"executor_failed"`, `"vetoed"`, …) as a flat string. This carries the
 * evidence, and only for the endings that HAVE evidence — a cancellation needs
 * none, because the stop reason already says everything true about it.
 *
 * ## Why a discriminated union and not one `error` field
 *
 * A veto is a guard verdict: the policy ran, decided no, and that is the
 * mechanism working. A failure is something breaking. Squeezing both into a field
 * named `error` — or worse, giving a veto an `AgentickError` subclass so it has
 * somewhere to live — makes every consumer that folds errors count deliberate
 * policy decisions as things going wrong: error-rate telemetry, alerting, retry
 * policy, eval scoring. That is a permanent operational cost paid for a one-time
 * naming convenience.
 *
 * `ExecutorTerminal` already discriminates these correctly
 * (`{ outcome: "failed"; error }` vs `{ outcome: "vetoed"; reason }`); this is the
 * same distinction surviving the trip to a caller, a timeline record, and a UI.
 *
 * Being discriminated FORCES a consumer to tell them apart, which it must: the
 * two demand different words and different affordances. A failure means "something
 * broke, here is what the provider said, retrying may work". A veto means "this was
 * refused, here is the policy, retrying will not help".
 */
export type StopCause =
  | {
      readonly kind: "failed";
      /** The executor's own error, serialized — `_tag`, `message`, own fields. */
      readonly error: import("../errors/base.js").SerializedAgentickError;
    }
  | {
      readonly kind: "vetoed";
      /** The guard's reason, verbatim. Absent when the veto gave none. */
      readonly reason?: string;
    };

// ============================================================================
// LanguageModelExecutionResult — v2 shipped family
// ============================================================================

/**
 * Canonical stop-reason set. Provider-specific variants live in
 * `finishMetadata`. `[V1-REPLACED]` of v1's `StopReason` enum (~17 values).
 */
export type LanguageModelStopReason =
  | "end"
  | "tool_use"
  | "max_tokens"
  | "content_filter"
  | "stop_sequence"
  | "other";

/**
 * Tool call extracted from a language-model response. Consistency
 * required: every entry MUST correspond to a `tool_use` block in
 * {@link ExecutionResult.output}.
 */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly metadata?: Record<string, unknown>;
  /**
   * Provider-specific metadata that must round-trip on subsequent
   * turns (e.g. Gemini 3+ `thoughtSignature`). Keyed by provider
   * namespace. Distinct from {@link metadata} which is adopter-facing.
   */
  readonly providerMetadata?: Record<string, Record<string, unknown>>;
}

export interface LanguageModelExecutionResult extends ExecutionResult {
  readonly toolCalls?: readonly ToolCall[];
  readonly stopReason: LanguageModelStopReason;
  /** Pass-through raw provider response. Debug only — MUST NOT be load-bearing. */
  readonly raw?: unknown;
}

// ============================================================================
// ExecutorDelta — streaming chunk (placeholder)
// ============================================================================

/**
 * Streaming chunk envelope. `[GAP]` — the source proposal explicitly leaves
 * the minimum universal chunk shape open (executor.md §Open Question 1).
 * Initial shape inherits the v1 streaming.ts taxonomy structure.
 */
export interface ExecutorDelta {
  /** e.g., `content_delta`, `tool_call_delta`. */
  readonly kind: string;
  readonly blockIndex?: number;
  readonly delta?: string;
  /** Emitted when a full block crystallizes from prior deltas. */
  readonly block?: ContentBlock;
  readonly metadata?: Record<string, unknown>;
}
