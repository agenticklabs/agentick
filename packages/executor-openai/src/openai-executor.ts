/**
 * `OpenAIExecutor` — `LanguageModelExecutor` backed by the OpenAI Chat
 * Completions API. The first real provider adapter for v2 (Phase 4c).
 *
 * Inherits `BaseHarness<"executor">` for the substrate phase contract,
 * FiberRef-bound scope, OTel spans, and lazy delta emission. Translates
 * `LanguageModelInput` ↔ `ChatCompletionCreateParams` ↔
 * `LanguageModelExecutionResult` at the harness boundary.
 *
 * Behavior:
 *   - `project()` is identical in shape to `MockLanguageModelExecutor` —
 *     folds rendered tree → canonical `LanguageModelInput`. Provider
 *     specifics happen later (inside `execute`).
 *   - `execute()` converts to OpenAI params, calls the SDK, returns the
 *     raw `ChatCompletion` (non-streaming) or accumulates chunks
 *     (streaming).
 *   - `normalize()` parses `ChatCompletion` → `LanguageModelExecutionResult`
 *     with stop-reason mapping and `toolCalls` extraction.
 *   - `run()` composes project → execute → normalize, with `executor:delta`
 *     envelopes emitted per streaming chunk via `emitDeltaLazy`.
 *   - `abort()` cancels in-flight requests through an internal
 *     `AbortController` registry.
 *
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

import { Effect } from "effect";
import { OpenAI, type ClientOptions } from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { BaseHarness, runHarnessProtocol, ulid } from "@agentick/runtime";
import type {
  AbortExecutorInput,
  AdapterDelta,
  ContentBlock,
  ContextEntry,
  EventBus,
  ExecuteError,
  ExecuteInput,
  ExecutionTarget,
  ExecutorError,
  ExecutorStream,
  ExecutorTerminal,
  LanguageModelExecutionResult,
  LanguageModelExecutor,
  LanguageModelInput,
  LanguageModelMessage,
  LanguageModelMessagePart,
  LanguageModelStopReason,
  LanguageModelTool,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  NormalizeError,
  NormalizeInput,
  Operation,
  OperationJournal,
  ProjectInput,
  ProjectionError,
  RenderedTree,
  RunInput,
  SectionEntry,
  ToolCall,
  ToolDeclaration,
  UsageStats,
} from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";

import { ThinkTagSplitter, splitThinkTags } from "./think-tag-splitter.js";

// ============================================================================
// ProviderOptions augmentation — typed OpenAI escape hatch
// ============================================================================

/**
 * Contribute the typed `openai` slot to `@agentick/spec`'s
 * {@link ProviderOptions}. Importing this package brings these
 * field types into scope at every `ExecutionTarget.providerOptions`
 * site. Same pattern as `HookBridges` augmentation (ADR 26/27).
 *
 * Fields mirror OpenAI's Chat Completions request body — adopters
 * can set provider-specific knobs without us hardcoding them in spec.
 */
declare module "@agentick/spec" {
  interface ProviderOptions {
    readonly openai?: {
      readonly seed?: number;
      readonly logprobs?: boolean;
      readonly top_logprobs?: number;
      readonly store?: boolean;
      readonly n?: number;
      readonly user?: string;
      readonly metadata?: Record<string, string>;
      readonly parallel_tool_calls?: boolean;
      readonly service_tier?: "auto" | "default" | "flex" | "priority" | (string & {});
      readonly prediction?: {
        readonly type: "content";
        readonly content: string | ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
      };
      readonly reasoning_effort?: "minimal" | "low" | "medium" | "high" | (string & {});
      readonly modalities?: ReadonlyArray<"text" | "audio">;
      readonly web_search_options?: Record<string, unknown>;
      readonly [key: string]: unknown;
    };
  }
}

// ============================================================================
// Construction options
// ============================================================================

export interface OpenAIExecutorOptions {
  /** Default model id (e.g. `"gpt-4o"`). May be overridden per execution. */
  readonly model?: string;
  /** OpenAI API key. Falls back to `OPENAI_API_KEY` env var. */
  readonly apiKey?: string;
  /** Custom base URL (e.g. for LM Studio, vLLM, ollama). */
  readonly baseURL?: string;
  /** OpenAI organization id. */
  readonly organization?: string;
  /** Default headers sent with every request. */
  readonly headers?: Record<string, string>;
  /** Per-request timeout, ms. */
  readonly timeout?: number;
  /** Max retries on transient failures (SDK default: 2). */
  readonly maxRetries?: number;
  /**
   * Inject a pre-built `OpenAI` client. Useful for tests (stub the SDK)
   * and for advanced setups (custom dispatcher, mTLS, etc.). When set,
   * `apiKey` / `baseURL` / `headers` are ignored.
   */
  readonly client?: OpenAI;
  /**
   * Stream every `execute()`. When false (default), uses non-streaming
   * completions and delta envelopes are not emitted. When true, every
   * call streams and per-chunk `executor:delta` envelopes are emitted
   * via `emitDeltaLazy`.
   */
  readonly stream?: boolean;
  /**
   * Parse inline `<think>...</think>` tags from `delta.content` and
   * route them as reasoning deltas. For OpenAI-compatible servers
   * (LM Studio, ollama, some quantized local models) that don't
   * extract reasoning server-side and instead emit raw tags in the
   * content channel. Defaults to `false` — adopters whose server
   * exposes reasoning via the standard `reasoning_content` /
   * `reasoning` fields (vLLM, LM Studio recent builds) get reasoning
   * extraction automatically via {@link mapChunkToAdapterDeltas}
   * without enabling this option.
   */
  readonly parseThinkTags?: boolean;
  /**
   * Override the self-described target. Defaults to
   * `{ kind: "language-model", provider: "openai", modelId: options.model ?? "gpt-4o-mini", capabilities: {...} }`.
   * Set this when surfacing a non-stock OpenAI-compatible endpoint
   * (vLLM, LM Studio, ollama) or to advertise additional capabilities.
   */
  readonly target?: ExecutionTarget;
}

