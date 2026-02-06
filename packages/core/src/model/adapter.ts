/**
 * Adapter - The recommended way to create model adapters
 *
 * This provides a clean API for creating adapters while preserving
 * all framework features (streaming, metadata, model-specific defaults, options merging).
 *
 * ## Why createAdapter?
 *
 * Creating adapters is one of the most common tasks when extending Tentickle.
 * This API minimizes boilerplate while maximizing flexibility:
 *
 * - **Minimal API**: Just implement prepareInput, mapChunk, execute, executeStream
 * - **Automatic streaming**: StreamAccumulator handles all lifecycle events
 * - **Options merging**: Built-in merging of providerOptions and libraryOptions
 * - **Model defaults**: Full support for messageTransformation config
 * - **Metadata extraction**: Hook for citations, annotations, grounding
 *
 * ## Quick Start
 *
 * ```typescript
 * import { createAdapter, StopReason } from '@tentickle/core/model';
 *
 * const model = createAdapter({
 *   metadata: {
 *     id: 'my-provider:my-model',
 *     provider: 'my-provider',
 *     capabilities: [{ stream: true, toolCalls: true }],
 *   },
 *
 *   prepareInput: (input) => ({
 *     model: 'my-model',
 *     messages: toProviderMessages(input.messages),
 *     tools: input.tools?.map(toProviderTool),
 *   }),
 *
 *   mapChunk: (chunk) => {
 *     if (chunk.type === 'text') return { type: 'text', delta: chunk.text };
 *     if (chunk.type === 'tool') return { type: 'tool_call', id: chunk.id, name: chunk.name, input: chunk.args };
 *     if (chunk.type === 'done') return { type: 'message_end', stopReason: StopReason.STOP };
 *     return null;
 *   },
 *
 *   execute: (input) => provider.generate(input),
 *   executeStream: (input) => provider.stream(input),
 * });
 * ```
 *
 * @module tentickle/model/adapter
 */

import React from "react";
import { Context } from "@tentickle/kernel";
import type { COMInput } from "../com/types";
import type { EngineResponse } from "../engine/engine-response";
import type { EngineModel, ModelInput, ModelOutput, ModelMetadata } from "./model";
import { createEngineProcedure } from "../procedure";
import {
  StreamAccumulator,
  type AdapterDelta,
  type ChunkMapping,
  createChunkMapper,
} from "./stream-accumulator";
import type {
  StreamEvent,
  ContentMetadata,
  MessageEvent,
  StreamEventBase,
} from "@tentickle/shared/streaming";
import type { ContentBlock } from "@tentickle/shared";
import { fromEngineState, toEngineState } from "./utils/language-model";
import type { LibraryGenerationOptions, ProviderGenerationOptions } from "../types";
import { Model } from "../jsx/components/model";

// ============================================================================
// Re-exports for adapter convenience
// ============================================================================

export { StopReason } from "@tentickle/shared";
export type { AdapterDelta, ChunkMapping } from "./stream-accumulator";
export { createChunkMapper } from "./stream-accumulator";

// ============================================================================
// ModelClass - Unified model type (component + adapter)
// ============================================================================

import type { COM } from "../com/object-model";
import type { ModelConfig as SharedModelConfig } from "@tentickle/shared/models";

/**
 * Props for ModelClass when used as a JSX component.
 * Extends SharedModelConfig with component-specific props.
 */
export interface ModelClassProps extends Partial<SharedModelConfig> {
  /** Child components */
  children?: React.ReactNode;
  /** Provider-specific options */
  providerOptions?: ProviderGenerationOptions;
  /** Callback when mounted */
  onMount?: (ctx: COM) => void | Promise<void>;
  /** Callback when unmounted */
  onUnmount?: (ctx: COM) => void | Promise<void>;
}

