import type Anthropic from "@anthropic-ai/sdk";
import { type ProviderClientOptions } from "@agentick/core";
import type { CustomBlockDefinition, DeltaTransformInput } from "@agentick/core/model";
import { StopReason } from "@agentick/shared";

/**
 * Anthropic adapter configuration.
 * Used when creating the Anthropic adapter instance.
 */
export interface AnthropicAdapterConfig {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  timeout?: number;
  maxRetries?: number;
  maxTokens?: number;
  client?: Anthropic;
  providerOptions?: ProviderClientOptions;
  /** Custom blocks to intercept from model output. Forwarded to createAdapter. */
  customBlocks?: Record<string, CustomBlockDefinition>;
  /** User-facing delta transform. Forwarded to createAdapter. */
  deltaTransform?: DeltaTransformInput;
  [key: string]: unknown;
}

/**
 * Anthropic-specific generation options.
 * Used for message creation calls and other operations.
 */
export type AnthropicGenerationOptions = Partial<Anthropic.MessageCreateParams> & {
  [key: string]: unknown;
};

/**
 * Anthropic-specific tool options.
 * Can override or extend the base Anthropic tool definition.
 */
export interface AnthropicToolOptions {
  name?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Module augmentation: Extend provider option interfaces to include Anthropic-specific options.
 */
declare module "@agentick/core" {
  interface ProviderClientOptions {
    anthropic?: AnthropicAdapterConfig;
  }

  interface ProviderGenerationOptions {
    anthropic?: AnthropicGenerationOptions;
  }

  interface ProviderToolOptions {
    anthropic?: AnthropicToolOptions;
  }
}

/**
 * Map Anthropic stop_reason values to normalized StopReason.
 *
 * Anthropic stop_reason values:
 * - end_turn: Natural stop (model finished generating)
 * - max_tokens: Maximum token limit reached
 * - stop_sequence: A stop sequence was encountered
 * - tool_use: Model wants to use a tool
 */
export const STOP_REASON_MAP: Record<string, StopReason> = {
  end_turn: StopReason.STOP,
  max_tokens: StopReason.MAX_TOKENS,
  stop_sequence: StopReason.STOP,
  tool_use: StopReason.TOOL_USE,
};