// ============================================================================
// Internals
// ============================================================================

interface InFlightEntry {
  readonly executionId: string;
  abort?: AbortController;
  abortReason?: string;
}

const SPEC_VERSION_LITERAL = SPEC_VERSION;

const STOP_REASON_MAP: Record<string, LanguageModelStopReason> = {
  stop: "end",
  length: "max_tokens",
  content_filter: "content_filter",
  tool_calls: "tool_use",
  function_call: "tool_use",
};

// ============================================================================
// OpenAIExecutor
// ============================================================================

export class OpenAIExecutor extends BaseHarness<"executor"> implements LanguageModelExecutor {
  readonly family = "language-model" as const;
  readonly target: ExecutionTarget;

  private readonly client: OpenAI;
  private readonly defaultModel: string | undefined;
  private readonly streamByDefault: boolean;
  private readonly parseThinkTags: boolean;
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly aborted = new Set<string>();

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: OpenAIExecutorOptions = {},
  ) {
    super("executor", scopeId, journal, bus, inbox);
    this.client = options.client ?? new OpenAI(buildClientOptions(options));
    this.defaultModel = options.model;
    this.streamByDefault = options.stream ?? false;
    this.parseThinkTags = options.parseThinkTags ?? false;
    this.target = options.target ?? {
      kind: "language-model",
      provider: "openai",
      modelId: options.model ?? "gpt-4o-mini",
      capabilities: { supportsTools: true, supportsStreaming: true },
    };
  }

  // ──────── ExecutorProtocol ────────

  project(input: ProjectInput): Promise<LanguageModelInput> {
    const op: Operation<ProjectInput, LanguageModelInput> = {
      opId: `executor:project:${ulid()}`,
      surface: "executor",
      name: "executor:command:project",
      scope: input.scope ?? {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.try({
          try: () => projectImpl(i),
          catch: (cause): ProjectionError => ({
            _tag: "ProjectionFailed",
            reason: "projection threw",
            cause,
          }),
        }),
      ),
    );
  }

  execute(input: ExecuteInput<LanguageModelInput>): Promise<unknown> {
    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    const op: Operation<ExecuteInput<LanguageModelInput>, unknown> = {
      opId: `executor:execute:${executionId}:${ulid()}`,
      surface: "executor",
      name: "executor:command:execute",
      scope: input.scope ?? { executionId },
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) => this.executeBody(i, executionId, undefined)),
    );
  }

  /**
   * Streaming surface — yields one `AdapterDelta` per provider chunk.
   * 1:1 translation: OpenAI sends `delta.content` → we emit
   * `content-delta`; `delta.tool_calls[i].function.name` → `tool-call-start`;
   * `delta.tool_calls[i].function.arguments` → `tool-call-delta`;
   * `finish_reason` → `message-end`; usage chunks → `usage`. After the
   * provider stream completes, we emit the symmetric summary events
   * (`content`, `tool-call`, `message`) from the accumulator state.
   *
   * `.result` resolves with the assembled raw `ChatCompletion` shape —
   * the same value the non-streaming `execute()` path returns. The
   * loop hands it to `normalize()` to convert into a
   * `LanguageModelExecutionResult`.
   */
  executeStream(input: ExecuteInput<LanguageModelInput>): ExecutorStream<ChatCompletion> {
    const queue: AdapterDelta[] = [];
    const resolvers: Array<(r: IteratorResult<AdapterDelta>) => void> = [];
    let done = false;
    let resultResolve!: (v: ChatCompletion) => void;
    let resultReject!: (e: unknown) => void;
    const resultPromise = new Promise<ChatCompletion>((res, rej) => {
      resultResolve = res;
      resultReject = rej;
    });
    const controller = new AbortController();
    if (input.signal) {
      if (input.signal.aborted) controller.abort(input.signal.reason);
      else
        input.signal.addEventListener(
          "abort",
          () => controller.abort(input.signal!.reason),
          { once: true },
        );
    }

    // Per-stream Operation so observability subscribers correlate deltas
    // to a single executor invocation. The op flows through emitDeltaLazy
    // alongside the iterator queue — bus subscribers (devtools,
    // telemetry, `app.events({surface: "executor", phase: "delta"})`)
    // see the same deltas the consumer reads from the AsyncIterable.
    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    const streamOp: Operation<ExecuteInput<LanguageModelInput>, ChatCompletion> = {
      opId: `executor:executeStream:${executionId}:${ulid()}`,
      surface: "executor",
      name: "executor:command:execute",
      scope: input.scope ?? { executionId },
      input,
    };

    const emit = (delta: AdapterDelta): void => {
      if (done) return;
      // Mirror to bus envelopes for observability — fire-and-forget so
      // we don't block the iterator hot path on subscriber latency.
      void Effect.runPromise(
        this.emitDeltaLazy(streamOp, () => delta).pipe(Effect.catchAll(() => Effect.void)),
      );
      const r = resolvers.shift();
      if (r) r({ value: delta, done: false });
      else queue.push(delta);
    };
    const complete = (): void => {
      done = true;
      while (resolvers.length > 0) {
        resolvers.shift()!({ value: undefined as unknown as AdapterDelta, done: true });
      }
    };

    // Drive the provider stream + emit chain on a detached promise. The
    // returned ExecutorStream's iterator + .result are both backed by it.
    void (async () => {
      try {
        const params = toOpenAIParams(input.targetInput, input.target, this.defaultModel);
        const stream = (await this.client.chat.completions.create(
          { ...params, stream: true, stream_options: { include_usage: true } },
          { signal: controller.signal },
        )) as unknown as AsyncIterable<ChatCompletionChunk>;

        const accum = new StreamAccumulator();
        emit({ type: "message-start", role: "assistant", model: params.model });

        // Per-block state needed for symmetric start/end emission.
        // Reasoning lives in its own block — vLLM/LM Studio emit
        // chain-of-thought BEFORE the assistant content, so it occupies
        // a lower blockIndex than the text content block.
        let textBlockStarted = false;
        const toolBlockStartedByIndex = new Set<number>();
        let reasoningBlockStarted = false;
        let reasoningAccum = "";
        let textAccum = "";
        const reasoningBlockIndex = -1; // sentinel; emitted before text (index 0)

        // Inline `<think>` parser. Active only when the executor was
        // constructed with `parseThinkTags: true`. Routes text inside
        // think tags to the reasoning stream and tracks accumulators
        // for the symmetric summary events.
        const thinkSplitter = this.parseThinkTags ? new ThinkTagSplitter() : null;

        const emitSegments = (text: string): void => {
          if (!thinkSplitter) return;
          for (const seg of thinkSplitter.feed(text)) {
            if (seg.mode === "text") {
              if (!textBlockStarted) {
                emit({ type: "content-start", blockIndex: 0, blockType: "text" });
                textBlockStarted = true;
              }
              emit({ type: "content-delta", blockIndex: 0, delta: seg.content });
              textAccum += seg.content;
            } else {
              if (!reasoningBlockStarted) {
                emit({ type: "reasoning-start", blockIndex: reasoningBlockIndex });
                reasoningBlockStarted = true;
              }
              emit({
                type: "reasoning-delta",
                blockIndex: reasoningBlockIndex,
                delta: seg.content,
              });
              reasoningAccum += seg.content;
            }
          }
        };

        for await (const chunk of stream) {
          accum.push(chunk);
          // When parseThinkTags is active, suppress mapChunk's
          // content-start/content-delta emission and route the raw text
          // through the splitter instead — the splitter decides what's
          // text vs reasoning. We do this by lying about textBlockStarted
          // so mapChunk never emits its content events.
          const mapState = thinkSplitter
            ? { textBlockStarted: true, toolBlockStartedByIndex, reasoningBlockStarted, reasoningBlockIndex }
            : { textBlockStarted, toolBlockStartedByIndex, reasoningBlockStarted, reasoningBlockIndex };
          for (const delta of mapChunkToAdapterDeltas(chunk, mapState)) {
            if (thinkSplitter && delta.type === "content-delta") {
              emitSegments(delta.delta);
              continue;
            }
            // Track block-start side effects so mapChunk knows what to
            // emit on subsequent chunks.
            if (delta.type === "content-start") textBlockStarted = true;
            if (delta.type === "tool-call-start") {
              toolBlockStartedByIndex.add(delta.blockIndex);
            }
            if (delta.type === "reasoning-start") reasoningBlockStarted = true;
            if (delta.type === "reasoning-delta") reasoningAccum += delta.delta;
            emit(delta);
          }
        }
        // Flush any buffered partial-tag content at stream end.
        if (thinkSplitter) {
          for (const seg of thinkSplitter.flush()) {
            if (seg.mode === "text") {
              if (!textBlockStarted) {
                emit({ type: "content-start", blockIndex: 0, blockType: "text" });
                textBlockStarted = true;
              }
              emit({ type: "content-delta", blockIndex: 0, delta: seg.content });
              textAccum += seg.content;
            } else {
              if (!reasoningBlockStarted) {
                emit({ type: "reasoning-start", blockIndex: reasoningBlockIndex });
                reasoningBlockStarted = true;
              }
              emit({
                type: "reasoning-delta",
                blockIndex: reasoningBlockIndex,
                delta: seg.content,
              });
              reasoningAccum += seg.content;
            }
          }
        }

        // Symmetric end + summary events from the accumulator state.
        // We close any open blocks that the provider didn't explicitly
        // close, then emit the summary events.
        const final = accum.toChatCompletion(params.model);
        // When parseThinkTags is on, the splitter routed text — use the
        // cleaned accumulators instead of the raw message.content
        // (which still contains the literal <think>...</think>).
        // Also rewrite the final ChatCompletion's message.content and
        // attach reasoning_content so normalize() sees the cleaned shape.
        if (thinkSplitter) {
          (final.choices[0]!.message as unknown as Record<string, unknown>).content =
            textAccum.length > 0 ? textAccum : null;
          if (reasoningAccum.length > 0) {
            (final.choices[0]!.message as unknown as Record<string, unknown>).reasoning_content =
              reasoningAccum;
          }
        }
        const choice = final.choices[0]!;
        const finishReason = choice.finish_reason ?? "stop";
        const text = thinkSplitter
          ? textAccum
          : typeof choice.message.content === "string"
            ? choice.message.content
            : "";
        const toolCallsRaw = choice.message.tool_calls ?? [];

        let blockIndex = 0;
        if (reasoningBlockStarted && reasoningAccum.length > 0) {
          emit({ type: "reasoning-end", blockIndex: reasoningBlockIndex });
          emit({
            type: "reasoning",
            blockIndex: reasoningBlockIndex,
            reasoning: reasoningAccum,
          });
        }
        if (textBlockStarted && text.length > 0) {
          emit({ type: "content-end", blockIndex });
          emit({
            type: "content",
            blockIndex,
            content: { type: "text", text } as ContentBlock,
          });
          blockIndex += 1;
        }
        for (const tc of toolCallsRaw) {
          const fn = (tc as { function?: { name: string; arguments: string } }).function;
          if (!fn) continue;
          const idx = blockIndex;
          if (toolBlockStartedByIndex.has(idx) === false) {
            // Provider never sent a function-name chunk for this index —
            // emit a synthetic tool-call-start before close so summary is symmetric.
            emit({
              type: "tool-call-start",
              callId: tc.id,
              name: fn.name,
              blockIndex: idx,
            });
          }
          emit({ type: "tool-call-end", callId: tc.id });
          let parsed: Readonly<Record<string, unknown>> = {};
          try {
            parsed = JSON.parse(fn.arguments) as Readonly<Record<string, unknown>>;
          } catch {
            /* invalid JSON — emit empty object as input */
          }
          emit({
            type: "tool-call",
            callId: tc.id,
            name: fn.name,
            input: parsed,
          });
          blockIndex += 1;
        }

        const usage: UsageStats = {
          inputTokens: final.usage?.prompt_tokens ?? 0,
          outputTokens: final.usage?.completion_tokens ?? 0,
          totalTokens: final.usage?.total_tokens ?? 0,
          ...(final.usage?.prompt_tokens_details?.cached_tokens !== undefined
            ? { cachedInputTokens: final.usage.prompt_tokens_details.cached_tokens }
            : {}),
        };
        const stopReason = mapFinishReason(finishReason);
        emit({ type: "message-end", stopReason, usage });

        // Assembled assistant message summary.
        const messageContent: ContentBlock[] = [];
        if (text.length > 0) messageContent.push({ type: "text", text });
        for (const tc of toolCallsRaw) {
          const fn = (tc as { function?: { name: string; arguments: string } }).function;
          if (!fn) continue;
          messageContent.push({
            type: "tool_use",
            toolUseId: tc.id,
            name: fn.name,
            input: ((): Readonly<Record<string, unknown>> => {
              try {
                return JSON.parse(fn.arguments) as Readonly<Record<string, unknown>>;
              } catch {
                return {};
              }
            })(),
          });
        }
        emit({
          type: "message",
          message: { role: "assistant", content: messageContent, model: params.model },
          stopReason,
          usage,
        });

        resultResolve(final);
        complete();
      } catch (cause) {
        resultReject(mapExecuteError(cause));
        complete();
      }
    })();

    return {
      result: resultPromise,
      abort(reason) {
        controller.abort(reason ?? "aborted");
      },
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<AdapterDelta>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (done) {
              return Promise.resolve({ value: undefined as unknown as AdapterDelta, done: true });
            }
            return new Promise((resolve) => resolvers.push(resolve));
          },
          return(): Promise<IteratorResult<AdapterDelta>> {
            complete();
            return Promise.resolve({ value: undefined as unknown as AdapterDelta, done: true });
          },
        };
      },
    };
  }

  normalize(input: NormalizeInput<unknown>): Promise<LanguageModelExecutionResult> {
    const op: Operation<NormalizeInput<unknown>, LanguageModelExecutionResult> = {
      opId: `executor:normalize:${ulid()}`,
      surface: "executor",
      name: "executor:command:normalize",
      scope: input.scope ?? {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.try({
          try: () => normalizeImpl(i),
          catch: (cause): NormalizeError => ({
            _tag: "NormalizationFailed",
            cause,
          }),
        }),
      ),
    );
  }

  run(input: RunInput): Promise<ExecutorTerminal<LanguageModelExecutionResult>> {
    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    // Per-tick opId composition — see MockLanguageModelExecutor for the
    // rationale (substrate idempotency keys must differ per tick).
    const tickId = input.scope?.tickId;
    const opId =
      tickId !== undefined
        ? `executor:run:${executionId}:${tickId}`
        : `executor:run:${executionId}:${ulid()}`;
    const op: Operation<RunInput, ExecutorTerminal<LanguageModelExecutionResult>> = {
      opId,
      surface: "executor",
      name: "executor:command:run",
      scope: { ...(input.scope ?? {}), executionId },
      input,
    };
    return runHarnessProtocol(this.runOperation(op, (i) => this.runBody(i, executionId, op)));
  }

  abort(input: AbortExecutorInput): Promise<void> {
    return runHarnessProtocol(
      Effect.sync(() => {
        const entry = this.inFlight.get(input.executionId);
        if (entry) {
          entry.abortReason = input.reason ?? "aborted";
          entry.abort?.abort(input.reason ?? "aborted");
        }
        this.aborted.add(input.executionId);
      }),
    );
  }

  // ──────── inbox dispatch ────────

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail({
      _tag: "HandlerError",
      cause: new Error("openai executor inbox dispatch not yet wired (Phase 4c minimum)"),
    });
  }

  // ──────── internals ────────

  /**
   * Common execute path used by both `execute()` and `run()`. When
   * `op` is supplied (run path), per-chunk deltas are emitted via
   * `emitDeltaLazy`. When omitted (execute path), streaming still
   * accumulates but no deltas are emitted to the bus.
   */
  private executeBody(
    input: ExecuteInput<LanguageModelInput>,
    executionId: string,
    op: Operation<unknown, unknown> | undefined,
  ): Effect.Effect<unknown, ExecuteError, never> {
    return Effect.gen(this, function* () {
      if (this.aborted.has(executionId)) {
        return yield* Effect.fail<ExecuteError>({
          _tag: "ProviderAborted",
          reason: "aborted prior to execute",
        });
      }

      const controller = new AbortController();
      const entry: InFlightEntry = { executionId, abort: controller };
      this.inFlight.set(executionId, entry);

      try {
        const params = toOpenAIParams(input.targetInput, input.target, this.defaultModel);
        const wantStream =
          this.streamByDefault && (input.target.capabilities?.supportsStreaming ?? true);
        const signal = mergeSignals(input.signal, controller.signal);

        if (!wantStream) {
          return yield* Effect.tryPromise<unknown, ExecuteError>({
            try: () =>
              this.client.chat.completions.create(
                { ...params, stream: false },
                { signal },
              ) as unknown as Promise<ChatCompletion>,
            catch: (cause): ExecuteError => mapExecuteError(cause),
          });
        }

        return yield* this.executeStreamBody(params, signal, op);
      } finally {
        this.inFlight.delete(executionId);
      }
    });
  }

  private executeStreamBody(
    params: ChatCompletionCreateParams,
    signal: AbortSignal | undefined,
    op: Operation<unknown, unknown> | undefined,
  ): Effect.Effect<ChatCompletion, ExecuteError, never> {
    return Effect.gen(this, function* () {
      const stream = yield* Effect.tryPromise<AsyncIterable<ChatCompletionChunk>, ExecuteError>({
        try: () =>
          this.client.chat.completions.create(
            {
              ...params,
              stream: true,
              stream_options: { include_usage: true },
            },
            { signal },
          ) as unknown as Promise<AsyncIterable<ChatCompletionChunk>>,
        catch: (cause): ExecuteError => mapExecuteError(cause),
      });

      const iterator = stream[Symbol.asyncIterator]();
      const accum = new StreamAccumulator();
      while (true) {
        const step = yield* Effect.tryPromise<IteratorResult<ChatCompletionChunk>, ExecuteError>({
          try: () => iterator.next(),
          catch: (cause): ExecuteError => mapExecuteError(cause),
        });
        if (step.done) break;
        const chunk = step.value;
        accum.push(chunk);
        if (op !== undefined) {
          yield* this.emitDeltaLazy(op, () => mapChunkToDelta(chunk, accum)).pipe(Effect.orDie);
        }
      }

      return accum.toChatCompletion(params.model);
    });
  }

  private runBody(
    input: RunInput,
    executionId: string,
    op: Operation<RunInput, ExecutorTerminal<LanguageModelExecutionResult>>,
  ): Effect.Effect<ExecutorTerminal<LanguageModelExecutionResult>, ExecutorError, never> {
    return Effect.gen(this, function* () {
      // Pre-execution abort short-circuit. Mid-stream aborts surface as
      // `ProviderAborted` from `executeBody` and are caught below.
      if (this.aborted.has(executionId)) {
        const terminal: ExecutorTerminal<LanguageModelExecutionResult> = {
          outcome: "canceled",
          reason: this.inFlight.get(executionId)?.abortReason ?? "aborted",
        };
        return terminal;
      }

      // 1. project (pure)
      const projected = projectImpl({
        compiled: input.compiled,
        target: input.target,
      });

      // 2. execute (provider call; may stream + emit deltas)
      const executeInput: ExecuteInput<LanguageModelInput> = {
        targetInput: projected,
        target: input.target,
        scope: { ...(input.scope ?? {}), executionId },
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      };
      const raw = yield* this.executeBody(
        executeInput,
        executionId,
        op as Operation<unknown, unknown>,
      ).pipe(
        Effect.catchTag("ProviderAborted", (e) =>
          Effect.succeed<ExecutorTerminal<LanguageModelExecutionResult>>({
            outcome: "canceled",
            reason: e.reason ?? "aborted",
          }),
        ),
      );

      // ProviderAborted recovery returned a terminal directly — pass through.
      if (
        raw &&
        typeof raw === "object" &&
        "outcome" in raw &&
        (raw as { outcome?: string }).outcome === "canceled"
      ) {
        return raw as ExecutorTerminal<LanguageModelExecutionResult>;
      }

      // When parseThinkTags is enabled, rewrite the message content so
      // normalize() sees the cleaned text + extracted reasoning.
      // (The streaming path already cleans the synthesized
      // ChatCompletion before reaching here.)
      const rawForNormalize = this.parseThinkTags
        ? applyThinkTagSplitToChatCompletion(raw)
        : raw;

      // 3. normalize (deterministic)
      const result = yield* Effect.try({
        try: () => normalizeImpl({ targetOutput: rawForNormalize, target: input.target }),
        catch: (cause): ExecutorError => ({
          _tag: "NormalizationFailed",
          cause,
        }),
      });

      const terminal: ExecutorTerminal<LanguageModelExecutionResult> = {
        outcome: "succeeded",
        result,
      };
      return terminal;
    });
  }
}

