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
 *   - `FakeLanguageModelExecutor` (in `@agentick/model-executor`; reference impl)
 *   - `@agentick/model-openai`, `-anthropic`, `-google`, `-ai-sdk`
 *     (Phase 4c — real provider adapters)
 *
 * The protocol exposes three logical phases — `project`, `execute`,
 * `normalize` — plus a convenience `run` that composes them with delta
 * emission, `abort`, and an optional `prepareRequest` that stops one step
 * short of sending (the provider-native request, for inspection). Implementations MAY collapse phases internally
 * for performance, but the **harness boundary preserves the phases as
 * observable events and interceptor seams**.
 *
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

import type { HarnessFx } from "./middleware.js";
import type { InstallerInterceptors } from "./app-extension.js";
import type { Effect } from "effect";
import type { ProviderOptions, ProviderToolOptions, RenderedTree } from "../data/rendered-tree.js";
import type { MediaSource } from "../data/content-blocks.js";
import type { ExecutionTarget, LanguageModelTarget } from "../data/execution-target.js";
import type {
  ExecutionResult,
  ExecutorError,
  ExecutorTerminal,
  LanguageModelExecutionResult,
} from "../data/execution-result.js";
import type { SubstrateError } from "../data/errors.js";
import type { ExecuteErrorChannel } from "../errors/harnesses.js";
import type { AdapterDelta } from "../data/streaming.js";
import type { PromiseView } from "./promise-view.js";
import type { AsyncStream } from "./async-stream.js";

// ============================================================================
// Error taxonomies for the per-phase commands
// ============================================================================

/**
 * Per-phase tagged-union errors. Each phase's E channel narrows to its
 * own slice. `run`'s E channel is the union — see `ExecutorError` in
 * `data/execution-result.ts`.
 */
/** Single-tag projection failure — migrated to a class (ADR 41). Local
 * alias form (mirrors {@link NormalizeError}) so the name is usable
 * in-file — a bare `export type { … as … }` re-export creates no local
 * binding. */
export type ProjectionError = import("../errors/harnesses.js").ProjectionFailed;

/** Migrated to class hierarchy (ADR 41). Re-exports from `../errors/harnesses.js`. */
export {
  ExecuteError,
  type ExecuteErrorChannel,
  NormalizationFailed,
  ProviderAborted,
  ProviderRejected,
  ProviderTimeout,
  StreamFailed,
} from "../errors/harnesses.js";

/** Legacy alias — single-tag union, retained for code that references `NormalizeError`. */
export type NormalizeError = import("../errors/harnesses.js").NormalizationFailed;

// ============================================================================
// Streaming surface — ExecutorStream returned by `executeStream`
// ============================================================================

/**
 * The executor's streaming handle — an instance of the singular streaming
 * edge {@link AsyncStream} (dual of `Promise<A>`). Items are provider
 * `AdapterDelta`s (content-delta tokens, content/message summaries,
 * tool-call deltas + summary, reasoning, usage, errors); the summary is
 * the final accumulated raw response (same shape `execute` returns).
 */
