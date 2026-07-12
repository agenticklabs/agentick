/**
 * `LanguageModelExecutor<TRaw, TChunk>` — THE executor harness (ADR 52).
 *
 * One final class: `BaseHarness<"executor">` (substrate phase contract,
 * FiberRef scope, OTel spans, lazy delta emission) plus the entire
 * execution engine, consuming a `LanguageModelAdapter` part for
 * provider normalization. There is no subclass tier — providers ship
 * adapters (`openai(...)`, `google(...)`, `anthropic(...)`), not
 * executor classes. This class owns everything Effect:
 *
 *   - `project` / `execute` / `executeStream` / `normalize` / `run` /
 *     `abort` envelope shapes + Operation construction
 *   - In-flight tracking (`inFlight: Map`, `aborted: Set`,
 *     `InFlightEntry`)
 *   - The shared `executeStream` iterator queue + resolver + bus-emit
 *     plumbing
 *   - The `runBody` skeleton (project → execute → postProcess →
 *     normalize → terminal wrap)
 *   - Default projection (canonical RenderedTree fold), default
 *     `mapProviderError` / `isAbortError` — each overridable by the
 *     adapter's optional hooks
 *
 * The adapter fills in provider specifics: `buildParams`, `call`,
 * `openStream`, `mapChunk`, `reconstructRaw`, `normalize`, plus the
 * optional quirk hooks (`postProcessForNormalize`, `adapterTransforms`,
 * `isAbortError`, ...). See `language-model-adapter.ts`.
 *
 * @see docs/proposals/v2/blueprint/52-executors-and-model-adapters.md
 */

import { omitUndefined, unwrapExit } from "@agentick/utils-next";

import { Cause, Chunk, Effect, Exit, Fiber, Option, Queue, Stream } from "effect";

import { BaseHarness, runHarnessProtocol, ulid } from "@agentick/runtime-next";
import type {
  AbortExecutorInput,
  AdapterDelta,
  EventBus,
  ExecuteErrorChannel,
  ExecuteInput,
  ExecutionTarget,
  ExecutorError,
  ExecutorFx,
  ExecutorStream,
  ExecutorTerminal,
  LanguageModelExecutionResult,
  LanguageModelExecutor as LanguageModelExecutorProtocol,
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
  SubstrateError,
} from "@agentick/spec-next";
import {
  HandlerError,
  NormalizationFailed,
  ProjectionFailed,
  ProviderAborted,
  ProviderRejected,
  StreamFailed,
} from "@agentick/spec-next";

import {
  composeTransforms,
  customBlockTransform,
  defaultFinalizeStream,
  defaultProject,
  StreamAccumulator,
  type CustomBlockDefinition,
  type DeltaTransform,
  type LanguageModelAdapter,
} from "@agentick/model-next";

import { ExecutorLifecycle, type ExecutorInFlightEntry } from "./executor-lifecycle.js";

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

export interface LanguageModelExecutorOptions<TRaw = unknown, TChunk = unknown> {
  /** The provider-normalization part (ADR 52). */
  readonly adapter: LanguageModelAdapter<TRaw, TChunk>;
}

