/**
 * Model System
 *
 * EngineModel is the primary interface for models in the engine.
 * Use createModel() to create models from options.
 *
 * ModelAdapter is available for class-based implementations (e.g., provider adapters).
 */

import {
  Context,
  type Middleware,
  type MiddlewarePipeline,
  type Procedure,
  type ProcedureOptions,
} from "../core/index.js";
import { createEngineProcedure } from "../procedure";
import type {
  ModelInput as BaseModelInput,
  ModelOutput as BaseModelOutput,
  ModelConfig as BaseModelConfig,
  ModelToolReference as BaseModelToolReference,
} from "@tentickle/shared/models";
import type {
  StreamEvent,
  MessageStartEvent,
  MessageEndEvent,
  MessageEvent,
  ContentDeltaEvent,
  ReasoningDeltaEvent,
  ToolCallEvent,
  StreamEventBase,
} from "@tentickle/shared/streaming";
import type { Message } from "@tentickle/shared/messages";
import { StopReason } from "@tentickle/shared";
import type { COMInput } from "../com/types";
import type { EngineResponse } from "../engine/engine-response";
import type { StopReasonInfo } from "../component/component";
import { type ModelHookMiddleware, type ModelHookName, ModelHookRegistry } from "./model-hooks";
import { ToolHookRegistry } from "../tool/tool-hooks";
import type { EventBlock, TextBlock, ContentBlock } from "@tentickle/shared";

export type { BaseModelToolReference, BaseModelConfig, BaseModelInput, BaseModelOutput };

// ============================================================================
// Event Helpers
// ============================================================================

let modelEventIdCounter = 0;

/**
 * Generate a unique event ID for model stream events
 */
function generateModelEventId(): string {
  return `mevt_${Date.now()}_${++modelEventIdCounter}`;
}

/**
 * Create base event fields for StreamEvent
 * Model layer always uses tick=1 since it doesn't have engine context
 */