/**
 * ModelClass - A model adapter that can be used both programmatically and as JSX.
 *
 * This is the return type of createAdapter. It behaves like:
 * - An EngineModel for programmatic use (createApp, direct generate/stream calls)
 * - A JSX component for declarative use in agent trees
 *
 * @example
 * ```typescript
 * const model = createAdapter({ ... });
 *
 * // Use as JSX component
 * <model temperature={0.9}>
 *   <MyAgent />
 * </model>
 *
 * // Use with createApp
 * const app = createApp(Agent, { model });
 *
 * // Direct execution
 * const output = await model.generate(input);
 * for await (const event of model.stream(input)) { ... }
 * ```
 */
export interface ModelClass extends EngineModel<ModelInput, ModelOutput> {
  /** Use as JSX component */
  (props: ModelClassProps): React.ReactElement;
}

// ============================================================================
// Options Merging Utilities
// ============================================================================

/**
 * Deep merge utility for options objects.
 * Handles nested objects and arrays intelligently.
 */
function deepMerge<T extends object>(...sources: (T | undefined)[]): T {
  const result = {} as T;

  for (const source of sources) {
    if (!source) continue;

    for (const key of Object.keys(source) as (keyof T)[]) {
      const value = source[key];
      const existing = result[key];

      if (value === undefined) continue;

      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof existing === "object" &&
        existing !== null &&
        !Array.isArray(existing)
      ) {
        // Deep merge nested objects
        result[key] = deepMerge(existing as object, value as object) as T[keyof T];
      } else {
        // Overwrite primitives, arrays, and null
        result[key] = value;
      }
    }
  }

  return result;
}

/**
 * Merge provider options from multiple sources.
 *
 * Priority (later sources override earlier):
 * 1. Model-level defaults (from adapter config)
 * 2. Input providerOptions (from ModelInput)
 * 3. Library-nested providerOptions (from libraryOptions[adapter].providerOptions)
 *
 * @example
 * ```typescript
 * const merged = mergeProviderOptions(
 *   'openai',
 *   { temperature: 0.5 },  // adapter defaults
 *   input.providerOptions, // input options
 *   input.libraryOptions,  // may contain nested providerOptions
 * );
 * ```
 */
export function mergeProviderOptions<T extends object = Record<string, unknown>>(
  providerKey: string,
  adapterDefaults?: Partial<T>,
  inputProviderOptions?: ProviderGenerationOptions,
  libraryOptions?: LibraryGenerationOptions,
): T {
  // Extract provider-specific options from each source
  const adapterOpts = adapterDefaults || {};
  const inputOpts = inputProviderOptions?.[providerKey] || {};

  // Library options may contain nested providerOptions for this provider.
  // We iterate over all library keys to collect nested providerOptions[providerKey].
  let libraryProviderOpts: Record<string, unknown> = {};
  if (libraryOptions) {
    for (const libraryKey of Object.keys(libraryOptions)) {
      const libraryValue = libraryOptions[libraryKey] as Record<string, unknown> | undefined;
      const nestedProviderOpts = (
        libraryValue?.providerOptions as Record<string, unknown> | undefined
      )?.[providerKey];
      if (nestedProviderOpts) {
        libraryProviderOpts = deepMerge(
          libraryProviderOpts,
          nestedProviderOpts as Record<string, unknown>,
        );
      }
    }
  }

  return deepMerge(adapterOpts as T, inputOpts as T, libraryProviderOpts as T);
}

/**
 * Merge library options from multiple sources.
 *
 * @example
 * ```typescript
 * const merged = mergeLibraryOptions(
 *   'ai-sdk',
 *   { maxSteps: 5 },       // adapter defaults
 *   input.libraryOptions,  // input options
 * );
 * ```
 */
export function mergeLibraryOptions<T extends object = Record<string, unknown>>(
  libraryKey: string,
  adapterDefaults?: Partial<T>,
  inputLibraryOptions?: LibraryGenerationOptions,
): T {
  const adapterOpts = adapterDefaults || {};
  const inputOpts = inputLibraryOptions?.[libraryKey] || {};

  return deepMerge(adapterOpts as T, inputOpts as T);
}