export type ExecutorStream<TOutput = unknown> = AsyncStream<AdapterDelta, TOutput>;

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
  /**
   * Tool declarations the model should see this tick. Canonical source
   * for the projected `tools` list. The loop sources this from
   * `ToolExecutorProtocol.compileForTick({ exposure: "model" })` —
   * the precedence-resolved unification of every layered declaration
   * seam (gateway/app/session/execution/extension/compiler).
   *
   * `compiled.declarations.tools` (the IR's record of tools emitted by
   * the compiler this tick) is NOT consulted by projection. The loop
   * syncs the compiler slice into the tool executor's registry via
   * `replaceCompilerTools` and then queries `compileForTick`, so the
   * resolved list passed here already includes compiler-emitted
   * tools with correct precedence.
   */
  readonly tools: readonly import("../data/declarations.js").ToolDeclaration[];
  /**
   * Provider-EXECUTED tools the model should see this tick (OpenAI
   * `web_search`, Anthropic `server_tool_use`, Google grounding). Sourced
   * by the loop from the compiled tree's
   * {@link import("../data/declarations.js").RuntimeDeclarations.providerTools}
   * (plus config), NOT from `compileForTick` — provider tools are not
   * executor citizens (no validation, no dispatch, no registry). The
   * projection maps them onto {@link LanguageModelInput.providerTools};
   * they NEVER enter the {@link tools} list and are never narrated.
   */
  readonly providerTools?: readonly import("../data/declarations.js").ProviderToolDeclaration[];
  /**
   * App-level model-narration switch (default `true` at the projection
   * site). When `true`, the projector injects the reserved
   * `TOOL_NARRATION_FIELD` (`_summary`) optional property into each
   * model-facing tool schema so the model can self-narrate a call. When
   * `false`, injection is skipped app-wide — the token-cost off-switch.
   * Per-tool `ToolAnnotations.narrate: false` opts a single tool out even
   * when this is on.
   */
  readonly narrate?: boolean;
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
  /**
   * Tool declarations the model should see this tick. See
   * {@link ProjectInput.tools} — `run` threads this through to its
   * internal `project` call.
   */
  readonly tools: readonly import("../data/declarations.js").ToolDeclaration[];
  /**
   * Provider-EXECUTED tools for this tick — threaded through to the
   * internal `project` call. See {@link ProjectInput.providerTools}.
   */
  readonly providerTools?: readonly import("../data/declarations.js").ProviderToolDeclaration[];
  /**
   * App-level model-narration switch — threaded through to the internal
   * `project` call. See {@link ProjectInput.narrate}.
   */
  readonly narrate?: boolean;
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
   * Provider-EXECUTED tools advertised to the model. Sourced from the
   * rendered tree's `declarations.providerTools` and projected verbatim
   * (no schema, no narration) to {@link ProviderToolWire}. Each shipped
   * adapter maps ONLY the subset whose `provider` matches its own key into
   * the provider's native tools array; the rest it ignores. Distinct from
   * {@link tools} (function tools): a provider tool carries no
   * `inputSchema` — the provider owns the tool's arguments — and never
   * flows through the tool executor.
   */
  readonly providerTools?: ReadonlyArray<ProviderToolWire>;
  /**
   * Generation parameters (temperature / max tokens / etc.) lifted from
   * the rendered tree's `config`. Provider-specific overrides flow via
   * `target.providerOptions`.
   */
  readonly parameters?: LanguageModelParameters;
  /**
   * Request-level provider escape hatch — the folded result of
   * `RenderedTree.providerOptions` **over** `ExecutionTarget.providerOptions`
   * (tree/per-render wins), computed at project time (#176). Mirrors the
   * `config` + `providerOptions` siblings on `RenderedTree`. Adapters read
   * this (merged over `target.providerOptions` defensively) for
   * thinking config, seed, safetySettings, cache_control, etc. Keep
   * `parameters` as pure canonical generation knobs — this is the
   * separate provider-specific dimension.
   */
  readonly providerOptions?: ProviderOptions;
}

/**
 * Provider-facing role vocabulary, plus the two AGENTICK-SEMANTIC roles the
 * canonical fold keeps intact for the adapter to lower: `grounding`
 * (non-conversational context) and `event` (a record of something that
 * happened). Every adapter maps those two to its own vocabulary at its own
 * boundary — OpenAI has `developer`, Anthropic and Google do not — and an
 * unrecognized role is an error there, never a coercion (ADR 94).
 */
export type LanguageModelMessageRole =
  | "system"
  | "user"
  | "assistant"
  | "tool"
  | "grounding"
  | "event";

export interface LanguageModelMessage {
  readonly role: LanguageModelMessageRole;
  readonly content: ReadonlyArray<LanguageModelMessagePart>;
  readonly toolCallId?: string;
  readonly name?: string;
  /**
   * Message-level provider knobs — the **input** channel (ADR 57 §2:
   * "what you send"). Carried from `MessageEntry.metadata.providerMetadata`
   * at projection (#173), mirroring how per-block `providerMetadata`
   * projects onto a part's `providerOptions`. Adapters map it where the
   * SDK has a message-level slot (AI SDK `ModelMessage.providerOptions`
   * is 1:1); providers without a message-level knob ignore it.
   */
  readonly providerOptions?: ProviderOptions;
  /**
   * Canonical prompt-cache hint carried from `MessageEntry.metadata.cache`
   * (#185). Normalize → translate → escape hatch: adapters translate to
   * their dialect (Anthropic `cache_control` on the message's last
   * block; providers with automatic prefix caching no-op); explicit
   * per-block `providerMetadata.<ns>` always wins over this hint.
   */
  readonly cache?: import("../data/content-blocks.js").CacheHint;
}

