/**
 * `AISDKExecutor` — `LanguageModelExecutor` backed by Vercel AI SDK.
 *
 * Wraps any `ai` package `LanguageModel` (whatever the user gets from
 * `openai("gpt-4o")` in `@ai-sdk/openai`, `anthropic(...)` from
 * `@ai-sdk/anthropic`, etc.) as our `LanguageModelExecutor`. The
 * progressive-adoption path — bring existing AI SDK code, get JSX
 * agents + sessions + observability for free.
 *
 * Behavior:
 *   - `project()` folds the rendered tree → AI SDK `ModelMessage[]` +
 *     tool descriptors.
 *   - `execute()` invokes `generateText({ model, messages, tools? })`.
 *     Streaming via `streamText` is a follow-up.
 *   - `normalize()` maps the AI SDK `GenerateTextResult` into our
 *     `LanguageModelExecutionResult`, translating the finishReason
 *     vocabulary and extracting tool calls.
 *   - `abort()` cancels in-flight via AbortController plumbed through
 *     AI SDK's `abortSignal` option.
 *
 * MVP scope — tools defined in JSX flow through the normal Agentick
 * tool-executor harness. Tools passed via the `aisdk({ tools })` slot
 * also register with the app's handler resolver (Phase 5.3a — see
 * factory module). This gives observability uniformity:
 * `app.events({ surface: "tool" })` sees all dispatches regardless of
 * which side declared the tool.
 *
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

import { Effect } from "effect";
import {
  generateText,
  streamText,
  type GenerateTextResult,
  type LanguageModel,
  type FinishReason,
  type ModelMessage,
  type ToolSet,
} from "ai";

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

// ============================================================================
// Construction options
// ============================================================================

export interface AISDKExecutorOptions {
  /** The AI SDK `LanguageModel` to invoke. */
  readonly model: LanguageModel;
  /**
   * Optional self-described target. Defaults are inferred from the
   * model's `provider` + `modelId` (when the model is a model handle,
   * not just a string id). Override for non-stock providers or to
   * advertise additional capabilities.
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

/**
 * The AI SDK input shape produced by `project()`. Kept opaque to
 * downstream phases — `execute()` consumes it, `normalize()` doesn't
 * see it.
 */
interface AISDKProjectedInput {
  readonly messages: ModelMessage[];
  readonly tools?: ToolSet;
  /**
   * Generation parameters mapped to AI SDK call-level fields (temperature,
   * maxOutputTokens, topP, frequencyPenalty, presencePenalty,
   * stopSequences). Spread onto the streamText/generateText call.
   */
  readonly generation: Record<string, unknown>;
  /**
   * Forwarded directly as AI SDK's `providerOptions` — adopter escape
   * hatch for provider-specific knobs (Anthropic cache control, OpenAI
   * reasoning effort, etc.). Sourced from `target.providerOptions`. Cast
   * to `never` at call sites — the spec carries the looser
   * `Record<string, unknown>` shape than AI SDK's strict
   * `SharedV2ProviderOptions`; runtime shape is the same.
   */
  readonly providerOptions?: never;
}

// ============================================================================
// AISDKExecutor
// ============================================================================

export class AISDKExecutor extends BaseHarness<"executor"> implements LanguageModelExecutor {
  readonly family = "language-model" as const;
  readonly target: ExecutionTarget;