// ============================================================================
// Client construction
// ============================================================================

function buildClientOptions(opts: OpenAIExecutorOptions): ClientOptions {
  const out: ClientOptions = {};
  const apiKey = opts.apiKey ?? process.env["OPENAI_API_KEY"];
  if (apiKey !== undefined) out.apiKey = apiKey;
  const baseURL = opts.baseURL ?? process.env["OPENAI_BASE_URL"];
  if (baseURL !== undefined) out.baseURL = baseURL;
  if (opts.organization !== undefined) out.organization = opts.organization;
  if (opts.headers !== undefined) out.defaultHeaders = opts.headers;
  if (opts.timeout !== undefined) out.timeout = opts.timeout;
  if (opts.maxRetries !== undefined) out.maxRetries = opts.maxRetries;
  return out;
}

/**
 * Post-process a non-streaming ChatCompletion through the
 * think-tag splitter. Used when `parseThinkTags: true` and the
 * server didn't stream. Mutates the message in-place: `content`
 * becomes the cleaned text (think tags removed), and
 * `reasoning_content` carries the extracted reasoning. normalize()
 * then surfaces the reasoning as a ReasoningBlock.
 */
function applyThinkTagSplitToChatCompletion(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as { choices?: Array<{ message?: Record<string, unknown> }> };
  const message = r.choices?.[0]?.message;
  if (!message || typeof message.content !== "string") return raw;
  let text = "";
  let reasoning = "";
  for (const seg of splitThinkTags(message.content)) {
    if (seg.mode === "text") text += seg.content;
    else reasoning += seg.content;
  }
  message.content = text.length > 0 ? text : null;
  if (reasoning.length > 0) message.reasoning_content = reasoning;
  return raw;
}

