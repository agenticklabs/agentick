/**
 * Adapter - The recommended way to create model adapters
 *
 * This provides a clean API for creating adapters while preserving
 * all framework features (streaming, metadata, model-specific defaults, options merging).
 *
 * ## Why createAdapter?
 *
 * Creating adapters is one of the most common tasks when extending Agentick.
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
 * import { createAdapter, StopReason } from '@agentick/core/model';
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
 * @module agentick/model/adapter
 */

import React from "react";
import type { COMInput } from "../com/types.js";
import type { EngineResponse } from "../engine/engine-response.js";
import type { EngineModel, ModelInput, ModelOutput, ModelMetadata } from "./model.js";
import { createEngineProcedure } from "../procedure/index.js";
import {
  StreamAccumulator,
  type AdapterDelta,
  type ChunkMapping,
  createChunkMapper,
} from "./stream-accumulator.js";
import type {
  StreamEvent,
  ContentMetadata,
  MessageEvent,
  StreamEventBase,
} from "@agentick/shared/streaming";
import type { ContentBlock, Message } from "@agentick/shared";
import { fromEngineState, toEngineState } from "./utils/language-model.js";
import type { LibraryGenerationOptions, ProviderGenerationOptions } from "../types.js";
import type { EmbedInput, EmbedResult } from "@agentick/shared";
import { Model } from "../jsx/components/model.js";
import { StreamTagParser, type StreamTagHandler } from "./stream-tag-parser.js";

// ============================================================================
// Re-exports for adapter convenience
// ============================================================================

export { StopReason } from "@agentick/shared";
export type { AdapterDelta, ChunkMapping } from "./stream-accumulator.js";
export { createChunkMapper } from "./stream-accumulator.js";

// ============================================================================
// ModelClass - Unified model type (component + adapter)
// ============================================================================

import type { COM } from "../com/object-model.js";
import type { ModelConfig as SharedModelConfig, UsageStats } from "@agentick/shared/models";

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
  mapChunk: (chunk: TChunk) => AdapterDelta | AdapterDelta[] | null;

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
    toolCalls: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
      providerMetadata?: Record<string, Record<string, unknown>>;
    }>;
    usage: UsageStats;
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

  /**
   * Optional embedding function.
   * When provided, the returned ModelClass will support `embed()` for generating embeddings.
   * This allows a single adapter to support both text generation and embedding.
   */
  embed?: (input: EmbedInput) => Promise<EmbedResult>;

  /**
   * Custom blocks to intercept from the model's text output.
   *
   * Keys are semantic names used in application code. Each definition
   * specifies what XML tag to intercept and how to handle the block.
   *
   * Internally creates a StreamTagParser + CustomBlockTransform pipeline,
   * composed before any user-provided deltaTransform.
   *
   * @example
   * ```typescript
   * createAdapter({
   *   customBlocks: {
   *     interpretation: {
   *       transform(block) {
   *         return [{ type: "text", delta: `[${block.content}]` }];
   *       },
   *     },
   *     done: { transform() { return []; } },
   *     "debug-info": {},
   *   },
   * });
   * ```
   */
  customBlocks?: Record<string, CustomBlockDefinition>;

  /**
   * Adapter-internal delta transform(s), applied FIRST in the pipeline.
   *
   * Runs before custom blocks and before the user's deltaTransform. Use for
   * provider-specific stream cleanup (e.g., ThinkTagParser strips `<think>`
   * tags before custom blocks see the text).
   *
   * Pipeline order: adapterTransform → customBlocks → deltaTransform
   *
   * Accepts a single transform, an array, or a factory function.
   */
  adapterTransform?: DeltaTransformInput;

  /**
   * User-facing delta transform applied after custom blocks, before accumulation.
   *
   * Runs AFTER adapter transforms and custom blocks extraction. Use for
   * arbitrary stream manipulation (markdown buffering, content rewriting, etc.).
   *
   * Accepts a single transform, an array, or a factory function that returns
   * a fresh transform per stream call. Use a factory for stateful transforms
   * (parsers with buffers) so each stream gets clean state.
   *
   * @example
   * ```typescript
   * // Stateless transform — single instance is fine
   * createAdapter({ ...options, deltaTransform: myStatelessTransform });
   *
   * // Stateful transform — factory ensures fresh state per stream
   * createAdapter({ ...options, deltaTransform: () => new ThinkTagParser() });
   *
   * // Pipeline
   * createAdapter({
   *   ...options,
   *   deltaTransform: [transform1, transform2],
   * });
   * ```
   */
  deltaTransform?: DeltaTransformInput;
}

