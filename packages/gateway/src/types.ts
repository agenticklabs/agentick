/**
 * Gateway Types
 */

import type { App } from "@tentickle/core";

// ============================================================================
// Gateway Configuration
// ============================================================================

export interface GatewayConfig {
  /**
   * Port to listen on
   * @default 18789
   */
  port?: number;

  /**
   * Host to bind to
   * @default "127.0.0.1"
   */
  host?: string;

  /**
   * Gateway ID (auto-generated if not provided)
   */
  id?: string;

  /**
   * Agent definitions
   */
  agents: Record<string, App>;

  /**
   * Default agent to use when session key doesn't specify one
   */
  defaultAgent: string;

  /**
   * Authentication configuration
   */
  auth?: AuthConfig;

  /**
   * Persistence configuration
   */
  storage?: StorageConfig;

  /**
   * Channel adapters (WhatsApp, Slack, etc.)
   */
  channels?: ChannelAdapter[];

  /**
   * Message routing configuration
   */
  routing?: RoutingConfig;

  /**
   * Transport mode
   * - "websocket": WebSocket only (default, good for CLI/native clients)
   * - "http": HTTP/SSE only (good for web browsers)
   * - "both": Both transports on different ports
   * @default "websocket"
   */
  transport?: "websocket" | "http" | "both";

  /**
   * HTTP path prefix (e.g., "/api")
   * @default ""
   */
  httpPathPrefix?: string;

  /**
   * CORS origin for HTTP transport
   * @default "*"
   */
  httpCorsOrigin?: string;

  /**
   * HTTP port when using "both" mode
   * @default port + 1
   */
  httpPort?: number;
}

// ============================================================================
// Authentication
// ============================================================================

export type AuthConfig =
  | { type: "none" }
  | { type: "token"; token: string }
  | { type: "jwt"; secret: string; issuer?: string }
  | { type: "custom"; validate: (token: string) => Promise<AuthResult> };

export interface AuthResult {
  valid: boolean;
  userId?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Storage
// ============================================================================

export interface StorageConfig {
  /**
   * Base directory for storage
   * @default "~/.tentickle"
   */
  directory?: string;

  /**
   * Enable session persistence
   * @default true
   */
  sessions?: boolean;

  /**
   * Enable memory persistence
   * @default true
   */
  memory?: boolean;
}

// ============================================================================
// Channels
// ============================================================================

export interface ChannelAdapter {
  /**
   * Channel identifier
   */
  id: string;

  /**
   * Human-readable name
   */
  name: string;

  /**
   * Initialize the channel
   */
  initialize(gateway: GatewayContext): Promise<void>;

  /**
   * Clean up resources
   */
  destroy(): Promise<void>;
}

export interface GatewayContext {
  /**
   * Send a message to a session
   */
  sendToSession(sessionId: string, message: string): Promise<void>;

  /**
   * Get available agents
   */
  getAgents(): string[];

  /**
   * Get or create a session
   */
  getSession(sessionId: string): SessionContext;
}

export interface SessionContext {
  id: string;
  agentId: string;
  send(message: string): AsyncGenerator<SessionEvent>;
}

export interface SessionEvent {
  type: string;
  data: unknown;
}

// ============================================================================
// Routing
// ============================================================================

export interface RoutingConfig {
  /**
   * Map channels to agents
   */
  channels?: Record<string, string>;

  /**
   * Custom routing function
   */
  custom?: (message: IncomingMessage, context: RoutingContext) => string | null;
}

export interface IncomingMessage {
  text: string;
  channel?: string;
  from?: string;
  metadata?: Record<string, unknown>;
}

export interface RoutingContext {
  availableAgents: string[];
  defaultAgent: string;
  sessionHistory?: Array<{ role: string; content: string }>;
}

// ============================================================================
// Client State
// ============================================================================

export interface ClientState {
  id: string;
  connectedAt: Date;
  authenticated: boolean;
  userId?: string;
  subscriptions: Set<string>;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Session State
// ============================================================================

export interface SessionState {
  id: string;
  agentId: string;
  createdAt: Date;
  lastActivityAt: Date;
  messageCount: number;
  isActive: boolean;
  subscribers: Set<string>;
}

// ============================================================================
// Events
// ============================================================================

export interface GatewayEvents {
  started: { port: number; host: string };
  stopped: Record<string, never>;
  "client:connected": { clientId: string; ip?: string };
  "client:disconnected": { clientId: string; reason?: string };
  "client:authenticated": { clientId: string; userId?: string };
  "session:created": { sessionId: string; agentId: string };
  "session:closed": { sessionId: string };
  "session:message": {
    sessionId: string;
    role: "user" | "assistant";
    content: string;
  };
  "agent:message": {
    agentId: string;
    sessionId: string;
    message: string;
  };
  "channel:message": {
    channel: string;
    from: string;
    message: string;
  };
  "channel:error": {
    channel: string;
    error: Error;
  };
  error: Error;
}