// ============================================================================
// IR → OpenAI params
// ============================================================================

function toOpenAIParams(
  input: LanguageModelInput,
  target: ExecutionTarget,
  defaultModel: string | undefined,
): ChatCompletionCreateParams {
  const messages: ChatCompletionMessageParam[] = [];
  for (const m of input.messages) messages.push(...toOpenAIMessages(m));

  const tools = input.tools && input.tools.length > 0 ? input.tools.map(toOpenAITool) : undefined;

  const params: ChatCompletionCreateParams = {
    model: defaultModel ?? "gpt-4o-mini",
    messages,
  };
  const p = input.parameters;
  if (p?.temperature !== undefined) params.temperature = p.temperature;
  if (p?.maxOutputTokens !== undefined) params.max_tokens = p.maxOutputTokens;
  if (p?.topP !== undefined) params.top_p = p.topP;
  if (p?.frequencyPenalty !== undefined) params.frequency_penalty = p.frequencyPenalty;
  if (p?.presencePenalty !== undefined) params.presence_penalty = p.presencePenalty;
  if (p?.stopSequences !== undefined) params.stop = p.stopSequences as string[];
  if (tools && tools.length > 0) {
    params.tools = tools;
    params.tool_choice = "auto";
  }
  if (p?.responseFormat) {
    const rf = p.responseFormat;
    if (rf.type === "text") {
      params.response_format = { type: "text" };
    } else if (rf.type === "json") {
      params.response_format = { type: "json_object" };
    } else if (rf.type === "json_schema" && rf.schema) {
      params.response_format = {
        type: "json_schema",
        json_schema: {
          name: rf.name ?? "response",
          schema: rf.schema,
          strict: true,
        },
      };
    }
  }
  // Adopter escape hatch — spread provider-specific options after canonical
  // mapping. Lets callers set logprobs, seed, store, n, prediction, etc.
  // without us hardcoding every OpenAI knob.
  const overrides = target.providerOptions?.openai;
  if (overrides && typeof overrides === "object") {
    Object.assign(params, overrides);
  }
  return params;
}

