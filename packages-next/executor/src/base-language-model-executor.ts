/**
 * `BaseLanguageModelExecutor<TRaw>` — abstract intermediate class for
 * first-party provider executors.
 *
 * Sits between `BaseHarness<"executor">` (substrate phase contract,
 * FiberRef scope, OTel spans, lazy delta emission) and the concrete
 * provider impls (`OpenAIExecutor`, `AnthropicExecutor`,
 * `GoogleExecutor`, `AISDKExecutor`, plus any third-party adopter
 * provider). Owns ~500 LOC of framework scaffolding that was duplicated
 * across the four shipped providers:
 *
 *   - `project` / `execute` / `executeStream` / `normalize` / `run` /
 *     `abort` envelope shapes + Operation construction
 *   - In-flight tracking (`inFlight: Map`, `aborted: Set`,
 *     `InFlightEntry`)
 *   - The shared `executeStream` iterator queue + resolver + bus-emit
 *     plumbing
 *   - The `runBody` skeleton (project → execute → postProcess →
 *     normalize → terminal wrap)
 *   - Default `projectImpl` (canonical RenderedTree fold)
 *   - Default `mapProviderError` + `isAbortError`
 *   - Default `handleMessage` stub
 *
 * Subclasses fill in provider-specific hooks: `buildParams`,
 * `callProvider`, `drainStream`, `normalizeRaw`, plus optional
 * `postProcessForNormalize` for tag-router-style mutations and
 * `isAbortError` for SDKs that throw non-standard abort error types.
 *
 * Adopters writing a one-off model integration should use the
 * callback-style `defineExecutor` factory instead — that surface is
 * shaped for the simple case (single async `run` callback returning
 * the normalized result). This base is for adapters that need to
 * preserve the raw provider response type for telemetry / replay /
 * provider-specific introspection.
 *
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

import { omitUndefined } from "@agentick/utils-next";

import { Chunk, Effect, Exit, Fiber, Option, Queue, Stream } from "effect";

import { BaseHarness, runHarnessProtocol, ulid } from "@agentick/runtime-next";
import type {
  AbortExecutorInput,
  AdapterDelta,
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
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  NormalizeError,
  NormalizeInput,
  Operation,
  OperationJournal,
  ProjectInput,
  ProjectionError,
  RunInput,
} from "@agentick/spec-next";

import { defaultProject } from "./canonical-projection.js";
import { composeTransforms, identityTransform, type DeltaTransform } from "./delta-transform.js";
import { ExecutorLifecycle, type ExecutorInFlightEntry } from "./executor-lifecycle.js";
import { StreamAccumulator } from "./stream-accumulator.js";
import {
  customBlockTransform,
  thinkTagTransform,
  type CustomBlockDefinition,
} from "./tag-transforms.js";

// Re-export so consumers of the base module can grab the canonical
// projection + pipeline primitives without a second import line.
export { defaultProject } from "./canonical-projection.js";
export { composeTransforms, identityTransform, type DeltaTransform } from "./delta-transform.js";
export { StreamAccumulator, type AccumToolCall } from "./stream-accumulator.js";
export {
  customBlockTransform,
  thinkTagTransform,
  type CustomBlockDefinition,
} from "./tag-transforms.js";

// ============================================================================
// Internals
// ============================================================================

/**
 * Bounded delta-queue capacity for `executeStream`. When the iterator
 * consumer lags, `Queue.offer` blocks at this depth, which propagates
 * backpressure up the Effect.Stream and through to the provider SDK's
 * async iterator (pulling slower in turn). 64 deltas ≈ a few hundred
 * tokens of upstream slack — enough to absorb GC pauses without
 * causing memory growth.
 */
const STREAM_QUEUE_CAPACITY = 64;

// InFlightEntry shape lives in `executor-lifecycle.ts` as
// `ExecutorInFlightEntry`. Re-aliased here for backward-compatibility
// with internal references — same shape, single source of truth.
type InFlightEntry = ExecutorInFlightEntry;

// ============================================================================
// BaseLanguageModelExecutor
// ============================================================================

