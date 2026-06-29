/**
 * `defineLanguageModelExecutor` — callback-style wrapper around
 * {@link BaseLanguageModelExecutor} for adopters who want the full
 * streaming hook surface without subclassing.
 *
 * Three rungs of the adopter ladder:
 *
 *   1. **`extends BaseLanguageModelExecutor`** — full power, class-based.
 *      First-party providers (OpenAI, Anthropic, Google, AI SDK) live
 *      here; advanced adopters with private streaming providers will
 *      too.
 *   2. **`defineLanguageModelExecutor({ openStream, mapChunk, ... })`**
 *      — same hooks, callback shape. For adopters with a streaming
 *      provider SDK who want zero subclass boilerplate.
 *   3. **`defineExecutor({ run })`** — single async callback returning
 *      the final result. For adopters with non-streaming providers
 *      (Promise → result) or one-off integrations where the hook surface
 *      would be overkill.
 *
 * This factory delegates to a thin internal `BaseLanguageModelExecutor`
 * subclass whose hooks dispatch to the supplied callbacks. The base
 * owns the Effect.Stream pipeline, accumulator, transform composition,
 * bounded-queue backpressure, fiber-interrupt cancellation, and bus
 * emission — adopters write pure callbacks and inherit all of it.
 *
 * @see ./base-language-model-executor.ts
 * @see ./define-executor.ts
 */

import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import type {
  AdapterDelta,
  EventBus,
  ExecuteError,
  ExecutionTarget,
  ExecutorFactory,
  ExecutorFactoryDeps,
  LanguageModelExecutionResult,
  LanguageModelExecutor,
  LanguageModelInput,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  ProjectInput,
} from "@agentick/spec-next";
import { HandlerError } from "@agentick/spec-next";
import { Effect } from "effect";

import { BaseLanguageModelExecutor, defaultProject } from "./base-language-model-executor.js";
import type { DeltaTransform } from "./delta-transform.js";
import type { StreamAccumulator } from "./stream-accumulator.js";
import type { CustomBlockDefinition } from "./tag-transforms.js";

/**
 * Callback bundle for `defineLanguageModelExecutor`. Mirrors the
 * `BaseLanguageModelExecutor` hook surface 1:1.
 *
 * @typeParam TRaw — provider's raw response shape (e.g. OpenAI's
 *   `ChatCompletion`, Anthropic's `Message`). Used as the streaming
 *   result type and the input to `normalizeRaw`.
 * @typeParam TChunk — provider's streaming chunk shape (e.g. OpenAI's
 *   `ChatCompletionChunk`). The base feeds these to `mapChunk`.
 */
export interface DefineLanguageModelExecutorInput<TRaw, TChunk> {
  /** Self-described target (provider id, modelId, capabilities). */
  readonly target: ExecutionTarget;

  /** Whether `execute()` should default to the streaming codepath. */
  readonly streamByDefault?: boolean;

  /**
   * Whether this provider supports the streaming codepath at all.
   * When `false`, `executeStream` throws and only `callProvider` is
   * called. Default: `true`.
   */
  readonly supportsRunStreaming?: boolean;

  /**
   * Translate canonical `LanguageModelInput` → provider request shape.
   * Pure; may read `target.providerOptions` for per-provider knobs.
   */
  readonly buildParams: (input: LanguageModelInput, target: ExecutionTarget) => unknown;

  /**
   * Non-streaming provider call. Receives the params from
   * `buildParams` plus a fiber-aware AbortSignal. Throws on provider
   * error.
   */
  readonly callProvider: (params: unknown, signal: AbortSignal | undefined) => Promise<TRaw>;

  /**
   * Open the provider's streaming response. The base owns the loop;
   * this callback just opens the stream. Throws on provider error.
   */
  readonly openStream: (
    params: unknown,
    signal: AbortSignal,
  ) => Promise<AsyncIterable<TChunk>> | AsyncIterable<TChunk>;

  /**
   * Pure chunk → AdapterDelta[] mapper. Reads accumulator state for
   * derived context (e.g. "is the text block already open?"); does
   * NOT mutate the accumulator — the base applies emitted deltas
   * through the pipeline.
   */
  readonly mapChunk: (chunk: TChunk, accum: StreamAccumulator) => readonly AdapterDelta[];

  /**
   * Synthesize the canonical provider raw response from final
   * accumulator state. Called once at end of stream; receives
   * `modelSeen` (whatever model id was carried in chunks, if any).
   */
  readonly reconstructRaw: (accum: StreamAccumulator, modelSeen: string | undefined) => TRaw;

  /**
   * Convert raw provider response → `LanguageModelExecutionResult`.
   * Called from `normalize()` and from `runBody` after
   * `postProcessForNormalize`. Throw to fail normalization.
   */
  readonly normalizeRaw: (raw: TRaw) => LanguageModelExecutionResult;

  /** Optional: custom projection (defaults to canonical RenderedTree fold). */
  readonly project?: (input: ProjectInput) => LanguageModelInput;

  /**
   * Optional: `DeltaTransform`s applied to chunk-mapped deltas before
   * the customBlocks pipeline. Common use: `thinkTagTransform()`.
   */
  readonly adapterTransforms?: () => readonly DeltaTransform[];

  /**
   * Optional: declarative custom-block extraction map. The base
   * compiles this into a transform and runs it after
   * `adapterTransforms`.
   */
  readonly customBlocks?: Readonly<Record<string, CustomBlockDefinition>>;

