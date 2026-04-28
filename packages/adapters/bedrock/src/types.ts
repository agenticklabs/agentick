import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { type ProviderClientOptions } from "@agentick/core";
import type { CustomBlockDefinition, DeltaTransformInput } from "@agentick/core/model";
import { StopReason } from "@agentick/shared";

/**
 * AWS Bedrock adapter configuration.
 * Used when creating the Bedrock adapter instance.
 */
export interface BedrockAdapterConfig {
  /** Default model ID (e.g. "us.anthropic.claude-sonnet-4-20250514-v1:0") */
  model?: string;
  /** AWS region */
  region?: string;
  /** Explicit AWS credentials */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** AWS profile name (resolved by the SDK credential chain) */
  profile?: string;
  /** Pre-configured BedrockRuntimeClient instance */
  client?: BedrockRuntimeClient;
  /** Default max tokens for inference */
  maxTokens?: number;
  /** Custom blocks to intercept from model output. Forwarded to createAdapter. */
  customBlocks?: Record<string, CustomBlockDefinition>;
  /** User-facing delta transform. Forwarded to createAdapter. */
  deltaTransform?: DeltaTransformInput;
  /** Provider-level options */
  providerOptions?: ProviderClientOptions;
  [key: string]: unknown;
}

/**
 * Bedrock-specific generation options.
 * Passed via providerOptions.bedrock in ModelInput to override/extend ConverseCommand params.
 */
export type BedrockGenerationOptions = {
  /** Override model ID for this request */
  modelId?: string;
  /** Additional model request fields (provider-specific) */
  additionalModelRequestFields?: Record<string, unknown>;
  /** Guardrail configuration */
  guardrailConfig?: {
    guardrailIdentifier: string;
    guardrailVersion: string;
    trace?: "enabled" | "disabled";
  };
  [key: string]: unknown;
};

/**
 * Bedrock-specific tool options.
 */
export interface BedrockToolOptions {
  toolSpec?: {
    name?: string;
    description?: string;
    inputSchema?: { json: Record<string, unknown> };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Module augmentation: Extend provider option interfaces to include Bedrock-specific options.
 */
declare module "@agentick/core" {
  interface ProviderClientOptions {
    bedrock?: BedrockAdapterConfig;
  }

  interface ProviderGenerationOptions {
    bedrock?: BedrockGenerationOptions;
  }

  interface ProviderToolOptions {
    bedrock?: BedrockToolOptions;
  }
}

/**
 * Map Bedrock stop reasons to normalized StopReason.
 *
 * Bedrock ConverseStream/Converse stopReason values:
 * - end_turn: Natural end of generation
 * - max_tokens: Token limit reached
 * - stop_sequence: Stop sequence encountered
 * - tool_use: Model wants to call a tool
 * - content_filtered: Content was filtered
 * - guardrail_intervened: Guardrail blocked the response
 */
export const STOP_REASON_MAP: Record<string, StopReason> = {
  end_turn: StopReason.STOP,
  max_tokens: StopReason.MAX_TOKENS,
  stop_sequence: StopReason.STOP,
  tool_use: StopReason.TOOL_USE,
  content_filtered: StopReason.CONTENT_FILTER,
  guardrail_intervened: StopReason.CONTENT_FILTER,
};