export class LanguageModelExecutor<TRaw = unknown, TChunk = unknown>
  extends BaseHarness<"executor">
  implements LanguageModelExecutorProtocol
{
  readonly family = "language-model" as const;

  /** The provider-normalization part (ADR 52). */
  private readonly adapter: LanguageModelAdapter<TRaw, TChunk>;

  /** Self-described target — delegated to the adapter. */
  get target(): ExecutionTarget {
    return this.adapter.target;
  }

  /** See {@link LanguageModelAdapter.streamByDefault}. */
  private get streamByDefault(): boolean {
    return this.adapter.streamByDefault ?? false;
  }

  /** See {@link LanguageModelAdapter.supportsStreaming}. */
  private get supportsRunStreaming(): boolean {
    return this.adapter.supportsStreaming ?? true;
  }

  private readonly lifecycle = new ExecutorLifecycle();
  // Backward-compat aliases for refs that haven't been renamed yet.
  private get inFlight(): Map<string, InFlightEntry> {
    return this.lifecycle.inFlight;
  }
  private get aborted(): Set<string> {
    return this.lifecycle.aborted;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: LanguageModelExecutorOptions<TRaw, TChunk>,
  ) {
    super("executor", scopeId, journal, bus, inbox);
    this.adapter = options.adapter;
  }

  // ──────────────────────────────────────────────────────────────────
  // Adapter delegation — the round trip (ADR 52). Bodies live on the
  // adapter; these thin privates keep every pipeline call site stable.
  // ──────────────────────────────────────────────────────────────────

  private buildParams(input: LanguageModelInput, target: ExecutionTarget): unknown {
    return this.adapter.buildParams(input, target);
  }

  private callProvider(params: unknown, signal: AbortSignal | undefined): Promise<TRaw> {
    return this.adapter.call(params, signal);
  }

  private openStream(
    params: unknown,
    signal: AbortSignal | undefined,
  ): AsyncIterable<TChunk> | Promise<AsyncIterable<TChunk>> {
    return this.adapter.openStream(params, signal);
  }

  private mapChunk(chunk: TChunk, accum: StreamAccumulator): readonly AdapterDelta[] {
    return this.adapter.mapChunk(chunk, accum);
  }

  private reconstructRaw(accum: StreamAccumulator, modelSeen: string | undefined): TRaw {
    return this.adapter.reconstructRaw(accum, modelSeen);
  }

  private normalizeRaw(raw: TRaw): LanguageModelExecutionResult {
    return this.adapter.normalize(raw);
  }

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
  private projectImpl(input: ProjectInput): LanguageModelInput {
    return this.adapter.project ? this.adapter.project(input) : defaultProject(input);
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
  private adapterTransforms(): readonly DeltaTransform[] {
    return this.adapter.adapterTransforms?.() ?? [];
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
  private get customBlocks(): Readonly<Record<string, CustomBlockDefinition>> | undefined {
    return this.adapter.customBlocks;
  }

  /**
   * Mutate the raw response between `execute` and `normalize` in the
   * `run` codepath. Default: identity. Most providers don't need this
   * anymore — the streaming pipeline (mapChunk + transforms +
   * reconstructRaw) already produces the cleaned text. Override only
   * when the non-streaming path also needs post-processing (e.g.
   * applyTagRouterToChatCompletion when streamByDefault is false but
   * tag routing should still apply).
   */
  private postProcessForNormalize(raw: TRaw): TRaw {
    return this.adapter.postProcessForNormalize ? this.adapter.postProcessForNormalize(raw) : raw;
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
  private extractMetadata(raw: TRaw): Readonly<Record<string, unknown>> | undefined {
    return this.adapter.extractMetadata?.(raw);
  }

  /**
   * Default abort-detection: matches `AbortError` (Web/Node) and
   * `APIUserAbortError` (OpenAI/Anthropic SDK convention) plus any
   * error message containing "abort". Override for SDKs with
   * non-standard abort signaling.
   */
  private isAbortError(cause: unknown): boolean {
    if (this.adapter.isAbortError) return this.adapter.isAbortError(cause);
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
  private mapProviderError(cause: unknown): ExecuteErrorChannel {
    if (this.adapter.mapProviderError) return this.adapter.mapProviderError(cause);
    if (this.isAbortError(cause)) {
      return new ProviderAborted({ reason: cause instanceof Error ? cause.message : "aborted" });
    }
    const status =
      (cause as { status?: unknown })?.status ?? (cause as { statusCode?: unknown })?.statusCode;
    if (typeof status === "number") {
      return new ProviderRejected({ status, cause });
    }
    return new StreamFailed({ cause });
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
  private finalizeStream(accum: StreamAccumulator): readonly AdapterDelta[] {
    if (this.adapter.finalizeStream) return this.adapter.finalizeStream(accum);
    return defaultFinalizeStream(accum);
  }

  /**
   * Default inbox handler — fails with a `HandlerError`. Override only
   * if your provider executor responds to async inbox messages (none
   * of the shipped four do yet).
   */
  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(
      new HandlerError({
        cause: new Error(`${this.constructor.name} inbox dispatch not yet wired`),
      }),
    );
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
          catch: (cause): ProjectionError =>
            new ProjectionFailed({ reason: "projection threw", cause }),
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
      const err: ExecuteErrorChannel = new StreamFailed({
        cause: new Error(
          `adapter '${this.adapter.provider}' does not support executeStream — use execute() instead`,
        ),
      });
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
      // Unwrap via the SAME helper `runHarnessProtocol` uses (which
      // execute()/run() go through), so `.result` rejects with the typed
      // `ExecuteErrorChannel` — not a raw Effect `Cause`. Keeps the
      // streaming path's failure surface identical to the non-streaming
      // paths and honors "Effect internal, Promise external" at the
      // ExecutorProtocol boundary (#181).
      Effect.runPromise(Fiber.await(fiber)).then((exit) => unwrapExit(exit) as TRaw),
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
            const { queue, fiber } = await ready;
            const item = await Effect.runPromise(Queue.take(queue)).catch(() =>
              Option.none<AdapterDelta>(),
            );
            if (Option.isNone(item)) {
              // End of stream (#182, Option A): a provider FAILURE throws
              // the typed error from the iterator — matching generateStream
              // and ecosystem async-iterable semantics. Abort/interrupt
              // clean-terminates (cancellation is an outcome, not an
              // error; `.result` carries the aborted terminal).
              const exit = await Effect.runPromise(Fiber.await(fiber));
              if (Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)) {
                const cause = Cause.squash(exit.cause);
                if (!(cause instanceof ProviderAborted)) throw cause;
              }
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
          catch: (cause): NormalizeError => new NormalizationFailed({ cause }),
        }),
      ),
    );
  }

  /**
   * The Effect-canonical `.fx` surface (ADR 77, the dual-typed edge). The
   * loop executor reaches `executor.fx.run(...)` to compose a tick into
   * one fiber tree; the plain `executor.run(...)` Promise below is the
   * derived facade (`runHarnessProtocol` at the boundary). Both drive the
   * SAME Operation — `fx.run` is `run` minus the terminal `runPromise`.
   *
   * TODO(stage-2): migrate `project` / `execute` / `normalize` / `abort`
   * into `ExecutorFx` too, and design the `executeStream` twin (Effect
   * `Stream<AdapterDelta>` vs `Effect<ExecutorStream>`) when Stage 3
   * composes the loop's streaming path. `run` is the beachhead.
   */
  get fx(): ExecutorFx<LanguageModelExecutionResult> {
    return { run: (input) => this.runFx(input) };
  }

  /**
   * The composable `run` Effect the harness builds — the `.fx.run` twin.
   * Constructs the Operation and returns `runOperation(op, body)` un-run,
   * so an in-process caller stays in one fiber. {@link run} is the facade.
   */
  private runFx(
    input: RunInput,
  ): Effect.Effect<
    ExecutorTerminal<LanguageModelExecutionResult>,
    ExecutorError | SubstrateError,
    never
  > {
    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    const tickId = input.scope?.tickId;
    const opId =
      tickId !== undefined
        ? `executor:run:${executionId}:${tickId}`
        : `executor:run:${executionId}:${ulid()}`;
    const op: Operation<RunInput, ExecutorTerminal<LanguageModelExecutionResult>, ExecutorError> = {
      opId,
      surface: "executor",
      name: "executor:command:run",
      scope: { ...(input.scope ?? {}), executionId },
      input,
    };
    return this.runOperation(op, (i) => this.runBody(i, executionId, op));
  }

  run(input: RunInput): Promise<ExecutorTerminal<LanguageModelExecutionResult>> {
    return runHarnessProtocol(this.runFx(input));
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
  ): Effect.Effect<TRaw, ExecuteErrorChannel, never> {
    return Effect.gen(this, function* () {
      if (this.aborted.has(executionId)) {
        return yield* Effect.fail<ExecuteErrorChannel>(
          new ProviderAborted({ reason: "aborted prior to execute" }),
        );
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
          return yield* Effect.tryPromise<TRaw, ExecuteErrorChannel>({
            try: (fiberSignal) =>
              this.callProvider(params, mergeSignals(input.signal, fiberSignal)),
            catch: (cause): ExecuteErrorChannel => this.mapProviderError(cause),
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
        const chunkStream: Stream.Stream<AdapterDelta, ExecuteErrorChannel> = Stream.unwrap(
          Effect.tryPromise<AsyncIterable<TChunk>, ExecuteErrorChannel>({
            try: async (fiberSignal) => {
              const merged = mergeSignals(externalSignal, fiberSignal);
              // External controller too — abort() API path.
              const finalSignal = mergeSignals(controller.signal, merged);
              const iter = await this.openStream(params, finalSignal);
              return iter;
            },
            catch: (cause): ExecuteErrorChannel => this.mapProviderError(cause),
          }).pipe(
            Effect.map((iter) =>
              Stream.fromAsyncIterable<TChunk, ExecuteErrorChannel>(iter, (cause) =>
                this.mapProviderError(cause),
              ),
            ),
          ),
        ).pipe(
          Stream.mapConcat((chunk: TChunk) => this.mapChunk(chunk, accum)),
          Stream.mapConcat((delta: AdapterDelta) => pipeline.process(delta)),
        );

        const flushStream: Stream.Stream<AdapterDelta, ExecuteErrorChannel> = Stream.suspend(() =>
          Stream.fromIterable(pipeline.flush()),
        );
        const finalizeStream: Stream.Stream<AdapterDelta, ExecuteErrorChannel> = Stream.suspend(
          () => Stream.fromIterable(this.finalizeStream(accum)),
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
        const fullStream: Stream.Stream<AdapterDelta, ExecuteErrorChannel> = Stream.concatAll(
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
        const finalStream: Stream.Stream<AdapterDelta, ExecuteErrorChannel> = sink
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
  ): <A>(self: Effect.Effect<A, ExecuteErrorChannel>) => Effect.Effect<A, ExecuteErrorChannel> {
    return <A>(self: Effect.Effect<A, ExecuteErrorChannel>) =>
      // raceFirst, NOT race: `Effect.race` is success-biased — if `self`
      // FAILS it waits for the other side to succeed, but the abort
      // watcher never completes absent an abort, so a provider failure
      // would hang forever (execute()/executeStream() never settle).
      // `raceFirst` settles on the first to COMPLETE (success or failure)
      // and interrupts the loser — provider failure propagates, abort
      // still wins when it fires. (#181 root cause.)
      Effect.raceFirst(
        self,
        Effect.async<never, ExecuteErrorChannel>((resume) => {
          const fire = (reason: unknown): void =>
            resume(
              Effect.fail<ExecuteErrorChannel>(
                new ProviderAborted({ reason: typeof reason === "string" ? reason : "aborted" }),
              ),
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
        Effect.catchTag("ProviderAborted", (e: ProviderAborted) =>
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
        catch: (cause): ExecutorError => new NormalizationFailed({ cause }),
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