function createModelEventBase(): StreamEventBase {
  return {
    id: generateModelEventId(),
    sequence: 0, // Placeholder - session.emitEvent assigns actual sequence
    tick: 1,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// Core Interface
// ============================================================================

/**
 * EngineModel is the primary interface for models.
 * All models (created via createModel or ModelAdapter) conform to this.
 */
export interface EngineModel<TModelInput = ModelInput, TModelOutput = ModelOutput> {
  /** Model metadata (id, description, capabilities, etc.) */
  metadata: ModelMetadata;

  /** Generate a response (non-streaming) */
  generate: Procedure<(input: TModelInput) => Promise<TModelOutput>>;

  /** Generate a streaming response */
  stream?: Procedure<(input: TModelInput) => AsyncIterable<StreamEvent>>;

  /** Convert engine state (COMInput) to model input */
  fromEngineState?: (input: COMInput) => Promise<TModelInput>;

  /** Convert model output to engine response */
  toEngineState?: (output: TModelOutput) => Promise<EngineResponse>;

  /** Aggregate stream events into final output */
  processStream?: (events: StreamEvent[]) => Promise<TModelOutput>;
}

// ============================================================================
// createModel - Functional Model Creation
// ============================================================================

type MaybePromise<T> = T | Promise<T>;

/**
 * Transformers for converting between model and provider formats.
 */
export interface ModelTransformers<
  TModelInput,
  TModelOutput,
  TProviderInput,
  TProviderOutput,
  TChunk,
> {
  /** Convert model input to provider-specific format */
  prepareInput?: (input: TModelInput) => MaybePromise<TProviderInput>;
  /** Convert provider output to model output */
  processOutput?: (output: TProviderOutput) => MaybePromise<TModelOutput>;
  /** Convert provider chunk to StreamEvent */
  processChunk?: (chunk: TChunk) => StreamEvent;
  /** Aggregate events into final output */
  processStream?: (events: TChunk[] | StreamEvent[]) => MaybePromise<TModelOutput>;
}

/**
 * Provider execution methods.
 */
export interface ModelExecutors<TProviderInput, TProviderOutput, TChunk> {
  /** Execute non-streaming generation */
  execute: (input: TProviderInput) => Promise<TProviderOutput>;
  /** Execute streaming generation */
  executeStream?: (input: TProviderInput) => AsyncIterable<TChunk>;
}

/**
 * Options for model procedures (middleware, etc.)
 */
export interface ModelProcedureOptions {
  middleware?: Middleware<any[]>[];
  handleFactory?: ProcedureOptions["handleFactory"];
}

/**
 * Options for createModel().
 */
export interface CreateModelOptions<
  TModelInput extends ModelInput = ModelInput,
  TModelOutput extends ModelOutput = ModelOutput,
  TProviderInput = any,
  TProviderOutput = any,
  TChunk = any,
> {
  /** Model metadata */
  metadata: ModelMetadata;
  /** Input/output transformers */
  transformers?: ModelTransformers<
    TModelInput,
    TModelOutput,
    TProviderInput,
    TProviderOutput,
    TChunk
  >;
  /** Provider execution methods */
  executors: ModelExecutors<TProviderInput, TProviderOutput, TChunk>;
  /** Procedure options for generate/stream */
  procedures?: {
    generate?: ModelProcedureOptions;
    stream?: ModelProcedureOptions;
  };
  /** Convert engine state to model input */
  fromEngineState?: (input: COMInput) => MaybePromise<TModelInput>;
  /** Convert model output to engine response */
  toEngineState?: (output: TModelOutput) => MaybePromise<EngineResponse>;
}

/**
 * Creates an EngineModel from options.
 *
 * @example
 * ```typescript
 * const myModel = createModel({
 *   metadata: { id: 'my-model', description: 'Custom model' },
 *   executors: {
 *     execute: async (input) => provider.generate(input),
 *     executeStream: async function* (input) { yield* provider.stream(input) },
 *   },
 *   transformers: {
 *     prepareInput: (input) => convertToProviderFormat(input),
 *     processOutput: (output) => convertFromProviderFormat(output),
 *   },
 * });
 * ```
 */
export function createModel<
  TModelInput extends ModelInput = ModelInput,
  TModelOutput extends ModelOutput = ModelOutput,
  TProviderInput = any,
  TProviderOutput = any,
  TChunk = any,
>(
  options: CreateModelOptions<TModelInput, TModelOutput, TProviderInput, TProviderOutput, TChunk>,
): EngineModel<TModelInput, TModelOutput> {
  const { metadata, transformers = {}, executors, procedures = {} } = options;

  // Default transformers (pass-through)
  const prepareInput =
    transformers.prepareInput ?? ((input: TModelInput) => input as unknown as TProviderInput);
  const processOutput =
    transformers.processOutput ?? ((output: TProviderOutput) => output as unknown as TModelOutput);
  const processChunk =
    transformers.processChunk ?? ((chunk: TChunk) => chunk as unknown as StreamEvent);
  const processStream = transformers.processStream;

  // Create generate procedure with low-cardinality telemetry
  const generate = createEngineProcedure<(input: TModelInput) => Promise<TModelOutput>>(
    {
      name: "model:generate",
      metadata: {
        type: "model",
        id: metadata.id,
        operation: "generate",
      },
      handleFactory: procedures.generate?.handleFactory,
      middleware: normalizeMiddleware(procedures.generate?.middleware),
      // Model calls are child executions within the parent engine execution
      executionBoundary: "child",
      executionType: "model",
    },
    async (input: TModelInput) => {
      const providerInput = await prepareInput(input);

      // Emit event with the provider-formatted input (for DevTools debugging)
      Context.emit("model:provider_request", {
        modelId: metadata.id,
        provider: metadata.provider,
        providerInput,
      });

      const providerOutput = await executors.execute(providerInput);

      // Emit event with the raw provider response (for DevTools debugging)
      Context.emit("model:provider_response", {
        modelId: metadata.id,
        provider: metadata.provider,
        providerOutput,
      });

      return processOutput(providerOutput);
    },
  );

  // Create stream procedure if streaming is supported
  let stream: Procedure<(input: TModelInput) => AsyncIterable<StreamEvent>> | undefined;
  if (executors.executeStream) {
    stream = createEngineProcedure<(input: TModelInput) => AsyncIterable<StreamEvent>>(
      {
        name: "model:stream",
        metadata: {
          type: "model",
          id: metadata.id,
          operation: "stream",
        },
        handleFactory: procedures.stream?.handleFactory,
        middleware: normalizeMiddleware(procedures.stream?.middleware),
        // Model calls are child executions within the parent engine execution
        executionBoundary: "child",
        executionType: "model",
      },
      async function* (input: TModelInput) {
        const providerInput = await prepareInput(input);

        // Emit event with the provider-formatted input (for DevTools debugging)
        Context.emit("model:provider_request", {
          modelId: metadata.id,
          provider: metadata.provider,
          providerInput,
        });

        const iterator = executors.executeStream!(providerInput);

        // Accumulate content for final message event
        let messageStartedAt: string | undefined;
        let accumulatedText = "";
        let accumulatedReasoning = "";
        const accumulatedToolCalls: Array<{
          id: string;
          name: string;
          input: Record<string, unknown>;
        }> = [];
        let lastUsage:
          | { inputTokens: number; outputTokens: number; totalTokens: number }
          | undefined;
        let lastStopReason: StopReason = StopReason.UNSPECIFIED;
        let modelId: string | undefined;

        for await (const chunk of iterator) {
          const processed = processChunk(chunk);

          // Track message lifecycle
          if (processed.type === "message_start") {
            messageStartedAt = new Date().toISOString();
            modelId = (processed as MessageStartEvent).model || metadata.id;
          }

          // Accumulate content
          if (processed.type === "content_delta") {
            accumulatedText += (processed as ContentDeltaEvent).delta;
          }
          if (processed.type === "reasoning_delta") {
            accumulatedReasoning += (processed as ReasoningDeltaEvent).delta;
          }
          if (processed.type === "tool_call") {
            const tc = processed as ToolCallEvent;
            accumulatedToolCalls.push({
              id: tc.callId,
              name: tc.name,
              input: tc.input,
            });
          }
          if (processed.type === "message_end") {
            const endEvent = processed as MessageEndEvent;
            if (endEvent.usage) lastUsage = endEvent.usage;
            lastStopReason = endEvent.stopReason;
          }

          yield processed;

          // After message_end, emit a complete message event
          if (processed.type === "message_end") {
            const content: ContentBlock[] = [];

            // Add reasoning block first if present
            if (accumulatedReasoning) {
              content.push({ type: "reasoning", text: accumulatedReasoning } as ContentBlock);
            }
            // Add text content
            if (accumulatedText) {
              content.push({ type: "text", text: accumulatedText });
            }
            // Add tool use blocks
            for (const tc of accumulatedToolCalls) {
              content.push({
                type: "tool_use",
                toolUseId: tc.id,
                name: tc.name,
                input: tc.input,
              } as ContentBlock);
            }

            const messageEvent: MessageEvent = {
              type: "message",
              ...createModelEventBase(),
              message: {
                role: "assistant" as const,
                content,
              },
              stopReason: lastStopReason,
              usage: lastUsage,
              model: modelId || metadata.id,
              startedAt: messageStartedAt || new Date().toISOString(),
              completedAt: new Date().toISOString(),
            };

            yield messageEvent;

            // Reset accumulators for potential multi-message streams
            messageStartedAt = undefined;
            accumulatedText = "";
            accumulatedReasoning = "";
            accumulatedToolCalls.length = 0;
          }
        }
      },
    );
  }

  return {
    metadata,
    generate,
    stream,
    fromEngineState: options.fromEngineState
      ? async (input: COMInput) => options.fromEngineState!(input)
      : async (input: COMInput) => {
          // Use default with model instance
          const modelInstance = { metadata } as any;
          return defaultFromEngineState(input, undefined, modelInstance) as Promise<TModelInput>;
        },
    toEngineState: options.toEngineState
      ? async (output: TModelOutput) => options.toEngineState!(output)
      : undefined,
    processStream: processStream
      ? async (events: StreamEvent[]) => processStream(events)
      : undefined,
  };
}

function normalizeMiddleware(
  middleware?: Middleware<any[]>[],
): (Middleware<any[]> | MiddlewarePipeline)[] | undefined {
  return middleware as (Middleware<any[]> | MiddlewarePipeline)[] | undefined;
}

// Import and re-export language model utilities
import {
  fromEngineState as defaultFromEngineState,
  toEngineState as defaultToEngineState,
} from "./utils/language-model";
import type {
  LibraryGenerationOptions,
  ProviderGenerationOptions,
  DelimiterConfig,
  EventBlockDelimiters,
} from "../types";
import type { ExecutableTool, ToolDefinition, ToolMetadata } from "../tool/tool";

/**
 * Creates a language model with standard fromEngineState/toEngineState transformers.
 * Convenience wrapper around createModel() for language models.
 */
export function createLanguageModel<
  TModelInput extends ModelInput = ModelInput,
  TModelOutput extends ModelOutput = ModelOutput,
  TProviderInput = any,
  TProviderOutput = any,
  TChunk = any,
>(
  options: CreateModelOptions<TModelInput, TModelOutput, TProviderInput, TProviderOutput, TChunk>,
): EngineModel<TModelInput, TModelOutput> {
  return createModel<TModelInput, TModelOutput, TProviderInput, TProviderOutput, TChunk>({
    metadata: {
      ...options.metadata,
      type: "language" as const,
    },
    transformers: options.transformers,
    executors: options.executors,
    procedures: options.procedures,
    fromEngineState: async (input: COMInput) => {
      if (options.fromEngineState) {
        return options.fromEngineState(input) as Promise<TModelInput>;
      }
      // Use default with model instance (created model has access to metadata)
      const modelInstance = { metadata: options.metadata } as any;
      return defaultFromEngineState(input, undefined, modelInstance) as Promise<TModelInput>;
    },
    toEngineState: (output: TModelOutput) =>
      (options.toEngineState || defaultToEngineState)(output),
  });
}

// ============================================================================
// ModelAdapter - Class-based Implementation
// ============================================================================

/**
 * Abstract class for provider-specific model adapters.
 *
 * Use this when you need class-based organization (e.g., OpenAI, Anthropic adapters).
 * For simpler cases, use createModel().
 *
 * Generic parameters:
 * - TModelInput: Standard input format (default: ModelInput)
 * - TModelOutput: Standard output format (default: ModelOutput)
 * - TProviderInput: Provider-specific input format
 * - TProviderOutput: Provider-specific output format
 * - TChunk: Provider-specific stream chunk format
 */
export abstract class ModelAdapter<
  TModelInput = ModelInput,
  TModelOutput = ModelOutput,
  TProviderInput = any,
  TProviderOutput = any,
  TChunk = StreamEvent,
> implements EngineModel<TModelInput, TModelOutput> {
  abstract metadata: ModelMetadata;

  static hooks: Record<string, ModelHookMiddleware<any>[]> = {};
  static tags: string[] = [];

  private hooksRegistry: ModelHookRegistry;
  private toolHooksRegistry: ToolHookRegistry;

  get hooks(): ModelHookRegistry {
    return Object.assign(this.hooksRegistry, { tools: this.toolHooksRegistry });
  }

  get toolHooks(): ToolHookRegistry {
    return this.toolHooksRegistry;
  }

  constructor() {
    this.hooksRegistry = new ModelHookRegistry();
    this.toolHooksRegistry = new ToolHookRegistry();
    this.registerStaticHooks();
  }

  private registerStaticHooks(): void {
    const modelClass = this.constructor as typeof ModelAdapter;
    const staticHooks = modelClass.hooks;
    if (!staticHooks) return;

    for (const [hookName, middleware] of Object.entries(staticHooks)) {
      if (middleware && Array.isArray(middleware)) {
        for (const mw of middleware) {
          this.hooksRegistry.register(hookName as ModelHookName, mw);
        }
      }
    }
  }

  // === Abstract methods for subclasses ===

  /** Convert model input to provider format */
  protected abstract prepareInput(input: TModelInput): TProviderInput | Promise<TProviderInput>;

  /** Convert provider output to model output */
  protected abstract processOutput(output: TProviderOutput): TModelOutput | Promise<TModelOutput>;

  /** Convert provider chunk to StreamEvent */
  protected abstract processChunk?(chunk: TChunk): StreamEvent;

  /** Execute generation (provider-specific) */
  protected abstract execute(input: TProviderInput): Promise<TProviderOutput>;

  /** Execute streaming (provider-specific) */
  protected abstract executeStream?(input: TProviderInput): AsyncIterable<TChunk>;

  // === EngineModel interface implementation ===

  /** Generate procedure - initialized lazily to access metadata */
  private _generate?: Procedure<(input: TModelInput) => Promise<TModelOutput>>;

  public get generate(): Procedure<(input: TModelInput) => Promise<TModelOutput>> {
    if (!this._generate) {
      this._generate = createEngineProcedure(
        {
          name: "model:generate",
          metadata: {
            type: "model",
            id: this.metadata.id,
            operation: "generate",
          },
          // Model calls are child executions within the parent engine execution
          executionBoundary: "child",
          executionType: "model",
        },
        async (input: TModelInput) => {
          const providerInput = await this.prepareInput(input);

          // Emit event with the provider-formatted input (for DevTools debugging)
          Context.emit("model:provider_request", {
            modelId: this.metadata.id,
            provider: this.metadata.provider,
            providerInput,
          });

          const providerOutput = await this.execute(providerInput);

          // Emit event with the raw provider response (for DevTools debugging)
          Context.emit("model:provider_response", {
            modelId: this.metadata.id,
            provider: this.metadata.provider,
            providerOutput,
          });

          return this.processOutput(providerOutput);
        },
      );
    }
    return this._generate;
  }

  /** Stream procedure - initialized lazily to access metadata */
  private _stream?: Procedure<(input: TModelInput) => AsyncIterable<StreamEvent>>;

  public get stream(): Procedure<(input: TModelInput) => AsyncIterable<StreamEvent>> {
    if (!this._stream) {
      const self = this;
      this._stream = createEngineProcedure(
        {
          name: "model:stream",
          metadata: {
            type: "model",
            id: this.metadata.id,
            operation: "stream",
          },
          // Model calls are child executions within the parent engine execution
          executionBoundary: "child",
          executionType: "model",
        },
        async function* (input: TModelInput): AsyncIterable<StreamEvent> {
          if (!self.executeStream) {
            throw new Error(`Model ${self.metadata.id} does not support streaming.`);
          }
          const providerInput = await self.prepareInput(input);

          // Emit event with the provider-formatted input (for DevTools debugging)
          Context.emit("model:provider_request", {
            modelId: self.metadata.id,
            provider: self.metadata.provider,
            providerInput,
          });

          // Accumulate content for final message event
          let messageStartedAt: string | undefined;
          let accumulatedText = "";
          let accumulatedReasoning = "";
          const accumulatedToolCalls: Array<{
            id: string;
            name: string;
            input: Record<string, unknown>;
          }> = [];
          let lastUsage:
            | { inputTokens: number; outputTokens: number; totalTokens: number }
            | undefined;
          let lastStopReason: StopReason = StopReason.UNSPECIFIED;
          let modelId: string | undefined;

          for await (const chunk of self.executeStream(providerInput)) {
            const processed = self.processChunk
              ? self.processChunk(chunk)
              : (chunk as unknown as StreamEvent);

            // Track message lifecycle
            if (processed.type === "message_start") {
              messageStartedAt = new Date().toISOString();
              modelId = (processed as MessageStartEvent).model || self.metadata.id;
            }

            // Accumulate content
            if (processed.type === "content_delta") {
              accumulatedText += (processed as ContentDeltaEvent).delta;
            }
            if (processed.type === "reasoning_delta") {
              accumulatedReasoning += (processed as ReasoningDeltaEvent).delta;
            }
            if (processed.type === "tool_call") {
              const tc = processed as ToolCallEvent;
              accumulatedToolCalls.push({
                id: tc.callId,
                name: tc.name,
                input: tc.input,
              });
            }
            if (processed.type === "message_end") {
              const endEvent = processed as MessageEndEvent;
              if (endEvent.usage) lastUsage = endEvent.usage;
              lastStopReason = endEvent.stopReason;
            }

            yield processed;

            // After message_end, emit a complete message event
            if (processed.type === "message_end") {
              const content: ContentBlock[] = [];

              // Add reasoning block first if present
              if (accumulatedReasoning) {
                content.push({ type: "reasoning", text: accumulatedReasoning } as ContentBlock);
              }
              // Add text content
              if (accumulatedText) {
                content.push({ type: "text", text: accumulatedText });
              }
              // Add tool use blocks
              for (const tc of accumulatedToolCalls) {
                content.push({
                  type: "tool_use",
                  toolUseId: tc.id,
                  name: tc.name,
                  input: tc.input,
                } as ContentBlock);
              }

              const messageEvent: MessageEvent = {
                type: "message",
                ...createModelEventBase(),
                message: {
                  role: "assistant" as const,
                  content,
                },
                stopReason: lastStopReason,
                usage: lastUsage,
                model: modelId || self.metadata.id,
                startedAt: messageStartedAt || new Date().toISOString(),
                completedAt: new Date().toISOString(),
              };

              yield messageEvent;

              // Reset accumulators for potential multi-message streams
              messageStartedAt = undefined;
              accumulatedText = "";
              accumulatedReasoning = "";
              accumulatedToolCalls.length = 0;
            }
          }
        },
      );
    }
    return this._stream;
  }

  /** Aggregate stream events into final output */
  public async processStream(events: TChunk[] | StreamEvent[]): Promise<TModelOutput> {
    const streamEvents = events as StreamEvent[];
    let text = "";
    const toolCalls: any[] = [];
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let stopReason: any = "unspecified";
    let model = this.metadata.id;

    for (const event of streamEvents) {
      if (event.type === "content_delta") {
        text += (event as ContentDeltaEvent).delta;
      }
      if (event.type === "tool_call") {
        const tc = event as ToolCallEvent;
        toolCalls.push({ id: tc.callId, name: tc.name, input: tc.input });
      }
      if (event.type === "message_end") {
        const endEvent = event as MessageEndEvent;
        if (endEvent.usage) {
          usage.inputTokens = Math.max(usage.inputTokens, endEvent.usage.inputTokens || 0);
          usage.outputTokens = Math.max(usage.outputTokens, endEvent.usage.outputTokens || 0);
          usage.totalTokens = Math.max(usage.totalTokens, endEvent.usage.totalTokens || 0);
        }
        stopReason = endEvent.stopReason;
      }
      if (event.type === "message") {
        const msgEvent = event as MessageEvent;
        if (msgEvent.model) model = msgEvent.model;
        if (msgEvent.usage) {
          usage.inputTokens = Math.max(usage.inputTokens, msgEvent.usage.inputTokens || 0);
          usage.outputTokens = Math.max(usage.outputTokens, msgEvent.usage.outputTokens || 0);
          usage.totalTokens = Math.max(usage.totalTokens, msgEvent.usage.totalTokens || 0);
        }
        stopReason = msgEvent.stopReason;
      }
    }

    return {
      model,
      createdAt: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "text", text }] },
      usage,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      stopReason,
      raw: {},
    } as unknown as TModelOutput;
  }

  /** Convert engine state to model input */
  public async fromEngineState(input: COMInput): Promise<TModelInput> {
    // Use default implementation with this model instance for transformation config
    return defaultFromEngineState(input, undefined, this as any) as Promise<TModelInput>;
  }

  /** Convert model output to engine response */
  public async toEngineState(output: TModelOutput): Promise<EngineResponse> {
    const modelOutput = output as unknown as ModelOutput;
    const stopReasonInfo = this.deriveStopReason(output);

    // Determine if we should stop:
    // 1. No tool calls AND terminal stop reason, OR
    // 2. No tool calls AND empty/no content (model has nothing to say)
    const hasToolCalls = modelOutput.toolCalls && modelOutput.toolCalls.length > 0;
    const hasContent =
      modelOutput.message?.content &&
      Array.isArray(modelOutput.message.content) &&
      modelOutput.message.content.length > 0;
    const isTerminal = stopReasonInfo ? this.isTerminalStopReason(stopReasonInfo.reason) : false;

    // Stop if: no tool calls AND (terminal stop reason OR empty response)
    // This prevents infinite loops when model returns empty content with UNSPECIFIED stop reason
    const shouldStop = !hasToolCalls && (isTerminal || !hasContent);

    return {
      newTimelineEntries: modelOutput.message
        ? [
            {
              kind: "message",
              message: modelOutput.message,
              tags: ["model_output"],
            },
          ]
        : [],
      toolCalls: modelOutput.toolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.name,
        input: tc.input,
      })),
      usage: modelOutput.usage,
      shouldStop,
      stopReason: stopReasonInfo,
    };
  }

  // === Stop reason helpers ===

  protected deriveStopReason(output: TModelOutput): StopReasonInfo | undefined {
    const modelOutput = output as unknown as ModelOutput;
    if (!modelOutput.stopReason) return undefined;

    const stopReason = modelOutput.stopReason as string | StopReason;
    return {
      reason: stopReason,
      description: this.getStopReasonDescription(stopReason),
      recoverable: this.isRecoverableStopReason(stopReason),
      metadata: { usage: modelOutput.usage, model: modelOutput.model },
    };
  }

  protected getStopReasonDescription(reason: string | StopReason): string {
    const descriptions: Record<string, string> = {
      [StopReason.MAX_TOKENS]: "Maximum token limit reached",
      [StopReason.CONTENT_FILTER]: "Content was filtered by safety filters",
      [StopReason.TOOL_USE]: "Model requested tool execution",
      [StopReason.STOP]: "Model completed naturally",
      [StopReason.PAUSED]: "Generation was paused",
      [StopReason.FORMAT_ERROR]: "Response format error occurred",
      [StopReason.EMPTY_RESPONSE]: "Model returned empty response",
      [StopReason.NO_CONTENT]: "No content was generated",
    };
    return descriptions[reason] || `Stopped: ${reason}`;
  }

  protected isRecoverableStopReason(reason: string | StopReason): boolean {
    const recoverable = [StopReason.PAUSED, StopReason.FORMAT_ERROR];
    const terminal = [
      StopReason.STOP,
      StopReason.EXPLICIT_COMPLETION,
      StopReason.NATURAL_COMPLETION,
    ];
    if (recoverable.includes(reason as StopReason)) return true;
    if (terminal.includes(reason as StopReason)) return false;
    return false;
  }

  protected isTerminalStopReason(reason: string | StopReason): boolean {
    const terminal = [
      StopReason.STOP,
      StopReason.EXPLICIT_COMPLETION,
      StopReason.NATURAL_COMPLETION,
      StopReason.MAX_TOKENS,
      StopReason.CONTENT_FILTER,
    ];
    return terminal.includes(reason as StopReason);
  }
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Type guard: checks if value is an EngineModel.
 */
