/**
 * The `image-model` and `embedding-model` executor families (ADR 105) — the
 * non-streaming siblings of `LanguageModelExecutor`, on the same shape: a
 * `BaseHarness<"model">` whose one call is a declared command, so journal,
 * spans, the inherited `guard()`/`use()` cascade, and cost attribution ride
 * the spine the language-model family built. The adapter owns the provider
 * call; this owns orchestration and the error taxonomy (ADR 52).
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

// The command input is the family input PLUS the per-call scope/signal, so a
// guard reads `call.input.prompt` (see `WithCall`).
declare module "@agentick/runtime" {
  interface CommandRegistry {
    "model:generate_image": {
      input: { readonly input: ImageGenerateInput; readonly opts?: ModalityCallOptions };
      output: ImageGenerateResult;
    };
    "model:embed": {
      input: { readonly input: EmbedInput; readonly opts?: ModalityCallOptions };
      output: EmbedResult;
    };
  }
}

export interface ImageModelExecutorOptions extends Pick<
  BaseHarnessOptions,
  "inheritedInterceptors" | "interceptorParent"
> {
  readonly adapter: ImageModelAdapter;
}

export interface EmbeddingModelExecutorOptions extends Pick<
  BaseHarnessOptions,
  "inheritedInterceptors" | "interceptorParent"
> {
  readonly adapter: EmbeddingModelAdapter;
}

/** Command input: the family input plus the per-call scope/signal, so `scope` reaches the op. */
interface WithCall<I> {
  readonly input: I;
  readonly opts?: ModalityCallOptions;
}

function mapProviderError(
  adapter: { mapProviderError?(cause: unknown): ExecuteErrorChannel },
  cause: unknown,
): ExecuteErrorChannel {
  if (isExecuteError(cause)) return cause;
  if (adapter.mapProviderError) return adapter.mapProviderError(cause);
  return defaultMapProviderError(cause, (c) => c instanceof Error && c.name === "AbortError");
}

export class ImageModelExecutor
  extends BaseHarness<typeof SURFACE>
  implements ImageModelExecutorProtocol
{
  readonly family = "image-model" as const;
  private readonly adapter: ImageModelAdapter;
  private readonly generateCmd: (
    input: WithCall<ImageGenerateInput>,
  ) => Promise<ImageGenerateResult>;

  get target(): ExecutionTarget {
    return this.adapter.target;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: ImageModelExecutorOptions,
  ) {
    super(SURFACE, scopeId, journal, bus, inbox, {
      inheritedInterceptors: options.inheritedInterceptors,
      interceptorParent: options.interceptorParent,
    });
    this.adapter = options.adapter;
    this.generateCmd = this.command<
      WithCall<ImageGenerateInput>,
      ImageGenerateResult,
      ExecuteErrorChannel | SubstrateError
    >({
      name: "model:generate_image",
      description: "the image-generation provider call",
      scope: (call) => call.opts?.scope ?? {},
      handler: (call) =>
        Effect.tryPromise({
          try: () => this.adapter.generate(call.input, call.opts?.signal),
          catch: (cause) => mapProviderError(this.adapter, cause),
        }),
    });
  }

  generate(input: ImageGenerateInput, opts?: ModalityCallOptions): Promise<ImageGenerateResult> {
    return this.generateCmd({ input, ...(opts !== undefined ? { opts } : {}) });
  }

  protected override spanAttributes(
    op: Operation<unknown, unknown, unknown>,
  ): Readonly<Record<string, unknown>> {
    const ns = this.telemetryNamespace;
    const call = op.input as WithCall<ImageGenerateInput> | undefined;
    return {
      ...super.spanAttributes(op),
      [`${ns}.image.model`]: this.adapter.target.modelId,
      ...(call?.input?.count !== undefined ? { [`${ns}.image.count`]: call.input.count } : {}),
    };
  }

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown model message type: ${msg.type}` }));
  }
}

export class EmbeddingModelExecutor
  extends BaseHarness<typeof SURFACE>
  implements EmbeddingModelExecutorProtocol
{
  readonly family = "embedding-model" as const;
  private readonly adapter: EmbeddingModelAdapter;
  private readonly embedCmd: (input: WithCall<EmbedInput>) => Promise<EmbedResult>;

  get target(): ExecutionTarget {
    return this.adapter.target;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: EmbeddingModelExecutorOptions,
  ) {
    super(SURFACE, scopeId, journal, bus, inbox, {
      inheritedInterceptors: options.inheritedInterceptors,
      interceptorParent: options.interceptorParent,
    });
    this.adapter = options.adapter;
    this.embedCmd = this.command<
      WithCall<EmbedInput>,
      EmbedResult,
      ExecuteErrorChannel | SubstrateError
    >({
      name: "model:embed",
      description: "the embedding provider call",
      scope: (call) => call.opts?.scope ?? {},
      handler: (call) =>
        Effect.tryPromise({
          try: () => this.adapter.embed(call.input, call.opts?.signal),
          catch: (cause) => mapProviderError(this.adapter, cause),
        }),
    });
  }

  embed(input: EmbedInput, opts?: ModalityCallOptions): Promise<EmbedResult> {
    return this.embedCmd({ input, ...(opts !== undefined ? { opts } : {}) });
  }

  protected override spanAttributes(
    op: Operation<unknown, unknown, unknown>,
  ): Readonly<Record<string, unknown>> {
    const ns = this.telemetryNamespace;
    const call = op.input as WithCall<EmbedInput> | undefined;
    return {
      ...super.spanAttributes(op),
      [`${ns}.embedding.model`]: this.adapter.target.modelId,
      ...(call?.input?.input !== undefined
        ? { [`${ns}.embedding.count`]: call.input.input.length }
        : {}),
    };
  }

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown model message type: ${msg.type}` }));
  }
}
