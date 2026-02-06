/**
 * Gateway Protocol Types
 *
 * Defines the WebSocket message protocol between clients and the gateway.
 */

// ============================================================================
// Client → Gateway Messages
// ============================================================================

export interface ConnectMessage {
  type: "connect";
  clientId: string;
  token?: string;
  metadata?: Record<string, unknown>;
}

export interface RequestMessage {
  type: "req";
  id: string;
  method: GatewayMethod;
  params: Record<string, unknown>;
}

export interface PingMessage {
  type: "ping";
  timestamp: number;
}

export type ClientMessage = ConnectMessage | RequestMessage | PingMessage;

// ============================================================================
// Gateway → Client Messages
// ============================================================================

export interface ConnectedMessage {
  type: "connected";
  gatewayId: string;
  apps: string[];
  sessions: string[];
}

export interface ResponseMessage {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface EventMessage {
  type: "event";
  event: GatewayEventType;
  sessionId: string;
  data: unknown;
}

export interface PongMessage {
  type: "pong";
  timestamp: number;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export type GatewayMessage =
  | ConnectedMessage
  | ResponseMessage
  | EventMessage
  | PongMessage
  | ErrorMessage;

// ============================================================================
// RPC Methods
// ============================================================================

/**
 * Built-in gateway methods with autocomplete support.
 */
export type BuiltInMethod =
  | "send" // Send message to session
  | "abort" // Abort current execution
  | "status" // Get gateway/session status
  | "history" // Get conversation history
  | "reset" // Reset a session
  | "close" // Close a session
  | "apps" // List available apps
  | "sessions" // List sessions
  | "subscribe" // Subscribe to session events
  | "unsubscribe"; // Unsubscribe from events

/**
 * Gateway method - built-in methods or custom method strings.
 * The (string & {}) allows any string while preserving autocomplete for built-in methods.
 */
export type GatewayMethod = BuiltInMethod | (string & {});

// ============================================================================
// Event Types
// ============================================================================

export type GatewayEventType =
  | "content_delta"
  | "content_block_start"
  | "content_block_end"
  | "tool_call_start"
  | "tool_call_delta"
  | "tool_result"
  | "message_start"
  | "message_end"
  | "error";

// ============================================================================
// Method Parameters
// ============================================================================

export interface SendParams {
  sessionId: string;
  message: string;
  attachments?: Array<{
    type: "image" | "file";
    data: string;
    mimeType: string;
    name?: string;
  }>;
}

export interface AbortParams {
  sessionId: string;
}

export interface StatusParams {
  sessionId?: string;
}

export interface HistoryParams {
  sessionId: string;
  limit?: number;
  before?: string;
}

export interface ResetParams {
  sessionId: string;
}

export interface CloseParams {
  sessionId: string;
}

export interface SubscribeParams {
  sessionId: string;
}

export interface UnsubscribeParams {
  sessionId: string;
}

// ============================================================================
// Response Payloads
// ============================================================================

export interface StatusPayload {
  gateway: {
    id: string;
    uptime: number;
    clients: number;
    sessions: number;
    apps: string[];
  };
  session?: {
    id: string;
    appId: string;
    messageCount: number;
    createdAt: string;
    lastActivityAt: string;
    isActive: boolean;
  };
}

export interface HistoryPayload {
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    timestamp: string;
    toolCalls?: Array<{
      name: string;
      input: unknown;
      output?: unknown;
    }>;
  }>;
  hasMore: boolean;
}

export interface AppsPayload {
  apps: Array<{
    id: string;
    name: string;
    description?: string;
    isDefault: boolean;
  }>;
}

export interface SessionsPayload {
  sessions: Array<{
    id: string;
    appId: string;
    createdAt: string;
    lastActivityAt: string;
    messageCount: number;
  }>;
}

// ============================================================================
// Session Key Format
// ============================================================================

/**
 * Session keys follow the format: [app:]name
 *
 * Examples:
 * - "main" → default app, "main" session
 * - "chat:main" → "chat" app, "main" session
 * - "research:task-123" → "research" app, "task-123" session
 * - "whatsapp:+1234567890" → WhatsApp channel session
 */
export interface SessionKey {
  appId: string;
  sessionName: string;
}

export function parseSessionKey(key: string, defaultApp: string): SessionKey {
  const parts = key.split(":");
  if (parts.length === 1) {
    return { appId: defaultApp, sessionName: parts[0] };
  }
  return { appId: parts[0], sessionName: parts.slice(1).join(":") };
}

export function formatSessionKey(key: SessionKey): string {
  return `${key.appId}:${key.sessionName}`;
}
