/**
 * `defineExecutor` — callback-style `LanguageModelExecutor` factory.
 *
 * Lets a user satisfy `LanguageModelExecutor` without subclassing
 * `BaseHarness`. Bring an async function (and a `target`), receive an
 * `ExecutorFactory` ready to drop into `createApp({ executor: ... })`.
 *
 * ```ts
 * const myExecutor = defineExecutor({
 *   target: {
 *     kind: "language-model",
 *     provider: "custom",
 *     modelId: "my-model-v1",
 *     capabilities: { supportsTools: true },
 *   },
 *   async run(input) {
 *     const response = await myProviderApi(input.messages);
 *     return {
 *       specVersion: "2026-05-08",
 *       output: [{ type: "text", text: response.text }],
 *       stopReason: "end",
 *       usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
 *     };
 *   },
 * });
 *
 * const app = await createApp(<Agent />, { executor: myExecutor });
 * ```
 *
 * Under the hood the factory constructs a `CallbackLanguageModelExecutor`
 * — a thin `BaseHarness<"executor">` subclass that delegates the
 * project / execute / normalize / run pipeline to the user-supplied
 * callbacks. The substrate phase contract, FiberRef scope, OTel spans,
 * and lazy delta emission still apply uniformly.
 *
 * Streaming via per-chunk delta emission is a follow-up (callback
 * signature will grow `ctx.emit`). The MVP supports the
 * synchronous-return shape only.
 *
 * @see docs/proposals/v2/IMPLEMENTATION-PLAN.md (FAÇADE.6)
 */

import { Effect } from "effect";
import {
  BaseHarness,
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  runHarnessProtocol,
  ulid,
} from "@agentick/runtime-next";
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
  ExecutorFactory,
  ExecutorFactoryDeps,
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

// ============================================================================
// Public API
// ============================================================================

export interface DefineExecutorInput {
  /**
   * Self-described target. Read by AppHarness / SessionHarness / LoopExecutor
   * as the default target for executions running through this executor.
   */
  readonly target: ExecutionTarget;
  /**
   * Family discriminator. Only `"language-model"` ships today.
   */
  readonly family?: "language-model";
  /**
   * Per-execution callback. Receives the projected `LanguageModelInput`
   * and a context bag with an optional abort signal + an `emit`
   * callback. Returns the canonical `LanguageModelExecutionResult`.
   *
   * Streaming-capable adopters call `ctx.emit(delta)` during the run
   * to emit `AdapterDelta` events. The harness routes emitted deltas
   * to two places:
   *
   *   1. The harness's `emitDeltaLazy` (bus envelope; observability —
   *      reaches subscribers via `app.events({ surface: "executor",
   *      phase: "delta" })`).
   *   2. The active `executeStream` iterator (when present), so
   *      consumers iterating the stream get deltas as they arrive.
   *
   * Adopters with non-streaming providers simply don't call `emit` —
   * `execute` still works (final-result-only path). The harness
   * synthesizes `message-start` / `message-end` / `message` summary
   * events around the run when no deltas were emitted, so consumers
   * subscribed only to summary events see them either way.
   *
   * Throw to fail the execution — the harness translates exceptions
   * into `ExecutorError` and emits the terminal envelope with
   * `outcome: "failed"`.
   */
  readonly run: (
    input: LanguageModelInput,
    ctx: {
      readonly signal?: AbortSignal;
      readonly scope: {
        readonly sessionId?: string;
        readonly executionId?: string;
        readonly tickId?: string;
      };
      /** Emit an `AdapterDelta` during the run. See callback doc. */
      readonly emit: (delta: AdapterDelta) => void;
    },
  ) => Promise<LanguageModelExecutionResult>;
  /**
   * Optional custom projection. Defaults to the canonical
   * RenderedTree → LanguageModelInput fold (system text + messages +
   * declared tools filtered to `model` exposure).
   */
  readonly project?: (input: ProjectInput) => LanguageModelInput;
}

/**
 * Construct an `ExecutorFactory` from a callback bundle. Plug the
 * factory into `createApp({ executor: defineExecutor(...) })` to share
 * substrate, or invoke the factory standalone for testing.
 */
export function defineExecutor(spec: DefineExecutorInput): ExecutorFactory {
  const factory = (deps?: ExecutorFactoryDeps): LanguageModelExecutor => {
    const scopeId = deps?.scopeId ?? `define-executor:${ulid()}`;
    const journal = deps?.journal ?? new MemoryJournal();
    const bus = deps?.bus ?? new LocalEventBus();
    const inbox = deps?.inbox ?? new LocalInbox();
    return new CallbackLanguageModelExecutor(scopeId, journal, bus, inbox, spec);
  };
  return Object.assign(factory, { executorFactory: true as const });
}

// ============================================================================
// CallbackLanguageModelExecutor
// ============================================================================

interface InFlightEntry {
  readonly executionId: string;
  abort?: AbortController;
  abortReason?: string;
}

/** Internal — routes adapter deltas to the active `executeStream` iterator. */
type DeltaSink = (delta: AdapterDelta) => void;