export abstract class BaseLanguageModelExecutor<TRaw, TChunk = unknown>
  extends BaseHarness<"executor">
  implements LanguageModelExecutor
{
  readonly family = "language-model" as const;
  abstract readonly target: ExecutionTarget;

  /**
   * Whether `execute()` (the non-iterating entry point) should still
   * use the streaming provider call internally to drive bus-level
   * `executor:delta` envelopes. Default: false (call the non-streaming
   * provider API). Subclasses override at construction.
   */
  protected readonly streamByDefault: boolean = false;

  /**
   * Whether this provider supports the streaming codepath at all. AI
   * SDK's `streamText` is its own surface (separate from
   * `generateText`); when `false`, the base throws if a caller hits
   * `executeStream`. Default: true.
   */
  protected readonly supportsRunStreaming: boolean = true;

  private readonly lifecycle = new ExecutorLifecycle();
  // Backward-compat aliases for refs that haven't been renamed yet.
  private get inFlight(): Map<string, InFlightEntry> {
    return this.lifecycle.inFlight;
  }
  private get aborted(): Set<string> {
    return this.lifecycle.aborted;
  }

  constructor(scopeId: string, journal: OperationJournal, bus: EventBus, inbox: MessageInbox) {
    super("executor", scopeId, journal, bus, inbox);
  }

  // ──────────────────────────────────────────────────────────────────
  // Required hooks — subclass MUST implement
  // ──────────────────────────────────────────────────────────────────

  /**
   * Translate canonical `LanguageModelInput` → provider request shape.
   * Examples:
   *   - OpenAI: `LanguageModelInput → ChatCompletionCreateParams`
   *   - Anthropic: `LanguageModelInput → MessageCreateParams`
   *   - Google: `LanguageModelInput → GenerateContentParameters`
   *
   * Pure. May read `target.providerOptions` for per-provider knobs.
   */
  protected abstract buildParams(input: LanguageModelInput, target: ExecutionTarget): unknown;

  /**
   * Non-streaming provider call. Returns the raw provider response.
   * Subclasses propagate `signal` to the SDK so abort works.
   *
   * Throws on provider error; base translates via `mapProviderError`.
   */
  protected abstract callProvider(params: unknown, signal: AbortSignal | undefined): Promise<TRaw>;

  /**
   * Open the provider's streaming response. Returns an async-iterable
   * of provider-specific chunks. The base owns the loop; subclass just
   * opens the stream.
   *
   * Subclasses propagate `signal` to the SDK so abort works. Throws on
   * provider error; base translates via `mapProviderError`.
   *
   * Override `supportsRunStreaming = false` if your provider has no
   * streaming surface (and this hook will never be called).
   */
  protected abstract openStream(
    params: unknown,
    signal: AbortSignal,
  ): Promise<AsyncIterable<TChunk>> | AsyncIterable<TChunk>;

  /**
   * Translate one provider chunk into zero or more `AdapterDelta`s.
   *
   * The base feeds every delta through the transform pipeline
   * (`adapterTransforms` → `customBlocks` → ...) and then routes the
   * final deltas to:
   *   1. The `StreamAccumulator` (the base's stream state)
   *   2. The bus (via `emitDeltaLazy`) for observability
   *   3. The active `executeStream` iterator (when present)
   *
   * Pure with respect to the accumulator — subclasses do NOT mutate
   * `accum`; the base updates it from the emitted deltas. The
   * accumulator is passed for read-only context (e.g. "what's the
   * current text block index?" via `accum.highWaterBlockIndex`).
   *
   * Most providers map one chunk to multiple deltas (content-start +
   * content-delta + tool-call-delta + ...); return them in order.
   */
  protected abstract mapChunk(chunk: TChunk, accum: StreamAccumulator): readonly AdapterDelta[];

  /**
   * Synthesize the provider's raw response shape from the final
   * accumulator state. Called once at the end of `drainStream`.
   *
   * Examples:
   *   - OpenAI → `ChatCompletion` (with `choices[0].message.content` =
   *     `accum.totalText()`, `tool_calls` from `accum.toolCalls`)
   *   - Anthropic → `Message` (with `content` array assembled from text
   *     + tool_use blocks)
   *   - Google → `GenerateContentResponse` (with `candidates[0].content.parts`
   *     reassembled from text + functionCall parts)
   *
   * The `modelSeen` argument is the model id the provider reported
   * during the stream (when chunk-carried; e.g. OpenAI's `chunk.model`,
   * Google's `chunk.modelVersion`). Falls back to whatever the
   * subclass knows.
   */
  protected abstract reconstructRaw(accum: StreamAccumulator, modelSeen: string | undefined): TRaw;

  /**
   * Convert raw provider response → canonical
   * `LanguageModelExecutionResult`. Called from `normalize()` and from
   * `runBody` (after `postProcessForNormalize`).
   */
  protected abstract normalizeRaw(raw: TRaw): LanguageModelExecutionResult;

  // ──────────────────────────────────────────────────────────────────
  // Optional hooks — sensible defaults; override when needed
  // ──────────────────────────────────────────────────────────────────

  /**
   * Project `ProjectInput` → `LanguageModelInput`. Default is the
   * canonical RenderedTree fold (system text from sections + messages
   * + declared tools filtered to `model` exposure).
   *
   * Override when the provider needs a different system-message shape
   * (e.g., Anthropic preserves per-section `providerMetadata` for
   * `cache_control` by emitting one text part per system section).
   */
  protected projectImpl(input: ProjectInput): LanguageModelInput {
    return defaultProject(input);
  }

  /**
   * Provider-internal `DeltaTransform`s applied to chunk-mapped deltas
   * BEFORE the customBlocks pipeline. Use this for provider-shape
   * cleanup (e.g. `thinkTagTransform()` for OpenAI-compatible servers
   * that emit `<think>` tags inline). Default: empty.
   *
   * Order matters: chunk → mapChunk → adapterTransforms[0] →
   * adapterTransforms[1] → ... → customBlocks → emit + accumulate.
   */
  protected adapterTransforms(): readonly DeltaTransform[] {
    return [];
  }

  /**
   * Declarative adopter-facing custom-block extraction. The base
   * compiles this map into a `customBlockTransform` and runs it after
   * `adapterTransforms`. Text outside the declared tags flows through
   * as `content-delta`; tag content becomes `custom-block-*` deltas.
   *
   * Set as a class field (or via constructor option threaded to a
   * protected setter). Default: undefined (no custom-block extraction).
   */
  protected readonly customBlocks: Readonly<Record<string, CustomBlockDefinition>> | undefined =
    undefined;

  /**
   * Mutate the raw response between `execute` and `normalize` in the
   * `run` codepath. Default: identity. Most providers don't need this
   * anymore — the streaming pipeline (mapChunk + transforms +
   * reconstructRaw) already produces the cleaned text. Override only
   * when the non-streaming path also needs post-processing (e.g.
   * applyTagRouterToChatCompletion when streamByDefault is false but
   * tag routing should still apply).
   */
  protected postProcessForNormalize(raw: TRaw): TRaw {
    return raw;
  }

  /**
   * Extract provider-specific metadata from the raw response after
   * `normalizeRaw` runs. The base merges the returned record into
   * `LanguageModelExecutionResult.finishMetadata` (last-write-wins per
   * key). v1 `createAdapter` parity — adopters surface fields the
   * canonical shape doesn't carry (OpenAI `system_fingerprint`, Google
   * `safetyRatings`, Anthropic `stop_sequence`, provider-specific
   * citation slots, etc.) without subclassing `normalizeRaw`.
   *
   * Default: undefined (no extraction). Return `undefined` to skip;
   * the base no-ops in that case.
   */
  protected extractMetadata(_raw: TRaw): Readonly<Record<string, unknown>> | undefined {
    return undefined;
  }

  /**
   * Default abort-detection: matches `AbortError` (Web/Node) and
   * `APIUserAbortError` (OpenAI/Anthropic SDK convention) plus any
   * error message containing "abort". Override for SDKs with
   * non-standard abort signaling.
   */
  protected isAbortError(cause: unknown): boolean {
    if (!(cause instanceof Error)) return false;
    return (
      cause.name === "AbortError" ||
      cause.name === "APIUserAbortError" ||
      /abort/i.test(cause.message)
    );
  }

  /**
   * Default provider-error mapping: AbortError → `ProviderAborted`;
   * any error with a numeric `status` / `statusCode` field →
   * `ProviderRejected`; everything else → `StreamFailed`. Override
   * when your provider surfaces structured errors you can extract more
   * detail from.
   */
  protected mapProviderError(cause: unknown): ExecuteError {
    if (this.isAbortError(cause)) {
      return {
        _tag: "ProviderAborted",
        reason: cause instanceof Error ? cause.message : "aborted",
      };
    }
    const status =
      (cause as { status?: unknown })?.status ?? (cause as { statusCode?: unknown })?.statusCode;
    if (typeof status === "number") {
      return {
        _tag: "ProviderRejected",
        status,
        cause,
      };
    }
    return { _tag: "StreamFailed", cause };
  }

  /**
   * Emit gap-filling deltas at end-of-stream: close any blocks the
   * provider didn't close inline, emit `tool-call-end` + `tool-call`
   * summaries for any tool calls without an `input` set, and emit
   * `message-end` + `message` if not yet observed.
   *
   * Providers whose chunk vocabulary includes explicit `content-end` /
   * `tool-call-end` / `message-end` events (Anthropic) emit them via
   * `mapChunk`; the accumulator records them and this method becomes a
   * no-op for those slots. Providers without explicit closes (OpenAI,
   * AI SDK text stream) get the closes synthesized here from accumulator
   * state.
   *
   * Override only if your provider needs a different terminal shape.
   */
  protected finalizeStream(accum: StreamAccumulator): readonly AdapterDelta[] {
    const out: AdapterDelta[] = [];

    // 1. Close any blocks still open + emit per-block summary.
    const openSorted = Array.from(accum.openBlocks.entries()).sort((a, b) => a[0] - b[0]);
    for (const [blockIndex, kind] of openSorted) {
      if (kind === "text") {
        out.push({ type: "content-end", blockIndex });
        const text = accum.textByBlock.get(blockIndex) ?? "";
        out.push({
          type: "content",
          blockIndex,
          content: { type: "text", text },
        });
      } else {
        out.push({ type: "reasoning-end", blockIndex });
        const reasoning = accum.reasoningByBlock.get(blockIndex) ?? "";
        out.push({ type: "reasoning", blockIndex, reasoning });
      }
    }

    // 2. Close any tool calls without a tool-call summary yet (OpenAI/
    //    AI SDK don't emit explicit tool-call-end events).
    for (const entry of accum.toolCalls.values()) {
      if (entry.input !== undefined) continue;
      let parsed: Readonly<Record<string, unknown>> = {};
      try {
        parsed = JSON.parse(entry.argsBuffer || "{}") as Readonly<Record<string, unknown>>;
      } catch {
        parsed = {};
      }
      out.push({ type: "tool-call-end", callId: entry.callId });
      const tc: AdapterDelta = {
        type: "tool-call",
        callId: entry.callId,
        name: entry.name,
        input: parsed,
        ...(entry.providerMetadata
          ? ({ providerMetadata: entry.providerMetadata } as Record<string, unknown>)
          : {}),
      } as AdapterDelta;
      out.push(tc);
    }

    // 3. message-end (if not already observed in-stream).
    if (!accum.messageEnded) {
      out.push({
        type: "message-end",
        stopReason: accum.stopReason,
        usage: accum.usage,
      });
    }

    // 4. message summary — always emit (single canonical assistant
    //    message synthesized from accumulator state).
    out.push({
      type: "message",
      message: {
        role: "assistant",
        content: accum.toContentBlocks(),
        ...(accum.modelSeen ? { model: accum.modelSeen } : {}),
      },
      stopReason: accum.stopReason,
      usage: accum.usage,
    });

    return out;
  }

  /**
   * Default inbox handler — fails with a `HandlerError`. Override only
   * if your provider executor responds to async inbox messages (none
   * of the shipped four do yet).
   */
  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail({
      _tag: "HandlerError",
      cause: new Error(`${this.constructor.name} inbox dispatch not yet wired`),
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // ExecutorProtocol — framework-final, do not override in subclasses
  // ──────────────────────────────────────────────────────────────────

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
          try: () => this.projectImpl(i),
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
      this.runOperation(op, (i) =>
        this.executeBody(i, executionId, op as Operation<unknown, unknown>, null),
      ),
    );
  }

  executeStream(input: ExecuteInput<LanguageModelInput>): ExecutorStream<TRaw> {
    if (!this.supportsRunStreaming) {
      const err: ExecuteError = {
        _tag: "StreamFailed",
        cause: new Error(
          `${this.constructor.name} does not support executeStream — use execute() instead`,
        ),
      };
      const resultPromise: Promise<TRaw> = Promise.reject(err);
      // Silence Node's unhandled-rejection — the caller may not await .result.
      resultPromise.catch(() => {});
      return {
        result: resultPromise,
        abort: () => {},
        [Symbol.asyncIterator]() {
          return {
            next: () => Promise.reject(err),
            return: () =>
              Promise.resolve({ value: undefined as unknown as AdapterDelta, done: true }),
          };
        },
      };
    }

    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    const streamOp: Operation<ExecuteInput<LanguageModelInput>, unknown> = {
      opId: `executor:execute:${executionId}:${ulid()}`,
      surface: "executor",
      name: "executor:command:execute",
      scope: input.scope ?? { executionId },
      input,
    };

    // Bounded delta queue — provides real backpressure: when the
    // iterator consumer lags, `Queue.offer` (inside executeBody's
    // sink-tap) blocks the upstream Stream, which pauses
    // `Stream.fromAsyncIterable`'s pull from the provider SDK.
    // None = stream completion sentinel.
    const harness = this;
    type QItem = Option.Option<AdapterDelta>;

    const program = Effect.gen(function* () {
      const queue = yield* Queue.bounded<QItem>(STREAM_QUEUE_CAPACITY);

      // Run executeBody to completion inside this fiber. The sink
      // injects deltas into the queue with backpressure; when the
      // stream completes we enqueue None as the iterator's terminator.
      const sink = (delta: AdapterDelta): Effect.Effect<void> =>
        Queue.offer(queue, Option.some(delta)).pipe(Effect.asVoid);

      const runEffect = harness
        .runOperation(streamOp, (i) =>
          harness.executeBody(i, executionId, streamOp as Operation<unknown, unknown>, sink),
        )
        .pipe(
          // Whatever happens (success, error, interrupt), the consumer
          // gets a terminating None so its iterator drains cleanly.
          Effect.ensuring(Queue.offer(queue, Option.none<AdapterDelta>())),
        ) as Effect.Effect<TRaw, unknown>;

      // forkDaemon — the streaming fiber must outlive this setup
      // Effect's scope; iterator.return() / abort() interrupt it
      // explicitly via the returned handle.
      const fiber = yield* Effect.forkDaemon(runEffect);
      return { queue, fiber };
    });

    // Forking via runPromise so the iterator and `.result` Promise can
    // both observe the same fiber outcome.
    let resolveQueueFiber!: (v: {
      queue: Queue.Queue<QItem>;
      fiber: Fiber.RuntimeFiber<TRaw, unknown>;
    }) => void;
    let rejectQueueFiber!: (e: unknown) => void;
    const ready = new Promise<{
      queue: Queue.Queue<QItem>;
      fiber: Fiber.RuntimeFiber<TRaw, unknown>;
    }>((res, rej) => {
      resolveQueueFiber = res;
      rejectQueueFiber = rej;
    });

    void Effect.runPromise(program).then(
      (qf) =>
        resolveQueueFiber(
          qf as { queue: Queue.Queue<QItem>; fiber: Fiber.RuntimeFiber<TRaw, unknown> },
        ),
      rejectQueueFiber,
    );

    const resultPromise: Promise<TRaw> = ready.then(({ fiber }) =>
      Effect.runPromise(Fiber.await(fiber)).then((exit) => {
        if (Exit.isSuccess(exit)) return exit.value;
        throw exit.cause;
      }),
    );
    // Silence Node's unhandled-rejection — the caller may not await .result.
    resultPromise.catch(() => {});

    // Track the fiber so `abort()` can interrupt it (separate from
    // executeBody's controller — interrupt the fiber, then let
    // withExternalAbort surface ProviderAborted).
    void ready.then(({ fiber }) => {
      const entry = this.inFlight.get(executionId);
      if (entry) entry.fiber = fiber as Fiber.RuntimeFiber<unknown, unknown>;
    });

    return {
      result: resultPromise,
      abort: (reason) => {
        this.aborted.add(executionId);
        const r = reason ?? "aborted";
        void ready.then(({ fiber }) => {
          const entry = this.inFlight.get(executionId);
          if (entry) {
            entry.abortReason = r;
            entry.abort?.abort(r);
          }
          void Effect.runPromise(Fiber.interrupt(fiber));
        });
      },
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<AdapterDelta>> => {
            const { queue } = await ready;
            const item = await Effect.runPromise(Queue.take(queue));
            if (Option.isNone(item)) {
              return { value: undefined as unknown as AdapterDelta, done: true };
            }
            return { value: item.value, done: false };
          },
          return: async (): Promise<IteratorResult<AdapterDelta>> => {
            try {
              const { fiber, queue } = await ready;
              await Effect.runPromise(Fiber.interrupt(fiber));
              await Effect.runPromise(Queue.shutdown(queue));
            } catch {
              // ignore — caller is closing iteration
            }
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
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.try({
          try: () => this.normalizeRaw(i.targetOutput as TRaw),
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
      Effect.sync(() => this.lifecycle.abortExecution(input.executionId, input.reason)),
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────

  private executeBody(
    input: ExecuteInput<LanguageModelInput>,
    executionId: string,
    op: Operation<unknown, unknown>,
    sink: ((delta: AdapterDelta) => Effect.Effect<void>) | null,
  ): Effect.Effect<TRaw, ExecuteError, never> {
    return Effect.gen(this, function* () {
      if (this.aborted.has(executionId)) {
        return yield* Effect.fail<ExecuteError>({
          _tag: "ProviderAborted",
          reason: "aborted prior to execute",
        });
      }

      // External-abort bridge: the caller's signal + abort() API both
      // feed this controller; Effect's fiber-interrupt path is layered
      // on top via Effect.tryPromise's built-in signal arg.
      const controller = new AbortController();
      const entry: InFlightEntry = { executionId, abort: controller };
      this.inFlight.set(executionId, entry);

      try {
        const params = this.buildParams(input.targetInput, input.target);
        // Force streaming when called from executeStream (sink non-null);
        // execute() opts in via streamByDefault. Target capabilities can
        // veto streaming for execute() but not for executeStream() — the
        // caller explicitly asked for the iterator.
        const wantStream =
          sink !== null ||
          (this.streamByDefault &&
            this.supportsRunStreaming &&
            (input.target.capabilities?.supportsStreaming ?? true));

        if (!wantStream) {
          // Non-streaming: Effect.tryPromise's `signal` arg auto-aborts
          // on fiber interrupt; merge with caller's external signal.
          return yield* Effect.tryPromise<TRaw, ExecuteError>({
            try: (fiberSignal) =>
              this.callProvider(params, mergeSignals(input.signal, fiberSignal)),
            catch: (cause): ExecuteError => this.mapProviderError(cause),
          }).pipe(
            // The external controller (abort() API) feeds the SDK via
            // the merged signal too — wire it through `Effect.race`
            // with a watcher that fails on external abort.
            this.withExternalAbort(controller, input.signal),
          );
        }

        // Streaming path — Effect.Stream owns the entire pipeline:
        //   openStream → mapChunk → transforms → accum + bus + sink
        // All side-effects run inside the fiber's scope; interrupting
        // the fiber tears down the iterator, the bus tap, and the
        // bounded queue together.
        const accum = new StreamAccumulator();
        const transforms: DeltaTransform[] = [...this.adapterTransforms()];
        if (this.customBlocks) {
          transforms.push(customBlockTransform(this.customBlocks));
        }
        const pipeline = composeTransforms(transforms);

        const harness = this;
        const externalSignal = input.signal;

        // Build the data stream — pure deltas, no side-effects yet.
        const chunkStream: Stream.Stream<AdapterDelta, ExecuteError> = Stream.unwrap(
          Effect.tryPromise<AsyncIterable<TChunk>, ExecuteError>({
            try: async (fiberSignal) => {
              const merged = mergeSignals(externalSignal, fiberSignal);
              // External controller too — abort() API path.
              const finalSignal = mergeSignals(controller.signal, merged);
              const iter = await this.openStream(params, finalSignal);
              return iter;
            },
            catch: (cause): ExecuteError => this.mapProviderError(cause),
          }).pipe(
            Effect.map((iter) =>
              Stream.fromAsyncIterable<TChunk, ExecuteError>(iter, (cause) =>
                this.mapProviderError(cause),
              ),
            ),
          ),
        ).pipe(
          Stream.mapConcat((chunk: TChunk) => this.mapChunk(chunk, accum)),
          Stream.mapConcat((delta: AdapterDelta) => pipeline.process(delta)),
        );

        const flushStream: Stream.Stream<AdapterDelta, ExecuteError> = Stream.suspend(() =>
          Stream.fromIterable(pipeline.flush()),
        );
        const finalizeStream: Stream.Stream<AdapterDelta, ExecuteError> = Stream.suspend(() =>
          Stream.fromIterable(this.finalizeStream(accum)),
        );

        // Synthetic-message-start guard: if the provider's first delta
        // is already a message-start, pass it through unchanged.
        // Otherwise prepend a minimal one. This avoids the double-start
        // problem (provider emits message-start carrying model + base
        // synthesizes its own without model).
        let messageStartEmitted = false;
        const ensureMessageStart = Stream.mapConcat(
          (delta: AdapterDelta): readonly AdapterDelta[] => {
            if (messageStartEmitted || delta.type === "message-start") {
              messageStartEmitted = true;
              return [delta];
            }
            messageStartEmitted = true;
            return [{ type: "message-start", role: "assistant" }, delta];
          },
        );

        // Concatenate: chunks ++ flush ++ finalize. Inject synthetic
        // message-start lazily via ensureMessageStart so providers can
        // carry their own (with model) without doubling up. Finalize
        // runs after everything else (suspend defers the closure until
        // upstream is drained).
        const fullStream: Stream.Stream<AdapterDelta, ExecuteError> = Stream.concatAll(
          Chunk.make(chunkStream, flushStream, finalizeStream),
        )
          .pipe(ensureMessageStart)
          .pipe(
            // Accumulator update — synchronous, in-fiber.
            Stream.tap((delta) => Effect.sync(() => accum.apply(delta))),
            // Bus emission — runs in-fiber so interrupt tears it down.
            // emitDeltaLazy publishes to a bounded internal bus; ignore
            // subscriber-count failures so slow subscribers don't kill
            // the stream.
            Stream.tap((delta) =>
              harness.emitDeltaLazy(op, () => delta).pipe(Effect.catchAll(() => Effect.void)),
            ),
          );

        // Sink injection — when executeStream is the entry point, tap
        // the stream into the bounded queue. Queue.offer blocks when
        // the queue is full → upstream stream pauses → provider stream
        // paces. This is the real backpressure win over the previous
        // unbounded array sink.
        const finalStream: Stream.Stream<AdapterDelta, ExecuteError> = sink
          ? Stream.tap(fullStream, sink)
          : fullStream;

        yield* Stream.runDrain(finalStream).pipe(this.withExternalAbort(controller, input.signal));
        return this.reconstructRaw(accum, accum.modelSeen);
      } finally {
        this.inFlight.delete(executionId);
      }
    });
  }

  /**
   * Wire the external abort path (caller signal + `abort()` API) into
   * the running Effect. Returns a piped Effect that races the inner
   * computation against an "external abort" watcher; if either signal
   * fires, the Effect fails with `ProviderAborted`. The race's
   * loser-side teardown propagates fiber interrupt to the inner
   * computation, which collapses through `Effect.tryPromise` into the
   * provider SDK as an AbortSignal abort.
   */
  private withExternalAbort(
    controller: AbortController,
    callerSignal: AbortSignal | undefined,
  ): <A>(self: Effect.Effect<A, ExecuteError>) => Effect.Effect<A, ExecuteError> {
    return <A>(self: Effect.Effect<A, ExecuteError>) =>
      Effect.race(
        self,
        Effect.async<never, ExecuteError>((resume) => {
          const fire = (reason: unknown): void =>
            resume(
              Effect.fail<ExecuteError>({
                _tag: "ProviderAborted",
                reason: typeof reason === "string" ? reason : "aborted",
              }),
            );
          if (controller.signal.aborted) {
            fire(controller.signal.reason);
            return;
          }
          if (callerSignal?.aborted) {
            fire(callerSignal.reason);
            return;
          }
          const onCtrl = (): void => fire(controller.signal.reason);
          controller.signal.addEventListener("abort", onCtrl, { once: true });
          const onCaller = callerSignal ? (): void => fire(callerSignal.reason) : undefined;
          if (callerSignal && onCaller) {
            callerSignal.addEventListener("abort", onCaller, { once: true });
          }
          return Effect.sync(() => {
            controller.signal.removeEventListener("abort", onCtrl);
            if (callerSignal && onCaller) {
              callerSignal.removeEventListener("abort", onCaller);
            }
          });
        }),
      );
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
      const projected = this.projectImpl({
        compiled: input.compiled,
        target: input.target,
        tools: input.tools,
      });

      // 2. execute (provider call; may stream + emit deltas)
      const executeInput: ExecuteInput<LanguageModelInput> = {
        targetInput: projected,
        target: input.target,
        scope: { ...(input.scope ?? {}), executionId },
        ...omitUndefined({ signal: input.signal }),
      };
      const raw = yield* this.executeBody(
        executeInput,
        executionId,
        op as Operation<unknown, unknown>,
        null,
      ).pipe(
        Effect.catchTag("ProviderAborted", (e) =>
          Effect.succeed<ExecutorTerminal<LanguageModelExecutionResult>>({
            outcome: "canceled",
            reason: e.reason ?? "aborted",
          }),
        ),
      );

      // ProviderAborted recovery returned a terminal directly — pass through.
      if (isTerminal(raw)) {
        return raw;
      }

      // 3. post-process (tag-router for OpenAI/Anthropic/Google; identity by default)
      const rawForNormalize = this.postProcessForNormalize(raw as TRaw);

      // 4. normalize (deterministic)
      const result = yield* Effect.try({
        try: () => this.normalizeRaw(rawForNormalize),
        catch: (cause): ExecutorError => ({
          _tag: "NormalizationFailed",
          cause,
        }),
      });

      // 5. merge provider-specific metadata (v1 extractMetadata parity).
      //    Default `extractMetadata` returns undefined → no-op.
      const extracted = this.extractMetadata(rawForNormalize);
      const finalResult: LanguageModelExecutionResult =
        extracted !== undefined
          ? {
              ...result,
              finishMetadata: { ...(result.finishMetadata ?? {}), ...extracted },
            }
          : result;

      const terminal: ExecutorTerminal<LanguageModelExecutionResult> = {
        outcome: "succeeded",
        result: finalResult,
      };
      return terminal;
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isTerminal(v: unknown): v is ExecutorTerminal<LanguageModelExecutionResult> {
  return (
    typeof v === "object" &&
    v !== null &&
    "outcome" in v &&
    (v as { outcome?: unknown }).outcome === "canceled"
  );
}

/**
 * Merge an optional caller signal with the internal controller signal
 * into one composite signal. When either fires, the composite fires.
 */
export function mergeSignals(caller: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  if (caller === undefined) return internal;
  if (caller.aborted) return caller;
  if (internal.aborted) return internal;
  const ctrl = new AbortController();
  const onCaller = (): void => ctrl.abort(caller.reason);
  const onInternal = (): void => ctrl.abort(internal.reason);
  caller.addEventListener("abort", onCaller, { once: true });
  internal.addEventListener("abort", onInternal, { once: true });
  return ctrl.signal;
}
