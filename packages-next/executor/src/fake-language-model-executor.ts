/**
 * `FakeLanguageModelExecutor` — reference implementation of
 * `LanguageModelExecutor` for tests, examples, and the v2 substrate
 * proof. Inherits from `BaseHarness<"executor">` for the full phase
 * contract + FiberRef scope + lazy delta emission.
 *
 * Behavior:
 *   - `project()` folds the rendered tree's `context.entries` into
 *     canonical `LanguageModelMessage[]` and includes declared tools
 *     filtered to `exposure.includes("model")`.
 *   - `execute()` consumes the optional `scripted` result configured at
 *     construction. If `scripted.stream` is supplied, it emits delta
 *     envelopes per chunk before returning the accumulated output.
 *     Without scripting, returns a default "ok" reply.
 *   - `normalize()` is the identity transform for the mock — it returns
 *     the scripted result as-is. Real adapters parse provider response
 *     shapes here.
 *   - `run()` composes project → execute → normalize, emitting deltas
 *     via `emitDeltaLazy` so the streaming sim path stays cheap when
 *     nobody is listening.
 *   - `abort()` marks the named execution as aborted; the next `run`
 *     for that id fails with `ProviderAborted`. In-flight runs are
 *     interrupted via fiber when the substrate scope tears down.
 *
 * Provider adapters (Phase 4c) replace `execute` + `normalize`; the
 * harness shape stays identical.
 */

import { Effect } from "effect";
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
  ToolDeclaration,
} from "@agentick/spec-next";
import { SPEC_VERSION, toJsonSchema } from "@agentick/spec-next";

import { ExecutorLifecycle } from "./executor-lifecycle.js";

// ============================================================================
// Construction options
// ============================================================================

export interface MockScriptedRun {
  /** The terminal result the mock executor returns from a `run` call. */
  readonly result: LanguageModelExecutionResult;
  /**
   * Optional ordered `AdapterDelta` events the mock emits via
   * `executeStream`. Each entry is yielded in order; `.result`
   * resolves with the scripted `result` after the last delta.
   * When omitted, `executeStream` synthesizes a sensible default
   * (message-start → content-start → content-delta(joined text) →
   * content-end → content(block) → message-end → message) from the
   * scripted result.
   */
  readonly deltas?: ReadonlyArray<AdapterDelta>;
}

export interface FakeLanguageModelExecutorOptions {
  /**
   * Scripted outcome for `run`. Accepts either a single scripted run
   * (every `run()` returns the same result) or an array of scripted
   * runs consumed in order — the i-th `run()` returns the i-th entry.
   * After the array is exhausted, subsequent calls reuse the last
   * entry. Without this, the executor returns a minimal `"hi"` reply
   * with `stopReason: "end"`.
   */
  readonly scripted?: MockScriptedRun | ReadonlyArray<MockScriptedRun>;
  /**
   * Self-described target. Defaults to a generic
   * `{ kind: "language-model", provider: "mock", modelId: "mock-v1" }`
   * with tool + streaming capabilities. Provider adapters supply their
   * own derived target; tests can override here.
   */
  readonly target?: ExecutionTarget;
}

// ============================================================================
// Internals
// ============================================================================

const DEFAULT_REPLY: LanguageModelExecutionResult = {
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text: "hi" }],
  stopReason: "end",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

// ============================================================================
// FakeLanguageModelExecutor
// ============================================================================

const DEFAULT_MOCK_TARGET: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