/**
 * Extract all relevant options for a library adapter.
 *
 * Returns a structured object with:
 * - `library`: Merged library-specific options
 * - `provider`: Merged provider-specific options
 * - `standard`: Standard ModelInput options (temperature, maxTokens, etc.)
 *
 * @example
 * ```typescript
 * const opts = extractAdapterOptions('ai-sdk', 'openai', input, {
 *   libraryDefaults: { maxSteps: 5 },
 *   providerDefaults: { temperature: 0.7 },
 * });
 *
 * return {
 *   model,
 *   messages,
 *   ...opts.library,    // AI SDK specific
 *   providerOptions: {
 *     openai: opts.provider,  // OpenAI specific
 *   },
 * };
 * ```
 */
export function extractAdapterOptions<
  TLibrary extends object = Record<string, unknown>,
  TProvider extends object = Record<string, unknown>,
>(
  libraryKey: string,
  providerKey: string,
  input: ModelInput,
  defaults?: {
    libraryDefaults?: Partial<TLibrary>;
    providerDefaults?: Partial<TProvider>;
  },
): {
  library: TLibrary;
  provider: TProvider;
  standard: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    stop?: string | string[];
  };
} {
  const library = mergeLibraryOptions<TLibrary>(
    libraryKey,
    defaults?.libraryDefaults,
    input.libraryOptions,
  );

  const provider = mergeProviderOptions<TProvider>(
    providerKey,
    defaults?.providerDefaults,
    input.providerOptions,
    input.libraryOptions,
  );

  return {
    library,
    provider,
    standard: {
      model: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      topP: input.topP,
      frequencyPenalty: input.frequencyPenalty,
      presencePenalty: input.presencePenalty,
      stop: input.stop,
    },
  };
}

// ============================================================================
// Adapter Options
// ============================================================================

/**
 * Options for createAdapter.
 *
 * This is the minimal interface for creating an adapter. The framework handles:
 * - Stream lifecycle (message_start, content_start/delta/end, message_end)
 * - Content accumulation and ModelOutput construction
 * - COMInput → ModelInput → ProviderInput transformations
 * - ModelOutput → EngineResponse transformations
 *
 * You only need to implement the provider-specific parts.
 *
 * @example
 * ```typescript
 * const model = createAdapter({
 *   metadata: { id: 'openai:gpt-4', provider: 'openai', capabilities: [{ stream: true, toolCalls: true }] },
 *
 *   prepareInput: (input) => ({
 *     model: 'gpt-4',
 *     messages: input.messages.map(toOpenAIMessage),
 *     tools: input.tools?.map(toOpenAITool),
 *   }),
 *
 *   mapChunk: (chunk) => {
 *     if (chunk.choices?.[0]?.delta?.content) {
 *       return { type: 'text', delta: chunk.choices[0].delta.content };
 *     }
 *     return null;
 *   },
 *
 *   execute: async (input) => openai.chat.completions.create(input),
 *   executeStream: (input) => openai.chat.completions.create({ ...input, stream: true }),
 * });
 * ```
 */
export interface AdapterOptions<TProviderInput, TProviderOutput, TChunk> {
  /** Model metadata */
  metadata: ModelMetadata;

  /**
   * Convert engine ModelInput to provider-specific input format.
   * This is the only complex transformation you need to implement.
   *
   * Use the options helpers to merge providerOptions and libraryOptions:
   * ```typescript
   * prepareInput: (input) => {
   *   const opts = extractAdapterOptions('ai-sdk', 'openai', input, {
   *     providerDefaults: { temperature: 0.7 },
   *   });
   *   return { model, messages, ...opts.provider };
   * }
   * ```
   */
  prepareInput: (input: ModelInput) => TProviderInput | Promise<TProviderInput>;