class CallbackLanguageModelExecutor
  extends BaseHarness<"executor">
  implements LanguageModelExecutor
{
  readonly family = "language-model" as const;
  readonly target: ExecutionTarget;

  private readonly spec: DefineExecutorInput;
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly aborted = new Set<string>();

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    spec: DefineExecutorInput,
  ) {
    super("executor", scopeId, journal, bus, inbox);
    this.spec = spec;
    this.target = spec.target;
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
          try: () => (this.spec.project ?? defaultProject)(i),
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
    return runHarnessProtocol(this.runOperation(op, (i) => this.executeBody(i, executionId, null)));
  }

  executeStream(input: ExecuteInput<LanguageModelInput>): ExecutorStream<unknown> {
    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    const queue: AdapterDelta[] = [];
    const resolvers: Array<(r: IteratorResult<AdapterDelta>) => void> = [];
    let done = false;
    let error: unknown = null;
    const controller = new AbortController();
    // Merge caller-supplied signal if present.
    if (input.signal) {
      if (input.signal.aborted) controller.abort(input.signal.reason);
      else
        input.signal.addEventListener("abort", () => controller.abort(input.signal!.reason), {
          once: true,
        });
    }

    const sink: DeltaSink = (delta) => {
      if (done) return;
      const r = resolvers.shift();
      if (r) r({ value: delta, done: false });
      else queue.push(delta);
    };

    const completeIteration = (): void => {
      done = true;
      while (resolvers.length > 0) {
        resolvers.shift()!({ value: undefined as unknown as AdapterDelta, done: true });
      }
    };

    const op: Operation<ExecuteInput<LanguageModelInput>, unknown> = {
      opId: `executor:execute:${executionId}:${ulid()}`,
      surface: "executor",
      name: "executor:command:execute",
      scope: input.scope ?? { executionId },
      input: { ...input, signal: controller.signal },
    };
    const resultPromise = runHarnessProtocol(
      this.runOperation(op, (i) => this.executeBody(i, executionId, sink)),
    )
      .then((res) => {
        completeIteration();
        return res;
      })
      .catch((err) => {
        error = err;
        completeIteration();
        throw err;
      });

    return {
      result: resultPromise,
      abort: (reason) => {
        controller.abort(reason ?? "aborted");
      },
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<AdapterDelta>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (done) {
              return error
                ? Promise.reject(error)
                : Promise.resolve({ value: undefined as unknown as AdapterDelta, done: true });
            }
            return new Promise((resolve) => resolvers.push(resolve));
          },
          return(): Promise<IteratorResult<AdapterDelta>> {
            completeIteration();
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
      cause: new Error("defineExecutor inbox dispatch not yet wired (FAÇADE.6 MVP)"),
    });
  }

  // ──────── internals ────────

  private executeBody(
    input: ExecuteInput<LanguageModelInput>,
    executionId: string,
    sink: DeltaSink | null,
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
      // Build the emit callback: always forward to emitDeltaLazy for
      // bus observability; additionally push into the iterator sink
      // when executeStream is the entry point.
      const harness = this;
      const op = {
        opId: `executor:run:emit:${executionId}`,
        surface: "executor" as const,
        name: "executor:command:execute",
        scope: input.scope ?? { executionId },
        input,
      } as Operation<unknown, unknown>;
      const emit = (delta: AdapterDelta): void => {
        // Bus side — fire-and-forget; ignore subscriber-count drops.
        void Effect.runPromise(harness.emitDeltaLazy(op, () => delta).pipe(Effect.orDie));
        // Iterator side — only when a sink is wired (executeStream caller).
        if (sink) sink(delta);
      };
      try {
        const result = yield* Effect.tryPromise<LanguageModelExecutionResult, ExecuteError>({
          try: () =>
            this.spec.run(input.targetInput, {
              ...(input.signal !== undefined ? { signal: input.signal } : {}),
              scope: {
                sessionId: input.scope?.sessionId,
                executionId,
                tickId: input.scope?.tickId,
              },
              emit,
            }),
          catch: (cause): ExecuteError => ({
            _tag: "ProviderRejected",
            cause,
          }),
        });
        return result as unknown;
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
      const projected = (this.spec.project ?? defaultProject)({
        compiled: input.compiled,
        target: input.target,
      });
      const executeInput: ExecuteInput<LanguageModelInput> = {
        targetInput: projected,
        target: input.target,
        scope: { ...(input.scope ?? {}), executionId },
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      };
      const raw = yield* this.executeBody(executeInput, executionId, null);
      const result = raw as LanguageModelExecutionResult;
      const terminal: ExecutorTerminal<LanguageModelExecutionResult> = {
        outcome: "succeeded",
        result,
      };
      return terminal;
    });
  }
}

// ============================================================================
// Default projection (same as MockLanguageModelExecutor)
// ============================================================================

function defaultProject(input: ProjectInput): LanguageModelInput {
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

function normalizeImpl(input: NormalizeInput<unknown>): LanguageModelExecutionResult {
  const out = input.targetOutput;
  if (isLanguageModelExecutionResult(out)) return out;
  throw new Error(
    "defineExecutor.normalize expected a LanguageModelExecutionResult — the run callback should return the canonical shape",
  );
}

function isLanguageModelExecutionResult(v: unknown): v is LanguageModelExecutionResult {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { stopReason?: unknown; output?: unknown };
  return typeof o.stopReason === "string" && Array.isArray(o.output);
}
