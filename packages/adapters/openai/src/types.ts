import type { OpenAI } from "openai";
import { type ClientOptions } from "openai";
import { type ProviderClientOptions } from "@agentick/core";
import type { CustomBlockDefinition, DeltaTransformInput } from "@agentick/core/model";
import { StopReason } from "@agentick/shared";

/**
 * OpenAI adapter configuration.
 * Used when creating the OpenAI adapter instance.
 */
export interface OpenAIAdapterConfig extends ClientOptions {
  model?: string; // Default model to use if not specified in ModelInput
  apiKey?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
  headers?: Record<string, string>;
  timeout?: number;
  maxRetries?: number;
  client?: OpenAI;
  providerOptions?: ProviderClientOptions;
  /** Parse `<think>...</think>` tags in content as reasoning blocks (for local models) */
  parseThinkTags?: boolean;
  /** Auto-discover models via `/v1/models` endpoint and register metadata */
  discoverModels?: boolean;
  /** Custom blocks to intercept from model output. Forwarded to createAdapter. */
  customBlocks?: Record<string, CustomBlockDefinition>;
  /** User-facing delta transform. Forwarded to createAdapter. */
  deltaTransform?: DeltaTransformInput;
  /** Embedding model name (enables `.embed()` on the returned ModelClass) */
  embeddingModel?: string;
  [key: string]: unknown;
}

/**
 * OpenAI-specific generation options.
 * Used for chat completion calls and other operations.
 * Extends OpenAI's ChatCompletionCreateParams to allow provider-specific overrides.
 */
export type OpenAIGenerationOptions =
  Partial<OpenAI.Chat.Completions.ChatCompletionCreateParams> & {
    [key: string]: unknown;
  };

/**
 * OpenAI-specific tool options.
 * Can override or extend the base OpenAI tool definition.
 */
export interface OpenAIToolOptions {
  type?: "function" | "code_interpreter" | "file_search";
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Module augmentation: Extend provider option interfaces to include OpenAI-specific options.
 */
declare module "@agentick/core" {
  interface ProviderClientOptions {
    openai?: OpenAIAdapterConfig;
  }

  interface ProviderGenerationOptions {
    openai?: OpenAIGenerationOptions;
  }

  interface ProviderToolOptions {
    openai?: OpenAIToolOptions;
  }
}

export const STOP_REASON_MAP: Record<string, StopReason> = {
  stop: StopReason.STOP,
  length: StopReason.MAX_TOKENS,
  content_filter: StopReason.CONTENT_FILTER,
  tool_calls: StopReason.TOOL_USE,
  function_call: StopReason.FUNCTION_CALL,
};