export class FakeLanguageModelExecutor
  extends BaseHarness<"executor">
  implements LanguageModelExecutor
{
  readonly family = "language-model" as const;
  readonly target: ExecutionTarget;

  private readonly scriptedSequence: ReadonlyArray<MockScriptedRun>;
  private scriptIndex = 0;
  private readonly lifecycle = new ExecutorLifecycle();

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: FakeLanguageModelExecutorOptions = {},
  ) {
    super("executor", scopeId, journal, bus, inbox);
    this.target = options.target ?? DEFAULT_MOCK_TARGET;
    this.scriptedSequence = options.scripted
      ? Array.isArray(options.scripted)
        ? options.scripted
        : [options.scripted as MockScriptedRun]
      : [];
  }

  private nextScripted(): MockScriptedRun | undefined {
    if (this.scriptedSequence.length === 0) return undefined;
    const entry =
      this.scriptedSequence[Math.min(this.scriptIndex, this.scriptedSequence.length - 1)];
    this.scriptIndex++;
    return entry;
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
      opId: `executor:execute:${executionId}`,
      surface: "executor",
      name: "executor:command:execute",
      scope: input.scope ?? { executionId },
      input,
    };
    return runHarnessProtocol(this.runOperation(op, (i) => this.executeBody(i, executionId)));
  }

  executeStream(input: ExecuteInput<LanguageModelInput>): ExecutorStream<unknown> {
    const next = this.nextScripted();
    const scriptedResult = next?.result ?? DEFAULT_REPLY;
    const scriptedDeltas: ReadonlyArray<AdapterDelta> =
      next?.deltas ?? defaultDeltasFor(scriptedResult);

    // Mirror G6: bus envelopes fire on the streaming path alongside the
    // iterator queue, so subscribers see the same deltas iterator
    // consumers do.
    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    const streamOp: Operation<ExecuteInput<LanguageModelInput>, unknown> = {
      opId: `executor:executeStream:${executionId}:${ulid()}`,
      surface: "executor",
      name: "executor:command:execute",
      scope: input.scope ?? { executionId },
      input,
    };
    const emitBus = (delta: AdapterDelta): void => {
      void Effect.runPromise(
        this.emitDeltaLazy(streamOp, () => delta).pipe(Effect.catchAll(() => Effect.void)),
      );
    };

    // Yield scripted deltas through an async iterator backed by a queue.
    // For the mock, deltas are known up-front; we just enqueue them all.
    const queue: AdapterDelta[] = [...scriptedDeltas];
    let aborted = false;
    let abortReason: unknown = null;

    return {
      result: aborted
        ? Promise.reject(abortReason ?? new Error("aborted"))
        : Promise.resolve(scriptedResult),
      abort(reason) {
        aborted = true;
        abortReason = reason ?? "aborted";
      },
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next: async (): Promise<IteratorResult<AdapterDelta>> => {
            if (aborted) {
              return { value: undefined as unknown as AdapterDelta, done: true };
            }
            if (index >= queue.length) {
              return { value: undefined as unknown as AdapterDelta, done: true };
            }
            const value = queue[index]!;
            index += 1;
            emitBus(value);
            return { value, done: false };
          },
          return: async (): Promise<IteratorResult<AdapterDelta>> => {
            aborted = true;
            return { value: undefined as unknown as AdapterDelta, done: true };
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
    // normalize is independent of the run-sequence cursor — it just
    // identity-transforms whatever was passed in (matching what a real
    // adapter would do parsing a provider response).
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.try({
          try: () => normalizeImpl(i, this.scriptedSequence[0]),
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
    // opId is per-tick, not per-execution — the same executor.run may be
    // called many times within one execution (multi-tick loops). Using
    // executionId alone would make the substrate's idempotency replay
    // the first tick's terminal on every subsequent tick.
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
      Effect.sync(() => this.lifecycle.abortExecution(input.executionId, input.reason)),
    );
  }

  // ──────── inbox dispatch ────────

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail({
      _tag: "HandlerError",
      cause: new Error("executor inbox dispatch not yet wired (Phase 4b minimum)"),
    });
  }

  // ──────── internals ────────

  private executeBody(
    input: ExecuteInput<LanguageModelInput>,
    executionId: string,
  ): Effect.Effect<unknown, ExecuteError, never> {
    return Effect.gen(this, function* () {
      if (this.lifecycle.isAborted(executionId)) {
        return yield* Effect.fail<ExecuteError>({
          _tag: "ProviderAborted",
          reason: "aborted prior to execute",
        });
      }
      this.lifecycle.register({ executionId });

      try {
        const next = this.nextScripted();
        return (next?.result ?? DEFAULT_REPLY) as unknown;
      } finally {
        this.lifecycle.unregister(executionId);
      }
    });
  }

  private runBody(
    input: RunInput,
    executionId: string,
    op: Operation<RunInput, ExecutorTerminal<LanguageModelExecutionResult>>,
  ): Effect.Effect<ExecutorTerminal<LanguageModelExecutionResult>, ExecutorError, never> {
    return Effect.gen(this, function* () {
      // Snapshot the next scripted run for this invocation. Subsequent
      // calls advance the sequence cursor in `nextScripted()`.
      const next = this.nextScripted();

      // 1. project
      const projected = yield* projectAsEffect(input);

      // 2. Emit scripted deltas (if any) for bus observability.
      //    The loop's streaming path uses `executeStream` directly,
      //    not run, so this is the observability-only mirror.
      const deltas = next?.deltas;
      if (deltas && deltas.length > 0) {
        for (const delta of deltas) {
          yield* this.emitDeltaLazy(op, () => delta).pipe(Effect.orDie);
        }
      }

      // 3. execute
      if (this.lifecycle.isAborted(executionId)) {
        const terminal: ExecutorTerminal<LanguageModelExecutionResult> = {
          outcome: "canceled",
          reason: "aborted",
        };
        return terminal;
      }
      const targetOutput = next?.result ?? DEFAULT_REPLY;
      void projected;

      // 4. normalize (identity for mock)
      const result: LanguageModelExecutionResult = targetOutput;
      const terminal: ExecutorTerminal<LanguageModelExecutionResult> = {
        outcome: "succeeded",
        result,
      };
      return terminal;
    });
  }
}

// ============================================================================
// Pure helpers
// ============================================================================

function projectAsEffect(input: RunInput): Effect.Effect<LanguageModelInput, never, never> {
  return Effect.sync(() =>
    projectImpl({ compiled: input.compiled, target: input.target, tools: input.tools }),
  );
}

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

function normalizeImpl(
  input: NormalizeInput<unknown>,
  scripted: MockScriptedRun | undefined,
): LanguageModelExecutionResult {
  // The mock's execute returned `LanguageModelExecutionResult` directly;
  // normalize is identity. A real adapter would parse `input.targetOutput`
  // shaped as the provider response.
  const out = input.targetOutput;
  if (isLanguageModelExecutionResult(out)) return out;
  return scripted?.result ?? DEFAULT_REPLY;
}

function isLanguageModelExecutionResult(v: unknown): v is LanguageModelExecutionResult {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { stopReason?: unknown; output?: unknown };
  return typeof o.stopReason === "string" && Array.isArray(o.output);
}

function buildMessages(tree: RenderedTree): ReadonlyArray<LanguageModelMessage> {
  const messages: LanguageModelMessage[] = [];
  // Sections (audience: model) fold into a single leading system message.
  const systemText = collectSectionText(tree.context.entries);
  if (systemText.length > 0) {
    messages.push({ role: "system", content: [{ type: "text", text: systemText }] });
  }
  // Each MessageEntry maps to one LanguageModelMessage.
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
      // Other blocks (csv, html, json, code, etc.) flatten to text.
      return {
        type: "text",
        text:
          ("text" in block && typeof block.text === "string"
            ? block.text
            : JSON.stringify(block)) || "",
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
      inputSchema: toJsonSchema(t.inputSchema) as Record<string, unknown>,
      ...(t.outputSchema !== undefined
        ? { outputSchema: toJsonSchema(t.outputSchema) as Record<string, unknown> }
        : {}),
      ...(t.providerOptions !== undefined ? { providerOptions: t.providerOptions } : {}),
    }));
}