function toOpenAIMessages(m: LanguageModelMessage): ChatCompletionMessageParam[] {
  // Tool result messages must go on their own `role: "tool"` entry.
  const toolResults: ChatCompletionMessageParam[] = [];
  const textParts: { type: "text"; text: string }[] = [];
  const imageParts: {
    type: "image_url";
    image_url: { url: string };
  }[] = [];
  const toolCalls: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[] = [];

  for (const part of m.content) {
    switch (part.type) {
      case "text":
        textParts.push({ type: "text", text: part.text });
        break;
      case "image":
        imageParts.push({
          type: "image_url",
          image_url: { url: part.imageUrl },
        });
        break;
      case "tool_use":
        toolCalls.push({
          id: part.id,
          type: "function",
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input ?? {}),
          },
        });
        break;
      case "tool_result": {
        const textOnly = part.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        toolResults.push({
          role: "tool",
          tool_call_id: part.toolUseId,
          content: textOnly || (part.isError ? "[error]" : "[done]"),
        });
        break;
      }
    }
  }

  if (m.role === "tool") return toolResults;

  if (
    toolResults.length > 0 &&
    textParts.length === 0 &&
    imageParts.length === 0 &&
    toolCalls.length === 0
  ) {
    return toolResults;
  }

  const content: ChatCompletionMessageParam["content"] =
    imageParts.length === 0
      ? textParts.map((p) => p.text).join("") || null
      : ([...textParts, ...imageParts] as unknown as Exclude<
          ChatCompletionMessageParam["content"],
          string | null
        >);

  const base = { role: m.role, content } as ChatCompletionMessageParam;
  if (toolCalls.length > 0 && m.role === "assistant") {
    (base as { tool_calls?: typeof toolCalls }).tool_calls = toolCalls;
  }
  if (m.name !== undefined) {
    (base as { name?: string }).name = m.name;
  }
  const out: ChatCompletionMessageParam[] = [base];
  if (toolResults.length > 0) out.push(...toolResults);
  return out;
}

