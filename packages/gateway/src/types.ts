/**
 * Gateway Types
 */

import type { App } from "@agentick/core";
import type { KernelContext, UserContext } from "@agentick/kernel";
import type { AuthConfig } from "@agentick/server";

// Re-export auth types from server
export type { AuthConfig, AuthResult } from "@agentick/server";

/**
 * Schema type that works with both Zod 3 and Zod 4.
 * We only need parse() and type inference (_output).
 */
export interface ZodLikeSchema<T = unknown> {
  parse(data: unknown): T;
  _output: T;
}

export type { UserContext } from "@agentick/kernel";

// ============================================================================
// Gateway Configuration
// ============================================================================

export interface GatewayConfig {
  /**
   * Port to listen on (ignored in embedded mode)
   * @default 18789
   */
  port?: number;

  /**
   * Host to bind to (ignored in embedded mode)
   * @default "127.0.0.1"
   */
  host?: string;

  /**
   * Gateway ID (auto-generated if not provided)
   */
  id?: string;

  /**
   * App definitions
   */
  apps: Record<string, App>;

  /**
   * Default app to use when session key doesn't specify one
   */
  defaultApp: string;

  /**
   * Authentication configuration
   */
  auth?: AuthConfig;

  /**
   * Run in embedded mode (no standalone server).
   * Use handleRequest() to process requests from your framework.
   * @default false
   */
  embedded?: boolean;

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
   * Transport mode (ignored in embedded mode)
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

  /**
   * Custom methods - runs within Agentick ALS context.
   *
   * Supports:
   * - Simple handlers: `async (params) => result`
   * - Streaming: `async function* (params) { yield value }`
   * - With config: `method({ schema, handler, roles, guard })`
   * - Namespaces: `{ tasks: { list, create, admin: { ... } } }` (recursive)
   *
   * Use method() wrapper for schema validation, roles, guards, etc.
   * ctx param is optional - use Context.get() for idiomatic access.
   */
  methods?: MethodsConfig;
}

// ============================================================================
// Storage
// ============================================================================

export interface StorageConfig {
  /**
   * Base directory for storage
   * @default "~/.agentick"
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
   * Get available apps
   */
  getApps(): string[];

  /**
   * Get or create a session
   */
  getSession(sessionId: string): SessionContext;
}

export interface SessionContext {
  id: string;
  appId: string;
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
  availableApps: string[];
  defaultApp: string;
  sessionHistory?: Array<{ role: string; content: string }>;
}

// ============================================================================
// Client State
// ============================================================================

export interface ClientState {
  id: string;
  connectedAt: Date;
  authenticated: boolean;
  /** Full user context from auth */
  user?: UserContext;
  subscriptions: Set<string>;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Session State
// ============================================================================

export interface SessionState {
  id: string;
  appId: string;
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
  "client:authenticated": { clientId: string; user?: UserContext };
  "session:created": { sessionId: string; appId: string };
  "session:closed": { sessionId: string };
  "session:message": {
    sessionId: string;
    role: "user" | "assistant";
    content: string;
  };
  "app:message": {
    appId: string;
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

// ============================================================================
// Custom Methods
// ============================================================================

/** Symbol for detecting method definitions vs namespaces */
export const METHOD_DEFINITION = Symbol.for("agentick:method-definition");

/**
 * Simple method handler - ctx param is optional since Context.get() works
 */
export type SimpleMethodHandler<TParams = Record<string, unknown>, TResult = unknown> = (
  params: TParams,
  ctx?: KernelContext,
) => Promise<TResult> | TResult;

/**
 * Streaming method handler - yields values to client
 */
export type StreamingMethodHandler<TParams = Record<string, unknown>, TYield = unknown> = (
  params: TParams,
  ctx?: KernelContext,
) => AsyncGenerator<TYield>;

/**
 * Method definition input (what you pass to method())
 */
export interface MethodDefinitionInput<TSchema extends ZodLikeSchema = ZodLikeSchema> {
  /** Zod schema for params validation + TypeScript inference */
  schema?: TSchema;
  /** Handler function - receives validated & typed params */
  handler: SimpleMethodHandler<TSchema["_output"]> | StreamingMethodHandler<TSchema["_output"]>;
  /** Required roles - checked before handler */
  roles?: string[];
  /** Custom guard function */
  guard?: (ctx: KernelContext) => boolean | Promise<boolean>;
  /** Method description for discovery */
  description?: string;
}

/**
 * Method definition with symbol marker (returned by method())
 */
export interface MethodDefinition<
  TSchema extends ZodLikeSchema = ZodLikeSchema,
> extends MethodDefinitionInput<TSchema> {
  [METHOD_DEFINITION]: true;
}

/**
 * Factory function to create a method definition.
 * Stores config (schema, roles, guards) - the gateway creates the
 * actual procedure during initialization with the full inferred path name.
 *
 * @example
 * methods: {
 *   tasks: {
 *     list: async (params) => { ... },  // Simple - auto-wrapped
 *     create: method({                   // With config
 *       schema: z.object({ title: z.string() }),
 *       handler: async (params) => { ... }
 *     }),
 *   }
 * }
 */
export function method<TSchema extends ZodLikeSchema>(
  definition: MethodDefinitionInput<TSchema>,
): MethodDefinition<TSchema> {
  return {
    [METHOD_DEFINITION]: true,
    ...definition,
  };
}

/**
 * Check if a value is a method definition (vs a namespace)
 */
export function isMethodDefinition(value: unknown): value is MethodDefinition {
  return typeof value === "object" && value !== null && METHOD_DEFINITION in value;
}

/**
 * Method can be:
 * - Simple function: async (params) => result
 * - Streaming function: async function* (params) { yield }
 * - Method definition: method({ schema, handler, roles, ... })
 */

export type Method = SimpleMethodHandler | StreamingMethodHandler | MethodDefinition<any>;

/**
 * Method namespace - recursively nested, arbitrary depth
 */
export type MethodNamespace = {
  [key: string]: Method | MethodNamespace;
};

/**
 * Methods config - supports flat or nested namespaces
 */
export type MethodsConfig = MethodNamespace;
