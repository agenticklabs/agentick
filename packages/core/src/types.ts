/**
 * Model Plugin Types
 *
 * Defines types for AI model components (generation, streaming, tool calling)
 *
 * ## Provider Options Architecture
 *
 * The engine supports three levels of provider-specific options, each with its own interface
 * that can be extended via module augmentation:
 *
 * 1. **ProviderClientOptions** - Client initialization options
 *    - Used when creating the underlying provider client (OpenAI, GoogleGenAI, Anthropic, HuggingFace, etc.)
 *    - Passed to adapter constructors or factory functions
 *    - Examples: API keys, base URLs, organization IDs, timeout settings
 *
 * 2. **ProviderGenerationOptions** - Model generation/operation options
 *    - Used for model generation/streaming calls and other operations
 *    - Passed via `ModelInput.providerOptions`
 *    - Can include provider-specific parameters for generateImage, editImage, countTokens, etc.
 *    - Merged into provider-specific request parameters in adapter's `prepareInput()` method
 *
 * 3. **ProviderToolOptions** - Tool definition options
 *    - Used for tool definitions to customize how tools are presented to the provider
 *    - Passed via `ToolMetadata.providerOptions` or `ToolDefinition.providerOptions`
 *    - Allows provider-specific tool configuration (e.g., OpenAI's tool types, function descriptions)
 *    - Merged into provider-specific tool definitions in adapter's `prepareInput()` method
 *
 * Each adapter extends these interfaces using module augmentation:
 * ```typescript
 * declare module 'tentickle' {
 *   interface ProviderClientOptions {
 *     openai?: OpenAIClientOptions;
 *   }
 *   interface ProviderGenerationOptions {
 *     openai?: OpenAIGenerationOptions;
 *   }
 *   interface ProviderToolOptions {
 *     openai?: OpenAIToolOptions;
 *   }
 * }
 * ```
 */

import { type Message, type ContentBlock, type GeneratedImageBlock } from "@tentickle/shared";
import type { Procedure, UserContext } from "@tentickle/kernel";
import type { ProcedureGraph, ProcedureNode } from "@tentickle/kernel";
import type { ChannelService } from "./channels/service";
import type { ExecutionHandleImpl } from "./engine/execution-handle";
import type {
  // ExecutionType,
  ExecutionHandle as EngineExecutionHandle,
} from "./engine/execution-types";
import type { EventEmitter } from "node:events";
import type { ContextMetadata, ContextMetrics } from "@tentickle/kernel";

export interface EngineContextMetadata extends ContextMetadata {}

export interface EngineContextMetrics extends ContextMetrics {
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    cachedInputTokens: number;
    [key: string]: number;
  };
}

/**
 * Module augmentation: Extend KernelContext with Engine-specific properties.
 * This allows Engine to add fields to KernelContext without modifying Kernel types.
 * These fields are optional and only present when Engine is being used.
 *
 * Note: We cannot override executionHandle (it's EventEmitter in Kernel),
 * but in Engine code we know it's always ExecutionHandleImpl and use type guards/assertions.
 */
declare module "@tentickle/core" {
  interface KernelContext {
    // Note: executionType, executionId, and parentExecutionId are now first-class
    // fields in KernelContext (Phase 3). We only augment with Engine-specific fields.

    /**
     * Parent execution PID for child executions.
     * Set by Engine when creating child executions.
     */
    parentPid?: string;
    /**
     * Parent execution handle for child executions.
     * Set by Engine when creating child executions.
     */
    parentHandle?: EngineExecutionHandle;
  }
}

/**
 * EngineContext is KernelContext with Engine-specific augmentations.
 *
 * Unlike simple `extends KernelContext`, we explicitly redeclare all KernelContext
 * properties to ensure TypeScript properly recognizes them across package boundaries.
 * This avoids issues where module augmentation doesn't propagate correctly.
 *
 * Engine augments KernelContext via module augmentation to add:
 * - executionType, parentPid, parentHandle (for child executions)
 *
 * This interface narrows executionHandle from EventEmitter to ExecutionHandleImpl
 * for better type safety in Engine code. This is valid because ExecutionHandleImpl
 * extends EventEmitter, making it a subtype.
 */
export interface EngineContext {
  // ========================================
  // Core KernelContext properties (explicit redeclaration)
  // ========================================

  /** Unique request ID for this execution context */
  requestId: string;

  /** Trace ID for distributed tracing */
  traceId: string;

  /** User context information */
  user?: UserContext;

