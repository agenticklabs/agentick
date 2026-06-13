/**
 * `GoogleExecutor` — `LanguageModelExecutor` backed by the Gemini API
 * (`@google/genai` SDK). Supports the Gemini Developer API (apiKey
 * path) and Vertex AI (project/location/auth path).
 *
 * Gemini-specific knobs handled at this layer:
 * - `sanitizeSchemaForGemini` — strict JSON-Schema subset for tool input
 * - `thoughtSignature` round-trip (Gemini 3+ thinking; opaque signature
 *   that MUST be sent back on subsequent turns to avoid
 *   MISSING_THOUGHT_SIGNATURE)
 * - `part.thought` flag routes text parts to the reasoning channel
 *   (Gemini 2.5+ thinking models)
 * - `thoughtsTokenCount` + `cachedContentTokenCount` usage surfacing
 *
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

import { Effect } from "effect";
import {
  GoogleGenAI,
  FinishReason,
  type Content,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type GoogleGenAIOptions,
  type Part,
  type Tool as GoogleTool,
  type FunctionDeclaration,
} from "@google/genai";

import { BaseHarness, runHarnessProtocol, ulid } from "@agentick/runtime-next";
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
// ProviderOptions augmentation — typed Google escape hatch (G5)
// ============================================================================

/**
 * All three v2 provider-option tiers contributed at once via the
 * SDK's actual types — no hand-rolled subsets.
 *
 * - `ProviderClientOptions["google"]`: {@link GoogleGenAIOptions} —
 *   every field the SDK constructor accepts (apiKey, vertexai,
 *   project, location, googleAuthOptions, httpOptions…).
 *
 * - `ProviderOptions["google"]`: {@link GenerateContentConfig} —
 *   every field the SDK accepts on per-call `config` (temperature,
 *   topP, topK, seed, safetySettings, thinkingConfig, cachedContent,
 *   responseLogprobs, …). Spread last onto the request config so
 *   any canonical knob the executor sets from
 *   `LanguageModelParameters` can be overridden by the adopter.
 *   Fields the executor controls structurally and SHOULD NOT be set
 *   via providerOptions: `systemInstruction`, `tools`, `abortSignal`,
 *   `httpOptions`.
 *
 * - `ProviderToolOptions["google"]`: `Partial<FunctionDeclaration>` —
 *   per-tool overrides merged onto the projected function
 *   declaration (e.g. `behavior`, custom `parameters`, etc.).
 */
declare module "@agentick/spec-next" {
  interface ProviderClientOptions {
    readonly google?: GoogleGenAIOptions;
  }
  interface ProviderOptions {
    readonly google?: GenerateContentConfig;
  }
  interface ProviderToolOptions {
    readonly google?: Partial<FunctionDeclaration>;
  }
}

// ============================================================================
// Construction options
// ============================================================================