/**
 * Message content parts. Mirrors the shape provider adapters consume
 * internally. The full content-block taxonomy from the IR projects onto
 * this set at the executor boundary: **wire-native modalities**
 * (`text`/`image`/`document`/`audio`/`video`/`reasoning`/`tool_use`/
 * `tool_result`) get a first-class variant so adapters can emit the
 * provider's native structural representation; **textual blocks**
 * (`json`/`xml`/`csv`/`html`/`code`/`custom`/events) are flattened to
 * `text` by the format harness before reaching the executor (ADR 57
 * §Taxonomy).
 */
/**
 * Per-part provider metadata carrier — the **output** channel. Mirrors
 * {@link BaseContentBlock.providerMetadata}: what `normalize` writes back
 * from a provider response (returned cache/reasoning tokens,
 * `thoughtSignature` as returned, etc.). Keyed by provider namespace.
 *
 * The **input** channel is `providerOptions` (what you send). See the
 * per-variant fields below and ADR 57 §2 for the send/return split.
 */
export type ProviderMetadataBag = Record<string, Record<string, unknown>>;

/**
 * The provider-knob input/output split carried on every message part
 * (ADR 57 §2):
 *   - `providerOptions` — **what you send.** Adopter-stamped per-block
 *     knobs (Anthropic `cacheControl`) and model-produced opaque data
 *     replayed verbatim (Gemini `thoughtSignature`) both ride here on
 *     the input path. Typed/augmentable — same target/tree use.
 *   - `providerMetadata` — **what the provider returned.** Set by
 *     `normalize` on output parts. Keyed by provider namespace.
 */
export type LanguageModelMessagePart =
  | {
      readonly type: "text";
      readonly text: string;
      readonly providerOptions?: ProviderOptions;
      readonly providerMetadata?: ProviderMetadataBag;
      /** Canonical cache hint for THIS part (per-section system boundaries, #185). */
      readonly cache?: import("../data/content-blocks.js").CacheHint;
    }
  | {
      /**
       * Wire-native image. Carries a {@link MediaSource}, for the same reason
       * `document` / `audio` / `video` below do.
       *
       * This was `imageUrl: string` — the lossy pre-flattening the next member's
       * docblock warns against — and it was the ONLY member that still did it.
       * The cost was not theoretical:
       *
       *   - A `MediaSource` that has no string form could not survive the trip. A
       *     `reference` (an adopter's own file id) was flattened to the bare id and
       *     handed to providers as a URL; Vertex answered "the fileUri parameter must
       *     be a Cloud Storage or HTTP(S) URI but the entered value was
       *     '019faa2c-…'". The information was destroyed before any adapter — or any
       *     amount of provider knowledge — could have helped.
       *   - Adapters re-parsed the string back into a `MediaSource` to project it
       *     (`imageSourceFromUrl` in the Anthropic adapter). A structured value
       *     stringified and then reverse-engineered, losing exactly the cases that
       *     have no lexical form.
       *
       * It survived because two of four providers happen to want a URL string on the
       * wire, so the flattening looked free until a source type appeared that has no
       * string form.
       */
      readonly type: "image";
      readonly source: MediaSource;
      readonly mediaType?: string;
      readonly providerOptions?: ProviderOptions;
      readonly providerMetadata?: ProviderMetadataBag;
    }
  | {
      /**
       * Wire-native document (PDF etc.). Carries a {@link MediaSource}
       * so adapters project to their wire form (base64 / url / file-id)
       * without lossy pre-flattening.
       */
      readonly type: "document";
      readonly source: MediaSource;
      readonly mediaType?: string;
      readonly providerOptions?: ProviderOptions;
      readonly providerMetadata?: ProviderMetadataBag;
    }
  | {
      /** Wire-native audio (OpenAI `input_audio` / Gemini audio). */
      readonly type: "audio";
      readonly source: MediaSource;
      readonly mediaType?: string;
      readonly providerOptions?: ProviderOptions;
      readonly providerMetadata?: ProviderMetadataBag;
    }
  | {
      /** Wire-native video (Gemini). */
      readonly type: "video";
      readonly source: MediaSource;
      readonly mediaType?: string;
      readonly providerOptions?: ProviderOptions;
      readonly providerMetadata?: ProviderMetadataBag;
    }
  | {
      /**
       * Signed reasoning / thinking that must round-trip verbatim
       * (Anthropic extended thinking + tool use). `signature` is the
       * provider-supplied signature; `data` carries the opaque payload
       * of a redacted reasoning block.
       */
      readonly type: "reasoning";
      readonly text: string;
      readonly signature?: string;
      readonly data?: unknown;
      readonly providerOptions?: ProviderOptions;
      readonly providerMetadata?: ProviderMetadataBag;
    }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
      readonly providerOptions?: ProviderOptions;
      readonly providerMetadata?: ProviderMetadataBag;
    }
  | {
      readonly type: "tool_result";
      readonly toolUseId: string;
      readonly content: ReadonlyArray<LanguageModelMessagePart>;
      readonly isError?: boolean;
      readonly providerOptions?: ProviderOptions;
      readonly providerMetadata?: ProviderMetadataBag;
    };