  /** Arbitrary metadata stored in the context */
  metadata: EngineContextMetadata;

  /** Metrics collected during execution */
  metrics: EngineContextMetrics;

  /** Global Request Bus for event emission */
  events: EventEmitter;

  /** Cancellation signal */
  signal?: AbortSignal;

  /**
   * Channel service for bidirectional communication (optional).
   * Injected by Engine when channels are configured.
   *
   * Provides access to:
   * - Router registry: `ctx.channels?.getRouter('channel-name')`
   * - Event dispatch: `ctx.channels?.handleEvent(...)`
   * - Transport: `ctx.channels?.getTransport()`
   * - Low-level methods: `publish()`, `subscribe()`, `waitForResponse()`
   */
  channels?: ChannelService;

  /**
   * Procedure graph for tracking procedure execution hierarchy.
   * Automatically initialized when first procedure is executed.
   */
  procedureGraph?: ProcedureGraph;

  /**
   * Current procedure PID (for tracking nested procedures).
   */
  procedurePid?: string;

  /** Current procedure node in the execution graph */
  procedureNode?: ProcedureNode;

  /**
   * Origin procedure node - the root procedure that initiated this execution chain.
   * Undefined for the root procedure itself (since it IS the origin).
   * Set automatically by ExecutionTracker when procedures are executed.
   */
  origin?: ProcedureNode;

  // ========================================
  // Execution Context (Phase 3)
  // ========================================

  /**
   * Current execution ID. Set when entering an execution boundary.
   * All procedures within this execution share this ID.
   */
  executionId?: string;

  /**
   * Type of execution at this boundary (e.g., 'engine', 'model', 'component_tool', 'harness').
   * Only meaningful at execution boundaries.
   */
  executionType?: string;

  /**
   * Parent execution ID for nested executions (e.g., component_tool called from engine).
   * Enables DevTools to show execution hierarchy.
   */
  parentExecutionId?: string;

  // ========================================
  // Engine-specific properties (from module augmentation)
  // ========================================

  /**
   * Parent execution PID for child executions.
   * Set by Engine when creating child executions.
   */
  parentPid?: string;

  /**
   * Parent execution handle for child executions.
   * Set by Engine when creating child executions.
   */
  parentHandle?: EngineExecutionHandle;

  // ========================================
  // Engine-specific narrowed types
  // ========================================

  /**
   * Execution handle narrowed to ExecutionHandleImpl (Engine's concrete implementation).
   * In Engine, executionHandle is always ExecutionHandleImpl, not just EventEmitter.
   */
  executionHandle?: ExecutionHandleImpl;
}

/**
 * Base interface for provider-specific client initialization options.
 * Used when creating the underlying provider client (OpenAI, GoogleGenAI, Anthropic, etc.).
 * Each adapter can extend this interface using module augmentation to add their provider key.
 *
 * Example:
 * ```typescript
 * declare module 'tentickle' {
 *   interface ProviderClientOptions {
 *     openai?: OpenAI.ClientOptions;
 *   }
 * }
 * ```
 */
export interface ProviderClientOptions {
  [provider: string]: any;
}

/**
 * Base interface for provider-specific generation options.
 * Used for model generation/streaming calls and other operations (generateImage, editImage, countTokens, etc.).
 * Each adapter can extend this interface using module augmentation to add their provider key.
 *
 * Example:
 * ```typescript
 * declare module 'tentickle' {
 *   interface ProviderGenerationOptions {
 *     openai?: Partial<OpenAI.Chat.Completions.ChatCompletionCreateParams>;
 *   }
 * }
 * ```
 */
export interface ProviderGenerationOptions {
  [provider: string]: any;
}

/**
 * Base interface for provider-specific tool options.
 * Used for tool definitions to customize how tools are presented to the provider.
 * Each adapter can extend this interface using module augmentation to add their provider key.
 *
 * Example:
 * ```typescript
 * declare module 'tentickle' {
 *   interface ProviderToolOptions {
 *     openai?: OpenAIToolOptions;
 *   }
 * }
 * ```
 */
export interface ProviderToolOptions {
  [provider: string]: any;
}

// ============================================================================
// Library Options (ai-sdk, langchain, llamaindex, etc.)
// ============================================================================
//
// Library options are distinct from provider options:
// - ProviderOptions: SDK-level params sent to the AI provider (OpenAI, Anthropic)
// - LibraryOptions: Library-level params consumed by the integration library runtime
//
// Library options mirror the three-level scope of provider options:
// 1. LibraryClientOptions - Client/adapter initialization
// 2. LibraryOperationOptions - Per-operation options
// 3. LibraryToolOptions - Tool-specific options
//
// Note: Many libraries have their own providerOptions concept. When both
// ModelInput.providerOptions AND libraryOptions[adapter].providerOptions are present,
// adapters should merge them (adapter's taking precedence).