/**
 * A stateful transform that processes AdapterDeltas in the streaming pipeline.
 * Sits between mapChunk output and StreamAccumulator input.
 *
 * Transforms can be composed into pipelines via {@link composeDeltaTransforms}.
 */
export interface DeltaTransform {
  /** Process a delta, returning zero or more transformed deltas. */
  process(delta: AdapterDelta): AdapterDelta[];
  /** Flush any buffered content at stream end. */
  flush(): AdapterDelta[];
}

/** Factory that creates a fresh DeltaTransform per stream call. */
export type DeltaTransformFactory = () => DeltaTransform;

/** Accepted forms for the deltaTransform adapter option. */
export type DeltaTransformInput = DeltaTransform | DeltaTransformFactory | DeltaTransform[];

// ============================================================================
// Custom Blocks — First-class adapter config
// ============================================================================

/**
 * Input passed to a custom block's transform function.
 */
export interface CustomBlockInput {
  tag: string;
  content: string;
  attrs: Record<string, string>;
  selfClosing?: boolean;
}

/**
 * Definition for a custom block type.
 *
 * Custom blocks are XML-like tags in the model's text output that get
 * intercepted, stripped from text, and handled by the application.
 *
 * @example
 * ```typescript
 * createAdapter({
 *   customBlocks: {
 *     // Passthrough — accumulate as CustomContentBlock
 *     citation: {},
 *
 *     // Transform — rewrite into a text block
 *     interpretation: {
 *       transform(block) {
 *         return [{ type: "text", delta: `[${block.content}]` }];
 *       },
 *     },
 *
 *     // Suppress — consume as side effect only
 *     done: {
 *       transform() { setDone(true); return []; },
 *     },
 *
 *     // Override XML tag name
 *     debugInfo: {
 *       tag: "debug-info",  // intercepts <debug-info>, key is "debugInfo"
 *     },
 *   },
 * });
 * ```
 */
export interface CustomBlockDefinition {
  /**
   * XML tag to intercept in the text stream.
   * Defaults to the config key.
   */
  tag?: string;

  /**
   * Short description of what this block represents.
   * Appears in the auto-generated tag listing in the system prompt.
   *
   * When provided (alone or with `instructions`), the adapter automatically
   * appends block documentation to the system prompt.
   *
   * @example
   * ```typescript
   * customBlocks: {
   *   citation: {
   *     description: "A quoted passage from a source.",
   *   },
   * }
   * ```
   */
  description?: string;

  /**
   * Detailed usage instructions for the model.
   * Appended after the description in the system prompt.
   * Use for elaboration on when to use the block, constraints,
   * expected attributes, or examples.
   *
   * @example
   * ```typescript
   * customBlocks: {
   *   interpretation: {
   *     description: "Analytical insight derived from evidence.",
   *     instructions: "Use when synthesizing information or drawing conclusions from multiple sources. Do not use for direct observations.",
   *   },
   *   done: {
   *     description: "Signals task completion.",
   *     instructions: "Output <done/> only when the task is fully complete and no further action is needed.",
   *     transform() { return []; },
   *   },
   * }
   * ```
   */
  instructions?: string;

  /**
   * Transform the complete block before it enters the content array.
   *
   * - Return `void` → passthrough as CustomContentBlock (default)
   * - Return `AdapterDelta[]` → emit these instead (`[]` suppresses the block)
   */
  transform?(block: CustomBlockInput): AdapterDelta[] | void;

  /**
   * Called when the opening tag is found, before content arrives.
   * Side-effect only — does not affect output.
   */
  onStart?(attrs: Record<string, string>): void;
}

/**
 * DeltaTransform that applies per-tag transform functions from CustomBlockDefinitions.
 * Intercepts `custom_block` deltas, runs the tag's transform if defined,
 * and remaps the tag from XML name to semantic config key.
 */
class CustomBlockTransform implements DeltaTransform {
  private readonly defs: Map<string, { key: string; def: CustomBlockDefinition }>;

  constructor(config: Record<string, CustomBlockDefinition>) {
    this.defs = new Map();
    for (const [key, def] of Object.entries(config)) {
      const xmlTag = def.tag ?? key;
      this.defs.set(xmlTag, { key, def });
    }
  }

  process(delta: AdapterDelta): AdapterDelta[] {
    if (delta.type !== "custom_block") return [delta];

    const entry = this.defs.get(delta.tag);
    if (!entry) return [delta];

    const { key, def } = entry;

    // Remap tag from XML name to semantic config key
    const block: CustomBlockInput = {
      tag: key,
      content: delta.content,
      attrs: delta.attrs,
      selfClosing: delta.selfClosing,
    };

    if (def.transform) {
      const result = def.transform(block);
      if (result !== undefined) return result;
    }

    // Default: passthrough with remapped tag
    return [
      {
        ...delta,
        tag: key,
      },
    ];
  }

