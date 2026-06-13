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
 *   - `FakeLanguageModelExecutor` (in `@agentick/executor-next`; reference impl)
 *   - `@agentick/executor-openai-next`, `-anthropic`, `-google`, `-ai-sdk`
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

import type { ProviderToolOptions, RenderedTree } from "../data/rendered-tree.js";
import type { ExecutionTarget, LanguageModelTarget } from "../data/execution-target.js";
import type {
  ExecutionResult,
  ExecutorTerminal,
  LanguageModelExecutionResult,
} from "../data/execution-result.js";
import type { AdapterDelta } from "../data/streaming.js";

// ============================================================================
// Error taxonomies for the per-phase commands
// ============================================================================

/**
 * Per-phase tagged-union errors. Each phase's E channel narrows to its
 * own slice. `run`'s E channel is the union — see `ExecutorError` in
 * `data/execution-result.ts`.
 */
export type ProjectionError = {
  readonly _tag: "ProjectionFailed";
  readonly reason: string;
  readonly cause?: unknown;
};

export type ExecuteError =
  | { readonly _tag: "ProviderRejected"; readonly status?: number; readonly cause?: unknown }
  | { readonly _tag: "ProviderTimeout"; readonly timeoutMs: number }
  | { readonly _tag: "ProviderAborted"; readonly reason?: string }
  | { readonly _tag: "StreamFailed"; readonly cause: unknown };

export type NormalizeError = { readonly _tag: "NormalizationFailed"; readonly cause: unknown };

// ============================================================================
// Streaming surface — ExecutorStream returned by `executeStream`
// ============================================================================

/**
 * Dual-shape handle returned by {@link ExecutorProtocol.executeStream}.
 *
 *   - As `AsyncIterable<AdapterDelta>`: consumers iterate provider
 *     emissions in real time (content-delta tokens, content/message
 *     summaries, tool-call deltas + summary, reasoning, usage, errors).
 *   - As `{ result: Promise<TOutput> }`: consumers await the final
 *     accumulated raw response (same shape `execute` returns).
 *
 * Both shapes derive from the same underlying provider call — iterating
 * the deltas does not change the final result; awaiting `.result` does
 * not consume deltas for other iterators (where the underlying impl
 * supports multi-subscribe — the reference impls expect single-iterator
 * consumption).
 *
 * `abort` cancels the in-flight provider request. Subsequent iterations
 * MAY yield a final `error` delta before the iterator completes.
 */
export interface ExecutorStream<TOutput = unknown> extends AsyncIterable<AdapterDelta> {
  /** Final accumulated raw response — the same shape `execute` would return. */
  readonly result: Promise<TOutput>;
  /** Abort the in-flight stream. Best-effort — provider may have already produced output. */
  abort(reason?: string): void;
}

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
/**
 * Per-part provider metadata carrier. Mirrors
 * {@link BaseContentBlock.providerMetadata} on the executor boundary so
 * round-trip data (Gemini 3+ `thoughtSignature`, Anthropic
 * `cache_control` on a specific block, OpenAI logprobs reference, etc.)
 * survives projection. Keyed by provider namespace.
 */
export type ProviderMetadataBag = Record<string, Record<string, unknown>>;

export type LanguageModelMessagePart =
  | {
      readonly type: "text";
      readonly text: string;
      readonly providerMetadata?: ProviderMetadataBag;
    }
  | {
      readonly type: "image";
      readonly imageUrl: string;
      readonly mediaType?: string;
      readonly providerMetadata?: ProviderMetadataBag;
    }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
      readonly providerMetadata?: ProviderMetadataBag;
    }
  | {
      readonly type: "tool_result";
      readonly toolUseId: string;
      readonly content: ReadonlyArray<LanguageModelMessagePart>;
      readonly isError?: boolean;
      readonly providerMetadata?: ProviderMetadataBag;
    };

export interface LanguageModelTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  /**
   * Per-tool provider-specific options. Reads from
   * {@link ToolDeclaration.providerOptions} during projection. Adapters
   * merge into the provider's tool shape (e.g. OpenAI `strict: true`
   * for JSON-schema mode, Anthropic `cache_control` on a specific tool).
   */
  readonly providerOptions?: ProviderToolOptions;
}