/**
 * Base interface for library client initialization options.
 * Used when creating library adapter instances.
 * Each adapter package extends this interface using module augmentation.
 *
 * Example:
 * ```typescript
 * declare module 'tentickle' {
 *   interface LibraryClientOptions {
 *     'ai-sdk'?: {
 *       telemetry?: { isEnabled?: boolean };
 *     };
 *   }
 * }
 * ```
 */
export interface LibraryClientOptions {
  [library: string]: unknown;
}

/**
 * Base interface for library generation options.
 * Used for per-request library-specific configuration.
 * Passed via `ModelInput.libraryOptions`.
 * Each adapter package extends this interface using module augmentation.
 *
 * Example:
 * ```typescript
 * declare module 'tentickle' {
 *   interface LibraryGenerationOptions {
 *     'ai-sdk'?: {
 *       maxSteps?: number;
 *       experimental?: { toolCallStreaming?: boolean };
 *       providerOptions?: Record<string, unknown>;
 *     };
 *   }
 * }
 * ```
 */
export interface LibraryGenerationOptions {
  [library: string]: unknown;
}

/**
 * Base interface for library tool options.
 * Used for tool-specific library configuration.
 * Passed via `ToolMetadata.libraryOptions` or `ToolDefinition.libraryOptions`.
 * Each adapter package extends this interface using module augmentation.
 *
 * Example:
 * ```typescript
 * declare module 'tentickle' {
 *   interface LibraryToolOptions {
 *     'ai-sdk'?: {
 *       maxDuration?: number;
 *     };
 *     langchain?: {
 *       callbacks?: CallbackHandler[];
 *     };
 *   }
 * }
 * ```
 */
export interface LibraryToolOptions {
  [library: string]: unknown;
}

/**
 * @deprecated Use LibraryGenerationOptions instead. Alias for backwards compatibility.
 */
export type LibraryOptions = LibraryGenerationOptions;

/**
 * @deprecated Use MessageTransformationConfig from 'tentickle/model' instead.
 * This interface is kept temporarily for migration purposes.
 */
export interface EphemeralRoleConfig {
  /**
   * @deprecated Use MessageTransformationConfig.roleMapping.ephemeral instead
   */
  role?: "user" | "system";

  /**
   * @deprecated Use MessageTransformationConfig.delimiters.ephemeral instead
   */
  delimiter?: string | { start: string; end: string };

  /**
   * @deprecated Use MessageTransformationConfig.ephemeralPosition instead
   */
  position?: "flow" | "start" | "end" | "before-user" | "after-system";
}

/** Simple delimiter - string or start/end pair */
export type DelimiterConfig = string | { start: string; end: string };

/** Per-block-type delimiter configuration */
export interface EventBlockDelimiters {
  /** Delimiter for user_action blocks */
  user_action?: DelimiterConfig;
  /** Delimiter for system_event blocks */
  system_event?: DelimiterConfig;
  /** Delimiter for state_change blocks */
  state_change?: DelimiterConfig;
  /** Delimiter for text blocks (or any block type not specified) */
  default?: DelimiterConfig;
}

/** Event content block types (for formatter) */
import type { EventBlock, TextBlock } from "@tentickle/shared";

/**
 * @deprecated Use MessageTransformationConfig from 'tentickle/model' instead.
 * This interface is kept temporarily for migration purposes.
 */
export interface EventRoleConfig {
  /**
   * @deprecated Use MessageTransformationConfig.roleMapping.event instead
   */
  role?: "user" | "event";

  /**
   * @deprecated Use MessageTransformationConfig.delimiters.event instead
   */
  delimiter?: DelimiterConfig | EventBlockDelimiters;

  /**
   * @deprecated Use MessageTransformationConfig.formatBlock instead
   */
  formatBlock?: (block: EventBlock | TextBlock) => ContentBlock[];
}

// ToolExecutionType and ToolIntent are now exported from '@tentickle/shared'

/**
 * Tool execution configuration options.
 * Controls how tools are executed by the Engine.
 */
export interface ToolExecutionOptions {
  /**
   * Execute tools in parallel when possible.
   * When true (default), independent tool calls are executed concurrently.
   * Set to false for tools with side effects that must run sequentially.
   * @default true
   */
  parallel?: boolean;