function toOpenAITool(t: LanguageModelTool): ChatCompletionTool {
  const fn: { name: string; description?: string; parameters: Record<string, unknown> } = {
    name: t.name,
    parameters: t.inputSchema,
  };
  if (t.description !== undefined) fn.description = t.description;
  return { type: "function", function: fn };
}

// ============================================================================
// IR projection — identical to MockLanguageModelExecutor (kept local so the
// adapter does not depend on @agentick/executor).
// ============================================================================

function projectImpl(input: ProjectInput): LanguageModelInput {
  const messages = buildMessages(input.compiled);
  const tools = buildTools(input.compiled);
  const parameters = buildParameters(input.compiled);
  return {
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(parameters !== undefined ? { parameters } : {}),
  };
}

function buildMessages(tree: RenderedTree): ReadonlyArray<LanguageModelMessage> {
  const messages: LanguageModelMessage[] = [];
  const systemText = collectSectionText(tree.context.entries);
  if (systemText.length > 0) {
    messages.push({
      role: "system",
      content: [{ type: "text", text: systemText }],
    });
  }
  for (const entry of tree.context.entries) {
    if (entry.kind !== "message") continue;
    messages.push({
      role: entry.role as LanguageModelMessage["role"],
      content: entry.content.map(messagePartFromBlock),
    });
  }
  return messages;
}

function collectSectionText(entries: ReadonlyArray<ContextEntry>): string {
  const parts: string[] = [];
  for (const e of entries) {
    if (e.kind !== "section") continue;
    const text = sectionText(e);
    if (text.length > 0) parts.push(text);
  }
  return parts.join("\n\n");
}

function sectionText(section: SectionEntry): string {
  const head = section.title ? `## ${section.title}\n\n` : "";
  const body = section.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter((t) => t.length > 0)
    .join("\n\n");
  return head + body;
}

function messagePartFromBlock(block: ContentBlock): LanguageModelMessagePart {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image",
        imageUrl: block.source.type === "url" ? block.source.url : "[binary]",
        ...(block.mimeType !== undefined ? { mediaType: block.mimeType } : {}),
      };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.toolUseId,
        name: block.name,
        input: block.input,
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: block.toolUseId,
        content: block.content.map(messagePartFromBlock),
        ...(block.isError !== undefined ? { isError: block.isError } : {}),
      };
    default:
      return {
        type: "text",
        text:
          "text" in block && typeof block.text === "string" ? block.text : JSON.stringify(block),
      };
  }
}

function buildTools(tree: RenderedTree): ReadonlyArray<LanguageModelTool> {
  const decl = tree.declarations?.tools ?? [];
  return decl
    .filter((t: ToolDeclaration) => t.exposure.includes("model"))
    .map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
}

