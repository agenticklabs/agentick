import type { UserContext } from "@agentick/kernel";
import type {
  CallToolResult,
  Tool,
  Resource,
  ResourceTemplate,
  ToolAnnotations,
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { z } from "zod";

// ============================================================================
// Re-exports from SDK (consumers shouldn't need to import the SDK directly)
// ============================================================================

/** The extra context passed to MCP server-side request handlers by the SDK. */
export type MCPHandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export type {
  CallToolResult,
  Tool as MCPToolSpec,
  Resource as MCPResourceSpec,
  ResourceTemplate as MCPResourceTemplateSpec,
  ToolAnnotations,
};

// ============================================================================
// Security Function Types
// ============================================================================

export interface ConnectionInfo {
  origin?: string;
  headers?: Record<string, string>;
  sessionId?: string;
  remoteAddress?: string;
  transport: "streamable-http" | "sse" | "stdio" | "in-process";
}

export interface OperationInfo {
  type: "tool_call" | "resource_read" | "resource_list" | "prompt_get" | "session_create";
  name?: string;
  sessionId: string;
}

export type AuthnResult = { authenticated: true } | { authenticated: false; reason: string };

export type AuthzResult = { allowed: true } | { allowed: false; reason: string };

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

/** Evaluated once when a transport connection is established. */
export type ConnectionGuard = (info: ConnectionInfo) => Promise<boolean>;

/** Verifies the request is from a known identity. Runs after contextProvider. */
export type Authenticator = (ctx: MCPRequestContext) => Promise<AuthnResult>;

/** Per-tool, per-resource, per-tenant access control. */
export type Authorizer = (ctx: MCPRequestContext, operation: OperationInfo) => Promise<AuthzResult>;

/** Throughput control per session, user, tool, or any dimension. */
export type RateLimiter = (
  ctx: MCPRequestContext,
  operation: OperationInfo,
) => Promise<RateLimitResult>;

/** Transforms or rejects tool input. Receives context for user-aware decisions. */
export type InputSanitizer = (
  ctx: MCPRequestContext,
  toolName: string,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

// ============================================================================
// Request Context
// ============================================================================

export interface MCPRequestContext {
  /** Authenticated user — references kernel's UserContext (single source of truth). */
  user?: UserContext;
  /** Request metadata (tracing, gateway ID, etc.) */
  metadata?: Record<string, any>;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

// ============================================================================
// Server Configuration
// ============================================================================

/**
 * Configuration for creating an MCPServer.
 *
 * Named MCPServerOptions (not MCPServerConfig) to avoid collision with the
 * existing cursor-style MCPServerConfig in core/src/mcp/types.ts.
 */
export interface MCPServerOptions {
  name: string;
  version: string;

  /**
   * Instructions describing how to use the server and its features.
   * Sent to MCP clients in the initialize response and injected into
   * the LLM's context to improve understanding of available tools,
   * resources, and workflows.
   */
  instructions?: string;

  tools?: MCPToolDefinition[];
  resources?: MCPStaticResource[];
  resourceTemplates?: MCPResourceTemplateDefinition[];
  apps?: MCPAppDefinition[];
  prompts?: MCPPromptDefinition[];

  /**
   * Per-call tool authorization. Called at tools/call time.
   * Return false to reject the tool call for this request context.
   */
  toolFilter?: (tool: MCPToolDefinition, ctx: MCPRequestContext) => boolean;

  /**
   * Security — all function types, transport-aware defaults.
   * HTTP: localOnlyGuard + rejectAllAuth. In-process/stdio: allowAll.
   */
  security?: {
    connectionGuard?: ConnectionGuard;
    authenticator?: Authenticator;
    authorizer?: Authorizer;
    rateLimiter?: RateLimiter;
    inputSanitizer?: InputSanitizer;
  };

  sessions?: {
    idleTtlMs?: number;
    maxSessions?: number;
    cleanupIntervalMs?: number;
  };

  logging?: {
    level?: "debug" | "info" | "warn" | "error";
  };

  /**
   * Called per-request to build MCPRequestContext from SDK's RequestHandlerExtra.
   * Runs BEFORE the security pipeline.
   */
  contextProvider?: (extra: MCPHandlerExtra) => MCPRequestContext | Promise<MCPRequestContext>;
}

// ============================================================================
// Tool Definitions (Server-Side)
// ============================================================================

/**
 * A tool registered on the MCP server.
 * Includes a handler — this is the server-side definition (not the discovered shape).
 */
export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema: z.ZodType | Record<string, unknown>;
  outputSchema?: z.ZodType | Record<string, unknown>;
  annotations?: ToolAnnotations;
  /** MCP Apps metadata — links this tool to a ui:// resource. */
  ui?: {
    resourceUri?: string;
    visibility?: Array<"model" | "app">;
  };
  /**
   * Raw `_meta` passthrough for interop with hosts or SDKs that author tools
   * against the legacy MCP Apps spec. On registration, if
   * `_meta["ui/resourceUri"]` is set but `ui.resourceUri` isn't, the canonical
   * `ui.resourceUri` is hydrated from it. Any extra keys on `_meta` are
   * preserved verbatim on `tools/list`.
   */
  _meta?: Record<string, unknown>;
  handler: MCPToolHandler;
}

/**
 * Context passed to all MCP handlers (tools, resources, prompts).
 * Contains the enriched request context (user, tenantId, roles, metadata)
 * and the raw SDK extra for low-level needs.
 */
export interface MCPHandlerContext {
  /** Authenticated request context — user identity, tenant, roles, metadata. */
  request: MCPRequestContext;
  /** Raw SDK handler extra — sessionId, requestId, signal, authInfo. */
  extra: MCPHandlerExtra;
  /** Shortcut: the session ID for this request. */
  sessionId: string;
}

export type MCPToolHandler = (
  input: Record<string, unknown>,
  ctx: MCPHandlerContext,
) => CallToolResult | Promise<CallToolResult>;

// ============================================================================
// Resource Definitions (Server-Side)
// ============================================================================

/** A fixed-URI resource served by the MCP server. */
export interface MCPStaticResource {
  name: string;
  uri: string;
  description?: string;
  mimeType?: string;
  read: (ctx: MCPHandlerContext) => MCPResourceReadResult | Promise<MCPResourceReadResult>;
}

/** A parameterized URI resource (RFC 6570 template). */
export interface MCPResourceTemplateDefinition {
  name: string;
  uriTemplate: string;
  description?: string;
  mimeType?: string;
  list?: (ctx: MCPHandlerContext) => MCPResourceListResult | Promise<MCPResourceListResult>;
  read: (
    uri: string,
    variables: Record<string, string>,
    ctx: MCPHandlerContext,
  ) => MCPResourceReadResult | Promise<MCPResourceReadResult>;
  complete?: Record<string, (value: string) => string[] | Promise<string[]>>;
}

export interface MCPResourceReadResult {
  contents: Array<{
    uri: string;
    text?: string;
    blob?: string;
    mimeType?: string;
  }>;
}

export interface MCPResourceListResult {
  resources: Array<{
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
  }>;
}

// ============================================================================
// MCP Apps Definitions
// ============================================================================

/** A ui:// resource for MCP Apps. */
export interface MCPAppDefinition {
  name: string;
  /** Must use ui:// scheme, e.g. "ui://my-server/dashboard" */
  uri: string;
  description?: string;
  /** HTML content (or a function that returns it). */
  content: string | (() => string | Promise<string>);
  /** CSP configuration for the iframe sandbox. */
  csp?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
  /** Iframe permissions to request. */
  permissions?: Array<"camera" | "microphone" | "geolocation" | "clipboardWrite">;
  prefersBorder?: boolean;
  /**
   * Dedicated origin for the view sandbox. Useful when the app needs a stable
   * origin for OAuth callbacks, CORS allowlists, or API-key restrictions.
   * The format is host-defined (e.g. `{hash}.claudemcpcontent.com`).
   */
  domain?: string;
}

// ============================================================================
// Prompts
// ============================================================================

export interface MCPPromptDefinition {
  name: string;
  description?: string;
  arguments?: MCPPromptArgument[];
  handler: (
    args: Record<string, string>,
    ctx: MCPHandlerContext,
  ) => MCPPromptResult | Promise<MCPPromptResult>;
}

export interface MCPPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface MCPPromptResult {
  description?: string;
  messages: Array<{
    role: "user" | "assistant";
    content:
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
      | {
          type: "resource";
          resource: { uri: string; text?: string; blob?: string; mimeType?: string };
        };
  }>;
}

// ============================================================================
// Events
// ============================================================================

export interface MCPServerEvents {
  "mcp:session:created": { sessionId: string; clientInfo?: Record<string, unknown> };
  "mcp:session:closed": { sessionId: string; reason: string };
  "mcp:session:idle-timeout": { sessionId: string; idleMs: number };

  "mcp:tool:start": { sessionId: string; tool: string; requestId: string };
  "mcp:tool:end": {
    sessionId: string;
    tool: string;
    requestId: string;
    durationMs: number;
    isError: boolean;
  };
  "mcp:tool:error": { sessionId: string; tool: string; requestId: string; error: string };

  "mcp:resource:read": { sessionId: string; uri: string };
  "mcp:resource:list": { sessionId: string };

  "mcp:session:stale": { sessionId: string | null; method?: string };

  "mcp:security:connection-rejected": { origin?: string; transport: string; reason: string };
  "mcp:security:auth-failed": { sessionId?: string; reason: string };
  "mcp:security:authz-denied": { sessionId: string; tool?: string; reason: string };
  "mcp:security:rate-limit": { sessionId: string; tool?: string; retryAfterMs: number };
  "mcp:security:input-rejected": { sessionId: string; tool: string; reason: string };

  "mcp:tools:changed": Record<string, never>;
  "mcp:resources:changed": Record<string, never>;
}

// ============================================================================
// Session Info (for introspection)
// ============================================================================

export interface MCPSessionInfo {
  sessionId: string;
  createdAt: number;
  lastActivityAt: number;
  userId?: string;
  tenantId?: string;
  transport: ConnectionInfo["transport"];
}