  flush(): AdapterDelta[] {
    return [];
  }
}

/**
 * Build StreamTagParser handlers from CustomBlockDefinitions.
 */
function buildTagHandlers(
  config: Record<string, CustomBlockDefinition>,
): Record<string, StreamTagHandler> {
  const handlers: Record<string, StreamTagHandler> = {};
  for (const [key, def] of Object.entries(config)) {
    const xmlTag = def.tag ?? key;
    handlers[xmlTag] = {
      onStart: def.onStart,
    };
  }
  return handlers;
}

/**
 * Build system prompt text from custom block descriptions and instructions.
 * Returns null if no blocks have description or instructions.
 */
function buildCustomBlockInstructions(
  config: Record<string, CustomBlockDefinition> | undefined,
): string | null {
  if (!config) return null;

  const lines: string[] = [];
  for (const [key, def] of Object.entries(config)) {
    if (!def.description && !def.instructions) continue;
    const xmlTag = def.tag ?? key;

    if (def.description && def.instructions) {
      lines.push(`- <${xmlTag}>: ${def.description}\n  ${def.instructions}`);
    } else {
      lines.push(`- <${xmlTag}>: ${def.description ?? def.instructions}`);
    }
  }

  if (lines.length === 0) return null;

  return `You can use the following XML tags in your output:\n${lines.join("\n")}`;
}

/**
 * Inject custom block instructions into the first system message.
 * If no system message exists, prepend one. System prompt is always first.
 * Mutates modelInput.messages in place.
 */
function injectCustomBlockInstructions(modelInput: ModelInput, instructions: string): void {
  const instructionBlock = { type: "text" as const, text: instructions };

  // Find the first system message
  for (let i = 0; i < modelInput.messages.length; i++) {
    if ((modelInput.messages[i] as Message).role === "system") {
      (modelInput.messages[i] as Message) = {
        ...(modelInput.messages[i] as Message),
        content: [...(modelInput.messages[i] as Message).content, instructionBlock],
      };
      return;
    }
  }

  // No system message — prepend one
  (modelInput.messages as Message[]).unshift({
    role: "system",
    content: [instructionBlock],
  });
}

/**
 * Compose multiple DeltaTransforms into a single pipeline.
 *
 * Each transform's output feeds the next transform's input.
 * On flush, each transform's buffered output cascades through
 * subsequent transforms before they flush their own state.
 *
 * @example
 * ```typescript
 * const pipeline = composeDeltaTransforms(
 *   thinkTagParser,     // strips <think> tags, emits reasoning
 *   customTagParser,    // strips app-specific tags, emits custom blocks
 *   markdownBufferer,   // coalesces text into render-friendly chunks
 * );
 *
 * createAdapter({ ...opts, deltaTransform: pipeline });
 * ```
 */