export interface GoogleExecutorOptions {
  /** Default model id. Overridable per call via `target.modelId`. */
  readonly model?: string;
  /**
   * SDK client construction options — every field
   * `@google/genai`'s `GoogleGenAI` constructor accepts (apiKey,
   * vertexai, project, location, googleAuthOptions, httpOptions, …).
   * Typed via the augmentable
   * {@link import("@agentick/spec-next").ProviderClientOptions} slot —
   * adopters get full IntelliSense from the SDK directly. Ignored
   * when `client` is supplied.
   *
   * Env-var fallbacks (`GOOGLE_API_KEY`, `GEMINI_API_KEY`,
   * `GOOGLE_GENAI_BASE_URL`) are applied during construction when the
   * corresponding field is absent.
   */
  readonly clientOptions?: GoogleGenAIOptions;
  /** Inject a pre-built `GoogleGenAI` client (testing, advanced setups). */
  readonly client?: GoogleGenAI;
  /** Whether `run()` streams by default. Per-call wins via the target. */
  readonly stream?: boolean;
  /**
   * Parse inline `<think>...</think>` tags in text. For Gemini 2.5+
   * thinking models, native `part.thought === true` is preferred —
   * this is for the niche case of piping a non-thinking Gemini
   * through a pre-prompt eliciting `<think>` artifacts.
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
const DEFAULT_MODEL = "gemini-2.5-flash";

// ============================================================================
// GoogleExecutor
// ============================================================================

export class GoogleExecutor extends BaseHarness<"executor"> implements LanguageModelExecutor {
  readonly family = "language-model" as const;
  readonly target: ExecutionTarget;

  private readonly client: GoogleGenAI;
  private readonly defaultModel: string | undefined;
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
    options: GoogleExecutorOptions = {},
  ) {
    super("executor", scopeId, journal, bus, inbox);
    this.client = options.client ?? new GoogleGenAI(buildClientOptions(options));
    this.defaultModel = options.model;
    this.streamByDefault = options.stream ?? false;
    this.parseThinkTags = options.parseThinkTags ?? false;
    this.customBlocks = options.customBlocks;
    this.target = options.target ?? {
      kind: "language-model",
      provider: "google",
      modelId: options.model ?? DEFAULT_MODEL,
      capabilities: {
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
        contextWindow: 1_000_000,
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

  executeStream(input: ExecuteInput<LanguageModelInput>): ExecutorStream<GenerateContentResponse> {
    const queue: AdapterDelta[] = [];
    const resolvers: Array<(r: IteratorResult<AdapterDelta>) => void> = [];
    let done = false;
    let resultResolve!: (v: GenerateContentResponse) => void;
    let resultReject!: (e: unknown) => void;
    const resultPromise = new Promise<GenerateContentResponse>((res, rej) => {
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
    const streamOp: Operation<ExecuteInput<LanguageModelInput>, GenerateContentResponse> = {
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
        const params = toGoogleParams(input.targetInput, input.target, this.defaultModel);

        const stream = await this.client.models.generateContentStream({
          ...params,
          // The SDK doesn't accept abort signal on the call directly; we
          // rely on the user-provided AbortController. Aborts surface as
          // the stream iterator throwing.
        });

        const tagRouter = buildTagRouter({
          parseThinkTags: this.parseThinkTags,
          customBlocks: this.customBlocks,
        });

        // Single-pass aggregation: build the final response shape as we
        // stream. No second walk in normalize() — see G18 perf notes.
        const accum = new GoogleStreamAccumulator();

        // Active-block tracking. Gemini doesn't give us indices, so we
        // maintain a logical index that bumps when the block type changes.
        let blockIndex = -1;
        let activeKind: "text" | "reasoning" | null = null;
        let routerReasoningStarted = false;
        let routerReasoningAccum = "";

        const closeActive = (): void => {
          if (activeKind === "text") {
            emit({ type: "content-end", blockIndex });
            const text = accum.currentTextBuffer();
            emit({
              type: "content",
              blockIndex,
              content: { type: "text", text } as ContentBlock,
            });
          } else if (activeKind === "reasoning") {
            emit({ type: "reasoning-end", blockIndex });
            emit({
              type: "reasoning",
              blockIndex,
              reasoning: accum.currentReasoningBuffer(),
            });
          }
          activeKind = null;
        };

        const handleTagEvent = (event: StreamTagEvent): void => {
          if (event.type === "text") {
            if (event.content.length === 0) return;
            if (activeKind !== "text") {
              closeActive();
              blockIndex += 1;
              accum.startTextBlock();
              emit({ type: "content-start", blockIndex, blockType: "text" });
              activeKind = "text";
            }
            emit({ type: "content-delta", blockIndex, delta: event.content });
            accum.appendText(event.content);
            return;
          }
          const mode = tagRouter!.modeFor(event.tag);
          if (mode === "reasoning") {
            switch (event.type) {
              case "block-start":
                if (!routerReasoningStarted) {
                  // Logical reasoning block at synthetic index
                  if (activeKind !== null) closeActive();
                  blockIndex += 1;
                  accum.startReasoningBlock();
                  emit({ type: "reasoning-start", blockIndex });
                  routerReasoningStarted = true;
                  activeKind = "reasoning";
                }
                break;
              case "block-delta":
                if (!routerReasoningStarted) {
                  if (activeKind !== null) closeActive();
                  blockIndex += 1;
                  accum.startReasoningBlock();
                  emit({ type: "reasoning-start", blockIndex });
                  routerReasoningStarted = true;
                  activeKind = "reasoning";
                }
                emit({ type: "reasoning-delta", blockIndex, delta: event.delta });
                accum.appendReasoning(event.delta);
                routerReasoningAccum += event.delta;
                break;
              case "block-end":
              case "block":
                // Close handled at next non-tag content or end of stream.
                break;
            }
            return;
          }
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

        let modelSeen: string | undefined;
        let stopReason: LanguageModelStopReason = "end";
        let finalUsage: UsageStats | undefined;

        // The standalone executeStream() loop accumulates inline via
        // startTextBlock/appendText/recordToolCall as it emits
        // AdapterDeltas. Do NOT call `accum.pushChunk(chunk)` here —
        // that path is reserved for `executeStreamBody` (the run()
        // path) which does no emission and uses pushChunk as the sole
        // accumulator entry point.
        for await (const chunk of stream) {
          if (chunk.modelVersion && !modelSeen) modelSeen = chunk.modelVersion;
          const candidate = chunk.candidates?.[0];
          if (!candidate) continue;
          const parts = candidate.content?.parts ?? [];

          for (const part of parts) {
            const isThought = (part as { thought?: boolean }).thought === true;

            // Text path
            if (typeof part.text === "string" && part.text.length > 0) {
              if (isThought) {
                // Native Gemini 2.5+ thinking — route to reasoning channel.
                if (activeKind !== "reasoning") {
                  closeActive();
                  blockIndex += 1;
                  accum.startReasoningBlock();
                  emit({ type: "reasoning-start", blockIndex });
                  activeKind = "reasoning";
                }
                emit({ type: "reasoning-delta", blockIndex, delta: part.text });
                accum.appendReasoning(part.text);
                continue;
              }
              if (tagRouter) {
                for (const ev of tagRouter.parser.process(part.text)) {
                  handleTagEvent(ev);
                }
              } else {
                if (activeKind !== "text") {
                  closeActive();
                  blockIndex += 1;
                  accum.startTextBlock();
                  emit({ type: "content-start", blockIndex, blockType: "text" });
                  activeKind = "text";
                }
                emit({ type: "content-delta", blockIndex, delta: part.text });
                accum.appendText(part.text);
              }
              continue;
            }

            // Function call path
            if (part.functionCall) {
              closeActive();
              const fc = part.functionCall;
              const callId = fc.id ?? `call_${ulid()}`;
              const name = fc.name ?? "";
              const args = (fc.args ?? {}) as Record<string, unknown>;
              const signature = (part as { thoughtSignature?: string }).thoughtSignature;
              blockIndex += 1;
              accum.recordToolCall({
                callId,
                name,
                input: args,
                ...(signature !== undefined ? { thoughtSignature: signature } : {}),
              });
              emit({
                type: "tool-call-start",
                callId,
                name,
                blockIndex,
              });
              const jsonDelta = JSON.stringify(args);
              if (jsonDelta !== "{}") {
                emit({ type: "tool-call-delta", callId, delta: jsonDelta });
              }
              emit({ type: "tool-call-end", callId });
              emit({
                type: "tool-call",
                callId,
                name,
                input: args,
                ...(signature !== undefined
                  ? {
                      providerMetadata: {
                        google: { thoughtSignature: signature },
                      },
                    }
                  : {}),
              });
            }
          }

          if (candidate.finishReason) {
            stopReason = mapFinishReason(candidate.finishReason);
            finalUsage = toUsageStats(chunk.usageMetadata);
            accum.setFinishReason(candidate.finishReason);
            accum.setUsage(chunk.usageMetadata);
          }
        }

        // Drain tag router's remaining buffer.
        if (tagRouter) {
          for (const ev of tagRouter.parser.flush()) {
            handleTagEvent(ev);
          }
        }
        closeActive();

        if (!finalUsage) finalUsage = toUsageStats(undefined);

        emit({ type: "message-end", stopReason, usage: finalUsage });
        emit({
          type: "message",
          message: {
            role: "assistant",
            content: accum.toContentBlocks(),
            model: modelSeen ?? params.model,
          },
          stopReason,
          usage: finalUsage,
        });

        resultResolve(accum.toResponse(modelSeen ?? params.model));
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
      cause: new Error("google executor inbox dispatch not yet wired"),
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
        const params = toGoogleParams(input.targetInput, input.target, this.defaultModel);
        const wantStream =
          this.streamByDefault && (input.target.capabilities?.supportsStreaming ?? true);

        if (!wantStream) {
          return yield* Effect.tryPromise<unknown, ExecuteError>({
            try: () => this.client.models.generateContent(params),
            catch: (cause): ExecuteError => mapExecuteError(cause),
          });
        }

        return yield* this.executeStreamBody(params, op);
      } finally {
        this.inFlight.delete(executionId);
      }
    });
  }

  private executeStreamBody(
    params: GenerateContentParameters,
    op: Operation<unknown, unknown> | undefined,
  ): Effect.Effect<GenerateContentResponse, ExecuteError, never> {
    return Effect.gen(this, function* () {
      const stream = yield* Effect.tryPromise<AsyncIterable<GenerateContentResponse>, ExecuteError>(
        {
          try: () =>
            this.client.models.generateContentStream(params) as unknown as Promise<
              AsyncIterable<GenerateContentResponse>
            >,
          catch: (cause): ExecuteError => mapExecuteError(cause),
        },
      );

      const iterator = stream[Symbol.asyncIterator]();
      const accum = new GoogleStreamAccumulator();
      let modelSeen = params.model;
      while (true) {
        const step = yield* Effect.tryPromise<
          IteratorResult<GenerateContentResponse>,
          ExecuteError
        >({
          try: () => iterator.next(),
          catch: (cause): ExecuteError => mapExecuteError(cause),
        });
        if (step.done) break;
        const chunk = step.value;
        accum.pushChunk(chunk);
        if (chunk.modelVersion) modelSeen = chunk.modelVersion;
        if (op !== undefined) {
          yield* this.emitDeltaLazy(op, () => summarizeChunk(chunk)).pipe(Effect.orDie);
        }
        const cand = chunk.candidates?.[0];
        if (cand?.finishReason) {
          accum.setFinishReason(cand.finishReason);
          accum.setUsage(chunk.usageMetadata);
        }
      }
      return accum.toResponse(modelSeen);
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
      const rawForNormalize = router ? applyTagRouterToResponse(raw, router) : raw;

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

function buildClientOptions(opts: GoogleExecutorOptions): GoogleGenAIOptions {
  // Adopter-supplied clientOptions wins; env-var fallbacks fill in any
  // missing fields. Spread last so explicit clientOptions overrides
  // env-derived values.
  const base: GoogleGenAIOptions = {};
  const envApiKey = process.env["GOOGLE_API_KEY"] ?? process.env["GEMINI_API_KEY"];
  if (envApiKey !== undefined) base.apiKey = envApiKey;
  const envBaseUrl = process.env["GOOGLE_GENAI_BASE_URL"];
  if (envBaseUrl !== undefined) {
    base.httpOptions = { baseUrl: envBaseUrl };
  }
  if (opts.clientOptions !== undefined) {
    // Merge httpOptions deeply so env baseUrl + adopter timeout/headers
    // both land.
    const merged: GoogleGenAIOptions = { ...base, ...opts.clientOptions };
    if (base.httpOptions !== undefined && opts.clientOptions.httpOptions !== undefined) {
      merged.httpOptions = { ...base.httpOptions, ...opts.clientOptions.httpOptions };
    }
    return merged;
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
 * Post-process a non-streaming GenerateContentResponse through the tag
 * router. Each text part is replaced with its cleaned version; reasoning
 * extracted from `<think>` tags is prepended as a synthetic
 * `thought`-flagged text part.
 */
function applyTagRouterToResponse(raw: unknown, router: TagRouter): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as GenerateContentResponse;
  const candidate = r.candidates?.[0];
  if (!candidate?.content?.parts) return raw;
  const newParts: Part[] = [];
  let reasoning = "";
  for (const part of candidate.content.parts) {
    if (typeof part.text === "string" && !(part as { thought?: boolean }).thought) {
      let cleaned = "";
      const events = [...router.parser.process(part.text), ...router.parser.flush()];
      for (const ev of events) {
        if (ev.type === "text") cleaned += ev.content;
        else if (ev.type === "block-delta") {
          if (router.modeFor(ev.tag) === "reasoning") reasoning += ev.delta;
        }
      }
      if (cleaned.length > 0) newParts.push({ text: cleaned });
    } else {
      newParts.push(part);
    }
  }
  if (reasoning.length > 0) {
    newParts.unshift({ text: reasoning, thought: true } as Part);
  }
  (candidate.content as { parts: Part[] }).parts = newParts;
  return raw;
}