  /**
   * Maximum number of concurrent tool executions when parallel is true.
   * @default 10
   */
  maxConcurrent?: number;

  /**
   * Default timeout for tool execution in milliseconds.
   * Can be overridden per-tool via tool definition.
   * @default 30000 (30 seconds)
   */
  defaultTimeoutMs?: number;

  /**
   * Whether to continue execution if a tool fails.
   * When true, failed tools return error results but don't stop the tick.
   * @default true
   */
  continueOnError?: boolean;
}

// StopReason is now exported from '@tentickle/shared'

// ============================================================================
// Engine Events
// ============================================================================

// ToolCall and ToolResult are now exported from '@tentickle/shared'
// StreamEvent and related unions are exported from './engine/engine-events'

// ============================================================================
// Image Generation
// ============================================================================

export interface ImageGenerationInput {
  messages: string | string[] | Message[];
  negative_prompt?: string;
  size?: ImageSize | string;
  quality?: ImageQuality;
  n?: number;
  style?: string;
  seed?: number;
  model?: string;
  outputType?: "url" | "blob";
  providerOptions?: Record<string, any>;
}

export interface ImageGenerationOutput {
  images: GeneratedImageBlock[];
  model: string;
  metadata: {
    createdAt: string;
    usage?: {
      imagesGenerated: number;
      creditsUsed?: number;
    };
  };
  raw: any;
}

export interface ImageEditInput extends ImageGenerationInput {
  image: ContentBlock; // Should be an ImageBlock
  referenceImages?: GeneratedImageBlock[];
  mask?: ContentBlock; // Should be an ImageBlock
}

export interface ImageVariationInput {
  image: ContentBlock; // Should be an ImageBlock
  n?: number;
  size?: ImageSize | string;
  model?: string;
  providerOptions?: Record<string, any>;
}

export enum ImageSize {
  SMALL = "256x256",
  MEDIUM = "512x512",
  LARGE = "1024x1024",
  EXTRA_LARGE = "2048x2048",
  SQUARE = "square",
  PORTRAIT = "portrait",
  LANDSCAPE = "landscape",
  AUTO = "auto",
}

export enum ImageQuality {
  STANDARD = "standard",
  HD = "hd",
  ULTRA_HD = "ultra_hd",
}

export enum ImageOperation {
  GENERATE = "generate",
  EDIT = "edit",
  VARIATION = "variation",
}

export interface ImageGenerationAdapter {
  generate: Procedure<(input: ImageGenerationInput) => ImageGenerationOutput>;
  edit?: Procedure<(input: ImageEditInput) => ImageGenerationOutput>;
  variation?: Procedure<(input: ImageVariationInput) => ImageGenerationOutput>;
}

// ============================================================================
// Embeddings
// ============================================================================

export interface EmbeddingInput {
  texts: string | string[] | ContentBlock[];
  model?: string;
  dimensions?: number;
  user?: string;
  encodingFormat?: "float" | "base64";
  providerOptions?: Record<string, any>;
}

export interface EmbeddingOutput {
  embeddings: number[][];
  model: string;
  usage?: {
    tokens: number;
    cost?: number;
  };
  raw: any;
}

export interface SimilarityInput {
  query: string;
  candidates: string[];
  model?: string;
  top_k?: number;
  threshold?: number;
}

export interface SimilarityResult {
  query: string;
  results: Array<{
    text: string;
    score: number;
    index: number;
  }>;
  model: string;
  raw: {
    query_embedding: number[];
    candidate_embeddings: number[][];
  };
}

export interface EmbeddingAdapter {
  embed: Procedure<(input: EmbeddingInput) => EmbeddingOutput>;
  similarity?: Procedure<(input: SimilarityInput) => SimilarityResult>;
}

// ============================================================================
// Utility Functions
// ============================================================================

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vectors must have same length");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function findSimilar(
  queryEmbedding: number[],
  candidateEmbeddings: number[][],
  candidates: string[],
  topK: number = 5,
  threshold?: number,
): Array<{ text: string; score: number; index: number }> {
  const similarities = candidateEmbeddings.map((embedding, index) => ({
    text: candidates[index],
    score: cosineSimilarity(queryEmbedding, embedding),
    index,
  }));

  similarities.sort((a, b) => b.score - a.score);

  const filtered = threshold ? similarities.filter((s) => s.score >= threshold) : similarities;

  return filtered.slice(0, topK);
}