export function composeDeltaTransforms(...transforms: DeltaTransform[]): DeltaTransform {
  if (transforms.length === 0) {
    return { process: (d) => [d], flush: () => [] };
  }
  if (transforms.length === 1) return transforms[0];

  return {
    process(delta: AdapterDelta): AdapterDelta[] {
      let deltas = [delta];
      for (const t of transforms) {
        const next: AdapterDelta[] = [];
        for (const d of deltas) next.push(...t.process(d));
        deltas = next;
      }
      return deltas;
    },
    flush(): AdapterDelta[] {
      let pending: AdapterDelta[] = [];
      for (const t of transforms) {
        // Feed pending output from upstream flushes through this transform
        const processed: AdapterDelta[] = [];
        for (const d of pending) processed.push(...t.process(d));
        // Then flush this transform's own buffered state
        const flushed = t.flush();
        pending = [...processed, ...flushed];
      }
      return pending;
    },
  };
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
 * import { createAdapter, StopReason, extractAdapterOptions } from '@agentick/core/model';
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
    adapterTransform: rawAdapterTransform,
    deltaTransform: rawDeltaTransform,
    customBlocks: customBlockConfig,
    onMount: adapterOnMount,
    onUnmount: adapterOnUnmount,
  } = options;

  // Build a fresh delta transform pipeline per stream call.
  // Pipeline order: adapterTransform → customBlocks → deltaTransform
  // Transforms like StreamTagParser are stateful (buffers, mode) and must not
  // be shared across streams. Factory ensures clean state each time.
  const hasAdapterTransform = !!rawAdapterTransform;
  const hasCustomBlocks = customBlockConfig && Object.keys(customBlockConfig).length > 0;
  const hasDeltaTransform = !!rawDeltaTransform;

  function isDeltaTransform(t: DeltaTransformInput): t is DeltaTransform {
    return typeof t === "object" && !Array.isArray(t) && "process" in t;
  }

  function resolveTransformInput(input: DeltaTransformInput): DeltaTransform[] {
    if (Array.isArray(input)) return input;
    if (isDeltaTransform(input)) return [input];
    return [input()]; // factory
  }

  function createDeltaTransform(): DeltaTransform | undefined {
    const transforms: DeltaTransform[] = [];

    // 1. Adapter-internal transforms (provider-specific cleanup)
    if (hasAdapterTransform) {
      transforms.push(...resolveTransformInput(rawAdapterTransform!));
    }

    // 2. Custom blocks extraction (StreamTagParser + CustomBlockTransform)
    if (hasCustomBlocks) {
      transforms.push(new StreamTagParser({ tags: buildTagHandlers(customBlockConfig!) }));
      transforms.push(new CustomBlockTransform(customBlockConfig!));
    }

    // 3. User-provided delta transforms
    if (hasDeltaTransform) {
      transforms.push(...resolveTransformInput(rawDeltaTransform!));
    }

    return transforms.length > 0 ? composeDeltaTransforms(...transforms) : undefined;
  }

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
      const providerOutput = await execute(providerInput);

      // Use processOutput if provided, otherwise we need streaming
      const output: ModelOutput = processOutput
        ? await processOutput(providerOutput)
        : ({
            model: metadata.id,
            createdAt: new Date().toISOString(),
            message: { role: "assistant", content: [] },
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            stopReason: "unspecified",
            raw: providerOutput,
          } as ModelOutput);

      // Attach provider input for DevTools (session emits provider_request)
      (output as any)._providerInput = providerInput;
      return output;
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

          // Yield provider_request as a proper stream event (DevTools picks it up
          // via the session's event pipeline — no separate getProviderInput call needed)
          yield {
            ...createAdapterEventBase(),
            type: "provider_request" as const,
            modelId: metadata.id,
            provider: metadata.provider,
            providerInput,
          } satisfies StreamEvent;

          // Fresh transform + accumulator per stream call
          const deltaTransform = createDeltaTransform();
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

            // Map chunk to AdapterDelta(s), optionally transform, then push to accumulator
            const delta = mapChunk(chunk);
            if (delta) {
              const rawDeltas = Array.isArray(delta) ? delta : [delta];
              for (const d of rawDeltas) {
                const transformed = deltaTransform ? deltaTransform.process(d) : [d];
                for (const td of transformed) {
                  const events = accumulator.push(td);
                  for (const event of events) {
                    yield event;
                  }
                }
              }
            }
          }

          // Flush delta transform at stream end (e.g., partial tag buffers)
          if (deltaTransform) {
            for (const d of deltaTransform.flush()) {
              const events = accumulator.push(d);
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

          // Ensure message_end was emitted — some adapters (Google) may not
          // produce a separate message_end delta for tool-call-only responses.
          // The protocol requires message_start → ... → message_end → message.
          if (accumulator.messageStarted && !accumulator.messageEnded) {
            yield {
              type: "message_end",
              ...createAdapterEventBase(),
              stopReason: accumulatedOutput.stopReason,
              usage: accumulatedOutput.usage,
            } as any;
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

  // Build custom block instructions for system prompt injection
  const customBlockInstructions = buildCustomBlockInstructions(customBlockConfig);

  // Default fromEngineState using model metadata for transformation config
  const defaultFromEngineState = async (input: COMInput): Promise<ModelInput> => {
    const modelInstance = { metadata } as any;
    const modelInput = (await fromEngineState(input, undefined, modelInstance)) as ModelInput;

    if (customBlockInstructions) {
      injectCustomBlockInstructions(modelInput, customBlockInstructions);
    }

    return modelInput;
  };

  // Create embed procedure if provided
  const embed = options.embed
    ? createEngineProcedure<(input: EmbedInput) => Promise<EmbedResult>>(
        {
          name: "model:embed",
          metadata: {
            model: metadata.model ?? metadata.id,
            provider: metadata.provider,
          },
        },
        async (input) => options.embed!(input),
      )
    : undefined;

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
    embed,
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
  if (embed) {
    (ModelComponent as any).embed = embed;
  }

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
