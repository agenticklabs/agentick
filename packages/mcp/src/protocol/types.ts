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
    /** Idle time before a session is evicted. Default: 30 minutes. */
    idleTtlMs?: number;
    /**
     * Hard cap on concurrent sessions. Default: 1000. Reaching the cap evicts
     * the least-recently-active session — a new client is never rejected.
     */
    maxSessions?: number;
    /** Idle sweep interval. Default: 60 seconds. */
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

  /**
   * Middleware registry — typically the Agentick instance — consulted by
   * the kernel when dispatching tool-call procedures. Without this, tool
   * dispatches run with no `context.middleware` set (because the on-the-fly
   * procedure created per call inherits its kernel context from
   * `Context.tryGet()`, which is empty unless an enclosing Session set it).
   *
   * Pass an `AgentickInstance` here so globally-registered middleware
   * (`Agentick.use("*", mw)`) actually fires for tool-call procedures —
   * otherwise consumers see procedure-internal attributes (`procedure.pid`,
   * etc.) but nothing their own middleware would have stamped.
   *
   * Structural typing: any object with `getMiddlewareFor(name)` works.
   */
  middlewareRegistry?: {
    getMiddlewareFor(procedureName: string): unknown[];
  };
}

// ============================================================================
// Spec metadata — BaseMetadataSchema + IconsSchema (2025-11-25)
// ============================================================================

/**
 * Optional icon metadata that clients may render in their UI. Per spec,
 * clients MUST support `image/png` and `image/jpeg`; SHOULD support
 * `image/svg+xml` and `image/webp`. The `theme` discriminator allows
 * shipping light/dark variants.
 */
export interface Icon {
  /** URL or data URI for the icon. */
  src: string;
  /** Optional MIME type (e.g. "image/png", "image/svg+xml"). */
  mimeType?: string;
  /**
   * Optional sizes in `WxH` format (e.g. `"48x48"`) or `"any"` for
   * scalable formats. If omitted, the client may use the icon at any size.
   */
  sizes?: string[];
  /**
   * Optional theme variant — `"light"` for use against light backgrounds,
   * `"dark"` for dark. If omitted, usable with any theme.
   */
  theme?: "light" | "dark";
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
  /**
   * Human-readable display name (per spec BaseMetadataSchema). Optional.
   * If omitted, clients use `name` for display, except where
   * `annotations.title` takes precedence.
   */
  title?: string;
  description?: string;
  inputSchema: z.ZodType | Record<string, unknown>;
  outputSchema?: z.ZodType | Record<string, unknown>;
  annotations?: ToolAnnotations;
  /**
   * Optional icons for client UI rendering (per spec IconsSchema).
   * Multiple sizes/themes can be provided; clients pick the best fit.
   */
  icons?: Icon[];
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
  /**
   * Sugar surface for `roots/list` — fetch the client's declared
   * filesystem roots and check whether paths are within them. Always
   * present; returns an empty list when the client did not advertise
   * the `roots` capability. Permissive defaults: `assertWithin` and
   * `isWithin` no-op (pass) when no roots are declared.
   *
   * Per MCP spec 2025-11-25, root URIs MUST be `file://`. Non-file
   * schemes are filtered out defensively.
   */
  roots: RootsAPI;

  /**
   * Sugar surface for `sampling/createMessage` — ask the client to run
   * an LLM completion on the server's behalf. Undefined when the client
   * did not advertise the `sampling` capability. Use `ctx.sample?.text(...)`
   * or guard explicitly: `if (!ctx.sample) throw ...`.
   */
  sample?: SampleAPI;

  /**
   * Sugar surface for `elicitation/create` — pause mid-tool to ask
   * the user for structured input (form mode) or to walk an external
   * URL flow (URL mode). Undefined when the client did not advertise
   * any `elicitation` sub-capability.
   */
  elicit?: ElicitAPI;
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
  /** Human-readable display name (BaseMetadataSchema). Optional. */
  title?: string;
  uri: string;
  description?: string;
  mimeType?: string;
  /** Optional icons for client UI rendering (IconsSchema). */
  icons?: Icon[];
  read: (ctx: MCPHandlerContext) => MCPResourceReadResult | Promise<MCPResourceReadResult>;
}

