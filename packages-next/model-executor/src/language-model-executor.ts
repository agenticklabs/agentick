/**
 * `LanguageModelExecutor<TRaw, TChunk>` — THE executor harness (ADR 52).
 *
 * One final class: `BaseHarness<"model">` (substrate phase contract,
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

import { omitUndefined } from "@agentick/utils-next";

import { Chunk, Effect, Fiber, Stream } from "effect";

import {
  BaseHarness,
  getContext,
  type Middleware,
  type StreamCommand,
  runHarnessProtocol,
  runHarnessStream,
  ulid,
} from "@agentick/runtime-next";
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

// ADR 80/83/89 — light up the model-path verbs on the derived `CommandHooks`
// surface. The provider call is command-ified (Phase 1B): `generate` /
// `generate_stream` are declared via `this.command` / `this.commandStream`, so
// they mint the boundary hooks AND are inbox-addressable; `project` /
// `normalize` / `run` route through `runOperation` via their `*Fx` twins.
// Typing each here mints `onBefore/After<Verb>`:
//
//   - `model:generate`        — the non-streaming provider call (`execute`).
//     `output` is `unknown` — the raw provider output `TRaw` is erased.
//   - `model:generate_stream` — the streaming provider call (`executeStream`,
//     the loop-default path). Its `.fx` sink-fold twin is what the loop's
//     per-tick model call consumes, so THAT call fires `onBefore/AfterModel-
//     GenerateStream` + guard. `output` is the erased raw (`unknown`).
//   - `model:project`         — compile → `LanguageModelInput` (media seam).
//   - `model:normalize`       — provider output → canonical result.
//   - `model:run`             — project → [generate] → normalize; the ONE seam
//     a loop tick fires on the NON-streaming path (project/generate inline
//     beneath it — one span per tick).
//
// A loop tick's STREAMING path fires `model:generate_stream` (with `project` /
// `normalize` bracketing it as their own ops); the non-streaming path fires
// `model:run` (project/generate inline beneath it — no sub-op re-fire).
declare module "@agentick/runtime-next" {
  interface CommandRegistry {
    "model:project": { input: ProjectInput; output: LanguageModelInput };
    "model:generate": { input: ExecuteInput<LanguageModelInput>; output: unknown };
    "model:generate_stream": { input: ExecuteInput<LanguageModelInput>; output: unknown };
    "model:run": { input: RunInput; output: ExecutorTerminal<LanguageModelExecutionResult> };
    "model:normalize": {
      input: NormalizeInput<unknown>;
      output: LanguageModelExecutionResult;
    };
  }
}

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
  /**
   * Resolved interceptor snapshot (ADR 76 tier 3 + ADR 83 amendment) — the
   * app's resolved interceptors (guards, `.use` transforms, AND declarative
   * `createApp({ hooks })` adapted to op-scoped middleware), folded in at
   * construction and forwarded to {@link BaseHarness}. App-shared spine, so this
   * folds the APP's layer (session hooks never reach shared harnesses).
   * Defaults to `[]`.
   */
  readonly inheritedInterceptors?: readonly Middleware<unknown, unknown, unknown>[];
  /**
   * LIVE interceptor parent (ADR 83 §4). The app passes `interceptorParent: this`
   * alongside the snapshot so a LATER `app.use()` / `app.guard()` / `app.hook()`
   * reaches this app-shared spine harness too. Forwarded to {@link BaseHarness}.
   */
  readonly interceptorParent?: BaseHarness;
}