  /**
   * Optional: post-process the raw response between `execute` and
   * `normalize` (non-streaming path). Default: identity.
   */
  readonly postProcessForNormalize?: (raw: TRaw) => TRaw;

  /**
   * Optional: extract provider-specific metadata from the raw response.
   * Returned record is merged into
   * `LanguageModelExecutionResult.finishMetadata` (last-write-wins per
   * key). v1 `createAdapter` parity — surface OpenAI
   * `system_fingerprint`, Google `safetyRatings`, citations, etc.
   * without rewriting `normalizeRaw`.
   */
  readonly extractMetadata?: (raw: TRaw) => Readonly<Record<string, unknown>> | undefined;
}

/**
 * Construct an `ExecutorFactory` from a callback bundle. Plug into
 * `createApp({ executor: defineLanguageModelExecutor(...) })`.
 *
 * @example
 * ```ts
 * const myExec = defineLanguageModelExecutor<MyRawResponse, MyChunk>({
 *   target: { kind: "language-model", provider: "my", modelId: "v1" },
 *   streamByDefault: true,
 *   buildParams: (input) => translateToMyApi(input),
 *   callProvider: (params, signal) => mySdk.complete(params, { signal }),
 *   openStream: (params, signal) => mySdk.stream(params, { signal }),
 *   mapChunk: (chunk, accum) => translateChunkToDeltas(chunk, accum),
 *   reconstructRaw: (accum, modelSeen) => assembleFromAccum(accum, modelSeen),
 *   normalizeRaw: (raw) => toExecutionResult(raw),
 * });
 * ```
 */
export function defineLanguageModelExecutor<TRaw, TChunk = unknown>(
  spec: DefineLanguageModelExecutorInput<TRaw, TChunk>,
): ExecutorFactory {
  const factory = (deps?: ExecutorFactoryDeps): LanguageModelExecutor => {
    const scopeId = deps?.scopeId ?? `define-lm-executor:${ulid()}`;
    const journal = deps?.journal ?? new MemoryJournal();
    const bus = deps?.bus ?? new LocalEventBus();
    const inbox = deps?.inbox ?? new LocalInbox();
    return new CallbackBaseLanguageModelExecutor<TRaw, TChunk>(scopeId, journal, bus, inbox, spec);
  };
  return Object.assign(factory, { executorFactory: true as const });
}

/**
 * Internal — `BaseLanguageModelExecutor` subclass that dispatches each
 * abstract/optional hook to the user's callback bundle.
 */
class CallbackBaseLanguageModelExecutor<TRaw, TChunk> extends BaseLanguageModelExecutor<
  TRaw,
  TChunk
> {
  readonly target: ExecutionTarget;
  protected override readonly streamByDefault: boolean;
  protected override readonly supportsRunStreaming: boolean;
  protected override readonly customBlocks:
    | Readonly<Record<string, CustomBlockDefinition>>
    | undefined;

  private readonly spec: DefineLanguageModelExecutorInput<TRaw, TChunk>;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    spec: DefineLanguageModelExecutorInput<TRaw, TChunk>,
  ) {
    super(scopeId, journal, bus, inbox);
    this.spec = spec;
    this.target = spec.target;
    this.streamByDefault = spec.streamByDefault ?? false;
    this.supportsRunStreaming = spec.supportsRunStreaming ?? true;
    this.customBlocks = spec.customBlocks;
  }

  protected override projectImpl(input: ProjectInput): LanguageModelInput {
    return (this.spec.project ?? defaultProject)(input);
  }

  protected buildParams(input: LanguageModelInput, target: ExecutionTarget): unknown {
    return this.spec.buildParams(input, target);
  }

  protected callProvider(params: unknown, signal: AbortSignal | undefined): Promise<TRaw> {
    return this.spec.callProvider(params, signal);
  }

  protected openStream(
    params: unknown,
    signal: AbortSignal,
  ): Promise<AsyncIterable<TChunk>> | AsyncIterable<TChunk> {
    return this.spec.openStream(params, signal);
  }

  protected mapChunk(chunk: TChunk, accum: StreamAccumulator): readonly AdapterDelta[] {
    return this.spec.mapChunk(chunk, accum);
  }

  protected reconstructRaw(accum: StreamAccumulator, modelSeen: string | undefined): TRaw {
    return this.spec.reconstructRaw(accum, modelSeen);
  }

  protected normalizeRaw(raw: TRaw): LanguageModelExecutionResult {
    return this.spec.normalizeRaw(raw);
  }

  protected override adapterTransforms(): readonly DeltaTransform[] {
    return this.spec.adapterTransforms?.() ?? super.adapterTransforms();
  }

  protected override postProcessForNormalize(raw: TRaw): TRaw {
    return this.spec.postProcessForNormalize ? this.spec.postProcessForNormalize(raw) : raw;
  }

  protected override extractMetadata(raw: TRaw): Readonly<Record<string, unknown>> | undefined {
    return this.spec.extractMetadata?.(raw);
  }

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(
      new HandlerError({
        cause: new Error(
          "defineLanguageModelExecutor inbox dispatch not wired — extend BaseLanguageModelExecutor directly for custom inbox handling",
        ),
      }),
    );
  }
}

// Silence unused-variable lint when only TRaw is observed.
type _ExecuteErrorAcknowledged = ExecuteError;
type _CallbackSilencer = _ExecuteErrorAcknowledged;
void (undefined as _CallbackSilencer | undefined);
