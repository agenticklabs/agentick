/**
 * Model Types
 *
 * Platform-independent types for model input/output and configuration.
 * Used by both backend (@agentick/core) and frontend (@agentick/client) for direct model execution.
 *
 * These are simplified versions that exclude backend-specific adapter concerns.
 * Backend extends these with providerOptions, libraryOptions, ephemeralConfig, etc.
 */

import type { Message } from "./messages.js";
import type { StopReason } from "./streaming.js";
import type { ToolCall, ToolDefinition } from "./tools.js";

// ============================================================================
// Response Format
// ============================================================================

/**
 * Normalized response format across providers.
 *
 * - `text`: Free-form text (default behavior, no constraint).
 * - `json`: JSON output (provider ensures valid JSON).
 * - `json_schema`: Structured output conforming to a JSON Schema.
 *   Users call `zodToJsonSchema()` themselves if using Zod.
 */
export type ResponseFormat =
  | { type: "text" }
  | { type: "json" }
  | { type: "json_schema"; schema: Record<string, unknown>; name?: string };

// ============================================================================
// Model Tool Reference
// ============================================================================

/**
 * Reference to a tool that can be used with a model.
 * Can be a string (tool name/id), ToolDefinition, or ClientToolDefinition.
 */
export type ModelToolReference = string | ToolDefinition;

// ============================================================================
// Model Input (Simplified)
// ============================================================================

/**
 * Model input - simplified platform-independent structure.
 *
 * Used for direct model execution from clients.
 * Backend extends this with providerOptions, libraryOptions, messageTransformation, etc.
 */
export interface ModelInput {
  /**
   * Model identifier (e.g., 'gpt-4', 'claude-3-5-sonnet')
   */
  model?: string;

  /**
   * Conversation messages
   */
  messages: string | string[] | Message[];

  /**
   * System prompt (optional)
   */
  system?: string;

  /**
   * Generation parameters
   */
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];

  /**
   * Tool references
   */
  tools?: ModelToolReference[];

  /**
   * Response format constraint.
   */
  responseFormat?: ResponseFormat;

  /**
   * Whether to stream the response
   */
  stream?: boolean;
}

// ============================================================================
// Token Usage
// ============================================================================

/**
 * Token usage information (normalized across providers).
 *
 * Used in ModelOutput, stream events, and execution metrics.
 */
export interface UsageStats {
  /** Input tokens consumed */
  inputTokens: number;

  /** Output tokens generated */
  outputTokens: number;

  /** Total tokens (input + output) */
  totalTokens: number;

  /** Reasoning/thinking tokens (Anthropic extended thinking, OpenAI o1) */
  reasoningTokens?: number;

  /** Tokens read from cache (Anthropic prompt caching) */
  cachedInputTokens?: number;

  /** Tokens used to create cache (Anthropic prompt caching) */
  cacheCreationTokens?: number;

  /** Number of ticks executed (engine-level, optional for model usage) */
  ticks?: number;
}

// ============================================================================
// Model Output (Simplified)
// ============================================================================

/**
 * Model output - simplified platform-independent structure.
 *
 * Used for direct model execution from clients.
 * Backend extends this with raw provider response, cacheId, etc.
 */
export interface ModelOutput {
  /**
   * Generation metadata
   */
  model: string;
  createdAt: string;

  /**
   * All messages from this model call.
   * May contain multiple messages for multi-step execution or provider-executed tools.
   * For single-turn responses, this will typically contain one assistant message.
   */
  messages?: Message[];

  /**
   * Convenience accessor for the primary assistant message.
   * When `messages` is provided, this is the last assistant-role message.
   * When `messages` is not provided, this is the single generated message.
   *
   * Use `messages` array for full conversation history or multi-message responses.
   */
  message?: Message;

  /**
   * Why generation stopped
   */
  stopReason: StopReason;

  /**
   * Token usage
   */
  usage: UsageStats;

  /**
   * Tool calls made by the model
   */
  toolCalls?: ToolCall[];
}

// ============================================================================
// Model Config (Simplified)
// ============================================================================

/**
 * Model configuration - simplified platform-independent structure.
 *
 * Used for model instance configuration from clients.
 * Backend extends this with providerOptions, messageTransformation, etc.
 */
export interface ModelConfig {
  /**
   * Model instance identifier
   */
  id?: string;

  /**
   * Model instance name
   */
  name?: string;

  /**
   * Model identifier (e.g., 'gpt-4', 'claude-3-5-sonnet')
   */
  model?: string;

  /**
   * Generation parameters
   */
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];

  /**
   * Tool references
   */
  tools?: ModelToolReference[];

  /**
   * Response format constraint.
   */
  responseFormat?: ResponseFormat;
}