export interface LanguageModelParameters {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly topP?: number;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
  readonly stopSequences?: ReadonlyArray<string>;
  readonly responseFormat?: {
    readonly type: "text" | "json" | "json_schema";
    readonly name?: string;
    readonly schema?: Record<string, unknown>;
  };
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
   * Resolves when the executor's substrate is initialized and the
   * executor is ready to accept calls. Mirrors the `.ready` shape on
   * every other v2 harness (`gateway.ready`, `app.ready`, etc.). Callers
   * MUST await this before invoking `project` / `execute` / `executeStream`
   * — `BaseHarness` guarantees `ready` resolves before substrate
   * operations are safe.
   */
  readonly ready: Promise<void>;

  /**
   * IR → target input projection. Pure (deterministic for the same
   * inputs). The first phase of an execution.
   *
   * @throws {ProjectionError}
   */
  project(input: ProjectInput): Promise<TInput>;

  /**
   * Target/provider request execution. Returns the final accumulated
   * raw response as a Promise. Streaming-capable implementations MAY
   * still emit `executor:delta` envelopes through the harness's
   * `emitDelta` for observability — but the typed streaming surface
   * for consumers that want chunk-by-chunk access is {@link executeStream}.
   *
   * @throws {ExecuteError}
   */
  execute(input: ExecuteInput<TInput>): Promise<TOutput>;

  /**
   * **Optional** streaming surface. When present and the target's
   * `capabilities.supportsStreaming` is true, the loop executor
   * prefers this over {@link execute} so consumers can receive
   * `AdapterDelta`s as the provider emits them.
   *
   * Returns an `ExecutorStream<TOutput>` — an `AsyncIterable<AdapterDelta>`
   * that ALSO exposes `.result: Promise<TOutput>` for callers that just
   * want the final assembled output. Both shapes derive from the same
   * underlying provider call.
   *
   * Adopters writing a custom executor for a non-streaming provider
   * (or who want streaming-disabled) simply omit this method —
   * `execute` continues to satisfy the protocol.
   *
   * @throws {ExecuteError} as Promise rejection on `.result`
   */
  executeStream?(input: ExecuteInput<TInput>): ExecutorStream<TOutput>;

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
 * shipped reference impl is `FakeLanguageModelExecutor` in
 * `@agentick/executor-next`; provider adapters in Phase 4c.
 */
export interface LanguageModelExecutor extends ExecutorProtocol<
  LanguageModelInput,
  unknown,
  LanguageModelExecutionResult
> {
  /** Type-narrowed for documentation; not load-bearing structurally. */
  readonly family: "language-model";

  /**
   * Self-described execution target. The executor knows its own
   * provider + modelId + capabilities — this property is read by the
   * app/session/loop so callers don't have to declare the target
   * redundantly at every layer. Per-call overrides still flow via
   * `RunInput.target` / `SendInput.target`.
   */
  readonly target: ExecutionTarget;
}

// ============================================================================
// ExecutorFactory — deferred construction with shared substrate
// ============================================================================

/**
 * Substrate dependencies a `LanguageModelExecutor` is constructed with.
 * Mirrors the args every `BaseHarness` subclass takes.
 */
export interface ExecutorFactoryDeps {
  readonly scopeId: string;
  readonly journal: import("./journal.js").OperationJournal;
  readonly bus: import("./bus.js").EventBus;
  readonly inbox: import("./inbox.js").MessageInbox;
}

/**
 * Deferred-construction form of `LanguageModelExecutor`. Parent harnesses
 * (typically `AppHarness`) call this factory at construction time with
 * their own substrate, so the executor's events appear on the
 * shared journal/bus instead of a private one. Closes the
 * `app.events()` observability gap by default.
 *
 * Marker symbol `executorFactory` disambiguates a factory from a
 * pre-constructed instance (which exposes `run`, `project`, etc.). The
 * runtime checks for the marker before the function call.
 */
export interface ExecutorFactory {
  readonly executorFactory: true;
  /**
   * Construct a `LanguageModelExecutor`. When invoked by a parent
   * harness (`AppHarness`), `deps` is supplied so the executor shares
   * the parent's substrate. When invoked standalone (tests, embedded
   * use), `deps` is omitted and the factory falls back to either
   * option-provided substrate or a freshly-constructed in-process
   * substrate. Every shipped factory (`openai`, `anthropic`, `google`,
   * `aiSdk`) honors this contract.
   */
  (deps?: ExecutorFactoryDeps): LanguageModelExecutor;
}

/** Type guard: distinguishes a factory from a constructed executor. */
export function isExecutorFactory(v: unknown): v is ExecutorFactory {
  return typeof v === "function" && (v as { executorFactory?: unknown }).executorFactory === true;
}

// Re-export the executable target alias for ergonomic imports.
export type { LanguageModelTarget };
