/**
 * `AnthropicExecutor` — `LanguageModelExecutor` backed by the Anthropic
 * Messages API. Mirrors `OpenAIExecutor`'s structure with provider-specific
 * translation tables (system extraction, strict user/assistant alternation,
 * native `thinking` blocks for reasoning, separate `cache_*_input_tokens`
 * usage fields).
 *
 * @see docs/proposals/v2/anthropic-adapter-plan.md
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

import { Effect } from "effect";
import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import type {
  ImageBlockParam,
  Message as AnthropicMessage,
  MessageCreateParams,
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
  MessageParam,
  RawMessageStreamEvent,
  RedactedThinkingBlock,
  TextBlock as AnthropicTextBlock,
  TextBlockParam,
  ThinkingBlock as AnthropicThinkingBlock,
  Tool as AnthropicTool,
  ToolResultBlockParam,
  ToolUseBlock as AnthropicToolUseBlock,
  ToolUseBlockParam,
  ContentBlockParam,
  Usage,
} from "@anthropic-ai/sdk/resources/messages";

import { BaseHarness, runHarnessProtocol, ulid } from "@agentick/runtime-next";
import type {
  AbortExecutorInput,
  AdapterDelta,
  ContentBlock,
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
  MediaSource,
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
} from "@agentick/spec-next";
import { SPEC_VERSION } from "@agentick/spec-next";

import {
  StreamTagParser,
  type StreamTagEvent,
  type StreamTagHandler,
} from "@agentick/executor-openai-next";

// ============================================================================
// ProviderOptions augmentation — typed Anthropic escape hatch (G5)
// ============================================================================

/**
 * All three v2 provider-option tiers contributed at once via the
 * SDK's actual types — no hand-rolled subsets.
 *
 * - `ProviderClientOptions["anthropic"]`: {@link ClientOptions} —
 *   every field `@anthropic-ai/sdk`'s `Anthropic` constructor
 *   accepts (apiKey, baseURL, authToken, defaultHeaders, timeout,
 *   maxRetries, fetch, httpAgent, …).
 *
 * - `ProviderOptions["anthropic"]`: `Partial<MessageCreateParams>` —
 *   every field the SDK accepts on the Messages request body
 *   (top_k, top_p, stop_sequences, thinking, tool_choice, metadata,
 *   service_tier, mcp_servers, container, …). Spread last onto the
 *   request body so executor-projected canonical knobs can be
 *   overridden. Fields the executor controls structurally and
 *   SHOULD NOT be set via providerOptions: `model`, `messages`,
 *   `system`, `tools`, `max_tokens` (use `maxTokens` constructor
 *   option), `stream`.
 *
 * - `ProviderToolOptions["anthropic"]`: per-tool SDK overrides
 *   (e.g. `cache_control: { type: "ephemeral" }` to mark a specific
 *   tool as a prompt-cache breakpoint).
 *
 * **Per-block `cache_control` lives on `BaseContentBlock.providerMetadata`,
 * not here.** Adopters who want to mark THIS message-block as a
 * cache breakpoint stamp
 * `providerMetadata.anthropic.cacheControl = { type: "ephemeral" }`
 * on the specific {@link ContentBlock}. The executor reads it
 * per-block during projection. No meta-knob policy.
 */
declare module "@agentick/spec-next" {
  interface ProviderClientOptions {
    readonly anthropic?: ClientOptions;
  }
  interface ProviderOptions {
    readonly anthropic?: Partial<MessageCreateParams>;
  }
  interface ProviderToolOptions {
    readonly anthropic?: Partial<AnthropicTool>;
  }
}

// ============================================================================
// Construction options
// ============================================================================

export interface AnthropicExecutorOptions {
  /** Default model id (e.g. `"claude-3-5-sonnet-latest"`). */
  readonly model?: string;
  /**
   * SDK client construction options — every field
   * `@anthropic-ai/sdk`'s `Anthropic` constructor accepts (apiKey,
   * baseURL, authToken, defaultHeaders, timeout, maxRetries, fetch,
   * httpAgent, …). Typed via the augmentable
   * {@link import("@agentick/spec-next").ProviderClientOptions} slot.
   * Ignored when `client` is supplied.
   *
   * Env-var fallbacks (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`)
   * are applied at construction time for any field not present here.
   */
  readonly clientOptions?: ClientOptions;
  /** Inject a pre-built Anthropic client (testing, advanced setups). */
  readonly client?: Anthropic;
  /** Default `max_tokens`. Anthropic REQUIRES this. Defaults to 4096. */
  readonly maxTokens?: number;
  /** Whether `run()` streams by default. Per-call wins via the target. */
  readonly stream?: boolean;
  /**
   * Parse inline `<think>...</think>` tags. For Claude, native
   * `thinking` blocks are preferred — this is for the niche case of
   * piping a non-thinking Claude through a pre-prompt eliciting
   * `<think>` artifacts in the text channel.
   */
  readonly parseThinkTags?: boolean;
  /** Adopter-declared XML-like tags to extract (G12). */
  readonly customBlocks?: Readonly<Record<string, CustomBlockDefinition>>;
  /** Override the self-described target. */
  readonly target?: ExecutionTarget;
}

