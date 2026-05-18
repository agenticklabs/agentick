/**
 * ExecutorProtocol — the target-family-aware boundary that turns the
 * `RenderedTree` IR into a target system call and the target's output
 * back into a normalized `ExecutionResult`.
 *
 * In v2, "executor" is a **protocol family**. The shipped v2 family is
 * `LanguageModelExecutor` (model calls); future families (image generation,
 * audio, retrieval) implement the same protocol against different targets.
 *
 * Implementations:
 *   - `MockLanguageModelExecutor` (in `@agentick/executor`; reference impl)
 *   - `@agentick/executor-openai`, `-anthropic`, `-google`, `-ai-sdk`
 *     (Phase 4c — real provider adapters)
 *
 * The protocol exposes three logical phases — `project`, `execute`,
 * `normalize` — plus a convenience `run` that composes them with delta
 * emission, plus `abort`. Implementations MAY collapse phases internally
 * for performance, but the **harness boundary preserves the phases as
 * observable events and interceptor seams**.
 *
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

import type { RenderedTree } from "../data/rendered-tree.js";
import type {
  ExecutionTarget,
  LanguageModelTarget,
} from "../data/execution-target.js";
import type {
  ExecutionResult,
  ExecutorError,
  ExecutorTerminal,
  LanguageModelExecutionResult,
} from "../data/execution-result.js";

// ============================================================================
// Error taxonomies for the per-phase commands
// ============================================================================

/**
 * Per-phase tagged-union errors. Each phase's E channel narrows to its
 * own slice. `run`'s E channel is the union — see `ExecutorError` in
 * `data/execution-result.ts`.
 */
export type ProjectionError =
  | { readonly _tag: "ProjectionFailed"; readonly reason: string; readonly cause?: unknown };

export type ExecuteError =
  | { readonly _tag: "ProviderRejected"; readonly status?: number; readonly cause?: unknown }
  | { readonly _tag: "ProviderTimeout"; readonly timeoutMs: number }
  | { readonly _tag: "ProviderAborted"; readonly reason?: string }
  | { readonly _tag: "StreamFailed"; readonly cause: unknown };

export type NormalizeError =
  | { readonly _tag: "NormalizationFailed"; readonly cause: unknown };

// ============================================================================
// Command inputs
// ============================================================================

/**
 * Per-execution scope identity. Same shape as the substrate's
 * `EventScope` slots that the executor harness's `runOperation` will
 * thread into the FiberRef context.
 */
export interface ExecutionScope {
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly tickId?: string;
  readonly opId?: string;
  readonly parentOpId?: string;
  readonly correlationId?: string;
}

export interface ProjectInput {
  readonly compiled: RenderedTree;
  readonly target: ExecutionTarget;
  readonly scope?: ExecutionScope;
}

export interface ExecuteInput<TInput = unknown> {
  readonly targetInput: TInput;
  readonly target: ExecutionTarget;
  readonly scope?: ExecutionScope;
  /**
   * Optional caller-supplied abort signal. The substrate also wires
   * fiber-interrupt — implementations SHOULD respect both.
   */
  readonly signal?: AbortSignal;
}

export interface NormalizeInput<TOutput = unknown> {
  readonly targetOutput: TOutput;
  readonly target: ExecutionTarget;
  readonly scope?: ExecutionScope;
}

export interface RunInput {
  readonly compiled: RenderedTree;
  readonly target: ExecutionTarget;
  readonly scope?: ExecutionScope;
  readonly signal?: AbortSignal;
}

export interface AbortExecutorInput {
  readonly executionId: string;
  readonly reason?: string;
}

// ============================================================================
// LanguageModelInput — the v2-shipped family's projected input shape
// ============================================================================

/**
 * Wire-safe projection target for `LanguageModelExecutor`. Provider
 * adapters convert this into their wire format (OpenAI Chat Completions
 * request body, Anthropic Messages request body, etc.). The shape is
 * intentionally provider-agnostic — only fields that every shipped
 * provider supports appear here.
 *
 * Provider-specific knobs (caching, reasoning effort, tool-call modes)
 * pass through `ExecutionTarget.providerOptions[providerKey]`.
 */
export interface LanguageModelInput {
  /**
   * Canonical ordered messages. The executor's `project` phase folds
   * the rendered tree's `context.entries` plus the formatted-system
   * text into this list.
   */
  readonly messages: ReadonlyArray<LanguageModelMessage>;
  /**
   * Tools advertised to the model. Sourced from the rendered tree's
   * `declarations.tools`, filtered to `exposure.includes("model")`.
   */
  readonly tools?: ReadonlyArray<LanguageModelTool>;
  /**
   * Generation parameters (temperature / max tokens / etc.) lifted from
   * the rendered tree's `config`. Provider-specific overrides flow via
   * `target.providerOptions`.
   */
  readonly parameters?: LanguageModelParameters;
}