/** A parameterized URI resource (RFC 6570 template). */
export interface MCPResourceTemplateDefinition {
  name: string;
  /** Human-readable display name (BaseMetadataSchema). Optional. */
  title?: string;
  uriTemplate: string;
  description?: string;
  mimeType?: string;
  /** Optional icons for client UI rendering (IconsSchema). */
  icons?: Icon[];
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
  /** Human-readable display name (BaseMetadataSchema). Optional. */
  title?: string;
  description?: string;
  /** Optional icons for client UI rendering (IconsSchema). */
  icons?: Icon[];
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

// ============================================================================
// Roots
// ============================================================================

/**
 * A filesystem boundary declared by the client. Per MCP spec 2025-11-25,
 * `uri` MUST be a `file://` URI; other schemes are filtered out by the
 * server's defensive parser.
 */
export interface Root {
  /** `file://` URI of the root directory. */
  uri: string;
  /** Optional human-readable display name. */
  name?: string;
}

/**
 * Sugar surface for `roots/list` exposed on `MCPHandlerContext.roots`.
 * Always present — returns empty list (and treats `assertWithin`/`isWithin`
 * permissively) when the client did not advertise the `roots` capability.
 */
export interface RootsAPI {
  /** Returns the connected client's roots, fetched once and cached. */
  list(): Promise<Root[]>;

  /**
   * Returns true if `path` (a POSIX path or `file://` URI) is within
   * any declared root. Returns true when no roots are declared
   * (permissive default — no constraints).
   */
  isWithin(path: string): Promise<boolean>;

  /**
   * Throws if `path` is outside all declared roots. No-op when no
   * roots are declared.
   */
  assertWithin(path: string): Promise<void>;

  /**
   * Returns the matching root for `path`, or null if none contains it.
   * When multiple roots match, returns the most specific (longest-prefix).
   */
  rootContaining(path: string): Promise<Root | null>;

  /**
   * Joins a relative path against the first declared root, or against
   * a root identified by `name` when supplied. Throws if no roots are
   * declared, or if the named root cannot be found.
   */
  resolveRelative(relativePath: string, opts?: { name?: string }): Promise<string>;

  /**
   * Subscribe to changes — fires when the client emits
   * `notifications/roots/list_changed` and the cache is refreshed.
   * Returns an `unsubscribe` function.
   */
  subscribe(listener: (roots: Root[]) => void): () => void;
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
// Sampling
// ============================================================================

/**
 * MCP content block types per spec 2025-11-25 — used in both
 * `sampling/createMessage` request messages and the response. Tool
 * use/result blocks are only valid in tool-enabled sampling
 * (capability `sampling.tools: {}`).
 */
export type SamplingContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      toolUseId: string;
      content: SamplingContentBlock[] | string;
      isError?: boolean;
    };

export interface ModelHint {
  name: string;
}

export interface ModelPreferences {
  hints?: ModelHint[];
  costPriority?: number;
  speedPriority?: number;
  intelligencePriority?: number;
}

export interface SamplingMessage {
  role: "user" | "assistant";
  content: SamplingContentBlock | SamplingContentBlock[];
}

export interface SamplingToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface SamplingParams {
  messages: SamplingMessage[];
  systemPrompt?: string;
  modelPreferences?: ModelPreferences;
  /**
   * Whether to include MCP context. Soft-deprecated in 2025-11-25 —
   * gated behind `sampling.context` sub-capability. Auto-scrubbed by
   * the sugar layer when the client did not advertise it.
   */
  includeContext?: "none" | "thisServer" | "allServers";
  temperature?: number;
  maxTokens: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
  /** New in 2025-11-25 — gated behind `sampling.tools` sub-capability. */
  tools?: SamplingToolDefinition[];
  toolChoice?: { mode: "auto" | "required" | "none" };
}

export interface SamplingResult {
  role: "assistant";
  content: SamplingContentBlock | SamplingContentBlock[];
  model: string;
  /**
   * 2025-11-25 names `endTurn` and `toolUse` explicitly; older spec
   * revisions also used `maxTokens` and `stopSequence`. Treat as an
   * open string for tolerance.
   */
  stopReason?: "endTurn" | "toolUse" | "maxTokens" | "stopSequence" | string;
}

/**
 * Sugar surface exposed at `MCPHandlerContext.sample` (undefined when
 * the client did not advertise `sampling`). Wraps
 * `MCPServer.requestSampling()` with typed shortcuts and capability
 * gating.
 */
export interface SampleAPI {
  /** Simplest: prompt in, text out. Single-turn. */
  text(prompt: string, opts?: SamplingTextOpts): Promise<string>;

  /** Multi-turn with full control. Returns the raw `SamplingResult`. */
  message(params: SamplingParams): Promise<SamplingResult>;

