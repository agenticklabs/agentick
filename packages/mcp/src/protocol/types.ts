/**
 * MCP protocol types — request context, server configuration, tool/resource
 * definitions, security function signatures, and handler context.
 *
 * These types form the contract between the MCPServer, its security pipeline,
 * and application-level handlers (tools, resources, prompts). The
 * {@link MCPRequestContext} is the central type — it flows through every stage
 * of the pipeline and carries user identity, client info, session metadata,
 * and SDK passthrough fields.
 *
 * @module @agentick/mcp/protocol
 */

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
  /** Abort signal for cancellation */
  signal?: AbortSignal;

  // ── Client identity (from SDK initialize handshake) ─────────────────
  /**
   * MCP client identity. Populated automatically from the SDK's clientInfo.
   * Examples: `{ name: "claude-desktop", version: "1.2.0" }`,
   * `{ name: "cursor", version: "0.50.0" }`, `{ name: "chatgpt", ... }`
   */
  clientInfo?: { name: string; version?: string };
  /**
   * MCP client capabilities from the initialize handshake.
   * Tells the server what features the client supports (sampling,
   * elicitation, roots, apps, etc.). Useful in toolFilter to hide
   * tools the client can't render (e.g., app tools for non-UI clients).
   */
  clientCapabilities?: Record<string, unknown>;

  // ── Session (from server session registry) ──────────────────────────
  /**
   * Session metadata from the active session. Includes transport type,
   * session ID, and timing. Useful in toolFilter to distinguish
   * in-process agents from HTTP clients.
   */
  session?: {
    sessionId: string;
    transportType: ConnectionInfo["transport"];
    createdAt: number;
  };

  // ── SDK passthrough ─────────────────────────────────────────────────
  /**
   * Auth info from the MCP SDK's built-in auth layer (RFC 9728 / OAuth).
   * Present when the SDK transport provides validated token claims.
   * Distinct from `user` (populated by the server's contextProvider).
   */
  authInfo?: Record<string, unknown>;
  /** JSON-RPC request ID — tracing/correlation across client ↔ server. */
  requestId?: string | number;
  /** Request-level metadata from the JSON-RPC `_meta` field. */
  _meta?: Record<string, unknown>;
  /** SDK task ID for long-running operations. */
  taskId?: string;
  /** Original HTTP request info (headers, URL, etc.) when transport is HTTP. */
  requestInfo?: unknown;

  // ── Application-level ───────────────────────────────────────────────
  /** Arbitrary application metadata (tracing, gateway ID, provenance, etc.) */
  metadata?: Record<string, any>;
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
   * Human-readable description of the server's purpose.
   * Sent to clients in the initialize response as part of serverInfo.
   */
  description?: string;

  /**
   * Instructions describing how to use the server and its features.
   * Sent to MCP clients in the initialize response and injected into
   * the LLM's context to improve understanding of available tools,
   * resources, and workflows.
   *
   * Can be a function for per-session dynamic instructions (e.g., injecting
   * authenticated user context). The function is called when each new client
   * session initializes — `Context.tryGet()?.user` is available at that point
   * for HTTP sessions authenticated via the gateway.
   */
  instructions?: string | (() => string);

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
   * Transform tool definitions per session before tools/list response.
   * Called for each tool with the request context. Return a modified definition
   * to inject per-session context (e.g., user info into description), or return
   * the original unchanged. Return null to remove the tool from the list.
   */
  toolTransform?: (tool: MCPToolDefinition, ctx: MCPRequestContext) => MCPToolDefinition | null;

  /**
   * Default security schemes applied to all tools on `tools/list`.
   * Emitted as `_meta.securitySchemes` per the MCP spec, so hosts
   * (ChatGPT, Claude, etc.) know which tools require authentication.
   *
   * Individual tools can override by setting `_meta.securitySchemes`
   * on their own definition.
   *
   * @example
   * ```ts
   * securitySchemes: [{ type: "oauth2", scopes: ["read"] }]
   * ```
   */
  securitySchemes?: Array<{ type: string; scopes?: string[] }>;

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
  /** AbortSignal — aborted when the client sends notifications/cancelled. */
  signal: AbortSignal;
  /**
   * Send a progress notification to the client. Only available when the
   * client supplied a progressToken in _meta. Undefined otherwise.
   *
   * @param progress - Current progress value
   * @param total - Total progress value (optional)
   * @param message - Human-readable progress message (optional)
   */
  sendProgress?: (progress: number, total?: number, message?: string) => Promise<void>;
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
  /**
   * Per-variable completion handlers for `completion/complete` requests
   * targeting this template. Sugar builders from `@agentick/mcp/completions`
   * are recommended.
   *
   * Legacy shape `(value) => string[]` is still accepted for
   * backwards compatibility — coerced to `{ values: [...] }` at dispatch.
   */
  complete?: Record<string, CompletionHandler>;
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
  /**
   * Per-argument completion handlers. When the client requests
   * `completion/complete` for one of this prompt's arguments, the
   * matching handler is invoked with the typed value and a context
   * carrying any already-resolved sibling arguments.
   *
   * Use sugar builders from `@agentick/mcp/completions`:
   * `completeFromList`, `completeFromEnum`, `completePrefixMatch`,
   * `completeDependent`, `completeFromAsync`.
   */
  complete?: Record<string, CompletionHandler>;
}

/**
 * Result shape for a `completion/complete` response, per MCP spec
 * 2025-11-25. Servers MUST cap `values` at 100 entries; sugar builders
 * enforce this automatically.
 */
export interface CompletionResult {
  values: string[];
  total?: number;
  hasMore?: boolean;
}

/**
 * Handler signature for argument completion. Receives the partial
 * value the user has typed so far and a context with already-resolved
 * sibling arguments (`ctx.resolvedArguments`). Returns either a typed
 * `CompletionResult` or a plain `string[]` (legacy shape, coerced to
 * `{ values: [...] }`).
 */
export type CompletionHandler = (
  value: string,
  ctx: MCPCompletionContext,
) => CompletionResult | string[] | Promise<CompletionResult | string[]>;

/**
 * Extended handler context for completion calls. Adds
 * `resolvedArguments` carrying the values of any sibling arguments the
 * user has already entered. Surfaced from the protocol's
 * `context.arguments` field.
 */
export interface MCPCompletionContext extends MCPHandlerContext {
  /**
   * Already-resolved sibling arguments for the same prompt or template.
   * Empty object when the request omits `context.arguments`.
   */
  resolvedArguments: Record<string, string>;
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
  "mcp:tool:cancelled": { sessionId: string; tool: string; requestId: string; durationMs: number };

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
