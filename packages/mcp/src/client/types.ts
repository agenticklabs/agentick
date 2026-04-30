/**
 * Client-side MCP types.
 *
 * These represent DISCOVERED data from MCP servers — the shapes returned by
 * tools/list, resources/list, etc. Different from server-side definitions
 * (MCPToolDefinition has a handler, these don't).
 */

// ============================================================================
// Connection Config
// ============================================================================

export type MCPTransport = "stdio" | "sse" | "streamable-http" | "in-process";

export interface MCPConnectionConfig {
  serverName: string;
  transport: MCPTransport;
  connection: {
    /** For stdio: command to spawn */
    command?: string;
    args?: string[];
    /** For SSE/HTTP: server URL */
    url?: string;
    /** For in-process: pre-created transport */
    transport?: import("@modelcontextprotocol/sdk/shared/transport.js").Transport;
    [key: string]: any;
  };
  /**
   * Authentication configuration.
   *
   * - `bearer` / `api_key`: static token, no OAuth flow
   * - `oauth`: custom OAuthProvider for full control over persistence and UX
   * - `none`: explicitly disable auth (no 401 retry)
   * - **omitted**: HTTP transports get automatic OAuth via DefaultOAuthProvider;
   *   stdio/in-process get no auth (trusted transports)
   */
  auth?:
    | { type: "bearer"; token: string }
    | { type: "api_key"; token: string }
    | { type: "oauth"; provider: import("./oauth.js").OAuthProvider }
    | { type: "none" }
    | { type: "custom"; [key: string]: any };
}

// ============================================================================
// Discovered Data (from servers)
// ============================================================================

/** A tool discovered from an MCP server. */
export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /**
   * Tool metadata per MCP spec — carries `_meta.ui` for MCP Apps
   * (resourceUri + visibility). Hosts use this to determine whether
   * to expose the tool to the model and/or to apps.
   */
  _meta?: Record<string, unknown>;
  serverName: string;
}

/** A resource discovered from an MCP server. */
export interface DiscoveredResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  serverName: string;
}

/** A resource template discovered from an MCP server. */
export interface DiscoveredResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
  serverName: string;
}

/** Content returned by reading a resource. */
export interface ResourceContent {
  uri: string;
  text?: string;
  blob?: string;
  mimeType?: string;
}

// ============================================================================
// Prompts (Discovered)
// ============================================================================

/** A prompt discovered from an MCP server. */
export interface DiscoveredPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
  serverName: string;
}

/** Result of getting a prompt. */
export interface PromptResult {
  description?: string;
  messages: Array<{
    role: "user" | "assistant";
    content: any;
  }>;
}

// ============================================================================
// Progress
// ============================================================================

export interface ProgressInfo {
  progress: number;
  total?: number;
  message?: string;
}

export type ProgressCallback = (info: ProgressInfo) => void;

// ============================================================================
// Sampling (Bidirectional — server asks client's model to generate)
// ============================================================================
//
// Re-export the canonical types from `@agentick/mcp/protocol`. The
// protocol versions are strict supersets — they include the new
// 2025-11-25 content blocks (audio, tool_use, tool_result) while
// remaining compatible with handlers that only emit text/image.

import type {
  SamplingParams,
  SamplingResult as ProtocolSamplingResult,
} from "../protocol/types.js";

/**
 * Server → client sampling request. Typed against the full
 * 2025-11-25 spec (supports audio + tool-use blocks). Handlers can
 * narrow to text/image when they don't need the new modalities.
 */
export type SamplingRequest = SamplingParams;

// `SamplingResult` is canonically defined in `@agentick/mcp/protocol/types`
// and re-exported there. Don't re-export here — that creates an ambiguous
// export at the package barrel. Consumers should import from the package
// root (`@agentick/mcp`).

export type SamplingHandler = (request: SamplingRequest) => Promise<ProtocolSamplingResult>;

// ============================================================================
// Elicitation (Bidirectional — server pauses to ask the user)
// ============================================================================

import type {
  ElicitationFormSchema,
  ElicitationResponse,
  UrlElicitationResponse,
} from "../protocol/types.js";

/**
 * Form-mode elicitation request received from the server. The handler
 * presents `requestedSchema` as a form to the user and resolves with
 * the user's response (or decline/cancel).
 */