  /**
   * Structured output via Zod schema. Re-prompts on JSON parse / Zod
   * validation failure up to `maxRetries` (default 2).
   */
  structured<T>(
    prompt: string,
    opts: { schema: import("zod").ZodType<T>; maxRetries?: number } & SamplingTextOpts,
  ): Promise<T>;

  /** Image generation hint. Throws if response has no image content block. */
  image(opts: {
    prompt: string;
    size?: "256x256" | "512x512" | "1024x1024";
    style?: string;
  }): Promise<{ data: string; mimeType: string }>;

  /** Audio generation hint. Throws if response has no audio content block. */
  audio(opts: { prompt: string; voice?: string }): Promise<{ data: string; mimeType: string }>;

  /**
   * Tool-use sampling — runs the spec-defined loop: model emits
   * `tool_use` blocks → server invokes registered handlers → packages
   * `tool_result` blocks (tool-results-only message constraint per
   * spec) → feeds back. Bounded by `maxIterations` (default 8).
   *
   * Throws when client did not advertise `sampling.tools`.
   */
  withTools<T = unknown>(opts: {
    prompt: string;
    tools: Array<{
      name: string;
      description?: string;
      input: import("zod").ZodType<T>;
      handler: (input: unknown) => unknown | Promise<unknown>;
    }>;
    toolChoice?: "auto" | "required" | "none";
    maxIterations?: number;
    systemPrompt?: string;
    maxTokens?: number;
    modelPreferences?: ModelPreferences;
  }): Promise<{
    finalText: string;
    toolCalls: Array<{ name: string; input: unknown; output: unknown }>;
  }>;

  /** Capability probes. */
  canUseTools(): boolean;
  canSampleAudio(): boolean;
  canIncludeContext(): boolean;
}

export interface SamplingTextOpts {
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  modelPreferences?: ModelPreferences;
  includeContext?: "none" | "thisServer" | "allServers";
}

// ============================================================================
// Elicitation
// ============================================================================

/**
 * URI for an elicitation/create form-mode request, restricted per
 * MCP spec 2025-11-25 to a flat object with primitive properties.
 */
export interface ElicitationFormSchema {
  type: "object";
  properties: Record<string, ElicitationPrimitiveSchema>;
  required?: string[];
}

/** A primitive property type allowed in form-mode elicitation schemas. */
export type ElicitationPrimitiveSchema =
  | ElicitationStringSchema
  | ElicitationNumberSchema
  | ElicitationBooleanSchema
  | ElicitationEnumSchema
  | ElicitationMultiSelectSchema;

export interface ElicitationStringSchema {
  type: "string";
  title?: string;
  description?: string;
  minLength?: number;
  maxLength?: number;
  format?: "email" | "uri" | "date" | "date-time";
  default?: string;
}

export interface ElicitationNumberSchema {
  type: "number" | "integer";
  title?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  default?: number;
}

export interface ElicitationBooleanSchema {
  type: "boolean";
  title?: string;
  description?: string;
  default?: boolean;
}

/** Single-select enum — flat array (untitled) or oneOf+const+title (titled). */
export type ElicitationEnumSchema =
  | {
      type: "string";
      title?: string;
      description?: string;
      enum: string[];
      default?: string;
    }
  | {
      type: "string";
      title?: string;
      description?: string;
      oneOf: Array<{ const: string; title: string }>;
      default?: string;
    };

/** Multi-select — array of enum strings or array of titled options. */
export type ElicitationMultiSelectSchema =
  | {
      type: "array";
      title?: string;
      description?: string;
      minItems?: number;
      maxItems?: number;
      items: { type: "string"; enum: string[] };
      default?: string[];
    }
  | {
      type: "array";
      title?: string;
      description?: string;
      minItems?: number;
      maxItems?: number;
      items: { anyOf: Array<{ const: string; title: string }> };
      default?: string[];
    };

/** Three-action discriminated outcome. */
export type ElicitationResponse =
  | {
      action: "accept";
      content: Record<string, string | number | boolean | string[]>;
    }
  | { action: "decline" }
  | { action: "cancel" };

/** URL-mode response (no content even on accept per spec). */
export type UrlElicitationResponse =
  | { action: "accept" }
  | { action: "decline" }
  | { action: "cancel" };

/** Discriminated outcome for `tryX` sugar variants — single-value form-mode. */
export type ElicitOutcome<T> =
  | { status: "accept"; value: T }
  | { status: "decline" }
  | { status: "cancel" };

/** Discriminated outcome for `tryUrl` — URL mode never carries a value. */
export type UrlElicitOutcome = { status: "accept" } | { status: "decline" } | { status: "cancel" };

/**
 * Common timeout option for user-loop sugar. `number` is milliseconds;
 * `"never"` disables the auto-cancel timeout (resolves to Node's
 * setTimeout max ~24.8 days). When omitted, the sugar applies a
 * spec-friendly default (5 min for form-mode, 30 min for URL-mode).
 */
export type ElicitTimeoutOption = number | "never";

/**
 * Sugar surface exposed at `MCPHandlerContext.elicit` (undefined when
 * the client did not advertise any `elicitation` sub-capability).
 */
export interface ElicitAPI {
  // ── Form mode — single-value sugar ─────────────────────────────────