function buildParameters(tree: RenderedTree) {
  const cfg = tree.config;
  if (!cfg) return undefined;
  const params: {
    temperature?: number;
    maxOutputTokens?: number;
    responseFormat?: {
      type: "text" | "json" | "json_schema";
      schema?: Record<string, unknown>;
    };
  } = {};
  if (cfg.temperature !== undefined) params.temperature = cfg.temperature;
  if (cfg.maxOutputTokens !== undefined) {
    params.maxOutputTokens = cfg.maxOutputTokens;
  }
  if (cfg.responseFormat !== undefined) {
    if (cfg.responseFormat.type === "json_schema") {
      params.responseFormat = {
        type: "json_schema",
        schema: cfg.responseFormat.schema as Record<string, unknown>,
      };
    } else {
      params.responseFormat = { type: cfg.responseFormat.type };
    }
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

// ============================================================================
// ChatCompletion → LanguageModelExecutionResult
// ============================================================================

function normalizeImpl(input: NormalizeInput<unknown>): LanguageModelExecutionResult {
  const raw = input.targetOutput;
  if (!isChatCompletion(raw)) {
    throw new Error("normalize expected ChatCompletion shape");
  }
  const choice = raw.choices?.[0];
  const message = choice?.message;
  if (!message) {
    throw new Error("ChatCompletion missing choices[0].message");
  }

  const output: ContentBlock[] = [];
  // Reasoning blocks ride before text — OpenAI-compatible servers
  // (vLLM `reasoning_content`, LM Studio `reasoning`) expose
  // chain-of-thought via non-standard message fields. Duck-typed since
  // neither lives in the SDK's typed shape.
  {
    const m = message as unknown as Record<string, unknown>;
    const rc = m.reasoning_content;
    const r = m.reasoning;
    const reasoning = typeof rc === "string" ? rc : typeof r === "string" ? r : undefined;
    if (reasoning !== undefined && reasoning.length > 0) {
      output.push({ type: "reasoning", text: reasoning });
    }
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    output.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part && typeof part === "object" && part.type === "text") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string" && text.length > 0) {
          output.push({ type: "text", text });
        }
      }
    }
  }

  const toolCalls: ToolCall[] = [];
  const tcs = (message as { tool_calls?: unknown[] }).tool_calls;
  if (Array.isArray(tcs)) {
    for (const tc of tcs) {
      if (!tc || typeof tc !== "object") continue;
      const t = tc as {
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      };
      if (t.type !== "function" || !t.function) continue;
      const name = t.function.name;
      const id = t.id;
      if (!name || !id) continue;
      let parsed: unknown;
      try {
        parsed = t.function.arguments ? JSON.parse(t.function.arguments) : {};
      } catch {
        parsed = t.function.arguments ?? {};
      }
      const inputObj =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { value: parsed };
      toolCalls.push({ id, name, input: inputObj });
      output.push({
        type: "tool_use",
        toolUseId: id,
        name,
        input: inputObj,
      });
    }
  }

  const stopReason: LanguageModelStopReason = choice?.finish_reason
    ? (STOP_REASON_MAP[choice.finish_reason] ?? "other")
    : "other";

  const result: LanguageModelExecutionResult = {
    specVersion: SPEC_VERSION_LITERAL,
    output,
    stopReason,
    usage: {
      inputTokens: raw.usage?.prompt_tokens ?? 0,
      outputTokens: raw.usage?.completion_tokens ?? 0,
      totalTokens: raw.usage?.total_tokens ?? 0,
      ...(raw.usage?.prompt_tokens_details?.cached_tokens !== undefined
        ? { cachedInputTokens: raw.usage.prompt_tokens_details.cached_tokens }
        : {}),
    },
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    raw,
  };
  return result;
}

function isChatCompletion(v: unknown): v is ChatCompletion {
  if (!v || typeof v !== "object") return false;
  const o = v as { choices?: unknown };
  return Array.isArray(o.choices);
}

// ============================================================================
// Streaming
// ============================================================================

/**
 * Accumulates `ChatCompletionChunk` streams into a synthetic
 * `ChatCompletion` for normalize(). Mirrors the v1 `reconstructRaw`
 * helper without depending on the v1 adapter package.
 */
class StreamAccumulator {
  private id = "";
  private created = 0;
  private model = "";
  private text = "";
  private reasoning = "";
  private finishReason: ChatCompletion["choices"][0]["finish_reason"] | null = null;
  private toolCallsByIndex = new Map<number, { id: string; name: string; arguments: string }>();
  private usage:
    | {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        prompt_tokens_details?: { cached_tokens?: number };
      }
    | undefined;

  push(chunk: ChatCompletionChunk): void {
    if (!this.id && chunk.id) this.id = chunk.id;
    if (!this.created && chunk.created) this.created = chunk.created;
    if (!this.model && chunk.model) this.model = chunk.model;
    if (chunk.usage) {
      this.usage = {
        prompt_tokens: chunk.usage.prompt_tokens ?? 0,
        completion_tokens: chunk.usage.completion_tokens ?? 0,
        total_tokens: chunk.usage.total_tokens ?? 0,
        ...(chunk.usage.prompt_tokens_details?.cached_tokens !== undefined
          ? {
              prompt_tokens_details: {
                cached_tokens: chunk.usage.prompt_tokens_details.cached_tokens,
              },
            }
          : {}),
      };
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return;
    if (typeof delta.content === "string") this.text += delta.content;
    // vLLM `reasoning_content`, LM Studio `reasoning` — duck-typed since
    // neither field is in the SDK's typed shape.
    {
      const d = delta as unknown as Record<string, unknown>;
      const rc = d.reasoning_content;
      if (typeof rc === "string") this.reasoning += rc;
      const r = d.reasoning;
      if (typeof r === "string") this.reasoning += r;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        const entry = this.toolCallsByIndex.get(idx) ?? { id: "", name: "", arguments: "" };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name = tc.function.name;
        if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        this.toolCallsByIndex.set(idx, entry);
      }
    }
  }