export interface LanguageModelTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  /**
   * Optional structured-output JSON Schema. Mirrors
   * {@link ToolDeclaration.outputSchema} after wire-projection
   * (`toJsonSchema()` applied). Adapters that support structured tool
   * outputs (e.g. OpenAI Responses API `output_format`, Anthropic
   * structured tools) project this into the provider's tool shape;
   * providers without first-class structured-output support ignore it.
   */
  readonly outputSchema?: Record<string, unknown>;
  /**
   * Per-tool provider-specific options. Reads from
   * {@link ToolDeclaration.providerOptions} during projection. Adapters
   * merge into the provider's tool shape (e.g. OpenAI `strict: true`
   * for JSON-schema mode, Anthropic `cache_control` on a specific tool).
   */
  readonly providerOptions?: ProviderToolOptions;
}

/**
 * Wire projection of a
 * {@link import("../data/declarations.js").ProviderToolDeclaration} — a
 * provider-EXECUTED tool as it appears on {@link LanguageModelInput}. The
 * projection resolves `name: name ?? type` and dedupes by `provider` +
 * `name`; adapters read this array and map the subset matching their own
 * `provider` key into the provider's native tools shape, ignoring the rest.
 *
 * Deliberately NOT a variant of {@link LanguageModelTool}: a provider tool
 * carries no `inputSchema` (the provider owns the arguments), no
 * `outputSchema`, and no `_summary` narration — it is a provider-request
 * declaration, not a dispatchable function. Its result returns on the model
 * response as a `tool_result` block stamped `executedBy: "provider:<key>"`.
 */
export interface ProviderToolWire {
  /** Routing key — the adapter that owns this tool (`"openai"`, …). */
  readonly provider: string;
  /** The provider-native tool type, verbatim (`"web_search_preview"`, …). */
  readonly type: string;
  /** Resolved framework id + model-visible name (`name ?? type`). */
  readonly name: string;
  /** Provider-native config, passed through verbatim into the tool shape. */
  readonly config?: Record<string, unknown>;
}

/**
 * Canonical tool-choice knob — how the model MUST treat the tool set on
 * this request. One normalized value, set once; every adapter TRANSLATES
 * it into its provider dialect under the normalize-translate-escape-hatch
 * rule: the canonical value is mapped by each adapter, and the provider
 * escape hatch (`providerOptions.<ns>`) spreads LAST so a provider-specific
 * override always wins.
 *
 * - `"auto"` — model decides whether to call a tool (the provider default).
 * - `"none"` — model MUST NOT call a tool this tick.
 * - `"required"` — model MUST call at least one tool (any of them).
 * - `{ tool }` — model MUST call THIS tool, named by framework tool name
 *   (a forced single call).
 *
 * The multi-tool restriction some providers support (e.g. Google's plural
 * `allowedFunctionNames`) is deliberately NOT part of the canonical form —
 * reach for `providerOptions.<ns>` for that.
 */