  text(
    message: string,
    opts?: {
      default?: string;
      pattern?: string;
      format?: "email" | "uri" | "date" | "date-time";
      minLength?: number;
      maxLength?: number;
      timeoutMs?: ElicitTimeoutOption;
    },
  ): Promise<string>;

  select<const T extends readonly string[]>(
    message: string,
    options: T,
    opts?: {
      default?: T[number];
      labels?: Partial<Record<T[number], string>>;
      timeoutMs?: ElicitTimeoutOption;
    },
  ): Promise<T[number]>;

  multiSelect<const T extends readonly string[]>(
    message: string,
    options: T,
    opts?: {
      default?: Array<T[number]>;
      min?: number;
      max?: number;
      labels?: Partial<Record<T[number], string>>;
      timeoutMs?: ElicitTimeoutOption;
    },
  ): Promise<Array<T[number]>>;

  confirm(
    message: string,
    opts?: { default?: boolean; timeoutMs?: ElicitTimeoutOption },
  ): Promise<boolean>;

  number(
    message: string,
    opts?: {
      min?: number;
      max?: number;
      integer?: boolean;
      default?: number;
      timeoutMs?: ElicitTimeoutOption;
    },
  ): Promise<number>;

  /**
   * Arbitrary structured input via Zod schema. Validated for spec
   * flatness (no nested objects, no arrays of objects beyond enums)
   * BEFORE dispatching to the client — fail fast on the server side.
   */
  object<T>(
    message: string,
    schema: import("zod").ZodType<T>,
    opts?: { timeoutMs?: ElicitTimeoutOption },
  ): Promise<T>;

  // ── URL mode ───────────────────────────────────────────────────────

  url(opts: {
    message: string;
    url: string;
    timeoutMs?: ElicitTimeoutOption;
  }): Promise<UrlElicitOutcome>;

  /**
   * Throws a `URLElicitationRequiredError` (-32042 protocol error)
   * containing one or more URL-mode elicitation specs the client
   * should walk before retrying. Used for OAuth-style deferred-auth
   * flows. Never returns.
   */
  requireUrls(elicitations: Array<{ message: string; url: string }>): never;

  // ── tryX variants — discriminated unions instead of throwing ───────

  tryText(message: string, opts?: Parameters<ElicitAPI["text"]>[1]): Promise<ElicitOutcome<string>>;
  trySelect<const T extends readonly string[]>(
    message: string,
    options: T,
    opts?: Parameters<ElicitAPI["select"]>[2],
  ): Promise<ElicitOutcome<T[number]>>;
  tryMultiSelect<const T extends readonly string[]>(
    message: string,
    options: T,
    opts?: Parameters<ElicitAPI["multiSelect"]>[2],
  ): Promise<ElicitOutcome<Array<T[number]>>>;
  tryConfirm(
    message: string,
    opts?: { default?: boolean; timeoutMs?: ElicitTimeoutOption },
  ): Promise<ElicitOutcome<boolean>>;
  tryNumber(
    message: string,
    opts?: Parameters<ElicitAPI["number"]>[1],
  ): Promise<ElicitOutcome<number>>;
  tryObject<T>(
    message: string,
    schema: import("zod").ZodType<T>,
    opts?: { timeoutMs?: ElicitTimeoutOption },
  ): Promise<ElicitOutcome<T>>;
  tryUrl(opts: {
    message: string;
    url: string;
    timeoutMs?: ElicitTimeoutOption;
  }): Promise<UrlElicitOutcome>;

  // ── Capability probes ──────────────────────────────────────────────

  canDoForm(): boolean;
  canDoUrl(): boolean;
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