export function isEngineModel(value: any): value is EngineModel {
  return (
    value &&
    typeof value === "object" &&
    "metadata" in value &&
    "generate" in value &&
    typeof value.generate === "function"
  );
}

/**
 * ModelInstance type - use EngineModel as the standard.
 * ModelAdapter implements EngineModel, so both work.
 */
export type ModelInstance = EngineModel;

/**
 * Unified message transformation configuration.
 * Handles both event and ephemeral content transformation.
 */
export interface MessageTransformationConfig {
  /**
   * Preferred renderer for content formatting.
   * Can be:
   * - String: Static renderer type ('markdown' | 'xml')
   * - Function: Dynamic renderer selection based on model ID
   *
   * @example
   * preferredRenderer: 'markdown'
   *
   * @example
   * preferredRenderer: (modelId: string) => {
   *   if (modelId.includes('claude')) return 'markdown';
   *   if (modelId.includes('gpt-4')) return 'markdown';
   *   return 'markdown'; // default
   * }
   */
  preferredRenderer?:
    | "markdown"
    | "xml"
    | ((modelId: string, provider?: string) => "markdown" | "xml");

  /**
   * Role mapping for transformed messages.
   * Controls how event/ephemeral messages are converted to model-understandable roles.
   */
  roleMapping?: {
    /**
     * Role to use for event messages.
     * - 'user': Most compatible, treat as user context
     * - 'developer': Use developer role (Claude, newer OpenAI)
     * - 'event': Keep as event (adapter handles model-specific mapping)
     * - 'system': Treat as system context
     */
    event?: "user" | "developer" | "event" | "system";

    /**
     * Role to use for ephemeral messages.
     * - 'user': Most compatible
     * - 'developer': Use developer role (Claude, newer OpenAI)
     * - 'system': Treat as system context
     */
    ephemeral?: "user" | "developer" | "system";
  };

