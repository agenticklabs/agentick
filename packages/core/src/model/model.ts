/**
 * Model System
 *
 * EngineModel is the primary interface for models in the engine.
 * Use createAdapter() from ./adapter.ts to create model adapters.
 */

import type { Procedure } from "@agentick/kernel";
import type {
  ModelInput as BaseModelInput,
  ModelOutput as BaseModelOutput,
  ModelConfig as BaseModelConfig,
  ModelToolReference as BaseModelToolReference,
} from "@agentick/shared/models";
import type { StreamEvent } from "@agentick/shared/streaming";
import type { Message } from "@agentick/shared/messages";
import type { COMInput, TokenEstimator } from "../com/types";
import type { EngineResponse } from "../engine/engine-response";
import type { EventBlock, TextBlock, ContentBlock } from "@agentick/shared";
import type {
  LibraryGenerationOptions,
  ProviderGenerationOptions,
  DelimiterConfig,
  EventBlockDelimiters,
} from "../types";
import type { ExecutableTool, ToolDefinition, ToolMetadata } from "../tool/tool";

export type { BaseModelToolReference, BaseModelConfig, BaseModelInput, BaseModelOutput };

// ============================================================================
// Core Interface
// ============================================================================

/**
 * EngineModel is the primary interface for models.
 * All models (created via createAdapter) conform to this interface.
 *
 * @example
 * ```typescript
 * import { createAdapter } from '@agentick/core/model';
 *
 * const model = createAdapter({
 *   metadata: { id: 'my-model', provider: 'my-provider', capabilities: [] },
 *   prepareInput: (input) => ({ ... }),
 *   mapChunk: (chunk) => ({ type: 'text', delta: chunk.text }),
 *   execute: (input) => provider.generate(input),
 *   executeStream: (input) => provider.stream(input),
 * });
 * ```
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

  /** Transform model input to provider-specific format (for DevTools visibility) */
  getProviderInput?: (input: TModelInput) => Promise<unknown>;
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

// ============================================================================
// Configuration Types
// ============================================================================

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

  /** Context window size in tokens (adapter-provided takes precedence over catalog) */
  contextWindow?: number;
  /** Maximum output tokens per response */
  maxOutputTokens?: number;
  /** Whether the model supports vision/image input */
  supportsVision?: boolean;
  /** Whether the model supports tool/function calling */
  supportsToolUse?: boolean;
  /** Whether the model supports structured output via JSON schema */
  supportsStructuredOutput?: boolean;
  /** Whether this is a reasoning model (extended thinking) */
  isReasoningModel?: boolean;

  /** Token estimator function (e.g., tiktoken). If provided, used instead of default char/4 heuristic. */
  tokenEstimator?: TokenEstimator;
}

/**
 * Model input (normalized across all providers)
 *
 * Extends the base ModelInput from @agentick/shared with backend-specific fields.
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
 * Extends the base ModelOutput from @agentick/shared with backend-specific fields.
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

// StreamEvent types are exported from '@agentick/shared/streaming'

export type ModelToolReference =
  | BaseModelToolReference
  | ToolDefinition
  | ToolMetadata
  | ExecutableTool;

export interface NormalizedModelTool {
  id: string;
  metadata: ToolMetadata;
}

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
 * Extends the base ModelConfig from @agentick/shared with backend-specific fields.
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