// ============================================================================
// IR → Google params
// ============================================================================

function toGoogleParams(
  input: LanguageModelInput,
  target: ExecutionTarget,
  defaultModel: string | undefined,
): GenerateContentParameters {
  const { systemInstruction, contents } = toGoogleContents(input.messages);
  const tools = input.tools && input.tools.length > 0 ? toGoogleTools(input.tools) : undefined;

  const config: Record<string, unknown> = {};
  const p = input.parameters;
  if (p?.temperature !== undefined) config.temperature = p.temperature;
  if (p?.maxOutputTokens !== undefined) config.maxOutputTokens = p.maxOutputTokens;
  if (p?.topP !== undefined) config.topP = p.topP;
  if (p?.stopSequences !== undefined) config.stopSequences = [...p.stopSequences];
  if (p?.responseFormat !== undefined) {
    if (p.responseFormat.type === "json" || p.responseFormat.type === "json_schema") {
      config.responseMimeType = "application/json";
    }
    if (p.responseFormat.type === "json_schema" && p.responseFormat.schema) {
      config.responseSchema = p.responseFormat.schema;
    }
  }
  // Silently drop frequencyPenalty / presencePenalty — Gemini has no native support.

  if (systemInstruction !== undefined) config.systemInstruction = systemInstruction;
  if (tools !== undefined) config.tools = tools;

  // G5 — adopter escape hatch. Spread last onto config.
  const overrides = target.providerOptions?.google;
  if (overrides && typeof overrides === "object") {
    Object.assign(config, overrides);
  }

  const params: GenerateContentParameters = {
    model: target.modelId ?? defaultModel ?? DEFAULT_MODEL,
    contents,
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
  return params;
}

function toGoogleContents(messages: ReadonlyArray<LanguageModelMessage>): {
  systemInstruction: { parts: Array<{ text: string }> } | undefined;
  contents: Content[];
} {
  const systemParts: string[] = [];
  const out: Content[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = message.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n\n");
      if (text) systemParts.push(text);
      continue;
    }

    const role: "user" | "model" = message.role === "assistant" ? "model" : "user";
    const parts: Part[] = [];

    for (const part of message.content) {
      switch (part.type) {
        case "text":
          if (part.text.length > 0) parts.push({ text: part.text });
          break;
        case "image": {
          const partOut = imagePartFromUrl(part.imageUrl, part.mediaType);
          if (partOut) parts.push(partOut);
          break;
        }
        case "tool_use": {
          const signature = part.providerMetadata?.["google"]?.["thoughtSignature"];
          const functionCallPart: Part = {
            functionCall: {
              id: part.id,
              name: part.name,
              args: (part.input ?? {}) as Record<string, unknown>,
            },
          };
          if (typeof signature === "string") {
            (functionCallPart as { thoughtSignature?: string }).thoughtSignature = signature;
          }
          parts.push(functionCallPart);
          break;
        }
        case "tool_result": {
          const responseText = toolResultText(part.content);
          parts.push({
            functionResponse: {
              id: part.toolUseId,
              name: lookupToolName(out, part.toolUseId) ?? part.toolUseId,
              response: { result: responseText },
            },
          });
          break;
        }
      }
    }
    if (parts.length === 0) continue;

    // Coalesce same-role consecutive entries (Google supports both
    // alternation and same-role coalescing, but coalescing is cleaner).
    const last = out[out.length - 1];
    if (last && last.role === role) {
      (last.parts as Part[]).push(...parts);
    } else {
      out.push({ role, parts });
    }
  }

  const systemInstruction =
    systemParts.length > 0 ? { parts: [{ text: systemParts.join("\n\n") }] } : undefined;

  return { systemInstruction, contents: out };
}