  /**
   * Delimiter configuration for transformed content.
   * When useDelimiters is true, content is wrapped with delimiters.
   */
  delimiters?: {
    /** Delimiter for event content */
    event?: DelimiterConfig | EventBlockDelimiters;
    /** Delimiter for ephemeral content */
    ephemeral?: DelimiterConfig;
    /** Global toggle for delimiter usage */
    useDelimiters?: boolean;
  };

  /**
   * Custom formatter for full control over event block transformation.
   * When provided, overrides delimiter-based formatting.
   */
  formatBlock?: (block: EventBlock | TextBlock) => ContentBlock[];

  /**
   * Position for ephemeral content in the message list (CSS-inspired).
   * - 'flow': Keep in declaration order (default)
   * - 'start': Move to beginning (after system)
   * - 'end': Move to end
   * - 'before-user': Move to just before last user message
   * - 'after-system': Move to just after system messages
   */
  ephemeralPosition?: "flow" | "start" | "end" | "before-user" | "after-system";
}

export interface ModelCapabilities {
  stream?: boolean;
  toolCalls?: boolean;
  provider?: string;

  /**
   * Message transformation configuration.
   * Can be:
   * - Static config object
   * - Function that returns config based on model ID
   *
   * @example
   * messageTransformation: {
   *   preferredRenderer: 'markdown',
   *   roleMapping: { event: 'user', ephemeral: 'user' }
   * }
   *
   * @example
   * messageTransformation: (modelId: string, provider?: string) => ({
   *   preferredRenderer: modelId.includes('claude') ? 'markdown' : 'markdown',
   *   roleMapping: {
   *     event: provider === 'anthropic' ? 'developer' : 'user',
   *     ephemeral: provider === 'anthropic' ? 'developer' : 'user'
   *   }
   * })
   */
  messageTransformation?:
    | MessageTransformationConfig
    | ((modelId: string, provider?: string) => MessageTransformationConfig);
}

