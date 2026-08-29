/**
 * The `image-model` and `embedding-model` executor families (ADR 105) — the
 * non-streaming siblings of `LanguageModelExecutor`, on the same shape: a
 * `BaseHarness<"model">` whose one call is a declared command, so journal,
 * spans, the inherited `guard()`/`use()` cascade, and cost attribution ride
 * the spine the language-model family built. The adapter owns the provider
 * call; this owns orchestration and the error taxonomy (ADR 52).
 *
 * One generic core, two named families: the families differ only in their
 * input/result types, command name, and span attributes.
 */

import { Effect } from "effect";
import type {
  EmbedInput,
  EmbedResult,
  EmbeddingModelAdapter,
  EmbeddingModelExecutorProtocol,
  EventBus,
  ExecuteErrorChannel,
  ExecutionTarget,
  ImageGenerateInput,
  ImageGenerateResult,
  ImageModelAdapter,
  ImageModelExecutorProtocol,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  ModalityCallOptions,
  Operation,
  OperationJournal,
  SubstrateError,
} from "@agentick/spec";
import { HandlerError, isExecuteError } from "@agentick/spec";
import { defaultMapProviderError } from "@agentick/model";
import { BaseHarness, type BaseHarnessOptions } from "@agentick/runtime";

const SURFACE = "model" as const;

/** Command input: the family input plus the per-call scope/signal, so `scope` reaches the op. */
export interface ModalityCall<I> {
  readonly input: I;
  readonly opts?: ModalityCallOptions;
}

declare module "@agentick/runtime" {
  interface CommandRegistry {
    "model:generate_image": {
      input: ModalityCall<ImageGenerateInput>;
      output: ImageGenerateResult;
    };
    "model:embed": { input: ModalityCall<EmbedInput>; output: EmbedResult };
  }
}

/** What every modality adapter shares — the executor core needs nothing else. */
interface ModalityAdapter<I, R> {
  readonly target: ExecutionTarget;
  readonly call: (input: I, signal?: AbortSignal) => Promise<R>;
  readonly mapProviderError?: (cause: unknown) => ExecuteErrorChannel;
}

export interface ModalityExecutorOptions<A> extends Pick<
  BaseHarnessOptions,
  "inheritedInterceptors" | "interceptorParent"
> {
  readonly adapter: A;
}

/**
 * The shared core: one command around one adapter call. Subclasses name the
 * family, the verb, and the span attributes.
 */
abstract class ModalityExecutor<I, R> extends BaseHarness<typeof SURFACE> {
  private readonly modality: ModalityAdapter<I, R>;
  private readonly cmd: (call: ModalityCall<I>) => Promise<R>;

  get target(): ExecutionTarget {
    return this.modality.target;
  }

  protected constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: Pick<BaseHarnessOptions, "inheritedInterceptors" | "interceptorParent">,
    modality: ModalityAdapter<I, R>,
    command: { readonly name: string; readonly description: string },
  ) {
    super(SURFACE, scopeId, journal, bus, inbox, {
      inheritedInterceptors: options.inheritedInterceptors,
      interceptorParent: options.interceptorParent,
    });
    this.modality = modality;
    this.cmd = this.command<ModalityCall<I>, R, ExecuteErrorChannel | SubstrateError>({
      name: command.name,
      description: command.description,
      scope: (call) => call.opts?.scope ?? {},
      handler: (call) =>
        Effect.tryPromise({
          try: () => modality.call(call.input, call.opts?.signal),
          catch: (cause) => this.mapProviderError(cause),
        }),
    });
  }

  protected run(input: I, opts?: ModalityCallOptions): Promise<R> {
    return this.cmd({ input, ...(opts !== undefined ? { opts } : {}) });
  }

  /** Typed throw wins, then the adapter's mapper, then the shared default. */
  private mapProviderError(cause: unknown): ExecuteErrorChannel {
    if (isExecuteError(cause)) return cause;
    if (this.modality.mapProviderError) return this.modality.mapProviderError(cause);
    return defaultMapProviderError(cause, (c) => c instanceof Error && c.name === "AbortError");
  }

  /** The family's own span identity (ADR 78: the harness owns identity). */
  protected abstract familyAttributes(input: I | undefined): Readonly<Record<string, unknown>>;

  protected override spanAttributes(
    op: Operation<unknown, unknown, unknown>,
  ): Readonly<Record<string, unknown>> {
    const call = op.input as ModalityCall<I> | undefined;
    return { ...super.spanAttributes(op), ...this.familyAttributes(call?.input) };
  }

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown model message type: ${msg.type}` }));
  }
}

export type ImageModelExecutorOptions = ModalityExecutorOptions<ImageModelAdapter>;
export type EmbeddingModelExecutorOptions = ModalityExecutorOptions<EmbeddingModelAdapter>;

export class ImageModelExecutor
  extends ModalityExecutor<ImageGenerateInput, ImageGenerateResult>
  implements ImageModelExecutorProtocol
{
  readonly family = "image-model" as const;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: ImageModelExecutorOptions,
  ) {
    const { adapter } = options;
    super(
      scopeId,
      journal,
      bus,
      inbox,
      options,
      {
        target: adapter.target,
        call: (input, signal) => adapter.generate(input, signal),
        ...(adapter.mapProviderError
          ? { mapProviderError: adapter.mapProviderError.bind(adapter) }
          : {}),
      },
      { name: "model:generate_image", description: "the image-generation provider call" },
    );
  }

  generate(input: ImageGenerateInput, opts?: ModalityCallOptions): Promise<ImageGenerateResult> {
    return this.run(input, opts);
  }

  protected familyAttributes(
    input: ImageGenerateInput | undefined,
  ): Readonly<Record<string, unknown>> {
    const ns = this.telemetryNamespace;
    return {
      [`${ns}.image.model`]: this.target.modelId,
      ...(input?.count !== undefined ? { [`${ns}.image.count`]: input.count } : {}),
    };
  }
}

export class EmbeddingModelExecutor
  extends ModalityExecutor<EmbedInput, EmbedResult>
  implements EmbeddingModelExecutorProtocol
{
  readonly family = "embedding-model" as const;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: EmbeddingModelExecutorOptions,
  ) {
    const { adapter } = options;
    super(
      scopeId,
      journal,
      bus,
      inbox,
      options,
      {
        target: adapter.target,
        call: (input, signal) => adapter.embed(input, signal),
        ...(adapter.mapProviderError
          ? { mapProviderError: adapter.mapProviderError.bind(adapter) }
          : {}),
      },
      { name: "model:embed", description: "the embedding provider call" },
    );
  }

  embed(input: EmbedInput, opts?: ModalityCallOptions): Promise<EmbedResult> {
    return this.run(input, opts);
  }

  protected familyAttributes(input: EmbedInput | undefined): Readonly<Record<string, unknown>> {
    const ns = this.telemetryNamespace;
    return {
      [`${ns}.embedding.model`]: this.target.modelId,
      ...(input !== undefined ? { [`${ns}.embedding.count`]: input.input.length } : {}),
    };
  }
}