  /**
   * Map a provider stream chunk to an AdapterDelta.
   * Return null to skip/ignore the chunk.
   *
   * The framework handles stream lifecycle automatically:
   * - First text/reasoning delta → emits content_start/reasoning_start
   * - Subsequent deltas → emits content_delta/reasoning_delta
   * - message_end → emits content_end/reasoning_end
   *
   * @example
   * ```typescript
   * mapChunk: (chunk) => {
   *   if (chunk.type === 'text-delta') return { type: 'text', delta: chunk.text };
   *   if (chunk.type === 'tool-call') return { type: 'tool_call', id: chunk.id, name: chunk.name, input: chunk.args };
   *   if (chunk.type === 'finish') return { type: 'message_end', stopReason: StopReason.STOP };
   *   return null;
   * }
   * ```
   */
  mapChunk: (chunk: TChunk) => AdapterDelta | null;

  /**
   * Execute non-streaming generation.
   */
  execute: (input: TProviderInput) => Promise<TProviderOutput>;

  /**
   * Execute streaming generation.
   * Returns an async iterable of provider chunks.
   */
  executeStream?: (input: TProviderInput) => AsyncIterable<TChunk>;

  /**
   * Convert non-streaming provider output to ModelOutput.
   * Optional - if not provided, streaming will be used and accumulated.
   */
  processOutput?: (output: TProviderOutput) => ModelOutput | Promise<ModelOutput>;

  /**
   * Reconstruct the raw provider response from accumulated streaming data.
   * This creates a response object that mirrors what a non-streaming call would return.
   *
   * @example
   * ```typescript
   * reconstructRaw: (accumulated) => ({
   *   id: accumulated.firstChunkId,
   *   object: "chat.completion",
   *   model: accumulated.model,
   *   choices: [{
   *     index: 0,
   *     message: { role: "assistant", content: accumulated.text },
   *     finish_reason: accumulated.stopReason === "stop" ? "stop" : "length",
   *   }],
   *   usage: accumulated.usage,
   * })
   * ```
   */
  reconstructRaw?: (accumulated: {
    text: string;
    reasoning: string;
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    stopReason: string;
    model: string;
    /** Raw chunks collected during streaming */
    chunks: TChunk[];
  }) => unknown;

  /**
   * Extract metadata (citations, annotations, etc.) from provider response.
   * Called at the end of streaming or after non-streaming generation.
   *
   * Use this to normalize provider-specific metadata:
   * - Anthropic citations → ContentMetadata.citations
   * - Google grounding → ContentMetadata.citations + extensions
   * - OpenAI annotations → ContentMetadata.annotations
   *
   * @example
   * ```typescript
   * extractMetadata: (chunk, accumulated) => {
   *   if (chunk.citations?.length) {
   *     return {
   *       citations: chunk.citations.map(c => ({
   *         text: c.cited_text,
   *         url: c.source?.url,
   *         title: c.source?.title,
   *       })),
   *     };
   *   }
   *   return undefined;
   * }
   * ```
   */
  extractMetadata?: (
    chunk: TChunk,
    accumulated: { text: string; reasoning: string },
  ) => ContentMetadata | undefined;

  /**
   * Custom fromEngineState (optional).
   * Converts COMInput to ModelInput before prepareInput.
   * Most adapters don't need this - the default handles standard transformations.
   */
  fromEngineState?: (input: COMInput) => ModelInput | Promise<ModelInput>;

  /**
   * Custom toEngineState (optional).
   * Converts ModelOutput to EngineResponse.
   * Most adapters don't need this - the default handles standard transformations.
   */
  toEngineState?: (output: ModelOutput) => EngineResponse | Promise<EngineResponse>;

  // === Component Lifecycle Hooks (for JSX usage) ===

  /**
   * Called when the model component is mounted.
   * Use for initialization when used as JSX.
   */
  onMount?: (ctx: COM) => void | Promise<void>;

  /**
   * Called when the model component is unmounted.
   * Use for cleanup when used as JSX.
   */
  onUnmount?: (ctx: COM) => void | Promise<void>;
}

/**
 * Declarative options using ChunkMapping instead of mapChunk function.
 */
