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
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** Anthropic extended thinking, OpenAI o1, etc. */
  readonly reasoningTokens?: number;
  /** Anthropic prompt-caching reads. */
  readonly cachedInputTokens?: number;
  /** Anthropic prompt-caching writes. */
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