export class LanguageModelExecutor<TRaw = unknown, TChunk = unknown>
  extends BaseHarness<"model">
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

  /**
   * The command-ified provider call (ADR 89 §1). `model:generate` is the
   * non-streaming call; `model:generate_stream` the streaming (loop-default)
   * call. Declaring them via `this.command` / `this.commandStream` mints
   * `onBefore/AfterModelGenerate[Stream]` + `guardGenerate` + journaling on the
   * model call. `execute()` / `executeStream()` are their edge facades; the
   * loop consumes the streaming command's `.fx` sink-fold twin.
   */
  private readonly modelGenerate: (
    input: ExecuteInput<LanguageModelInput>,
    opts?: { readonly origin?: import("@agentick/spec-next").OperationOrigin },
  ) => Promise<unknown>;
  private readonly modelGenerateStream: StreamCommand<
    ExecuteInput<LanguageModelInput>,
    AdapterDelta,
    TRaw,
    ExecuteErrorChannel
  >;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: LanguageModelExecutorOptions<TRaw, TChunk>,
  ) {
    super("model", scopeId, journal, bus, inbox, {
      inheritedInterceptors: options.inheritedInterceptors,
      interceptorParent: options.interceptorParent,
    });
    this.adapter = options.adapter;

    // Command-ify the provider call (ADR 89 §1). Both commands share the
    // `generateBody` pipeline; the non-streaming call passes a `null` sink
    // (deltas still emit to the bus when `streamByDefault`), the streaming call
    // passes the real sink. `scope` pins `executionId` (set by the facades) so
    // the op's scope and `generateBody`'s in-flight bookkeeping agree.
    this.modelGenerate = this.command<
      ExecuteInput<LanguageModelInput>,
      unknown,
      ExecuteErrorChannel
    >({
      name: "model:generate",
      description: "the non-streaming provider call",
      scope: (input) => input.scope ?? {},
      handler: (input) => this.generateBody(input, null),
    });
    this.modelGenerateStream = this.commandStream<
      ExecuteInput<LanguageModelInput>,
      AdapterDelta,
      TRaw,
      ExecuteErrorChannel
    >({
      name: "model:generate_stream",
      description: "the streaming provider call (loop-default path)",
      scope: (input) => input.scope ?? {},
      body: (input, sink) => this.generateBody(input, sink),
      // Streaming-edge policy for the `.stream` (AsyncStream) face. The `.fx`
      // twin the loop consumes ignores these — its cancellation is fiber
      // interrupt, its bookkeeping the in-fiber `generateBody`.
      stream: {
        queueCapacity: STREAM_QUEUE_CAPACITY,
        // Cancellation completes the iterator cleanly; a real provider failure
        // throws (#182). `.result` carries the aborted terminal either way.
        isCancellation: (cause) => cause instanceof ProviderAborted,
        onStart: (fiber, input) => {
          const executionId = input.scope?.executionId;
          if (executionId === undefined) return;
          const entry = this.inFlight.get(executionId);
          if (entry) entry.fiber = fiber as Fiber.RuntimeFiber<unknown, unknown>;
        },
        onAbort: (reason, input) => {
          const executionId = input.scope?.executionId;
          if (executionId === undefined) return;
          this.aborted.add(executionId);
          const entry = this.inFlight.get(executionId);
          if (entry) {
            entry.abortReason = reason;
            entry.abort?.abort(reason);
          }
        },
      },
    });
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

  /**
   * The composable `project` Effect the harness builds — the
   * `.fx.project` twin. Returns `runOperation(op, body)` un-run so the
   * loop's streaming path composes it in one fiber. {@link project} is
   * the facade.
   */
  private projectFx(
    input: ProjectInput,
  ): Effect.Effect<LanguageModelInput, ProjectionError | SubstrateError, never> {
    const op: Operation<ProjectInput, LanguageModelInput, ProjectionError> = {
      opId: `model:project:${ulid()}`,
      surface: "model",
      name: "model:command:project",
      scope: input.scope ?? {},
      input,
    };
    return this.runOperation(op, (i) =>
      Effect.try({
        try: () => this.projectImpl(i),
        catch: (cause): ProjectionError =>
          new ProjectionFailed({ reason: "projection threw", cause }),
      }),
    );
  }

  project(input: ProjectInput): Promise<LanguageModelInput> {
    return runHarnessProtocol(this.projectFx(input));
  }

  execute(input: ExecuteInput<LanguageModelInput>): Promise<unknown> {
    // Edge facade over the `model:generate` command. Pin `executionId` into the
    // input scope so the command's Operation and `generateBody`'s in-flight
    // bookkeeping agree.
    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    return this.modelGenerate({ ...input, scope: { ...(input.scope ?? {}), executionId } });
  }

  executeStream(input: ExecuteInput<LanguageModelInput>): ExecutorStream<TRaw> {
    if (!this.supportsRunStreaming) {
      // Unsupported adapter: a stream that fails immediately — the iterator
      // throws and `.result` rejects with the typed error, via the bridge.
      const err: ExecuteErrorChannel = new StreamFailed({
        cause: new Error(
          `adapter '${this.adapter.provider}' does not support executeStream — use execute() instead`,
        ),
      });
      return runHarnessStream<AdapterDelta, TRaw>(() => Effect.fail(err), {
        queueCapacity: STREAM_QUEUE_CAPACITY,
      });
    }

    // Edge facade = the `.stream` (AsyncStream) face of the `model:generate_stream`
    // command. The command owns the Queue/fork/Promise machinery + the
    // streaming-edge policy (queueCapacity / isCancellation / onStart / onAbort,
    // declared in the constructor). `executionId` is pinned into the input so
    // the command's Operation and the in-flight bookkeeping agree.
    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    return this.modelGenerateStream.stream({
      ...input,
      scope: { ...(input.scope ?? {}), executionId },
    });
  }

  /**
   * The composable `normalize` Effect the harness builds — the
   * `.fx.normalize` twin. Returns `runOperation(op, body)` un-run so the
   * loop's streaming path composes it in one fiber. {@link normalize} is
   * the facade.
   */
  private normalizeFx(
    input: NormalizeInput<unknown>,
  ): Effect.Effect<LanguageModelExecutionResult, NormalizeError | SubstrateError, never> {
    const op: Operation<NormalizeInput<unknown>, LanguageModelExecutionResult, NormalizeError> = {
      opId: `model:normalize:${ulid()}`,
      surface: "model",
      name: "model:command:normalize",
      scope: input.scope ?? {},
      input,
    };
    return this.runOperation(op, (i) =>
      Effect.try({
        try: () => this.normalizeRaw(i.targetOutput as TRaw),
        catch: (cause): NormalizeError => new NormalizationFailed({ cause }),
      }),
    );
  }

  normalize(input: NormalizeInput<unknown>): Promise<LanguageModelExecutionResult> {
    return runHarnessProtocol(this.normalizeFx(input));
  }

  /**
   * The Effect-canonical `.fx` surface (ADR 77, the dual-typed edge). The
   * loop executor reaches `executor.fx.run(...)` to compose a tick into
   * one fiber tree; the plain `executor.run(...)` Promise below is the
   * derived facade (`runHarnessProtocol` at the boundary). Both drive the
   * SAME Operation — `fx.run` is `run` minus the terminal `runPromise`.
   *
   * Stage 3 + ADR 89 §1: `project` / `normalize` are twinned (the loop's
   * streaming path composes project → executeStream → normalize in one fiber).
   * `executeStream` routes to the `model:generate_stream` command's `.fx`
   * sink-fold twin — so the loop's per-tick model call rides that command's
   * cascade (its `onBefore/AfterModelGenerateStream` hooks + guard fire).
   * `abort` is a control-plane sync op (facade-only).
   */
  get fx(): ExecutorFx<LanguageModelInput, TRaw, LanguageModelExecutionResult> {
    return {
      use: (mw) => this.registerEffectMiddleware(mw),
      run: (input) => this.runFx(input),
      project: (input) => this.projectFx(input),
      normalize: (input) => this.normalizeFx(input),
      executeStream: (input, sink) => this.executeStreamFx(input, sink),
    };
  }

  /**
   * The streaming-edge canonical twin (sink-fold) — the `.fx` face of the
   * `model:generate_stream` command. Composes in the caller's fiber (no
   * Queue/fork/Promise bridge), driving the provider ONCE through the command's
   * cascade: guard → `onBeforeModelGenerateStream(input)` → `generateBody(sink)`
   * → `onAfterModelGenerateStream(raw)` → `terminal`. This is what the loop's
   * per-tick model call consumes — so the model call gets the hooks + guard.
   * The public {@link executeStream} facade adds the {@link AsyncStream}
   * projection (the command's `.stream` face) on top of the same command.
   */
  private executeStreamFx(
    input: ExecuteInput<LanguageModelInput>,
    sink: (delta: AdapterDelta) => Effect.Effect<void>,
  ): Effect.Effect<TRaw, ExecuteErrorChannel | SubstrateError, never> {
    if (!this.supportsRunStreaming) {
      return Effect.fail(
        new StreamFailed({
          cause: new Error(
            `adapter '${this.adapter.provider}' does not support executeStream — use execute() instead`,
          ),
        }),
      );
    }
    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    return this.modelGenerateStream.fx(
      { ...input, scope: { ...(input.scope ?? {}), executionId } },
      sink,
    );
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
        ? `model:run:${executionId}:${tickId}`
        : `model:run:${executionId}:${ulid()}`;
    const op: Operation<RunInput, ExecutorTerminal<LanguageModelExecutionResult>, ExecutorError> = {
      opId,
      surface: "model",
      name: "model:command:run",
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

  /**
   * The `model:generate[_stream]` command body (ADR 89 §1). Runs INSIDE the
   * command's `runOperation` cascade, so the ambient {@link RuntimeContext}
   * already carries this op's `opId` / `parentOpId` / scope. Rebuilds the
   * {@link Operation} shape {@link executeBody}'s in-flight delta emission needs
   * from that ambient scope (the command primitive owns the real op and does not
   * hand it to the handler), then delegates to the shared pipeline. `sink` is
   * `null` for `model:generate` (non-streaming — deltas still emit to the bus
   * when `streamByDefault`) and the real delta sink for `model:generate_stream`.
   */
  private generateBody(
    input: ExecuteInput<LanguageModelInput>,
    sink: ((delta: AdapterDelta) => Effect.Effect<void>) | null,
  ): Effect.Effect<TRaw, ExecuteErrorChannel, never> {
    return Effect.gen(this, function* () {
      const ctx = yield* getContext;
      const executionId = input.scope?.executionId ?? ctx.executionId ?? `exec:${ulid()}`;
      const opName = sink !== null ? "model:command:generate_stream" : "model:command:generate";
      const op: Operation<unknown, unknown> = {
        opId: ctx.opId ?? `${opName}:${ulid()}`,
        surface: "model",
        name: opName,
        ...(ctx.parentOpId !== undefined ? { parentOpId: ctx.parentOpId } : {}),
        scope: input.scope ?? {},
        input,
      };
      return yield* this.executeBody(input, executionId, op, sink);
    });
  }

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
        ...(input.narrate !== undefined ? { narrate: input.narrate } : {}),
      });

      // 2. execute (provider call; may stream + emit deltas)
      const executeInput: ExecuteInput<LanguageModelInput> = {
        targetInput: projected,
        target: input.target,
        scope: { ...(input.scope ?? {}), executionId },
        ...omitUndefined({ signal: input.signal }),
      };
      // TODO(adr-89-phase-next): this NON-STREAMING run path calls
      // `executeBody` DIRECTLY, bypassing the `model:generate` command —
      // so onBefore/AfterModelGenerate hooks, guardGenerate, and the
      // ADR-89 §4 useOnModelGenerateStart/End projection do NOT fire on
      // non-streaming ticks (the streaming path rides the
      // `model:generate_stream` command and gets all of them). Per ADR 89
      // §1 ("run composes project → the execute command → normalize"),
      // route this through `this.modelGenerate`'s command cascade —
      // needs the ProviderAborted→canceled-terminal fold carried across
      // the command boundary. Mirror in FakeLanguageModelExecutor.runBody.
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