export interface DeclarativeOptions<TProviderInput, TProviderOutput, TChunk> extends Omit<
  AdapterOptions<TProviderInput, TProviderOutput, TChunk>,
  "mapChunk"
> {
  /**
   * Declarative chunk mapping.
   * Alternative to mapChunk for simple cases.
   */
  chunkMapping: ChunkMapping<TChunk>;
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an adapter with the simplest possible API.
 *
 * This is the recommended way to create model adapters. It wraps createLanguageModel
 * with sensible defaults:
 * - Uses StreamAccumulator for stream handling (no manual accumulation)
 * - Uses default fromEngineState/toEngineState (standard transformations)
 * - Automatically generates StreamEvents from AdapterDeltas
 * - Supports model-specific messageTransformation config
 *
 * @example
 * ```typescript
 * import { createAdapter, StopReason, extractAdapterOptions } from '@tentickle/core/model';
 * import { openai } from '@ai-sdk/openai';
 *
 * const model = createAdapter({
 *   metadata: {
 *     id: 'ai-sdk:gpt-4',
 *     provider: 'ai-sdk',
 *     capabilities: [
 *       { stream: true, toolCalls: true },
 *       {
 *         // Model-specific transformation config
 *         messageTransformation: (modelId, provider) => ({
 *           preferredRenderer: 'markdown',
 *           roleMapping: {
 *             event: modelId.includes('gpt-4') ? 'developer' : 'user',
 *             ephemeral: modelId.includes('gpt-4') ? 'developer' : 'user',
 *           },
 *         }),
 *       },
 *     ],
 *   },
 *
 *   prepareInput: (input) => {
 *     const opts = extractAdapterOptions('ai-sdk', 'openai', input);
 *     return {
 *       model: openai('gpt-4'),
 *       messages: toAiSdkMessages(input.messages),
 *       tools: convertToolsToToolSet(input.tools),
 *       ...opts.library,
 *       providerOptions: { openai: opts.provider },
 *     };
 *   },
 *
 *   mapChunk: (chunk) => {
 *     switch (chunk.type) {
 *       case 'text-delta': return { type: 'text', delta: chunk.text };
 *       case 'reasoning-delta': return { type: 'reasoning', delta: chunk.text };
 *       case 'tool-call': return { type: 'tool_call', id: chunk.toolCallId, name: chunk.toolName, input: chunk.args };
 *       case 'finish': return { type: 'message_end', stopReason: StopReason.STOP, usage: chunk.totalUsage };
 *       default: return null;
 *     }
 *   },
 *
 *   execute: (input) => generateText(input),
 *   executeStream: (input) => streamText(input).fullStream,
 * });
 * ```
 */
/**
 * Event ID counter for generating unique event IDs
 */
let adapterEventIdCounter = 0;

function generateAdapterEventId(): string {
  return `aevt_${Date.now()}_${++adapterEventIdCounter}`;
}

function createAdapterEventBase(): StreamEventBase {
  return {
    id: generateAdapterEventId(),
    sequence: 0, // Placeholder - session.emitEvent assigns actual sequence
    tick: 1,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create an adapter using StreamAccumulator for clean streaming.
 *
 * This is the recommended way to create model adapters. StreamAccumulator
 * handles all the complexity of converting AdapterDeltas to StreamEvents
 * with proper lifecycle management.
 *
 * Returns a ModelClass that can be used:
 * - As a JSX component: `<model temperature={0.9}><MyAgent /></model>`
 * - With createApp: `createApp(Agent, { model })`
 * - For direct calls: `await model.generate(input)`
 */
export function createAdapter<TProviderInput, TProviderOutput, TChunk>(
  options: AdapterOptions<TProviderInput, TProviderOutput, TChunk>,
): ModelClass {
  const {
    metadata,
    prepareInput,
    mapChunk,
    execute,
    executeStream,
    processOutput,
    extractMetadata,
    reconstructRaw,
    onMount: adapterOnMount,
    onUnmount: adapterOnUnmount,
  } = options;

  // Create generate procedure
  const generate = createEngineProcedure<(input: ModelInput) => Promise<ModelOutput>>(
    {
      name: "model:generate",
      metadata: {
        type: "model",
        id: metadata.id,
        operation: "generate",
      },
      executionBoundary: "child",
      executionType: "model",
    },
    async (input: ModelInput) => {
      const providerInput = await prepareInput(input);

      // Emit event with the provider-formatted input (for DevTools debugging)
      Context.emit("model:provider_request", {
        modelId: metadata.id,
        provider: metadata.provider,
        providerInput,
      });

      const providerOutput = await execute(providerInput);

      // Emit event with the raw provider response (for DevTools debugging)
      Context.emit("model:provider_response", {
        modelId: metadata.id,
        provider: metadata.provider,
        providerOutput,
      });

      // Use processOutput if provided, otherwise we need streaming
      if (processOutput) {
        return processOutput(providerOutput);
      }

      // Fallback: convert provider output to ModelOutput
      // This is a simplified fallback - adapters should provide processOutput
      return {
        model: metadata.id,
        createdAt: new Date().toISOString(),
        message: { role: "assistant", content: [] },
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        stopReason: "unspecified",
        raw: providerOutput,
      } as ModelOutput;
    },
  );

  // Create stream procedure using StreamAccumulator
  const stream = executeStream
    ? createEngineProcedure<(input: ModelInput) => AsyncIterable<StreamEvent>>(
        {
          name: "model:stream",
          metadata: {
            type: "model",
            id: metadata.id,
            operation: "stream",
          },
          handleFactory: false, // Stream procedures return async generators
          executionBoundary: "child",
          executionType: "model",
        },
        async function* (input: ModelInput): AsyncIterable<StreamEvent> {
          const providerInput = await prepareInput(input);

          // Emit event with the provider-formatted input (for DevTools debugging)
          Context.emit("model:provider_request", {
            modelId: metadata.id,
            provider: metadata.provider,
            providerInput,
          });

          // Use StreamAccumulator for clean lifecycle management
          const accumulator = new StreamAccumulator({ modelId: metadata.id });
          const rawChunks: TChunk[] = [];

          for await (const chunk of executeStream(providerInput)) {
            rawChunks.push(chunk);

            // Extract metadata if hook provided
            if (extractMetadata) {
              const contentMetadata = extractMetadata(chunk, {
                text: accumulator.getText(),
                reasoning: accumulator.getReasoning(),
              });
              if (contentMetadata) {
                const metadataEvents = accumulator.push({
                  type: "content_metadata",
                  metadata: contentMetadata,
                });
                for (const event of metadataEvents) {
                  yield event;
                }
              }
            }

            // Map chunk to AdapterDelta and push to accumulator
            const delta = mapChunk(chunk);
            if (delta) {
              const events = accumulator.push(delta);
              for (const event of events) {
                yield event;
              }
            }
          }

          // Get final accumulated output
          const accumulatedOutput = accumulator.toModelOutput();

          // Reconstruct raw provider response if adapter provides reconstructRaw
          const rawResponse = reconstructRaw
            ? reconstructRaw({
                text: accumulatedOutput.raw?.text || "",
                reasoning: accumulatedOutput.raw?.reasoning || "",
                toolCalls: accumulatedOutput.toolCalls || [],
                usage: accumulatedOutput.usage,
                stopReason: accumulatedOutput.stopReason,
                model: accumulatedOutput.model,
                chunks: rawChunks,
              })
            : undefined;

          // Build final message content
          const content: ContentBlock[] = [];
          if (accumulatedOutput.raw?.reasoning) {
            content.push({
              type: "reasoning",
              text: accumulatedOutput.raw.reasoning,
            } as ContentBlock);
          }
          if (accumulatedOutput.raw?.text) {
            content.push({ type: "text", text: accumulatedOutput.raw.text });
          }
          if (accumulatedOutput.toolCalls) {
            for (const tc of accumulatedOutput.toolCalls) {
              content.push({
                type: "tool_use",
                toolUseId: tc.id,
                name: tc.name,
                input: tc.input,
              } as ContentBlock);
            }
          }

          // Yield final message event with all accumulated data
          const messageEvent: MessageEvent & { raw?: unknown } = {
            type: "message",
            ...createAdapterEventBase(),
            message: {
              role: "assistant" as const,
              content,
            },
            stopReason: accumulatedOutput.stopReason,
            usage: accumulatedOutput.usage,
            model: accumulatedOutput.model,
            startedAt: accumulatedOutput.createdAt,
            completedAt: new Date().toISOString(),
            raw: rawResponse,
          };

          yield messageEvent;
        },
      )
    : undefined;

  // Default fromEngineState using model metadata for transformation config
  const defaultFromEngineState = async (input: COMInput): Promise<ModelInput> => {
    const modelInstance = { metadata } as any;
    return fromEngineState(input, undefined, modelInstance) as Promise<ModelInput>;
  };

  // Build the EngineModel properties
  const engineModel: EngineModel<ModelInput, ModelOutput> = {
    metadata,
    generate,
    stream,
    fromEngineState: options.fromEngineState
      ? async (input: COMInput) => options.fromEngineState!(input)
      : defaultFromEngineState,
    toEngineState: options.toEngineState
      ? async (output: ModelOutput) => options.toEngineState!(output)
      : (output: ModelOutput) => toEngineState(output),
    getProviderInput: async (input: ModelInput) => prepareInput(input),
  };

  // Create functional component that wraps <Model>
  const ModelComponent = function ModelComponent(props: ModelClassProps): React.ReactElement {
    const { children, onMount: propsOnMount, onUnmount: propsOnUnmount, ...modelOptions } = props;

    // Merge lifecycle hooks: props override adapter defaults
    const onMount = propsOnMount ?? adapterOnMount;
    const onUnmount = propsOnUnmount ?? adapterOnUnmount;

    return React.createElement(
      Model,
      {
        model: engineModel,
        onMount,
        onUnmount,
        ...modelOptions,
      },
      children,
    );
  };

  // Set display name for React DevTools
  ModelComponent.displayName = `Model(${metadata.id})`;

  // Attach EngineModel properties to make it a valid ModelClass
  (ModelComponent as any).metadata = metadata;
  (ModelComponent as any).generate = generate;
  (ModelComponent as any).stream = stream;
  (ModelComponent as any).fromEngineState = engineModel.fromEngineState;
  (ModelComponent as any).toEngineState = engineModel.toEngineState;
  (ModelComponent as any).getProviderInput = engineModel.getProviderInput;

  return ModelComponent as unknown as ModelClass;
}

/**
 * Create an adapter using declarative chunk mapping.
 *
 * This is even simpler than createAdapter for cases where
 * chunk mapping can be expressed declaratively.
 *
 * @example
 * ```typescript
 * const model = createDeclarativeAdapter({
 *   metadata: { id: 'my-model', ... },
 *   prepareInput: (input) => ({ ... }),
 *   execute: (input) => provider.call(input),
 *   executeStream: (input) => provider.stream(input),
 *   chunkMapping: {
 *     text: { type: 'text-delta', extract: (c) => c.text },
 *     toolCall: { type: 'tool-call', extract: (c) => ({ id: c.id, name: c.name, input: c.args }) },
 *     messageEnd: { type: 'finish', extract: (c) => ({ stopReason: StopReason.STOP }) },
 *   },
 * });
 * ```
 */
export function createDeclarativeAdapter<
  TProviderInput,
  TProviderOutput,
  TChunk extends { type: string },
>(options: DeclarativeOptions<TProviderInput, TProviderOutput, TChunk>): ModelClass {
  const { chunkMapping, ...rest } = options;
  const mapChunk = createChunkMapper(chunkMapping);

  return createAdapter({
    ...rest,
    mapChunk,
  });
}