/**
 * Model operations supported by adapters.
 *
 * Used by the Model component's `operation` prop to specify which
 * model method to invoke during execution.
 *
 * Core operations (available on all language models):
 * - 'generate': Non-streaming text generation (default)
 * - 'stream': Streaming text generation
 *
 * Extended operations (adapter-specific, may require specific model types):
 * - 'generateObject': Structured output generation
 * - 'streamObject': Streaming structured output
 * - 'generateImage': Image generation
 * - 'editImage': Image editing
 * - 'embed': Generate embeddings
 * - 'countTokens': Token counting
 * - 'transcribe': Audio to text
 * - 'speak': Text to audio
 */
export type ModelOperation =
  // Core operations (always available)
  | "generate"
  | "stream"
  // Extended operations (adapter-specific)
  | "generateObject"
  | "streamObject"
  | "generateImage"
  | "editImage"
  | "embed"
  | "countTokens"
  | "transcribe"
  | "speak"
  // Extensible for custom operations
  | (string & {});

export interface ModelMetadata {
  id: string;
  model?: string;
  description?: string;
  version?: string;
  provider?: string;
  type?: "language" | "image" | "embedding" | "vision";
  capabilities: ModelCapabilities[];
}

/**
 * Model input (normalized across all providers)
 *
 * Extends the base ModelInput from @tentickle/shared with backend-specific fields.
 */
