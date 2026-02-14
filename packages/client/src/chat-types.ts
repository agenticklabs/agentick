import type { ContentBlock, Message, TimelineEntry, StreamEvent } from "@agentick/shared";
import type { ToolConfirmationRequest, ToolConfirmationResponse } from "./types.js";
import type { SteeringMode, MessageSteeringOptions } from "./message-steering.js";

// ---------------------------------------------------------------------------
// Attachment types
// ---------------------------------------------------------------------------

export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly source: AttachmentSource;
  readonly size?: number;
}

export type AttachmentSource =
  | { readonly type: "base64"; readonly data: string }
  | { readonly type: "url"; readonly url: string };

export interface AttachmentInput {
  name: string;
  mimeType: string;
  source: string | AttachmentSource;
  size?: number;
}

export type AttachmentValidator = (
  input: AttachmentInput,
) => { valid: true } | { valid: false; reason: string };

export type AttachmentToBlock = (attachment: Attachment) => ContentBlock;

export interface AttachmentManagerOptions {
  validator?: AttachmentValidator;
  toBlock?: AttachmentToBlock;
  maxAttachments?: number;
}

// Re-export TimelineEntry from shared (replaces the weak local version)
export type { TimelineEntry } from "@agentick/shared";

export interface ToolCallEntry {
  id: string;
  name: string;
  status: "done";
  duration?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string | ContentBlock[];
  toolCalls?: ToolCallEntry[];
}

export type ChatMode = "idle" | "streaming" | "confirming_tool";

export interface ToolConfirmationState {
  request: ToolConfirmationRequest;
  respond: (response: ToolConfirmationResponse) => void;
}

// ---------------------------------------------------------------------------
// RenderMode
// ---------------------------------------------------------------------------

/**
 * Controls how progressively messages appear in the message list.
 *
 * - `"streaming"`: Token-by-token — content deltas, tool call deltas
 * - `"block"`: Block-at-a-time — full content blocks, full tool calls, tool results
 * - `"message"`: Full message — entire assistant response at once
 *
 * When omitted, messages only appear at `execution_end` (coarsest granularity).
 */
export type RenderMode = "streaming" | "block" | "message";

// ---------------------------------------------------------------------------
// MessageLog types
// ---------------------------------------------------------------------------

/** Context passed to the transform function. */
export interface MessageTransformContext {
  /** Tool call durations accumulated during this execution. */
  toolDurations: ReadonlyMap<string, number>;
}

/**
 * Converts timeline entries into display messages.
 * The default implementation is `timelineToMessages` from chat-transforms.
 * Override to customize message extraction (include tool messages,
 * add custom metadata, change filtering, etc).
 */
export type MessageTransform = (
  entries: TimelineEntry[],
  context: MessageTransformContext,
) => ChatMessage[];

export interface MessageLogOptions {
  sessionId?: string;
  /** Pre-loaded messages (e.g. from session history). Sets initial messageCount for dedup. */
  initialMessages?: ChatMessage[];
  /** Custom transform. Default: timelineToMessages. */
  transform?: MessageTransform;
  /** When false, caller must call processEvent() manually. Default: true. */
  subscribe?: boolean;
  /** Progressive rendering mode. When omitted, messages appear at execution_end only. */
  renderMode?: RenderMode;
}

export interface MessageLogState {
  readonly messages: readonly ChatMessage[];
}

// ---------------------------------------------------------------------------
// ToolConfirmations types
// ---------------------------------------------------------------------------

/**
 * Policy decision for handling an incoming tool confirmation.
 * - "prompt": Show to user (default)
 * - "approve": Auto-approve without user interaction
 * - "deny": Auto-deny with optional reason
 */
export type ConfirmationDecision =
  | { action: "prompt" }
  | { action: "approve" }
  | { action: "deny"; reason?: string };

export type ConfirmationPolicy = (request: ToolConfirmationRequest) => ConfirmationDecision;

export interface ToolConfirmationsOptions {
  sessionId?: string;
  /** Policy for auto-approving/denying tools. Default: always prompt. */
  policy?: ConfirmationPolicy;
  /** When false, caller must call handleConfirmation() manually. Default: true. */
  subscribe?: boolean;
}

export interface ToolConfirmationsState {
  /** The pending confirmation, or null if none. */
  readonly pending: ToolConfirmationState | null;
}

// ---------------------------------------------------------------------------
// ChatModeDeriver
// ---------------------------------------------------------------------------

/**
 * Derives the chat mode from execution and confirmation state.
 * Default: idle/streaming/confirming_tool.
 * Override for custom modes (e.g. "error", "reconnecting").
 */
export type ChatModeDeriver<T extends string = ChatMode> = (input: {
  isExecuting: boolean;
  hasPendingConfirmation: boolean;
}) => T;

// ---------------------------------------------------------------------------
// ChatSession types
// ---------------------------------------------------------------------------

export interface ChatSessionState<TMode extends string = ChatMode> {
  readonly messages: readonly ChatMessage[];
  readonly chatMode: TMode;
  readonly toolConfirmation: ToolConfirmationState | null;
  readonly lastSubmitted: string | null;
  readonly queued: readonly Message[];
  readonly isExecuting: boolean;
  readonly mode: SteeringMode;
  /** Error from the most recent execution failure (null on success or abort) */
  readonly error: { message: string; name: string } | null;
  readonly attachments: readonly Attachment[];
}

export interface ChatSessionOptions<
  TMode extends string = ChatMode,
> extends MessageSteeringOptions {
  /** Pre-loaded messages. Passed to MessageLog. */
  initialMessages?: ChatMessage[];
  /** Custom message transform. Passed to MessageLog. */
  transform?: MessageTransform;
  /** Auto-approve/deny policy. Passed to ToolConfirmations. */
  confirmationPolicy?: ConfirmationPolicy;
  /** Custom mode derivation. Type parameter inferred from return type. */
  deriveMode?: ChatModeDeriver<TMode>;
  /** Raw event hook — called for every event before processing. */
  onEvent?: (event: StreamEvent) => void;
  /** Subscribe to the session's SSE transport on construction. Default: true. */
  autoSubscribe?: boolean;
  /** Progressive rendering mode. Passed to MessageLog. */
  renderMode?: RenderMode;
  /** Attachment manager options. */
  attachments?: AttachmentManagerOptions;
}