export interface CustomBlockDefinition {
  readonly tag?: string;
  readonly onStart?: (attrs: Readonly<Record<string, string>>) => void;
  readonly onContent?: (content: string, attrs: Readonly<Record<string, string>>) => void;
  readonly onSelfClosing?: (attrs: Readonly<Record<string, string>>) => void;
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
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MODEL = "claude-3-5-sonnet-latest";

// ============================================================================
// AnthropicExecutor
// ============================================================================

export class AnthropicExecutor extends BaseHarness<"executor"> implements LanguageModelExecutor {
  readonly family = "language-model" as const;
  readonly target: ExecutionTarget;

  private readonly client: Anthropic;
  private readonly defaultModel: string | undefined;
  private readonly defaultMaxTokens: number | undefined;
  private readonly streamByDefault: boolean;
  private readonly parseThinkTags: boolean;
  private readonly customBlocks?: Readonly<Record<string, CustomBlockDefinition>>;
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly aborted = new Set<string>();

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: AnthropicExecutorOptions = {},
  ) {
    super("executor", scopeId, journal, bus, inbox);
    this.client = options.client ?? new Anthropic(buildClientOptions(options));
    this.defaultModel = options.model;
    this.defaultMaxTokens = options.maxTokens;
    this.streamByDefault = options.stream ?? false;
    this.parseThinkTags = options.parseThinkTags ?? false;
    this.customBlocks = options.customBlocks;
    this.target = options.target ?? {
      kind: "language-model",
      provider: "anthropic",
      modelId: options.model ?? DEFAULT_MODEL,
      capabilities: {
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
      },
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

  executeStream(input: ExecuteInput<LanguageModelInput>): ExecutorStream<AnthropicMessage> {
    const queue: AdapterDelta[] = [];
    const resolvers: Array<(r: IteratorResult<AdapterDelta>) => void> = [];
    let done = false;
    let resultResolve!: (v: AnthropicMessage) => void;
    let resultReject!: (e: unknown) => void;
    const resultPromise = new Promise<AnthropicMessage>((res, rej) => {
      resultResolve = res;
      resultReject = rej;
    });
    const controller = new AbortController();
    if (input.signal) {
      if (input.signal.aborted) controller.abort(input.signal.reason);
      else
        input.signal.addEventListener("abort", () => controller.abort(input.signal!.reason), {
          once: true,
        });
    }

    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    const streamOp: Operation<ExecuteInput<LanguageModelInput>, AnthropicMessage> = {
      opId: `executor:executeStream:${executionId}:${ulid()}`,
      surface: "executor",
      name: "executor:command:execute",
      scope: input.scope ?? { executionId },
      input,
    };

    const emit = (delta: AdapterDelta): void => {
      if (done) return;
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

    void (async () => {
      try {
        const params = toAnthropicParams(
          input.targetInput,
          input.target,
          this.defaultModel,
          this.defaultMaxTokens,
        );
        const stream = (await this.client.messages.create(
          { ...params, stream: true } as MessageCreateParamsStreaming,
          { signal: controller.signal },
        )) as unknown as AsyncIterable<RawMessageStreamEvent>;

        const accum = new AnthropicStreamAccumulator();

        const tagRouter = buildTagRouter({
          parseThinkTags: this.parseThinkTags,
          customBlocks: this.customBlocks,
        });

        // Per-block state. Keyed by Anthropic's block index.
        interface BlockState {
          type: "text" | "thinking" | "tool_use" | "redacted_thinking";
          callId?: string;
          name?: string;
          jsonBuffer: string;
          textBuffer: string;
        }
        const blocks = new Map<number, BlockState>();
        // Track which blocks emitted a *-start so we can emit symmetric closes.
        const startedTextBlocks = new Set<number>();
        const startedToolBlocks = new Set<number>(); // by Anthropic block index
        const startedReasoningBlocks = new Set<number>();
        // Tag-router auxiliary accumulators (only used when tagRouter is active).
        let routerReasoningStarted = false;
        let routerReasoningBlockIndex = -1; // sentinel for tag-router-driven reasoning
        let routerReasoningAccum = "";

        const handleTagEvent = (event: StreamTagEvent, blockIndex: number): void => {
          if (event.type === "text") {
            if (event.content.length === 0) return;
            if (!startedTextBlocks.has(blockIndex)) {
              emit({ type: "content-start", blockIndex, blockType: "text" });
              startedTextBlocks.add(blockIndex);
            }
            emit({ type: "content-delta", blockIndex, delta: event.content });
            const st = blocks.get(blockIndex);
            if (st) st.textBuffer += event.content;
            return;
          }
          const mode = tagRouter!.modeFor(event.tag);
          if (mode === "reasoning") {
            switch (event.type) {
              case "block-start":
                if (!routerReasoningStarted) {
                  emit({ type: "reasoning-start", blockIndex: routerReasoningBlockIndex });
                  routerReasoningStarted = true;
                }
                break;
              case "block-delta":
                if (!routerReasoningStarted) {
                  emit({ type: "reasoning-start", blockIndex: routerReasoningBlockIndex });
                  routerReasoningStarted = true;
                }
                emit({
                  type: "reasoning-delta",
                  blockIndex: routerReasoningBlockIndex,
                  delta: event.delta,
                });
                routerReasoningAccum += event.delta;
                break;
              case "block-end":
              case "block":
                break;
            }
            return;
          }
          // custom-block passthrough
          switch (event.type) {
            case "block-start":
              emit({ type: "custom-block-start", tag: event.tag, attrs: event.attrs });
              break;
            case "block-delta":
              emit({ type: "custom-block-delta", tag: event.tag, delta: event.delta });
              break;
            case "block-end":
              emit({ type: "custom-block-end", tag: event.tag });
              break;
            case "block":
              emit({
                type: "custom-block",
                tag: event.tag,
                content: event.content,
                attrs: event.attrs,
                ...(event.selfClosing ? { selfClosing: true } : {}),
              });
              break;
          }
        };

        for await (const event of stream) {
          accum.push(event);
          switch (event.type) {
            case "message_start": {
              emit({
                type: "message-start",
                role: "assistant",
                model: event.message.model,
              });
              break;
            }
            case "content_block_start": {
              const block = event.content_block;
              if (block.type === "text") {
                blocks.set(event.index, {
                  type: "text",
                  jsonBuffer: "",
                  textBuffer: "",
                });
                if (!tagRouter) {
                  emit({
                    type: "content-start",
                    blockIndex: event.index,
                    blockType: "text",
                  });
                  startedTextBlocks.add(event.index);
                }
                // With tagRouter, content-start is emitted lazily when the
                // first non-tag text chunk arrives.
              } else if (block.type === "tool_use") {
                blocks.set(event.index, {
                  type: "tool_use",
                  callId: block.id,
                  name: block.name,
                  jsonBuffer: "",
                  textBuffer: "",
                });
                emit({
                  type: "tool-call-start",
                  callId: block.id,
                  name: block.name,
                  blockIndex: event.index,
                });
                startedToolBlocks.add(event.index);
              } else if (block.type === "thinking") {
                blocks.set(event.index, {
                  type: "thinking",
                  jsonBuffer: "",
                  textBuffer: "",
                });
                emit({ type: "reasoning-start", blockIndex: event.index });
                startedReasoningBlocks.add(event.index);
              } else if (block.type === "redacted_thinking") {
                blocks.set(event.index, {
                  type: "redacted_thinking",
                  jsonBuffer: "",
                  textBuffer: "[redacted]",
                });
                // Emit synthetic reasoning start so consumers see a placeholder.
                emit({ type: "reasoning-start", blockIndex: event.index });
                startedReasoningBlocks.add(event.index);
              }
              break;
            }
            case "content_block_delta": {
              const idx = event.index;
              const state = blocks.get(idx);
              const delta = event.delta;
              if (delta.type === "text_delta") {
                if (tagRouter) {
                  for (const ev of tagRouter.parser.process(delta.text)) {
                    handleTagEvent(ev, idx);
                  }
                } else {
                  emit({ type: "content-delta", blockIndex: idx, delta: delta.text });
                  if (state) state.textBuffer += delta.text;
                }
              } else if (delta.type === "input_json_delta") {
                if (state) state.jsonBuffer += delta.partial_json;
                emit({
                  type: "tool-call-delta",
                  callId: state?.callId ?? "",
                  delta: delta.partial_json,
                });
              } else if (delta.type === "thinking_delta") {
                emit({
                  type: "reasoning-delta",
                  blockIndex: idx,
                  delta: delta.thinking,
                });
                if (state) state.textBuffer += delta.thinking;
              }
              // signature_delta + citations_delta: ignored (G3 §10.4/§10.5).
              break;
            }
            case "content_block_stop": {
              const idx = event.index;
              const state = blocks.get(idx);
              if (!state) break;
              if (state.type === "text") {
                if (startedTextBlocks.has(idx)) {
                  emit({ type: "content-end", blockIndex: idx });
                  emit({
                    type: "content",
                    blockIndex: idx,
                    content: { type: "text", text: state.textBuffer } as ContentBlock,
                  });
                }
              } else if (state.type === "tool_use") {
                let parsed: Readonly<Record<string, unknown>> = {};
                try {
                  parsed = state.jsonBuffer
                    ? (JSON.parse(state.jsonBuffer) as Readonly<Record<string, unknown>>)
                    : {};
                } catch {
                  /* invalid JSON — emit empty input */
                }
                emit({ type: "tool-call-end", callId: state.callId ?? "" });
                emit({
                  type: "tool-call",
                  callId: state.callId ?? "",
                  name: state.name ?? "",
                  input: parsed,
                });
              } else if (state.type === "thinking" || state.type === "redacted_thinking") {
                emit({ type: "reasoning-end", blockIndex: idx });
                emit({
                  type: "reasoning",
                  blockIndex: idx,
                  reasoning: state.textBuffer,
                });
              }
              break;
            }
            case "message_delta":
            case "message_stop":
              break;
          }
        }
        // Drain any partial buffered tag content.
        if (tagRouter) {
          for (const ev of tagRouter.parser.flush()) {
            handleTagEvent(ev, 0);
          }
        }

        // If tag-router routed reasoning to its synthetic block, emit close.
        if (routerReasoningStarted && routerReasoningAccum.length > 0) {
          emit({ type: "reasoning-end", blockIndex: routerReasoningBlockIndex });
          emit({
            type: "reasoning",
            blockIndex: routerReasoningBlockIndex,
            reasoning: routerReasoningAccum,
          });
        }

        const final = accum.toMessage(params.model);

        // When tagRouter is active, rewrite the synthesized Message so
        // normalize() picks up cleaned text + extracted reasoning.
        if (tagRouter) {
          // Replace each text block's text with its cleaned textBuffer
          // (already drained through the router via blocks.textBuffer).
          let textIndex = 0;
          const cleanedContent: AnthropicMessage["content"] = [];
          for (const [, st] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
            if (st.type === "text") {
              if (st.textBuffer.length > 0) {
                cleanedContent.push({
                  type: "text",
                  text: st.textBuffer,
                  citations: null,
                } as AnthropicTextBlock);
              }
              textIndex++;
            } else if (st.type === "tool_use") {
              let parsed: unknown = {};
              try {
                parsed = st.jsonBuffer ? JSON.parse(st.jsonBuffer) : {};
              } catch {
                parsed = {};
              }
              cleanedContent.push({
                type: "tool_use",
                id: st.callId ?? "",
                name: st.name ?? "",
                input: parsed,
              } as AnthropicToolUseBlock);
            } else if (st.type === "thinking") {
              cleanedContent.push({
                type: "thinking",
                thinking: st.textBuffer,
                signature: "",
              } as AnthropicThinkingBlock);
            }
          }
          // Surface router-routed reasoning as a synthetic thinking block.
          if (routerReasoningAccum.length > 0) {
            cleanedContent.unshift({
              type: "thinking",
              thinking: routerReasoningAccum,
              signature: "",
            } as AnthropicThinkingBlock);
          }
          (final as { content: AnthropicMessage["content"] }).content = cleanedContent;
          void textIndex;
        }

        const stopReason = mapFinishReason(final.stop_reason);
        const usage = toUsageStats(final.usage);
        emit({ type: "message-end", stopReason, usage });

        const messageContent = anthropicContentToContentBlocks(final.content);
        emit({
          type: "message",
          message: {
            role: "assistant",
            content: messageContent,
            model: final.model,
          },
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
              return Promise.resolve({
                value: undefined as unknown as AdapterDelta,
                done: true,
              });
            }
            return new Promise((resolve) => resolvers.push(resolve));
          },
          return(): Promise<IteratorResult<AdapterDelta>> {
            complete();
            return Promise.resolve({
              value: undefined as unknown as AdapterDelta,
              done: true,
            });
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
      cause: new Error("anthropic executor inbox dispatch not yet wired"),
    });
  }

  // ──────── internals ────────

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
        const params = toAnthropicParams(
          input.targetInput,
          input.target,
          this.defaultModel,
          this.defaultMaxTokens,
        );
        const wantStream =
          this.streamByDefault && (input.target.capabilities?.supportsStreaming ?? true);
        const signal = mergeSignals(input.signal, controller.signal);

        if (!wantStream) {
          return yield* Effect.tryPromise<unknown, ExecuteError>({
            try: () =>
              this.client.messages.create(
                { ...params, stream: false } as MessageCreateParamsNonStreaming,
                { signal },
              ) as unknown as Promise<AnthropicMessage>,
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
    params: MessageCreateParams,
    signal: AbortSignal | undefined,
    op: Operation<unknown, unknown> | undefined,
  ): Effect.Effect<AnthropicMessage, ExecuteError, never> {
    return Effect.gen(this, function* () {
      const stream = yield* Effect.tryPromise<AsyncIterable<RawMessageStreamEvent>, ExecuteError>({
        try: () =>
          this.client.messages.create({ ...params, stream: true } as MessageCreateParamsStreaming, {
            signal,
          }) as unknown as Promise<AsyncIterable<RawMessageStreamEvent>>,
        catch: (cause): ExecuteError => mapExecuteError(cause),
      });

      const iterator = stream[Symbol.asyncIterator]();
      const accum = new AnthropicStreamAccumulator();
      while (true) {
        const step = yield* Effect.tryPromise<IteratorResult<RawMessageStreamEvent>, ExecuteError>({
          try: () => iterator.next(),
          catch: (cause): ExecuteError => mapExecuteError(cause),
        });
        if (step.done) break;
        const event = step.value;
        accum.push(event);
        if (op !== undefined) {
          yield* this.emitDeltaLazy(op, () => summarizeEvent(event)).pipe(Effect.orDie);
        }
      }

      return accum.toMessage(params.model);
    });
  }

  private runBody(
    input: RunInput,
    executionId: string,
    op: Operation<RunInput, ExecutorTerminal<LanguageModelExecutionResult>>,
  ): Effect.Effect<ExecutorTerminal<LanguageModelExecutionResult>, ExecutorError, never> {
    return Effect.gen(this, function* () {
      if (this.aborted.has(executionId)) {
        const terminal: ExecutorTerminal<LanguageModelExecutionResult> = {
          outcome: "canceled",
          reason: this.inFlight.get(executionId)?.abortReason ?? "aborted",
        };
        return terminal;
      }

      const projected = projectImpl({
        compiled: input.compiled,
        target: input.target,
      });

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

      if (
        raw &&
        typeof raw === "object" &&
        "outcome" in raw &&
        (raw as { outcome?: string }).outcome === "canceled"
      ) {
        return raw as ExecutorTerminal<LanguageModelExecutionResult>;
      }

      const router = buildTagRouter({
        parseThinkTags: this.parseThinkTags,
        customBlocks: this.customBlocks,
      });
      const rawForNormalize = router ? applyTagRouterToMessage(raw, router) : raw;

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

function buildClientOptions(opts: AnthropicExecutorOptions): ClientOptions {
  // Env-var fallbacks fill in any field absent from explicit
  // clientOptions. Explicit values win.
  const base: ClientOptions = {};
  const envApiKey = process.env["ANTHROPIC_API_KEY"];
  if (envApiKey !== undefined) base.apiKey = envApiKey;
  const envBaseURL = process.env["ANTHROPIC_BASE_URL"];
  if (envBaseURL !== undefined) base.baseURL = envBaseURL;
  if (opts.clientOptions !== undefined) {
    return { ...base, ...opts.clientOptions };
  }
  return base;
}

// ============================================================================
// Tag routing — shared StreamTagParser machinery (G7 + G12)
// ============================================================================

type TagMode = "reasoning" | "custom-block";

interface TagRouter {
  readonly parser: StreamTagParser;
  modeFor(tag: string): TagMode;
}

function buildTagRouter(opts: {
  parseThinkTags: boolean;
  customBlocks?: Readonly<Record<string, CustomBlockDefinition>>;
}): TagRouter | null {
  const tagModes = new Map<string, TagMode>();
  const handlers: Record<string, StreamTagHandler> = {};

  if (opts.parseThinkTags) {
    tagModes.set("think", "reasoning");
    handlers["think"] = {};
  }
  if (opts.customBlocks) {
    for (const [key, def] of Object.entries(opts.customBlocks)) {
      const tagName = def.tag ?? key;
      tagModes.set(tagName, "custom-block");
      const h: StreamTagHandler = {};
      if (def.onStart) h.onStart = def.onStart;
      if (def.onContent) h.onContent = def.onContent;
      if (def.onSelfClosing) h.onSelfClosing = def.onSelfClosing;
      handlers[tagName] = h;
    }
  }
  if (tagModes.size === 0) return null;
  const parser = new StreamTagParser({ tags: handlers });
  return {
    parser,
    modeFor(tag) {
      return tagModes.get(tag) ?? "custom-block";
    },
  };
}

/**
 * Post-process a non-streaming Anthropic Message through the tag router.
 * Each text block's text is replaced with the cleaned version; any
 * reasoning extracted from `<think>` tags is prepended as a synthetic
 * thinking block.
 */
function applyTagRouterToMessage(raw: unknown, router: TagRouter): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as AnthropicMessage;
  if (!Array.isArray(r.content)) return raw;
  const newContent: AnthropicMessage["content"] = [];
  let reasoning = "";
  for (const block of r.content) {
    if (block.type === "text") {
      let cleaned = "";
      const events = [...router.parser.process(block.text), ...router.parser.flush()];
      for (const ev of events) {
        if (ev.type === "text") cleaned += ev.content;
        else if (ev.type === "block-delta") {
          if (router.modeFor(ev.tag) === "reasoning") reasoning += ev.delta;
        }
      }
      if (cleaned.length > 0) {
        newContent.push({
          type: "text",
          text: cleaned,
          citations: block.citations ?? null,
        } as AnthropicTextBlock);
      }
    } else {
      newContent.push(block);
    }
  }
  if (reasoning.length > 0) {
    newContent.unshift({
      type: "thinking",
      thinking: reasoning,
      signature: "",
    } as AnthropicThinkingBlock);
  }
  (r as { content: AnthropicMessage["content"] }).content = newContent;
  return raw;
}

// ============================================================================
// IR → Anthropic params
// ============================================================================

function toAnthropicParams(
  input: LanguageModelInput,
  target: ExecutionTarget,
  defaultModel: string | undefined,
  executorMaxTokens: number | undefined,
): MessageCreateParams {
  const { system, messages } = toAnthropicMessages(input.messages);
  const tools = input.tools && input.tools.length > 0 ? toAnthropicTools(input.tools) : undefined;

  const params: MessageCreateParams = {
    model: target.modelId ?? defaultModel ?? DEFAULT_MODEL,
    messages,
    max_tokens: input.parameters?.maxOutputTokens ?? executorMaxTokens ?? DEFAULT_MAX_TOKENS,
  } as MessageCreateParams;

  if (system !== undefined) (params as { system?: MessageCreateParams["system"] }).system = system;
  if (tools !== undefined) params.tools = tools;
  const p = input.parameters;
  if (p?.temperature !== undefined) params.temperature = p.temperature;
  if (p?.topP !== undefined) params.top_p = p.topP;
  if (p?.stopSequences !== undefined) params.stop_sequences = [...p.stopSequences];
  // Silently drop frequencyPenalty / presencePenalty / responseFormat —
  // Anthropic has no native support (G1 caveat from the skill).

  // Adopter escape hatch — spread last so explicit overrides win.
  const overrides = target.providerOptions?.anthropic;
  if (overrides && typeof overrides === "object") {
    Object.assign(params, overrides);
  }
  return params;
}

/** Read `providerMetadata.anthropic.cacheControl` from a part as a
 *  validated SDK `cache_control` value, or undefined. */
function readBlockCacheControl(part: {
  readonly providerMetadata?: Record<string, Record<string, unknown>>;
}): { type: "ephemeral" } | undefined {
  const v = part.providerMetadata?.["anthropic"]?.["cacheControl"];
  if (v && typeof v === "object" && "type" in v && (v as { type?: unknown }).type === "ephemeral") {
    return { type: "ephemeral" };
  }
  return undefined;
}

function toAnthropicMessages(messages: ReadonlyArray<LanguageModelMessage>): {
  system: string | Array<TextBlockParam> | undefined;
  messages: Array<MessageParam>;
} {
  // Track each collected system text + whether the source part marked
  // itself ephemeral via providerMetadata. If ANY system part is
  // marked, emit the array form so cache_control can land on the
  // right segment.
  const systemEntries: Array<{ text: string; cache: boolean }> = [];
  const out: Array<MessageParam> = [];

  for (const message of messages) {
    if (message.role === "system") {
      for (const part of message.content) {
        if (part.type !== "text" || !part.text) continue;
        systemEntries.push({
          text: part.text,
          cache: readBlockCacheControl(part) !== undefined,
        });
      }
      continue;
    }

    const role: "user" | "assistant" = message.role === "assistant" ? "assistant" : "user";
    const content: ContentBlockParam[] = [];

    for (const part of message.content) {
      const cache = readBlockCacheControl(part);
      switch (part.type) {
        case "text": {
          const block: TextBlockParam = { type: "text", text: part.text };
          if (cache) block.cache_control = cache;
          content.push(block);
          break;
        }
        case "image": {
          const source = imageSourceFromUrl(part.imageUrl, part.mediaType);
          const block: ImageBlockParam = { type: "image", source };
          if (cache) (block as { cache_control?: { type: "ephemeral" } }).cache_control = cache;
          content.push(block);
          break;
        }
        case "tool_use": {
          const block: ToolUseBlockParam = {
            type: "tool_use",
            id: part.id,
            name: part.name,
            input: (part.input ?? {}) as Record<string, unknown>,
          };
          if (cache) (block as { cache_control?: { type: "ephemeral" } }).cache_control = cache;
          content.push(block);
          break;
        }
        case "tool_result": {
          const inner = toolResultContent(part.content);
          const block: ToolResultBlockParam = {
            type: "tool_result",
            tool_use_id: part.toolUseId,
            content: inner,
            ...(part.isError ? { is_error: true } : {}),
          };
          if (cache) (block as { cache_control?: { type: "ephemeral" } }).cache_control = cache;
          content.push(block);
          break;
        }
      }
    }
    if (content.length === 0) continue;

    // Strict user/assistant alternation: coalesce consecutive same-role.
    const last = out[out.length - 1];
    if (last && last.role === role) {
      if (Array.isArray(last.content)) {
        (last.content as ContentBlockParam[]).push(...content);
      } else {
        last.content = [{ type: "text", text: last.content } as TextBlockParam, ...content];
      }
    } else {
      out.push({ role, content });
    }
  }

  // System param: array form if any segment marked ephemeral, else
  // joined string.
  let systemOut: string | Array<TextBlockParam> | undefined;
  if (systemEntries.length === 0) {
    systemOut = undefined;
  } else if (systemEntries.some((e) => e.cache)) {
    systemOut = systemEntries.map((e) => {
      const block: TextBlockParam = { type: "text", text: e.text };
      if (e.cache) block.cache_control = { type: "ephemeral" };
      return block;
    });
  } else {
    systemOut = systemEntries.map((e) => e.text).join("\n\n");
  }
  return { system: systemOut, messages: out };
}

function toolResultContent(
  parts: ReadonlyArray<LanguageModelMessagePart>,
): Array<TextBlockParam | ImageBlockParam> {
  const result: Array<TextBlockParam | ImageBlockParam> = [];
  for (const c of parts) {
    if (c.type === "text") {
      result.push({ type: "text", text: c.text } as TextBlockParam);
    } else if (c.type === "image") {
      const source = imageSourceFromUrl(c.imageUrl, c.mediaType);
      result.push({ type: "image", source } as ImageBlockParam);
    } else {
      // Flatten anything else to a JSON text representation (matches v1).
      result.push({ type: "text", text: JSON.stringify(c) } as TextBlockParam);
    }
  }
  if (result.length === 0) {
    // Anthropic rejects empty tool_result.content — insert placeholder.
    result.push({ type: "text", text: "Done" } as TextBlockParam);
  }
  return result;
}

function toAnthropicTools(tools: ReadonlyArray<LanguageModelTool>): Array<AnthropicTool> {
  return tools.map((t) => {
    const base: AnthropicTool = {
      name: t.name,
      input_schema: (t.inputSchema ?? {
        type: "object",
      }) as AnthropicTool["input_schema"],
    };
    if (t.description !== undefined) base.description = t.description;
    // Per-tool providerOptions.anthropic — adopter-supplied SDK
    // overrides (typically `cache_control` for prompt-cache breakpoints)
    // win over projected defaults.
    const overrides = t.providerOptions?.anthropic;
    return overrides ? { ...base, ...overrides } : base;
  });
}

function imageSourceFromUrl(
  imageUrl: string,
  mimeType: string | undefined,
):
  | {
      type: "base64";
      media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
      data: string;
    }
  | { type: "url"; url: string } {
  if (imageUrl.startsWith("data:")) {
    // data:image/png;base64,XXXX
    const match = /^data:([^;]+);base64,(.*)$/.exec(imageUrl);
    if (match) {
      const inferred = (match[1] ?? mimeType ?? "image/png") as
        | "image/jpeg"
        | "image/png"
        | "image/gif"
        | "image/webp";
      return {
        type: "base64",
        media_type: inferred,
        data: match[2] ?? "",
      };
    }
  }
  return { type: "url", url: imageUrl };
}

// ============================================================================
// IR projection
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
  // Emit one text part per section (not a single joined string) so
  // per-section `metadata.providerMetadata` survives projection. The
  // executor reads each part's providerMetadata in
  // `toAnthropicMessages` to decide string vs array system form.
  const systemParts: LanguageModelMessagePart[] = [];
  for (const e of tree.context.entries) {
    if (e.kind !== "section") continue;
    const text = sectionText(e);
    if (text.length === 0) continue;
    const part: LanguageModelMessagePart = { type: "text", text };
    const pm = e.metadata?.providerMetadata;
    if (pm !== undefined) {
      (part as { providerMetadata?: Record<string, Record<string, unknown>> }).providerMetadata =
        pm;
    }
    systemParts.push(part);
  }
  if (systemParts.length > 0) {
    messages.push({ role: "system", content: systemParts });
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

function sectionText(section: SectionEntry): string {
  const head = section.title ? `## ${section.title}\n\n` : "";
  const body = section.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter((t) => t.length > 0)
    .join("\n\n");
  return head + body;
}

function imageUrlFromSource(source: MediaSource, mimeType: string | undefined): string {
  switch (source.type) {
    case "url":
      return source.url;
    case "base64": {
      const mt = source.mimeType ?? mimeType ?? "image/png";
      return `data:${mt};base64,${source.data}`;
    }
    case "reference":
      return source.fileId;
    case "s3":
      return `s3://${source.bucket}/${source.key}`;
    case "gcs":
      return `gs://${source.bucket}/${source.object}`;
  }
}

function messagePartFromBlock(block: ContentBlock): LanguageModelMessagePart {
  const pm =
    block.providerMetadata !== undefined ? { providerMetadata: block.providerMetadata } : {};
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text, ...pm };
    case "image":
      return {
        type: "image",
        imageUrl: imageUrlFromSource(block.source, block.mimeType),
        ...(block.mimeType !== undefined ? { mediaType: block.mimeType } : {}),
        ...pm,
      };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.toolUseId,
        name: block.name,
        input: block.input,
        ...pm,
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: block.toolUseId,
        content: block.content.map(messagePartFromBlock),
        ...(block.isError !== undefined ? { isError: block.isError } : {}),
        ...pm,
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
      ...(t.providerOptions !== undefined ? { providerOptions: t.providerOptions } : {}),
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
// Anthropic Message → LanguageModelExecutionResult
// ============================================================================

function normalizeImpl(input: NormalizeInput<unknown>): LanguageModelExecutionResult {
  const raw = input.targetOutput;
  if (!isAnthropicMessage(raw)) {
    throw new Error("normalize expected Anthropic Message shape");
  }
  const output = anthropicContentToContentBlocks(raw.content);
  const toolCalls: ToolCall[] = [];
  for (const block of raw.content) {
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  const stopReason = mapFinishReason(raw.stop_reason);
  const usage = toUsageStats(raw.usage);

  const result: LanguageModelExecutionResult = {
    specVersion: SPEC_VERSION_LITERAL,
    output,
    stopReason,
    usage,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    raw,
  };
  return result;
}

function anthropicContentToContentBlocks(
  content: AnthropicMessage["content"] | undefined,
): ContentBlock[] {
  const output: ContentBlock[] = [];
  if (!content) return output;
  for (const block of content) {
    switch (block.type) {
      case "text":
        if ((block as AnthropicTextBlock).text.length > 0) {
          output.push({ type: "text", text: (block as AnthropicTextBlock).text });
        }
        break;
      case "tool_use": {
        const t = block as AnthropicToolUseBlock;
        output.push({
          type: "tool_use",
          toolUseId: t.id,
          name: t.name,
          input: (t.input ?? {}) as Record<string, unknown>,
        });
        break;
      }
      case "thinking":
        output.push({
          type: "reasoning",
          text: (block as AnthropicThinkingBlock).thinking,
        });
        break;
      case "redacted_thinking":
        output.push({
          type: "reasoning",
          text: "[redacted]",
        });
        void (block as RedactedThinkingBlock);
        break;
    }
  }
  return output;
}

function isAnthropicMessage(v: unknown): v is AnthropicMessage {
  if (!v || typeof v !== "object") return false;
  const o = v as { type?: unknown; content?: unknown };
  return o.type === "message" && Array.isArray(o.content);
}

function toUsageStats(usage: Usage | undefined | null): UsageStats {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(usage.cache_read_input_tokens != null
      ? { cachedInputTokens: usage.cache_read_input_tokens }
      : {}),
    ...(usage.cache_creation_input_tokens != null
      ? { cacheCreationTokens: usage.cache_creation_input_tokens }
      : {}),
  };
}

// ============================================================================
// Streaming accumulator
// ============================================================================

interface AccumBlockState {
  type: "text" | "thinking" | "tool_use" | "redacted_thinking";
  callId?: string;
  name?: string;
  textBuffer: string;
  jsonBuffer: string;
  data?: string;
}

class AnthropicStreamAccumulator {
  private id = "";
  private model = "";
  private blocks = new Map<number, AccumBlockState>();
  private stopReason: AnthropicMessage["stop_reason"] = null;
  private stopSequence: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheRead: number | null = null;
  private cacheCreation: number | null = null;

  push(event: RawMessageStreamEvent): void {
    switch (event.type) {
      case "message_start": {
        if (event.message.id) this.id = event.message.id;
        if (event.message.model) this.model = event.message.model;
        const u = event.message.usage;
        if (u) {
          if (u.input_tokens != null) this.inputTokens = u.input_tokens;
          if (u.output_tokens != null) this.outputTokens = u.output_tokens;
          if (u.cache_read_input_tokens != null) this.cacheRead = u.cache_read_input_tokens;
          if (u.cache_creation_input_tokens != null)
            this.cacheCreation = u.cache_creation_input_tokens;
        }
        break;
      }
      case "content_block_start": {
        const b = event.content_block;
        if (b.type === "text") {
          this.blocks.set(event.index, {
            type: "text",
            textBuffer: "",
            jsonBuffer: "",
          });
        } else if (b.type === "tool_use") {
          this.blocks.set(event.index, {
            type: "tool_use",
            callId: b.id,
            name: b.name,
            textBuffer: "",
            jsonBuffer: "",
          });
        } else if (b.type === "thinking") {
          this.blocks.set(event.index, {
            type: "thinking",
            textBuffer: "",
            jsonBuffer: "",
          });
        } else if (b.type === "redacted_thinking") {
          this.blocks.set(event.index, {
            type: "redacted_thinking",
            textBuffer: "",
            jsonBuffer: "",
            data: (b as RedactedThinkingBlock).data,
          });
        }
        break;
      }
      case "content_block_delta": {
        const s = this.blocks.get(event.index);
        if (!s) break;
        const d = event.delta;
        if (d.type === "text_delta") s.textBuffer += d.text;
        else if (d.type === "input_json_delta") s.jsonBuffer += d.partial_json;
        else if (d.type === "thinking_delta") s.textBuffer += d.thinking;
        break;
      }
      case "message_delta": {
        if (event.delta.stop_reason) this.stopReason = event.delta.stop_reason;
        if (event.delta.stop_sequence != null) this.stopSequence = event.delta.stop_sequence;
        if (event.usage?.output_tokens != null) this.outputTokens = event.usage.output_tokens;
        break;
      }
      default:
        break;
    }
  }

  toMessage(modelHint: string): AnthropicMessage {
    const content: AnthropicMessage["content"] = [];
    for (const [, s] of [...this.blocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (s.type === "text") {
        if (s.textBuffer.length > 0) {
          content.push({
            type: "text",
            text: s.textBuffer,
            citations: null,
          } as AnthropicTextBlock);
        }
      } else if (s.type === "tool_use") {
        let parsed: unknown = {};
        try {
          parsed = s.jsonBuffer ? JSON.parse(s.jsonBuffer) : {};
        } catch {
          parsed = {};
        }
        content.push({
          type: "tool_use",
          id: s.callId ?? "",
          name: s.name ?? "",
          input: parsed,
        } as AnthropicToolUseBlock);
      } else if (s.type === "thinking") {
        content.push({
          type: "thinking",
          thinking: s.textBuffer,
          signature: "",
        } as AnthropicThinkingBlock);
      } else if (s.type === "redacted_thinking") {
        content.push({
          type: "redacted_thinking",
          data: s.data ?? "",
        } as RedactedThinkingBlock);
      }
    }
    return {
      id: this.id || `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: this.model || modelHint,
      content,
      stop_reason: this.stopReason ?? "end_turn",
      stop_sequence: this.stopSequence,
      usage: {
        input_tokens: this.inputTokens,
        output_tokens: this.outputTokens,
        cache_read_input_tokens: this.cacheRead,
        cache_creation_input_tokens: this.cacheCreation,
      },
    } as AnthropicMessage;
  }
}

function summarizeEvent(event: RawMessageStreamEvent): {
  kind: string;
  delta?: string;
  blockIndex?: number;
  metadata?: Record<string, unknown>;
} {
  switch (event.type) {
    case "message_start":
      return { kind: "message_start", metadata: { model: event.message.model } };
    case "content_block_start":
      return {
        kind: "content_block_start",
        blockIndex: event.index,
        metadata: { blockType: event.content_block.type },
      };
    case "content_block_delta": {
      const d = event.delta;
      if (d.type === "text_delta")
        return { kind: "content_delta", delta: d.text, blockIndex: event.index };
      if (d.type === "input_json_delta")
        return { kind: "tool_call_delta", delta: d.partial_json, blockIndex: event.index };
      if (d.type === "thinking_delta")
        return { kind: "reasoning_delta", delta: d.thinking, blockIndex: event.index };
      return { kind: "noop" };
    }
    case "content_block_stop":
      return { kind: "content_block_stop", blockIndex: event.index };
    case "message_delta":
      return {
        kind: "message_delta",
        metadata: { stopReason: event.delta.stop_reason ?? null },
      };
    case "message_stop":
      return { kind: "message_stop" };
    default:
      return { kind: "noop" };
  }
}

// ============================================================================
// Stop-reason mapping
// ============================================================================

function mapFinishReason(reason: string | null | undefined): LanguageModelStopReason {
  switch (reason) {
    case "end_turn":
      return "end";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "tool_use":
      return "tool_use";
    default:
      return "end";
  }
}

// ============================================================================
// Error + signal helpers
// ============================================================================

function mapExecuteError(cause: unknown): ExecuteError {
  if (cause instanceof Error) {
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