  private readonly model: LanguageModel;
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly aborted = new Set<string>();

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: AISDKExecutorOptions,
  ) {
    super("executor", scopeId, journal, bus, inbox);
    this.model = options.model;
    this.target = options.target ?? deriveTarget(options.model);
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

  executeStream(input: ExecuteInput<LanguageModelInput>): ExecutorStream<unknown> {
    const queue: AdapterDelta[] = [];
    const resolvers: Array<(r: IteratorResult<AdapterDelta>) => void> = [];
    let done = false;
    let resultResolve!: (v: unknown) => void;
    let resultReject!: (e: unknown) => void;
    const resultPromise = new Promise<unknown>((res, rej) => {
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

    // Per-stream Operation so bus observers see the same deltas the
    // iterator consumer reads. See OpenAI executor for the same pattern.
    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    const streamOp: Operation<ExecuteInput<LanguageModelInput>, unknown> = {
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
        const aiSdk = toAISDKInput(input.targetInput, input.target);
        const stream = streamText({
          model: this.model,
          messages: aiSdk.messages,
          ...(aiSdk.tools !== undefined ? { tools: aiSdk.tools } : {}),
          ...aiSdk.generation,
          ...(aiSdk.providerOptions !== undefined
            ? { providerOptions: aiSdk.providerOptions as never }
            : {}),
          abortSignal: controller.signal,
        });

        emit({ type: "message-start", role: "assistant" });

        // Per-block tracking for symmetric start/end emission.
        let textBlockStarted = false;
        let textAccum = "";
        const toolCallStarted = new Set<string>();
        const toolCallArgsByCallId = new Map<string, string>();
        const toolCallNameByCallId = new Map<string, string>();
        let blockIndex = 0;
        let stopReason: LanguageModelStopReason = "end";
        let usage: UsageStats = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

        // AI SDK 5's fullStream events. We narrow with permissive duck-typing
        // so this stays robust to minor SDK shape changes between releases.
        for await (const partU of stream.fullStream) {
          const part = partU as { type: string } & Record<string, unknown>;
          switch (part.type) {
            case "text-start": {
              if (!textBlockStarted) {
                textBlockStarted = true;
                emit({ type: "content-start", blockIndex, blockType: "text" });
              }
              break;
            }
            case "text-delta":
            case "text": {
              const delta = (part as { text?: string; delta?: string }).text ??
                (part as { delta?: string }).delta ?? "";
              if (!textBlockStarted) {
                textBlockStarted = true;
                emit({ type: "content-start", blockIndex, blockType: "text" });
              }
              if (delta.length > 0) {
                textAccum += delta;
                emit({ type: "content-delta", blockIndex, delta });
              }
              break;
            }
            case "text-end": {
              // The text-block close is emitted from the post-loop cleanup
              // so we always emit content-end+content together symmetrically.
              break;
            }
            case "tool-input-start": {
              const callId = (part.toolCallId as string | undefined) ?? (part.id as string | undefined) ?? `tc_${ulid()}`;
              const name = (part.toolName as string | undefined) ?? "";
              toolCallStarted.add(callId);
              toolCallNameByCallId.set(callId, name);
              emit({ type: "tool-call-start", callId, name, blockIndex });
              break;
            }
            case "tool-input-delta": {
              const callId = (part.toolCallId as string | undefined) ?? (part.id as string | undefined) ?? "";
              const delta = (part.argsTextDelta as string | undefined) ?? (part.delta as string | undefined) ?? "";
              if (callId && delta) {
                const prev = toolCallArgsByCallId.get(callId) ?? "";
                toolCallArgsByCallId.set(callId, prev + delta);
                emit({ type: "tool-call-delta", callId, delta });
              }
              break;
            }
            case "tool-input-end":
            case "tool-call": {
              const callId = (part.toolCallId as string | undefined) ?? (part.id as string | undefined) ?? "";
              const name = (part.toolName as string | undefined) ?? toolCallNameByCallId.get(callId) ?? "";
              if (!toolCallStarted.has(callId)) {
                emit({ type: "tool-call-start", callId, name, blockIndex });
                toolCallStarted.add(callId);
              }
              emit({ type: "tool-call-end", callId });
              const inputObj =
                (part.input as Readonly<Record<string, unknown>> | undefined) ??
                (part.args as Readonly<Record<string, unknown>> | undefined) ??
                ((): Readonly<Record<string, unknown>> => {
                  try {
                    return JSON.parse(
                      toolCallArgsByCallId.get(callId) ?? "{}",
                    ) as Readonly<Record<string, unknown>>;
                  } catch {
                    return {};
                  }
                })();
              emit({ type: "tool-call", callId, name, input: inputObj });
              break;
            }
            case "finish":
            case "finish-step": {
              const fin = (part.finishReason as FinishReason | undefined);
              const us = part.usage as
                | {
                    inputTokens?: number;
                    outputTokens?: number;
                    totalTokens?: number;
                    cachedInputTokens?: number;
                    cacheCreationTokens?: number;
                  }
                | undefined;
              if (fin) stopReason = mapFinishReason(fin);
              if (us) {
                usage = {
                  inputTokens: us.inputTokens ?? 0,
                  outputTokens: us.outputTokens ?? 0,
                  totalTokens: us.totalTokens ?? 0,
                  ...(us.cachedInputTokens !== undefined
                    ? { cachedInputTokens: us.cachedInputTokens }
                    : {}),
                  ...(us.cacheCreationTokens !== undefined
                    ? { cacheCreationTokens: us.cacheCreationTokens }
                    : {}),
                };
              }
              break;
            }
            case "error": {
              const err = part.error;
              emit({
                type: "error",
                error: {
                  message: err instanceof Error ? err.message : String(err),
                },
              });
              break;
            }
            default:
              // Other AI SDK events (reasoning, files, sources, etc.) —
              // not yet mapped. Adopters relying on these can subscribe
              // to the executor's bus envelopes; the typed handle stream
              // skips them for now.
              break;
          }
        }

        // Close any open text block + emit content summary.
        if (textBlockStarted) {
          emit({ type: "content-end", blockIndex });
          emit({
            type: "content",
            blockIndex,
            content: { type: "text", text: textAccum } as ContentBlock,
          });
        }

        emit({ type: "message-end", stopReason, usage });

        // Final assembled message summary.
        const messageContent: ContentBlock[] = [];
        if (textAccum.length > 0) messageContent.push({ type: "text", text: textAccum });
        for (const [callId, name] of toolCallNameByCallId) {
          let parsed: Readonly<Record<string, unknown>> = {};
          try {
            parsed = JSON.parse(
              toolCallArgsByCallId.get(callId) ?? "{}",
            ) as Readonly<Record<string, unknown>>;
          } catch {
            /* keep empty */
          }
          messageContent.push({
            type: "tool_use",
            toolUseId: callId,
            name,
            input: parsed,
          });
        }
        emit({
          type: "message",
          message: { role: "assistant", content: messageContent },
          stopReason,
          usage,
        });

        // Resolve .result with a shape compatible with the non-streaming
        // path — the normalize() impl narrows generateText-style output.
        // We pass an object the existing normalize() can consume.
        const resolved = {
          text: textAccum,
          finishReason: (() => {
            switch (stopReason) {
              case "end":
                return "stop";
              case "tool_use":
                return "tool-calls";
              case "max_tokens":
                return "length";
              case "content_filter":
                return "content-filter";
              default:
                return "stop";
            }
          })() as FinishReason,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
          },
          toolCalls: Array.from(toolCallNameByCallId.entries()).map(([callId, name]) => {
            let parsed: Readonly<Record<string, unknown>> = {};
            try {
              parsed = JSON.parse(
                toolCallArgsByCallId.get(callId) ?? "{}",
              ) as Readonly<Record<string, unknown>>;
            } catch {
              /* keep empty */
            }
            return { toolCallId: callId, toolName: name, input: parsed };
          }),
        };
        resultResolve(resolved);
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

  execute(input: ExecuteInput<LanguageModelInput>): Promise<unknown> {
    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    const op: Operation<ExecuteInput<LanguageModelInput>, unknown> = {
      opId: `executor:execute:${executionId}:${ulid()}`,
      surface: "executor",
      name: "executor:command:execute",
      scope: input.scope ?? { executionId },
      input,
    };
    return runHarnessProtocol(this.runOperation(op, (i) => this.executeBody(i, executionId)));
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
    return runHarnessProtocol(this.runOperation(op, (i) => this.runBody(i, executionId)));
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

  // ──────── inbox dispatch (deferred) ────────

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail({
      _tag: "HandlerError",
      cause: new Error("ai-sdk executor inbox dispatch not yet wired"),
    });
  }

  // ──────── internals ────────

  private executeBody(
    input: ExecuteInput<LanguageModelInput>,
    executionId: string,
  ): Effect.Effect<unknown, ExecuteError, never> {
    return Effect.gen(this, function* () {
      if (this.aborted.has(executionId)) {
        return yield* Effect.fail<ExecuteError>({
          _tag: "ProviderAborted",
          reason: "aborted prior to execute",
        });
      }
      const controller = new AbortController();
      this.inFlight.set(executionId, { executionId, abort: controller });
      try {
        // Per the spec, `targetInput` is the canonical LanguageModelInput.
        // Translate to AI SDK shape here, inside execute(), so the
        // phase contract holds: project returns canonical, execute
        // consumes canonical and produces provider output.
        const aiSdk = toAISDKInput(input.targetInput, input.target);
        const signal = mergeSignals(input.signal, controller.signal);
        return yield* Effect.tryPromise<unknown, ExecuteError>({
          try: () =>
            generateText({
              model: this.model,
              messages: aiSdk.messages,
              ...(aiSdk.tools !== undefined ? { tools: aiSdk.tools } : {}),
              ...aiSdk.generation,
              ...(aiSdk.providerOptions !== undefined
                ? { providerOptions: aiSdk.providerOptions }
                : {}),
              ...(signal !== undefined ? { abortSignal: signal } : {}),
            }) as unknown as Promise<unknown>,
          catch: (cause): ExecuteError => mapExecuteError(cause),
        });
      } finally {
        this.inFlight.delete(executionId);
      }
    });
  }

  private runBody(
    input: RunInput,
    executionId: string,
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
      const raw = yield* this.executeBody(executeInput, executionId).pipe(
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

      const result = yield* Effect.try({
        try: () => normalizeImpl({ targetOutput: raw, target: input.target }),
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
// IR projection — same canonical fold every executor uses
// ============================================================================

function projectImpl(input: ProjectInput): LanguageModelInput {
  const messages = buildMessages(input.compiled);
  const tools = buildTools(input.compiled);
  return {
    messages,
    ...(tools.length > 0 ? { tools } : {}),
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
    block.providerMetadata !== undefined
      ? { providerMetadata: block.providerMetadata }
      : {};
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
      ...(t.providerOptions !== undefined
        ? { providerOptions: t.providerOptions }
        : {}),
    }));
}

// ============================================================================
// LanguageModelInput → AI SDK input
// ============================================================================

function toAISDKInput(
  input: LanguageModelInput,
  target: ExecutionTarget,
): AISDKProjectedInput {
  const messages: ModelMessage[] = [];
  for (const m of input.messages) {
    messages.push(...toAISDKMessage(m));
  }
  const p = input.parameters;
  const generation: Record<string, unknown> = {};
  if (p?.temperature !== undefined) generation.temperature = p.temperature;
  if (p?.maxOutputTokens !== undefined) generation.maxOutputTokens = p.maxOutputTokens;
  if (p?.topP !== undefined) generation.topP = p.topP;
  if (p?.frequencyPenalty !== undefined) generation.frequencyPenalty = p.frequencyPenalty;
  if (p?.presencePenalty !== undefined) generation.presencePenalty = p.presencePenalty;
  if (p?.stopSequences !== undefined) {
    generation.stopSequences = [...p.stopSequences];
  }
  const result: AISDKProjectedInput = {
    messages,
    generation,
    ...(target.providerOptions !== undefined
      ? { providerOptions: target.providerOptions as never }
      : {}),
  };
  return result;
}

/**
 * v2 spec carries per-part `providerMetadata` keyed by provider
 * namespace (`anthropic`, `openai`, `google`). AI SDK 5 accepts the
 * same per-part shape under the field name `providerOptions`. The
 * two are 1:1 — forward by renaming the carrier field.
 */
function pmToProviderOptions(part: {
  readonly providerMetadata?: Record<string, Record<string, unknown>>;
}): { providerOptions: Record<string, Record<string, unknown>> } | object {
  return part.providerMetadata !== undefined
    ? { providerOptions: part.providerMetadata }
    : {};
}

function toAISDKMessage(m: LanguageModelMessage): ModelMessage[] {
  // AI SDK splits messages by role with specific content shapes.
  switch (m.role) {
    case "system":
      return [
        {
          role: "system",
          content: m.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n"),
        },
      ];
    case "user":
      return [
        {
          role: "user",
          content: m.content.map((p) => {
            if (p.type === "text") {
              return { type: "text", text: p.text, ...pmToProviderOptions(p) };
            }
            if (p.type === "image") {
              return {
                type: "image",
                image: p.imageUrl,
                ...(p.mediaType !== undefined ? { mediaType: p.mediaType } : {}),
                ...pmToProviderOptions(p),
              };
            }
            // Fallback — flatten to text.
            return {
              type: "text",
              text: JSON.stringify(p),
            };
          }),
        } as ModelMessage,
      ];
    case "assistant": {
      const parts: unknown[] = [];
      for (const p of m.content) {
        if (p.type === "text") {
          parts.push({ type: "text", text: p.text, ...pmToProviderOptions(p) });
        } else if (p.type === "tool_use") {
          parts.push({
            type: "tool-call",
            toolCallId: p.id,
            toolName: p.name,
            input: p.input,
            ...pmToProviderOptions(p),
          });
        }
      }
      return [{ role: "assistant", content: parts } as ModelMessage];
    }
    case "tool": {
      // Each tool_result block becomes its own tool-result part. AI SDK
      // expects one ToolModelMessage per turn carrying all results.
      const parts: unknown[] = [];
      for (const p of m.content) {
        if (p.type === "tool_result") {
          const textOnly = p.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          parts.push({
            type: "tool-result",
            toolCallId: p.toolUseId,
            toolName: "unknown",
            output: { type: "text", value: textOnly || "[done]" },
            ...pmToProviderOptions(p),
          });
        }
      }
      return parts.length > 0 ? [{ role: "tool", content: parts } as ModelMessage] : [];
    }
    default:
      return [];
  }
}

// ============================================================================
// AI SDK result → LanguageModelExecutionResult
// ============================================================================

function normalizeImpl(input: NormalizeInput<unknown>): LanguageModelExecutionResult {
  const raw = input.targetOutput as GenerateTextResult<ToolSet, unknown>;
  if (!raw || typeof raw !== "object") {
    throw new Error("normalize expected an AI SDK GenerateTextResult");
  }

  const output: ContentBlock[] = [];
  if (typeof raw.text === "string" && raw.text.length > 0) {
    output.push({ type: "text", text: raw.text });
  }

  const toolCalls: ToolCall[] = [];
  for (const tc of raw.toolCalls ?? []) {
    const tcAny = tc as {
      toolCallId: string;
      toolName: string;
      input: unknown;
    };
    const inputObj =
      tcAny.input && typeof tcAny.input === "object" && !Array.isArray(tcAny.input)
        ? (tcAny.input as Record<string, unknown>)
        : { value: tcAny.input };
    toolCalls.push({
      id: tcAny.toolCallId,
      name: tcAny.toolName,
      input: inputObj,
    });
    output.push({
      type: "tool_use",
      toolUseId: tcAny.toolCallId,
      name: tcAny.toolName,
      input: inputObj,
    });
  }

  const rawUsage = raw.usage as
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        cachedInputTokens?: number;
        cacheCreationTokens?: number;
      }
    | undefined;
  const result: LanguageModelExecutionResult = {
    specVersion: SPEC_VERSION,
    output,
    stopReason: mapFinishReason(raw.finishReason),
    usage: {
      inputTokens: rawUsage?.inputTokens ?? 0,
      outputTokens: rawUsage?.outputTokens ?? 0,
      totalTokens: rawUsage?.totalTokens ?? 0,
      ...(rawUsage?.cachedInputTokens !== undefined
        ? { cachedInputTokens: rawUsage.cachedInputTokens }
        : {}),
      ...(rawUsage?.cacheCreationTokens !== undefined
        ? { cacheCreationTokens: rawUsage.cacheCreationTokens }
        : {}),
    },
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    raw,
  };
  return result;
}

function mapFinishReason(reason: FinishReason): LanguageModelStopReason {
  switch (reason) {
    case "stop":
      return "end";
    case "length":
      return "max_tokens";
    case "content-filter":
      return "content_filter";
    case "tool-calls":
      return "tool_use";
    default:
      return "other";
  }
}

// ============================================================================
// Helpers
// ============================================================================

function deriveTarget(model: LanguageModel): ExecutionTarget {
  if (typeof model === "string") {
    return {
      kind: "language-model",
      provider: "ai-sdk",
      modelId: model,
      capabilities: { supportsTools: true, supportsStreaming: true },
    };
  }
  return {
    kind: "language-model",
    provider: model.provider ?? "ai-sdk",
    modelId: model.modelId ?? "unknown",
    capabilities: { supportsTools: true, supportsStreaming: true },
  };
}

function mapExecuteError(cause: unknown): ExecuteError {
  if (cause instanceof Error) {
    if (/abort/i.test(cause.message) || cause.name === "AbortError") {
      return { _tag: "ProviderAborted", reason: cause.message };
    }
    const status = (cause as { statusCode?: number }).statusCode;
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