function toolResultText(parts: ReadonlyArray<LanguageModelMessagePart>): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part.type === "text") out.push(part.text);
    else out.push(JSON.stringify(part));
  }
  return out.join("\n") || "Done";
}

/**
 * Look up the function name associated with a previously-emitted
 * functionCall in the contents-so-far. Gemini requires the
 * functionResponse's `name` to match the original call's name (not the
 * id). Returns undefined if not found.
 */
function lookupToolName(contents: ReadonlyArray<Content>, toolUseId: string): string | undefined {
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i];
    if (!c || !Array.isArray(c.parts)) continue;
    for (const p of c.parts) {
      if (p.functionCall && p.functionCall.id === toolUseId) {
        return p.functionCall.name;
      }
    }
  }
  return undefined;
}

function imagePartFromUrl(imageUrl: string, mimeType: string | undefined): Part | null {
  if (imageUrl.startsWith("data:")) {
    const match = /^data:([^;]+);base64,(.*)$/.exec(imageUrl);
    if (match) {
      return {
        inlineData: {
          mimeType: match[1] ?? mimeType ?? "image/jpeg",
          data: match[2] ?? "",
        },
      };
    }
  }
  return {
    fileData: {
      mimeType: mimeType ?? "image/jpeg",
      fileUri: imageUrl,
    },
  };
}

