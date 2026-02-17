/**
 * Apple Foundation Models adapter configuration and types.
 */

import { StopReason } from "@agentick/shared";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Apple Foundation Models adapter configuration.
 */
export interface AppleAdapterConfig {
  /**
   * Path to the compiled Swift bridge executable.
   * Defaults to the binary compiled by the package's postinstall script.
   */
  bridgePath?: string;
  /** Model identifier (default: "apple-foundation-3b") */
  model?: string;
}

// ============================================================================
// Wire Protocol Types (match the Swift bridge's JSON)
// ============================================================================

/** Input sent to the Swift bridge via stdin */
export interface BridgeInput {
  messages: BridgeMessage[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  stream: boolean;
  responseFormat?: BridgeResponseFormat;
}

/** Response format for structured output */
export type BridgeResponseFormat =
  | { type: "text" }
  | { type: "json" }
  | { type: "json_schema"; schema: BridgeJsonSchema; name?: string };

/** JSON Schema structure for DynamicGenerationSchema conversion */
export interface BridgeJsonSchema {
  type: "object";
  properties: Record<string, BridgeSchemaProperty>;
  description?: string;
}

export interface BridgeSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array";
  description?: string;
  properties?: Record<string, BridgeSchemaProperty>; // for nested objects
  items?: BridgeSchemaProperty; // for arrays
}

export interface BridgeMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

/** Non-streaming response from the bridge (stdout JSON) */
export interface BridgeOutput {
  model: string;
  createdAt: string;
  message: { role: string; content: Array<{ type: string; text: string }> };
  stopReason: string;
  usage: BridgeUsage;
}

export interface BridgeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Streaming chunks from the bridge (stdout NDJSON lines) */
export type BridgeChunk =
  | { type: "text"; delta: string }
  | { type: "message_end"; stopReason: string; usage: BridgeUsage }
  | { type: "error"; error: string };

// ============================================================================
// Stop Reason Mapping
// ============================================================================

export const STOP_REASON_MAP: Record<string, StopReason> = {
  stop: StopReason.STOP,
  max_tokens: StopReason.MAX_TOKENS,
};
