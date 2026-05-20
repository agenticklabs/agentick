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
  type GenerateTextResult,
  type LanguageModel,
  type FinishReason,
  type ModelMessage,
  type ToolSet,
} from "ai";

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
        const aiSdk = toAISDKInput(input.targetInput);
        const signal = mergeSignals(input.signal, controller.signal);
        return yield* Effect.tryPromise<unknown, ExecuteError>({
          try: () =>
            generateText({
              model: this.model,
              messages: aiSdk.messages,
              ...(aiSdk.tools !== undefined ? { tools: aiSdk.tools } : {}),
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

// ============================================================================
// LanguageModelInput → AI SDK input
// ============================================================================

function toAISDKInput(input: LanguageModelInput): AISDKProjectedInput {
  const messages: ModelMessage[] = [];
  for (const m of input.messages) {
    messages.push(...toAISDKMessage(m));
  }
  return { messages };
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
            if (p.type === "text") return { type: "text", text: p.text };
            if (p.type === "image") {
              return {
                type: "image",
                image: p.imageUrl,
                ...(p.mediaType !== undefined ? { mediaType: p.mediaType } : {}),
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
        if (p.type === "text") parts.push({ type: "text", text: p.text });
        else if (p.type === "tool_use") {
          parts.push({
            type: "tool-call",
            toolCallId: p.id,
            toolName: p.name,
            input: p.input,
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

  const result: LanguageModelExecutionResult = {
    specVersion: SPEC_VERSION,
    output,
    stopReason: mapFinishReason(raw.finishReason),
    usage: {
      inputTokens: raw.usage?.inputTokens ?? 0,
      outputTokens: raw.usage?.outputTokens ?? 0,
      totalTokens: raw.usage?.totalTokens ?? 0,
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