export interface ModelInput extends BaseModelInput {
  /**
   * Provider-specific generation options.
   * Used for model generation/streaming calls and other operations.
   * Each adapter can extend this type using module augmentation.
   */
  providerOptions?: ProviderGenerationOptions;

  /**
   * Adapter-specific options (keyed by library: ai-sdk, langchain, llamaindex, etc.).
   * Used to pass library-specific configuration that isn't provider-specific.
   * Each adapter package extends LibraryGenerationOptions via module augmentation.
   *
   * Note: If an adapter has its own providerOptions concept, provide them here
   * under the adapter key. The adapter will merge them with ModelInput.providerOptions.
   */
  libraryOptions?: LibraryGenerationOptions;

  /**
   * Message transformation configuration.
   * Controls how event and ephemeral messages are transformed for the model.
   * Can be set per-request to override model-level defaults.
   *
   * @see MessageTransformationConfig
   */
  messageTransformation?: Partial<MessageTransformationConfig>;

  /**
   * Engine-level metadata
   */
  engineMetadata?: Record<string, unknown>;

  /**
   * Engine-level sections
   */
  engineSections?: Array<{
    id: string;
    title?: string;
    content?: any;
    visibility?: string;
    audience?: "model" | "human" | "system";
    ttlMs?: number;
    ttlTicks?: number;
  }>;