function toGoogleTools(tools: ReadonlyArray<LanguageModelTool>): GoogleTool[] {
  const functionDeclarations: FunctionDeclaration[] = tools.map((t) => {
    const base: FunctionDeclaration = {
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      parameters: ensureObjectSchema(
        sanitizeSchemaForGemini(t.inputSchema as Record<string, unknown>),
      ) as FunctionDeclaration["parameters"],
    };
    // Per-tool providerOptions.google — adopter-supplied overrides
    // win over executor-projected defaults.
    const overrides = t.providerOptions?.google;
    return overrides ? { ...base, ...overrides } : base;
  });
  return [{ functionDeclarations }];
}

// ============================================================================
// IR projection (executor-agnostic shape)
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
  if (cfg.maxOutputTokens !== undefined) params.maxOutputTokens = cfg.maxOutputTokens;
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
// GenerateContentResponse → LanguageModelExecutionResult
// ============================================================================

function normalizeImpl(input: NormalizeInput<unknown>): LanguageModelExecutionResult {
  const raw = input.targetOutput;
  if (!isGoogleResponse(raw)) {
    throw new Error("normalize expected Google GenerateContentResponse shape");
  }
  const candidate = raw.candidates?.[0];
  const output: ContentBlock[] = [];
  const toolCalls: ToolCall[] = [];

  if (candidate?.content?.parts) {
    for (const part of candidate.content.parts) {
      const isThought = (part as { thought?: boolean }).thought === true;
      if (typeof part.text === "string" && part.text.length > 0) {
        if (isThought) {
          output.push({ type: "reasoning", text: part.text });
        } else {
          output.push({ type: "text", text: part.text });
        }
        continue;
      }
      if (part.functionCall) {
        const fc = part.functionCall;
        const id = fc.id ?? `call_${ulid()}`;
        const name = fc.name ?? "";
        const args = (fc.args ?? {}) as Record<string, unknown>;
        const signature = (part as { thoughtSignature?: string }).thoughtSignature;
        const providerMetadata =
          signature !== undefined ? { google: { thoughtSignature: signature } } : undefined;
        output.push({
          type: "tool_use",
          toolUseId: id,
          name,
          input: args,
          ...(providerMetadata !== undefined ? { providerMetadata } : {}),
        });
        toolCalls.push({
          id,
          name,
          input: args,
          ...(providerMetadata !== undefined ? { providerMetadata } : {}),
        });
      }
    }
  }

  const stopReason = mapFinishReason(candidate?.finishReason);
  const usage = toUsageStats(raw.usageMetadata);

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

function isGoogleResponse(v: unknown): v is GenerateContentResponse {
  if (!v || typeof v !== "object") return false;
  const o = v as { candidates?: unknown };
  return Array.isArray(o.candidates);
}

function toUsageStats(usage: GenerateContentResponse["usageMetadata"]): UsageStats {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  const inputTokens = usage.promptTokenCount ?? 0;
  const outputTokens = usage.candidatesTokenCount ?? 0;
  const totalTokens = usage.totalTokenCount ?? inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(usage.thoughtsTokenCount != null ? { reasoningTokens: usage.thoughtsTokenCount } : {}),
    ...(usage.cachedContentTokenCount != null
      ? { cachedInputTokens: usage.cachedContentTokenCount }
      : {}),
  };
}

