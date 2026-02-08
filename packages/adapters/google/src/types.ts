import type { GoogleGenAI } from "@google/genai";
import { type GenerateContentParameters } from "@google/genai";
import { type ProviderClientOptions } from "@agentick/core";
import { StopReason } from "@agentick/shared";

/**
 * Google-specific client initialization options.
 */
export interface GoogleClientOptions {
  apiKey?: string;
  vertexai?: boolean;
  project?: string;
  location?: string;
  timeout?: number;
  baseUrl?: string;
  googleAuthOptions?: {
    keyFilename?: string;
    keyFile?: string;
    credentials?: any;
    clientOptions?: any;
    scopes?: string[];
    projectId?: string;
    universeDomain?: string;
  };
  [key: string]: unknown;
}

/**
 * Google-specific generation options.
 */
export type GoogleGenerationOptions = Partial<GenerateContentParameters> & {
  [key: string]: unknown;
};

/**
 * Google-specific tool options.
 */
export interface GoogleToolOptions {
  functionDeclarations?: Array<{
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/**
 * Module augmentation: Extend provider option interfaces to include Google-specific options.
 */
declare module "@agentick/core" {
  interface ProviderClientOptions {
    google?: GoogleClientOptions;
  }

  interface ProviderGenerationOptions {
    google?: GoogleGenerationOptions;
  }

  interface ProviderToolOptions {
    google?: GoogleToolOptions;
  }
}

export interface GoogleAdapterConfig {
  apiKey?: string;
  vertexai?: boolean;
  project?: string;
  location?: string;
  timeout?: number;
  baseUrl?: string;
  googleAuthOptions?: GoogleClientOptions["googleAuthOptions"];
  model?: string; // Default model to use if not specified in ModelInput
  client?: GoogleGenAI;
  providerOptions?: ProviderClientOptions;
}

/**
 * Map Google FinishReason enum values to normalized StopReason.
 *
 * Google FinishReason values (from @google/genai):
 * - FINISH_REASON_UNSPECIFIED: Default/unused value
 * - STOP: Natural stop or provided stop sequence
 * - MAX_TOKENS: Maximum token limit reached
 * - SAFETY: Flagged for safety reasons
 * - RECITATION: Flagged for recitation
 * - LANGUAGE: Unsupported language
 * - OTHER: Unknown reason
 * - BLOCKLIST: Contains forbidden terms
 * - PROHIBITED_CONTENT: Potentially prohibited content
 * - SPII: Sensitive Personally Identifiable Information
 * - MALFORMED_FUNCTION_CALL: Invalid function call
 * - IMAGE_SAFETY/IMAGE_PROHIBITED_CONTENT/IMAGE_OTHER/NO_IMAGE/IMAGE_RECITATION: Image-related stops
 * - UNEXPECTED_TOOL_CALL: Tool call when no tools enabled
 * - TOO_MANY_TOOL_CALLS: Consecutive tool call limit exceeded
 * - MISSING_THOUGHT_SIGNATURE: Missing thought signature
 */
export const STOP_REASON_MAP: Record<string, StopReason> = {
  // Core stop reasons
  FINISH_REASON_UNSPECIFIED: StopReason.UNSPECIFIED,
  STOP: StopReason.STOP,
  MAX_TOKENS: StopReason.MAX_TOKENS,

  // Safety and content filtering
  SAFETY: StopReason.CONTENT_FILTER,
  RECITATION: StopReason.CONTENT_FILTER,
  LANGUAGE: StopReason.CONTENT_FILTER,
  BLOCKLIST: StopReason.CONTENT_FILTER,
  PROHIBITED_CONTENT: StopReason.CONTENT_FILTER,
  SPII: StopReason.CONTENT_FILTER,

  // Tool/function call related
  MALFORMED_FUNCTION_CALL: StopReason.FORMAT_ERROR,
  UNEXPECTED_TOOL_CALL: StopReason.ERROR,
  TOO_MANY_TOOL_CALLS: StopReason.ERROR,

  // Image generation related
  IMAGE_SAFETY: StopReason.CONTENT_FILTER,
  IMAGE_PROHIBITED_CONTENT: StopReason.CONTENT_FILTER,
  IMAGE_OTHER: StopReason.OTHER,
  NO_IMAGE: StopReason.NO_CONTENT,
  IMAGE_RECITATION: StopReason.CONTENT_FILTER,

  // Other
  OTHER: StopReason.OTHER,
  MISSING_THOUGHT_SIGNATURE: StopReason.ERROR,
};
