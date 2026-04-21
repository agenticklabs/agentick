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

export type SamplingHandler = (request: SamplingRequest) => Promise<SamplingResult>;

export interface SamplingRequest {
  messages: Array<{
    role: "user" | "assistant";
    content: any;
  }>;
  modelPreferences?: {
    hints?: Array<{ name?: string }>;
    costPriority?: number;
    speedPriority?: number;
    intelligencePriority?: number;
  };
  systemPrompt?: string;
  includeContext?: "none" | "thisServer" | "allServers";
  temperature?: number;
  maxTokens: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
}

export interface SamplingResult {
  role: "user" | "assistant";
  content: { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
  model: string;
  stopReason?: string;
}

// ============================================================================
// Roots (Client provides filesystem roots to server)
// ============================================================================

export interface Root {
  uri: string;
  name?: string;
}

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