// ============================================================================
// Stream accumulator — single-pass: build ContentBlock[] during streaming.
// ============================================================================

interface AccumToolCall {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  thoughtSignature?: string;
}

type AccumBlock =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_use"; call: AccumToolCall };

/**
 * Single-pass accumulator that builds the IR-shaped `ContentBlock[]`
 * directly during streaming. Avoids the dual-walk pattern in older
 * adapters (provider chunks → synthesized raw → ContentBlock[]).
 * `toResponse` synthesizes a GenerateContentResponse only when callers
 * still need it (non-streaming-path consumers + tests).
 */
class GoogleStreamAccumulator {
  private blocks: AccumBlock[] = [];
  private currentText: AccumBlock | null = null;
  private currentReasoning: AccumBlock | null = null;
  private finish: FinishReason | undefined;
  private usage: GenerateContentResponse["usageMetadata"];

  /**
   * Full-walk accumulation used by `executeStreamBody` (the
   * `run()` path) which does not emit AdapterDeltas itself —
   * accumulation IS the entire job there. Walks each part and
   * records text / reasoning / functionCalls / usage / finishReason.
   * Idempotent on no-op chunks.
   *
   * The standalone `executeStream` method instead calls the more
   * granular `startTextBlock` / `appendText` / etc. directly during
   * its single-pass emit-and-accumulate loop — DO NOT also call
   * `pushChunk` there, or content would double-accumulate.
   */
  pushChunk(chunk: GenerateContentResponse): void {
    const candidate = chunk.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    for (const part of parts) {
      const isThought = (part as { thought?: boolean }).thought === true;
      if (typeof part.text === "string" && part.text.length > 0) {
        if (isThought) {
          if (this.currentReasoning === null) this.startReasoningBlock();
          this.appendReasoning(part.text);
        } else {
          if (this.currentText === null) this.startTextBlock();
          this.appendText(part.text);
        }
        continue;
      }
      if (part.functionCall) {
        const fc = part.functionCall;
        this.recordToolCall({
          callId: fc.id ?? `call_${ulid()}`,
          name: fc.name ?? "",
          input: (fc.args ?? {}) as Record<string, unknown>,
          ...((part as { thoughtSignature?: string }).thoughtSignature !== undefined
            ? {
                thoughtSignature: (part as { thoughtSignature?: string }).thoughtSignature!,
              }
            : {}),
        });
      }
    }
    if (candidate?.finishReason) {
      this.setFinishReason(candidate.finishReason);
    }
    if (chunk.usageMetadata) {
      this.setUsage(chunk.usageMetadata);
    }
  }