export interface ElicitationFormRequest {
  mode: "form";
  message: string;
  requestedSchema: ElicitationFormSchema;
}

/**
 * URL-mode elicitation request received from the server. The handler
 * navigates the user to `url` and resolves with the action when the
 * flow completes (or is dismissed).
 */
export interface ElicitationUrlRequest {
  mode: "url";
  message: string;
  url: string;
  elicitationId: string;
}

export type ElicitationRequest = ElicitationFormRequest | ElicitationUrlRequest;

/**
 * Handler for server-initiated `elicitation/create` requests. Receives
 * a discriminated form/URL request and returns the user's response.
 *
 * Form mode: return `{ action: "accept", content: {...} }` (matching
 * the requested schema) or `{ action: "decline" | "cancel" }`.
 *
 * URL mode: return `{ action: "accept" | "decline" | "cancel" }` —
 * content is omitted per spec.
 */
export type ElicitationHandler = (
  request: ElicitationRequest,
) => Promise<ElicitationResponse | UrlElicitationResponse>;

// ============================================================================
// Roots (Client provides filesystem roots to server)
// ============================================================================

// Re-export the canonical `Root` type from protocol so client and server
// reference the same shape. Avoids the ambiguous-export TS2308 from a
// duplicate definition.
import type { Root } from "../protocol/types.js";
export type { Root };

// ============================================================================
// Logging (Server → Client log messages)
// ============================================================================

export type LogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

export interface LogMessage {
  level: LogLevel;
  logger?: string;
  data: unknown;
}

export type LogHandler = (message: LogMessage, serverName: string) => void;

// ============================================================================
// Client Options
// ============================================================================

export interface MCPClientOptions {
  /** Client name sent during initialization. */
  name?: string;
  /** Client version sent during initialization. */
  version?: string;
  /** Handler for server-initiated sampling (createMessage) requests. */
  samplingHandler?: SamplingHandler;
  /**
   * Handler for server-initiated elicitation requests (form mode and URL
   * mode per MCP spec 2025-11-25). Returning `{ action: "accept", content }`
   * delivers the user's input back to the server; `decline` and `cancel`
   * are propagated as distinct outcomes. Omit either mode in
   * `elicitationModes` to opt out of advertising the corresponding
   * sub-capability.
   */
  elicitationHandler?: ElicitationHandler;
  /**
   * Which elicitation modes to advertise. Default: `["form", "url"]` when
   * `elicitationHandler` is set; ignored otherwise. Set to a subset to
   * opt out of one mode.
   */
  elicitationModes?: Array<"form" | "url">;
  /** Filesystem roots to provide to servers on request. */
  roots?: Root[];
  /** Handler for server log messages. */
  logHandler?: LogHandler;
  /**
   * Advertise the `io.modelcontextprotocol/ui` extension during initialization
   * so spec-compliant servers emit MCP Apps metadata. Default: `true`. Set to
   * `false` for headless clients that will never render `ui://` resources —
   * strict servers may then downgrade to text-only tool registration.
   */
  mcpApps?: boolean;
  /** Default timeout in milliseconds for tool calls. Default: 60000 (60s). */
  toolCallTimeoutMs?: number;
  /** Circuit breaker for consistently failing servers. */
  circuitBreaker?: {
    /** Consecutive failures before opening the circuit. Default: 5. */
    failureThreshold?: number;
    /** Time in ms to keep circuit open before allowing a probe. Default: 30000. */
    resetTimeoutMs?: number;
  };
}

// ============================================================================
// Client Errors
// ============================================================================

export interface MCPToolCallError {
  type: "timeout" | "server_error" | "circuit_open" | "connection_lost" | "unknown";
  message: string;
  serverName: string;
  toolName: string;
  cause?: Error;
}

export class MCPClientError extends Error {
  constructor(public readonly detail: MCPToolCallError) {
    super(detail.message);
    this.name = "MCPClientError";
  }
}

// ============================================================================
// Connection Health
// ============================================================================

export type ConnectionState = "connected" | "disconnected" | "reconnecting" | "degraded";

export interface ServerHealth {
  serverName: string;
  state: ConnectionState;
  lastConnectedAt?: number;
  lastErrorAt?: number;
  lastError?: string;
}