export type LanguageModelToolChoice = "auto" | "none" | "required" | { readonly tool: string };

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
  /**
   * Canonical tool-choice directive — see {@link LanguageModelToolChoice}.
   * Normalized once here; each adapter translates it to its dialect before
   * spreading `providerOptions` (so provider overrides still win).
   */
  readonly toolChoice?: LanguageModelToolChoice;
}

// ============================================================================
// ExecutorProtocol
// ============================================================================

/**
 * Methods every executor implementation MUST provide. All return
 * `Promise<T>` at the public surface (matching the other harness
 * protocols — `CompilerProtocol`, `ToolExecutorProtocol` — so the
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
/**
 * The executor's **canonical** composable surface: the Effect twins of
 * its operations (ADR 77, the dual-typed edge). An in-process caller —
 * the loop executor composing a tick — reaches these via `executor.fx`
 * to stay in one fiber tree (`yield* executor.fx.run(...)`); the plain
 * Promise methods on {@link ExecutorProtocol} are the derived edge facade
 * ({@link PromiseView} of this), `runHarnessProtocol` at the boundary.
 *
 * Unlike a command-declaring harness (knobs), the executor's `run` is not
 * a registry command — it builds its Operation inline. So `.fx` is NOT
 * `fxProxy`-derived; the concrete harness hand-exposes the very Effect its
 * `run` already builds (`runOperation(op, body)`), un-run.
 *
 * SCOPE: `run` only for now — the composition unit the loop's non-stream
 * path consumes. `project` / `execute` / `normalize` / `abort` and the
 * streaming `executeStream` twin migrate here as Stage 3 composes them;
 * the streaming twin (Effect `Stream` vs `Effect<ExecutorStream>`) is a
 * deliberate Stage-3 decision, made where the loop's delta consumption is
 * known. See TODO(stage-2) on the harness.
 */
export interface ExecutorFx<
  TInput = unknown,
  TOutput = unknown,
  TResult extends ExecutionResult = ExecutionResult,
> extends HarnessFx {
  /**
   * Convenience: project → execute → normalize, with delta events
   * emitted throughout. Returns an `ExecutorTerminal` envelope (typed
   * outcome). The loop executor uses this on the non-streaming path.
   *
   * Successful terminals (`outcome: "succeeded"`) succeed the Effect.
   * Non-success terminals (`canceled`, `vetoed`, `replaced`) also
   * succeed — they're the operation's legitimate outcomes. Only
   * substrate/executor failures inhabit the `E` channel.
   */
  run(
    input: RunInput,
  ): Effect.Effect<ExecutorTerminal<TResult>, ExecutorError | SubstrateError, never>;

  /**
   * IR → target input projection (the first execution phase). Pure —
   * deterministic for the same inputs. Composes in the loop's fiber on
   * the STREAMING path, where `run` is not used (the loop splits
   * project → executeStream → normalize so it can forward deltas).
   *
   * @throws {ProjectionError} on the `E` channel.
   */
  project(input: ProjectInput): Effect.Effect<TInput, ProjectionError | SubstrateError, never>;

  /**
   * Target output → canonical `ExecutionResult` (the final execution
   * phase). Deterministic. The streaming path's terminal step after the
   * sink-fold `executeStream` returns the accumulated raw output.
   *
   * @throws {NormalizeError} on the `E` channel.
   */
  normalize(
    input: NormalizeInput<TOutput>,
  ): Effect.Effect<TResult, NormalizeError | SubstrateError, never>;

  /**
   * The streaming-edge canonical form (sink-fold): drives the provider
   * once, invoking `sink` per emitted `AdapterDelta`, and succeeds with
   * the final accumulated raw output. Composes in the loop's fiber —
   * `yield* executor.fx.executeStream(input, (d) => Effect.sync(...))` —
   * with no queue/fork; that machinery lives only in the JS facade's
   * bridge ({@link AsyncStream} / `runHarnessStream`).
   *
   * NOT `PromiseView`-derivable: the facade
   * ({@link ExecutorProtocol.executeStream}) has a different arity
   * (`(input): ExecutorStream`, no sink) — the two surfaces share the
   * bridge implementation, not a mapped type. Hand-declared on both.
   */
  executeStream(
    input: ExecuteInput<TInput>,
    sink: (delta: AdapterDelta) => Effect.Effect<void>,
  ): Effect.Effect<TOutput, ExecuteErrorChannel | SubstrateError, never>;
}