  startTextBlock(): void {
    const block: AccumBlock = { kind: "text", text: "" };
    this.blocks.push(block);
    this.currentText = block;
    this.currentReasoning = null;
  }

  appendText(text: string): void {
    if (!this.currentText) this.startTextBlock();
    (this.currentText as { text: string }).text += text;
  }

  startReasoningBlock(): void {
    const block: AccumBlock = { kind: "reasoning", text: "" };
    this.blocks.push(block);
    this.currentReasoning = block;
    this.currentText = null;
  }

  appendReasoning(text: string): void {
    if (!this.currentReasoning) this.startReasoningBlock();
    (this.currentReasoning as { text: string }).text += text;
  }

  recordToolCall(call: AccumToolCall): void {
    this.blocks.push({ kind: "tool_use", call });
    this.currentText = null;
    this.currentReasoning = null;
  }

  currentTextBuffer(): string {
    return this.currentText?.kind === "text" ? this.currentText.text : "";
  }

  currentReasoningBuffer(): string {
    return this.currentReasoning?.kind === "reasoning" ? this.currentReasoning.text : "";
  }

  setFinishReason(reason: FinishReason): void {
    this.finish = reason;
  }

  setUsage(usage: GenerateContentResponse["usageMetadata"]): void {
    this.usage = usage;
  }

  toContentBlocks(): ContentBlock[] {
    const out: ContentBlock[] = [];
    for (const block of this.blocks) {
      if (block.kind === "text") {
        if (block.text.length > 0) out.push({ type: "text", text: block.text });
      } else if (block.kind === "reasoning") {
        if (block.text.length > 0) out.push({ type: "reasoning", text: block.text });
      } else {
        const { call } = block;
        const providerMetadata =
          call.thoughtSignature !== undefined
            ? { google: { thoughtSignature: call.thoughtSignature } }
            : undefined;
        out.push({
          type: "tool_use",
          toolUseId: call.callId,
          name: call.name,
          input: call.input,
          ...(providerMetadata !== undefined ? { providerMetadata } : {}),
        });
      }
    }
    return out;
  }

  toResponse(modelHint: string): GenerateContentResponse {
    const parts: Part[] = [];
    for (const block of this.blocks) {
      if (block.kind === "text") {
        if (block.text.length > 0) parts.push({ text: block.text });
      } else if (block.kind === "reasoning") {
        if (block.text.length > 0) parts.push({ text: block.text, thought: true } as Part);
      } else {
        const { call } = block;
        const fcPart: Part = {
          functionCall: { id: call.callId, name: call.name, args: call.input },
        };
        if (call.thoughtSignature !== undefined) {
          (fcPart as { thoughtSignature?: string }).thoughtSignature = call.thoughtSignature;
        }
        parts.push(fcPart);
      }
    }
    return {
      candidates: [
        {
          content: { role: "model", parts },
          finishReason: this.finish ?? FinishReason.STOP,
          index: 0,
        },
      ],
      modelVersion: modelHint,
      ...(this.usage !== undefined ? { usageMetadata: this.usage } : {}),
    } as GenerateContentResponse;
  }
}

function summarizeChunk(chunk: GenerateContentResponse): {
  kind: string;
  delta?: string;
  metadata?: Record<string, unknown>;
} {
  const cand = chunk.candidates?.[0];
  if (!cand) return { kind: "noop" };
  const firstText = cand.content?.parts?.find((p) => typeof p.text === "string");
  if (firstText) return { kind: "content_delta", delta: firstText.text };
  if (cand.finishReason)
    return { kind: "message_delta", metadata: { stopReason: cand.finishReason } };
  return { kind: "chunk" };
}

// ============================================================================
// Stop-reason mapping
// ============================================================================