function buildParameters(tree: RenderedTree) {
  const cfg = tree.config;
  if (!cfg) return undefined;
  const params: {
    temperature?: number;
    maxOutputTokens?: number;
    responseFormat?: { type: "text" | "json" | "json_schema"; schema?: Record<string, unknown> };
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

/**
 * Synthesize a sensible default `AdapterDelta` stream for a scripted
 * result when the caller didn't supply explicit deltas. Mirrors what a
 * naive real adapter would emit: message-start → content-start →
 * content-delta(full text) → content-end → content(block) →
 * message-end → message.
 */
function defaultDeltasFor(result: LanguageModelExecutionResult): readonly AdapterDelta[] {
  const out: AdapterDelta[] = [{ type: "message-start", role: "assistant" }];
  let blockIndex = 0;
  for (const block of result.output) {
    if (block.type === "text") {
      out.push({ type: "content-start", blockIndex, blockType: "text" });
      out.push({ type: "content-delta", blockIndex, delta: block.text });
      out.push({ type: "content-end", blockIndex });
      out.push({ type: "content", blockIndex, content: block });
    } else {
      // Non-text blocks (image, tool_use, etc.) — emit just the
      // start/end + summary, no delta (no streaming text).
      out.push({
        type: "content-start",
        blockIndex,
        blockType: block.type as never,
      });
      out.push({ type: "content-end", blockIndex });
      out.push({ type: "content", blockIndex, content: block });
    }
    blockIndex += 1;
  }
  for (const tc of result.toolCalls ?? []) {
    out.push({
      type: "tool-call",
      callId: tc.id,
      name: tc.name,
      input: tc.input as Readonly<Record<string, unknown>>,
    });
  }
  const usage = result.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  out.push({ type: "message-end", stopReason: result.stopReason, usage });
  out.push({
    type: "message",
    message: { role: "assistant", content: result.output },
    stopReason: result.stopReason,
    usage,
  });
  return out;
}