  toChatCompletion(modelHint: string): ChatCompletion {
    const toolCalls = Array.from(this.toolCallsByIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id,
        type: "function" as const,
        function: { name: v.name, arguments: v.arguments },
      }));

    // Reasoning rides as a non-standard field on the synthesized
    // message — normalize() picks it up via duck-typing, same as the
    // non-streaming response path.
    const message = {
      role: "assistant" as const,
      content: this.text.length > 0 ? this.text : null,
      refusal: null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(this.reasoning.length > 0 ? { reasoning_content: this.reasoning } : {}),
    } as ChatCompletion["choices"][0]["message"];

    return {
      id: this.id || `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: this.created || Math.floor(Date.now() / 1000),
      model: this.model || modelHint,
      choices: [
        {
          index: 0,
          message,
          finish_reason: this.finishReason ?? "stop",
          logprobs: null,
        },
      ],
      usage: this.usage ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    } as ChatCompletion;
  }
}

/**
 * 1:1 translation of an OpenAI `ChatCompletionChunk` to zero-or-more
 * typed `AdapterDelta` events. State-aware: tracks whether a text
 * content block has been opened, and whether each tool-call slot has
 * been opened. The caller maintains the state across chunks.
 */
function mapChunkToAdapterDeltas(
  chunk: ChatCompletionChunk,
  state: {
    textBlockStarted: boolean;
    toolBlockStartedByIndex: Set<number>;
    reasoningBlockStarted: boolean;
    reasoningBlockIndex: number;
  },
): AdapterDelta[] {
  const out: AdapterDelta[] = [];
  // Usage chunks (some providers emit a standalone trailer with usage).
  if (chunk.usage && !chunk.choices?.[0]?.delta) {
    out.push({
      type: "usage",
      usage: {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? 0,
        ...(chunk.usage.prompt_tokens_details?.cached_tokens !== undefined
          ? { cachedInputTokens: chunk.usage.prompt_tokens_details.cached_tokens }
          : {}),
      },
    });
  }
  const choice = chunk.choices?.[0];
  if (!choice) return out;
  const delta = choice.delta;
  if (delta) {
    // Reasoning content — OpenAI-compatible servers expose chain-of-thought
    // via non-standard fields: vLLM uses `reasoning_content`, LM Studio
    // uses `reasoning`. v1 surfaces this through reasoning deltas; we do
    // the same. Both fields are duck-typed since they aren't in the
    // OpenAI SDK's typed shape.
    const reasoningChunk = ((): string | undefined => {
      const d = delta as unknown as Record<string, unknown>;
      const rc = d.reasoning_content;
      if (typeof rc === "string" && rc.length > 0) return rc;
      const r = d.reasoning;
      if (typeof r === "string" && r.length > 0) return r;
      return undefined;
    })();
    if (reasoningChunk !== undefined) {
      if (!state.reasoningBlockStarted) {
        out.push({ type: "reasoning-start", blockIndex: state.reasoningBlockIndex });
      }
      out.push({
        type: "reasoning-delta",
        blockIndex: state.reasoningBlockIndex,
        delta: reasoningChunk,
      });
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!state.textBlockStarted) {
        out.push({ type: "content-start", blockIndex: 0, blockType: "text" });
      }
      out.push({ type: "content-delta", blockIndex: 0, delta: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (tc.function?.name && !state.toolBlockStartedByIndex.has(idx)) {
          out.push({
            type: "tool-call-start",
            callId: tc.id ?? `tc_${idx}`,
            name: tc.function.name,
            blockIndex: idx,
          });
        }
        if (typeof tc.function?.arguments === "string" && tc.function.arguments.length > 0) {
          out.push({
            type: "tool-call-delta",
            callId: tc.id ?? `tc_${idx}`,
            delta: tc.function.arguments,
          });
        }
      }
    }
  }
  // We don't emit message-end here — the streaming loop emits it from
  // the accumulator after the iterator completes (so usage is final).
  return out;
}

/** Map OpenAI's `finish_reason` to the framework's `LanguageModelStopReason`. */
function mapFinishReason(reason: string): LanguageModelStopReason {
  switch (reason) {
    case "stop":
      return "end";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "content_filter";
    default:
      return "end";
  }
}

function mapChunkToDelta(
  chunk: ChatCompletionChunk,
  accum: StreamAccumulator,
): {
  kind: string;
  delta?: string;
  blockIndex?: number;
  metadata?: Record<string, unknown>;
} {
  // Final-chunk indicator (finish_reason + maybe usage)
  const choice = chunk.choices?.[0];
  if (choice?.finish_reason) {
    return {
      kind: "message_end",
      metadata: { finishReason: choice.finish_reason },
    };
  }
  const delta = choice?.delta;
  if (delta?.content) return { kind: "content_delta", delta: delta.content };
  if (Array.isArray(delta?.tool_calls)) {
    for (const tc of delta.tool_calls) {
      if (tc.function?.name) {
        return {
          kind: "tool_call_start",
          metadata: { id: tc.id, name: tc.function.name, index: tc.index },
        };
      }
      if (tc.function?.arguments) {
        return {
          kind: "tool_call_delta",
          delta: tc.function.arguments,
          blockIndex: tc.index,
        };
      }
    }
  }
  if (chunk.usage) {
    return {
      kind: "usage",
      metadata: {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
      },
    };
  }
  // No observable payload — return a kind anyway since emitDeltaLazy is
  // guarded by hasSubscriber upstream.
  void accum;
  return { kind: "noop" };
}

// ============================================================================
// Error + signal helpers
// ============================================================================

function mapExecuteError(cause: unknown): ExecuteError {
  if (cause instanceof Error) {
    // OpenAI SDK exposes APIError with a `status` field. Narrow by duck-typing
    // to avoid a hard runtime dependency on the SDK's error classes here.
    const status = (cause as { status?: number }).status;
    if (cause.name === "APIUserAbortError" || /aborted/i.test(cause.message)) {
      return { _tag: "ProviderAborted", reason: cause.message };
    }
    if (typeof status === "number") {
      return { _tag: "ProviderRejected", status, cause };
    }
  }
  return { _tag: "StreamFailed", cause };
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal | undefined {
  if (a === undefined) return b;
  if (a.aborted) return a;
  const c = new AbortController();
  const onAbort = (signal: AbortSignal) => () => c.abort(signal.reason ?? "aborted");
  a.addEventListener("abort", onAbort(a), { once: true });
  b.addEventListener("abort", onAbort(b), { once: true });
  return c.signal;
}
