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
  ContentBlock,
  ContextEntry,
  EventBus,
  ExecuteError,
  ExecuteInput,
  ExecutionTarget,
  ExecutorError,
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
} from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";

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
        const params = toOpenAIParams(input.targetInput, this.defaultModel);
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

      // 3. normalize (deterministic)
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

// ============================================================================
// IR → OpenAI params
// ============================================================================

function toOpenAIParams(
  input: LanguageModelInput,
  defaultModel: string | undefined,
): ChatCompletionCreateParams {
  const messages: ChatCompletionMessageParam[] = [];
  for (const m of input.messages) messages.push(...toOpenAIMessages(m));

  const tools = input.tools && input.tools.length > 0 ? input.tools.map(toOpenAITool) : undefined;

  const params: ChatCompletionCreateParams = {
    model: defaultModel ?? "gpt-4o-mini",
    messages,
  };
  if (input.parameters?.temperature !== undefined) {
    params.temperature = input.parameters.temperature;
  }
  if (input.parameters?.maxOutputTokens !== undefined) {
    params.max_tokens = input.parameters.maxOutputTokens;
  }
  if (input.parameters?.stopSequences !== undefined) {
    params.stop = input.parameters.stopSequences as string[];
  }
  if (tools && tools.length > 0) {
    params.tools = tools;
    params.tool_choice = "auto";
  }
  if (input.parameters?.responseFormat) {
    const rf = input.parameters.responseFormat;
    if (rf.type === "text") {
      params.response_format = { type: "text" };
    } else if (rf.type === "json") {
      params.response_format = { type: "json_object" };
    } else if (rf.type === "json_schema" && rf.schema) {
      params.response_format = {
        type: "json_schema",
        json_schema: {
          name: "response",
          schema: rf.schema,
          strict: true,
        },
      };
    }
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
  private finishReason: ChatCompletion["choices"][0]["finish_reason"] | null = null;
  private toolCallsByIndex = new Map<number, { id: string; name: string; arguments: string }>();
  private usage:
    | { prompt_tokens: number; completion_tokens: number; total_tokens: number }
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
      };
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return;
    if (typeof delta.content === "string") this.text += delta.content;
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

    const message: ChatCompletion["choices"][0]["message"] = {
      role: "assistant",
      content: this.text.length > 0 ? this.text : null,
      refusal: null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };

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
