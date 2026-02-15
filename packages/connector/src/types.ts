import type { ChatMessage, RenderMode, ConfirmationPolicy } from "@agentick/client";
import type {
  SendInput,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
} from "@agentick/shared";
import type { ToolSummarizer } from "./content-pipeline.js";

// ============================================================================
// Connector Status
// ============================================================================

export type ConnectorStatus = "disconnected" | "connecting" | "connected" | "error";

export interface ConnectorStatusEvent {
  status: ConnectorStatus;
  /** Present when status is "error". */
  error?: Error;
  /** Human-readable detail. */
  message?: string;
}

// ============================================================================
// Content Policy
// ============================================================================

/**
 * Controls what content reaches the platform.
 *
 * - `"full"` — pass through unchanged
 * - `"text-only"` — strip tool_use/tool_result blocks, keep text + images
 * - `"summarized"` — collapse tool calls into brief summaries, keep text
 * - Function — full control over filtering/transformation
 */
export type ContentPolicy = "full" | "text-only" | "summarized" | ContentPolicyFn;
export type ContentPolicyFn = (message: ChatMessage) => ChatMessage | null;

// ============================================================================
// Delivery Strategy
// ============================================================================

/**
 * Controls when messages are delivered to the platform.
 *
 * - `"immediate"` — deliver on every state change
 * - `"on-idle"` — deliver only when execution completes
 * - `"debounced"` — deliver after N ms of no new content
 */
export type DeliveryStrategy = "immediate" | "on-idle" | "debounced";

// ============================================================================
// Rate Limiting
// ============================================================================

export interface RateLimitConfig {
  /** Maximum inbound messages per minute. */
  maxPerMinute?: number;
  /** Maximum inbound messages per day. */
  maxPerDay?: number;
  /** Called when a message is rate-limited. Return a string to reply, or void to silently drop. */
  onLimited?: (info: { remaining: number; resetMs: number }) => string | void;
}

// ============================================================================
// Retry Config
// ============================================================================

export interface RetryConfig {
  /** Maximum delivery attempts before giving up. Default: 3. */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff. Default: 1000. */
  baseDelay?: number;
  /** Maximum delay in ms. Default: 30000. */
  maxDelay?: number;
  /** Called when all retries are exhausted. */
  onExhausted?: (error: Error, output: ConnectorOutput) => void;
}

// ============================================================================
// Connector Config
// ============================================================================

export interface ConnectorConfig {
  sessionId: string;
  contentPolicy?: ContentPolicy;
  deliveryStrategy?: DeliveryStrategy;
  debounceMs?: number;
  renderMode?: RenderMode;
  confirmationPolicy?: ConfirmationPolicy;
  autoSubscribe?: boolean;
  rateLimit?: RateLimitConfig;
  /** Custom tool summarizer for the "summarized" content policy. */
  toolSummarizer?: ToolSummarizer;
  /** Retry config for failed outbound deliveries. */
  retry?: RetryConfig;
}

// ============================================================================
// Connector Output
// ============================================================================

export interface ConnectorOutput {
  messages: ChatMessage[];
  isComplete: boolean;
}

// ============================================================================
// Platform Adapter
// ============================================================================

/**
 * Interface for external platform adapters (Telegram, iMessage, etc).
 * Receives a bridge on start that it uses to send messages in and receive
 * processed output.
 */
export interface ConnectorPlatform {
  start(bridge: ConnectorBridge): void | Promise<void>;
  stop(): void | Promise<void>;
  /** Optional — platform reports its own health. */
  readonly status?: ConnectorStatus;
}

/**
 * Bridge provided by the framework to the platform adapter.
 * The platform uses this to push inbound messages and receive
 * delivery-ready output.
 */
export interface ConnectorBridge {
  send(text: string): void;
  sendInput(input: SendInput): void;
  onDeliver(handler: (output: ConnectorOutput) => void | Promise<void>): () => void;
  onConfirmation(
    handler: (
      request: ToolConfirmationRequest,
      respond: (r: ToolConfirmationResponse) => void,
    ) => void,
  ): () => void;
  /** Platform reports status changes to the framework. */
  reportStatus(status: ConnectorStatus, error?: Error): void;
  /** Register a handler called when an execution starts. Returns unsubscribe. */
  onExecutionStart(handler: () => void): () => void;
  /** Register a handler called when an execution ends. Returns unsubscribe. */
  onExecutionEnd(handler: () => void): () => void;
  abort(reason?: string): void;
  destroy(): void;
}