export interface ExecutorProtocol<
  TInput = unknown,
  TOutput = unknown,
  TResult extends ExecutionResult = ExecutionResult,
> extends PromiseView<Pick<ExecutorFx<TInput, TOutput, TResult>, "run" | "project" | "normalize">> {
  /**
   * The Effect-canonical composable surface (ADR 77, the dual-typed edge)
   * — the twins the spine composes in-fiber (`yield* executor.fx.run(...)`).
   * On the protocol so a protocol-typed ref (e.g. the loop's
   * `RunExecutionInput.modelExecutor`) can compose without severing the fiber
   * at the Promise facade.
   */
  readonly fx: ExecutorFx<TInput, TOutput, TResult>;

  /**
   * Resolves when the executor's substrate is initialized and the
   * executor is ready to accept calls. Mirrors the `.ready` shape on
   * every other v2 harness (`gateway.ready`, `app.ready`, etc.). Callers
   * MUST await this before invoking `project` / `execute` / `executeStream`
   * — `BaseHarness` guarantees `ready` resolves before substrate
   * operations are safe.
   */
  readonly ready: Promise<void>;

  // `project` is derived from `PromiseView<ExecutorFx>` — the Promise
  // facade of the Effect-canonical {@link ExecutorFx.project} twin.

  /**
   * **Optional.** The projected input → the PROVIDER-NATIVE request, without
   * sending it. Pure, synchronous, and the last artifact that exists before
   * bytes leave the process — so this is what you inspect to answer "what did
   * we actually ask the provider for".
   *
   * ```ts
   * const tree    = await compiler.renderTree({ mountId });
   * const input   = await executor.project({ compiled: tree, target, tools });
   * const request = executor.prepareRequest?.({ targetInput: input, target });
   * ```
   *
   * **Two honest caveats.**
   *
   * 1. It is the request BEFORE the `model:provider-request` command runs, so
   *    an `onBeforeModelProviderRequest` hook that rewrites the native request
   *    has not been applied. What ships can differ from what this returns;
   *    everything up to the hook is identical.
   * 2. Absent on an executor with no provider adapter behind it — a fake, a
   *    replay executor, a scripted double. Feature-detect rather than assume.
   *
   * Nothing is sent, nothing is journaled, and no timeline entry is written.
   */
  prepareRequest?(input: ExecuteInput<TInput>): unknown;

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

  // `normalize` is derived from `PromiseView<ExecutorFx>` — the Promise
  // facade of the Effect-canonical {@link ExecutorFx.normalize} twin.

  // `run` is derived from `PromiseView<ExecutorFx>` — the Promise facade of
  // the Effect-canonical {@link ExecutorFx.run} twin. The concrete harness
  // exposes the canonical Effect surface as `executor.fx`.

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
 * `@agentick/model-executor`; provider adapters in Phase 4c.
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
 *
 */
export interface ExecutorFactoryDeps {
  /**
   * The host's interceptor cascade, in the SAME nested shape a
   * {@link InstallerInterceptors} handle takes — so `inheritedFrom(deps)` from
   * `@agentick/runtime` spreads it straight into your harness options.
   *
   * Absent before this existed, which meant a factory-built executor received
   * no app hooks, no guards, and no telemetry enrichment — silently, since the
   * executor still worked.
   */
  readonly interceptors?: InstallerInterceptors;
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