  /**
   * Cached content reference
   */
  cacheId?: string;
}

/**
 * Model output (normalized across all providers)
 *
 * Extends the base ModelOutput from @tentickle/shared with backend-specific fields.
 */
export interface ModelOutput extends BaseModelOutput {
  /**
   * Cache ID if content was cached
   */
  cacheId?: string;

  /**
   * Raw provider response
   */
  raw: any;
}

// StreamEvent types are exported from '@tentickle/shared/streaming'

export type ModelToolReference =
  | BaseModelToolReference
  | ToolDefinition
  | ToolMetadata
  | ExecutableTool; // Changed from Tool class to ExecutableTool interface

export interface NormalizedModelTool {
  id: string;
  metadata: ToolMetadata;
}

// ToolCall is now exported from '@tentickle/shared'

/**
 * Normalized model input (after message normalization)
 */
export interface NormalizedModelInput extends Omit<ModelInput, "messages" | "tools"> {
  messages: Message[];
  model: string; // Override to make required after validation
  tools: NormalizedModelTool[];
}

/**
 * Model operations interface
 */
export interface ModelOperations {
  /**
   * Generate completion (non-streaming)
   */
  generate: Procedure<(input: ModelInput) => ModelOutput>;

  /**
   * Generate completion (streaming)
   */
  stream: Procedure<(input: ModelInput) => AsyncIterable<StreamEvent>>;
}

/**
 * Model configuration
 *
 * Extends the base ModelConfig from @tentickle/shared with backend-specific fields.
 */
export interface ModelConfig extends BaseModelConfig {
  /**
   * Provider-specific generation options.
   * Used for model generation/streaming calls and other operations.
   */
  providerOptions?: Record<string, any>;
  /**
   * Message transformation configuration.
   * Controls how event and ephemeral messages are transformed for the model.
   * @see MessageTransformationConfig
   */
  messageTransformation?: Partial<MessageTransformationConfig>;
}