export interface LanguageModelMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: ReadonlyArray<LanguageModelMessagePart>;
  readonly toolCallId?: string;
  readonly name?: string;
}

/**
 * Message content parts. Mirrors the shape provider adapters consume
 * internally — text, images, tool calls. The full content-block
 * taxonomy from the IR collapses to this smaller set at the executor
 * boundary; richer types (csv, html, json) flatten to text by the
 * format harness before reaching the executor.
 */
export type LanguageModelMessagePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly imageUrl: string; readonly mediaType?: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: "tool_result"; readonly toolUseId: string; readonly content: ReadonlyArray<LanguageModelMessagePart>; readonly isError?: boolean };

export interface LanguageModelTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface LanguageModelParameters {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly stopSequences?: ReadonlyArray<string>;
  readonly responseFormat?: { readonly type: "text" | "json" | "json_schema"; readonly schema?: Record<string, unknown> };
}

// ============================================================================
// ExecutorProtocol
// ============================================================================

/**
 * Methods every executor implementation MUST provide. All return
 * `Promise<T>` at the public surface (matching the other harness
 * protocols — `ReconcilerProtocol`, `ToolExecutorProtocol` — so the
 * loop executor / session harness can compose them ergonomically).
 * Concrete impls wrap their bodies in `Effect.runPromise` via
 * `runHarnessProtocol` so the substrate's FiberRef scope, OTel spans,
 * and `Effect.scoped` finalizers apply to the internal command flow.
 *
 * Errors propagate as Promise rejections with tagged-union values
 * matching the per-phase types — `ProjectionError`, `ExecuteError`,
 * `NormalizeError`. `run` rejects with the union `ExecutorError`.
 *
 * Type parameters are generic over family-specific input/output/result
 * shapes — `LanguageModelExecutor` narrows them.
 */
export interface ExecutorProtocol<
  TInput = unknown,
  TOutput = unknown,
  TResult extends ExecutionResult = ExecutionResult,
> {
  /**
   * IR → target input projection. Pure (deterministic for the same
   * inputs). The first phase of an execution.
   *
   * @throws {ProjectionError}
   */
  project(input: ProjectInput): Promise<TInput>;

  /**
   * Target/provider request execution. May stream — implementations
   * emit `executor:delta` envelopes through the harness's `emitDelta`
   * for each chunk. The returned `TOutput` is the accumulated raw
   * response (kept opaque to consumers other than `normalize`).
   *
   * @throws {ExecuteError}
   */
  execute(input: ExecuteInput<TInput>): Promise<TOutput>;

  /**
   * Target output → canonical `ExecutionResult`. Deterministic.
   *
   * @throws {NormalizeError}
   */
  normalize(input: NormalizeInput<TOutput>): Promise<TResult>;

  /**
   * Convenience: project → execute → normalize, with delta events
   * emitted throughout. Returns an `ExecutorTerminal` envelope (typed
   * outcome). The loop executor (Phase 4d) uses this.
   *
   * Successful terminals (`outcome: "succeeded"`) resolve the Promise.
   * Non-success terminals (`canceled`, `vetoed`, `replaced`) also
   * resolve — they're the operation's legitimate outcomes. Only
   * substrate-level failures (`ExecutorError`) reject.
   *
   * @throws {ExecutorError}
   */
  run(input: RunInput): Promise<ExecutorTerminal<TResult>>;

  /**
   * Abort the in-flight execution identified by `executionId`. No-op
   * for unknown ids. Subsequent `run` calls with the same id MUST
   * fail with `ProviderAborted`.
   */
  abort(input: AbortExecutorInput): Promise<void>;
}

// ============================================================================
// LanguageModelExecutor — the v2 shipped family
// ============================================================================

/**
 * `ExecutorProtocol` narrowed to the language-model family. The
 * shipped reference impl is `MockLanguageModelExecutor` in
 * `@agentick/executor`; provider adapters in Phase 4c.
 */
export interface LanguageModelExecutor
  extends ExecutorProtocol<
    LanguageModelInput,
    unknown,
    LanguageModelExecutionResult
  > {
  /** Type-narrowed for documentation; not load-bearing structurally. */
  readonly family: "language-model";
}

// Re-export the executable target alias for ergonomic imports.
export type { LanguageModelTarget };
