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
  agents: string[];
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

export type GatewayMethod =
  | "send" // Send message to session
  | "abort" // Abort current execution
  | "status" // Get gateway/session status
  | "history" // Get conversation history
  | "reset" // Reset a session
  | "close" // Close a session
  | "agents" // List available agents
  | "sessions" // List sessions
  | "subscribe" // Subscribe to session events
  | "unsubscribe"; // Unsubscribe from events

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
    agents: string[];
  };
  session?: {
    id: string;
    agentId: string;
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

export interface AgentsPayload {
  agents: Array<{
    id: string;
    name: string;
    description?: string;
    isDefault: boolean;
  }>;
}

export interface SessionsPayload {
  sessions: Array<{
    id: string;
    agentId: string;
    createdAt: string;
    lastActivityAt: string;
    messageCount: number;
  }>;
}

// ============================================================================
// Session Key Format
// ============================================================================

/**
 * Session keys follow the format: [agent:]name
 *
 * Examples:
 * - "main" → default agent, "main" session
 * - "chat:main" → "chat" agent, "main" session
 * - "research:task-123" → "research" agent, "task-123" session
 * - "whatsapp:+1234567890" → WhatsApp channel session
 */
export interface SessionKey {
  agentId: string;
  sessionName: string;
}

export function parseSessionKey(key: string, defaultAgent: string): SessionKey {
  const parts = key.split(":");
  if (parts.length === 1) {
    return { agentId: defaultAgent, sessionName: parts[0] };
  }
  return { agentId: parts[0], sessionName: parts.slice(1).join(":") };
}

export function formatSessionKey(key: SessionKey): string {
  return `${key.agentId}:${key.sessionName}`;
}