/**
 * Map Google's full FinishReason enum (incl. SAFETY, RECITATION,
 * MALFORMED_FUNCTION_CALL, MISSING_THOUGHT_SIGNATURE, IMAGE_* etc.)
 * to the normalized `LanguageModelStopReason`. Mirrors v1's table.
 */
function mapFinishReason(
  reason: FinishReason | string | null | undefined,
): LanguageModelStopReason {
  if (!reason) return "end";
  switch (reason) {
    case FinishReason.STOP:
    case "STOP":
      return "end";
    case FinishReason.MAX_TOKENS:
    case "MAX_TOKENS":
      return "max_tokens";
    case FinishReason.SAFETY:
    case "SAFETY":
    case FinishReason.RECITATION:
    case "RECITATION":
    case FinishReason.BLOCKLIST:
    case "BLOCKLIST":
    case FinishReason.PROHIBITED_CONTENT:
    case "PROHIBITED_CONTENT":
    case FinishReason.SPII:
    case "SPII":
    case FinishReason.IMAGE_SAFETY:
    case "IMAGE_SAFETY":
    case FinishReason.IMAGE_PROHIBITED_CONTENT:
    case "IMAGE_PROHIBITED_CONTENT":
    case FinishReason.IMAGE_RECITATION:
    case "IMAGE_RECITATION":
    case FinishReason.LANGUAGE:
    case "LANGUAGE":
      return "content_filter";
    case FinishReason.MALFORMED_FUNCTION_CALL:
    case "MALFORMED_FUNCTION_CALL":
    case "UNEXPECTED_TOOL_CALL":
    case "TOO_MANY_TOOL_CALLS":
    case "MISSING_THOUGHT_SIGNATURE":
      // Spec's LanguageModelStopReason has no "error" — fold to "other"
      // with the underlying reason recoverable from raw if needed.
      return "other";
    default:
      return "other";
  }
}

// ============================================================================
// Schema sanitization — Gemini supports a strict JSON Schema subset.
// ============================================================================

/**
 * Sanitize a JSON Schema for Gemini's function-declaration format.
 * Recursively strips unsupported features while preserving intent.
 *
 * Removed: $ref, $defs/$definitions, additionalItems, propertyNames.
 * additionalProperties: {} dropped, false retained, {schema} dropped.
 * items: [array] (tuple) collapsed to first item's schema.
 * anyOf/oneOf with $ref entries: filtered out; single → inlined; all
 * $ref → object fallback.
 */
export function sanitizeSchemaForGemini(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== "object" || depth > 15) return schema;
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeSchemaForGemini(item, depth + 1));
  }
  const obj = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (
      key === "$ref" ||
      key === "$defs" ||
      key === "$definitions" ||
      key === "additionalItems" ||
      key === "propertyNames"
    ) {
      continue;
    }

    if (key === "additionalProperties") {
      if (value && typeof value === "object" && Object.keys(value).length === 0) {
        continue;
      }
      if (value === false) {
        result[key] = value;
        continue;
      }
      continue;
    }

    if (key === "items" && Array.isArray(value)) {
      const first = value[0];
      result[key] = first ? sanitizeSchemaForGemini(first, depth + 1) : { type: "string" };
      continue;
    }

    if ((key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      const cleaned = value
        .filter((v) => !(v && typeof v === "object" && "$ref" in v))
        .map((v) => sanitizeSchemaForGemini(v, depth + 1));
      if (cleaned.length === 0) {
        result["type"] = "object";
      } else if (cleaned.length === 1) {
        Object.assign(result, cleaned[0] as Record<string, unknown>);
      } else {
        result[key] = cleaned;
      }
      continue;
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = sanitizeSchemaForGemini(value, depth + 1);
    } else {
      result[key] = value;
    }
  }

  return result;
}

function ensureObjectSchema(params: unknown): unknown {
  if (!params || typeof params !== "object") return { type: "object" };
  const obj = params as Record<string, unknown>;
  if (!obj["type"]) return { ...obj, type: "object" };
  return obj;
}

// ============================================================================
// Error helpers
// ============================================================================

function mapExecuteError(cause: unknown): ExecuteError {
  if (cause instanceof Error) {
    const status = (cause as { status?: number }).status;
    if (cause.name === "AbortError" || /abort/i.test(cause.message)) {
      return { _tag: "ProviderAborted", reason: cause.message };
    }
    if (typeof status === "number") {
      return { _tag: "ProviderRejected", status, cause };
    }
  }
  return { _tag: "StreamFailed", cause };
}
