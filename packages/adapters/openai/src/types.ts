import type { OpenAI } from "openai";
import { type ClientOptions } from "openai";
import { type ProviderClientOptions } from "@tentickle/core";
import { StopReason } from "@tentickle/shared";

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
declare module "@tentickle/core" {
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
