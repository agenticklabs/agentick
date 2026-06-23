/**
 * Core client types — state machine, options, MCP spec eras.
 *
 * Kept narrow to avoid pulling SDK internals into adopters' code; the
 * harness file wires these together with the SDK `Client` / `Transport`
 * shapes.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpAuth } from "./auth.js";
import type { EraCodec } from "./era-codec.js";

// ============================================================================
// State machine
// ============================================================================

/**
 * Lifecycle states a per-server MCP client transitions through. The
 * state is published on the bus as `mcp:<scopeId>:state` envelopes;
 * subscribers can observe + react.
 *
 *   idle          — constructed but not yet connect()ed
 *   connecting    — connect() in flight, handshake not done
 *   ready         — connected, handshake complete, RPCs flow
 *   degraded      — past the reconnect ceiling; manual recovery only
 *   reconnecting  — transport dropped; backoff timer running
 *   closed        — close() called; terminal
 */
export type McpClientState =
  | "idle"
  | "connecting"
  | "ready"
  | "degraded"
  | "reconnecting"
  | "closed";

// ============================================================================
// MCP spec eras
// ============================================================================

/**
 * MCP protocol versions the client supports talking. The canonical
 * shape inside the harness mirrors `draft`; era codecs translate at
 * the wire edge so adopters interact with one canonical shape
 * regardless of which version the remote server speaks.
 *
 *   2024-11-05  — legacy, supported but discouraged
 *   2025-11-25  — latest official
 *   draft        — the target going forward (2026-07-28-ish working draft)
 */
export type McpSpecEra = "2024-11-05" | "2025-11-25" | "draft";

// ============================================================================
// Construction options
// ============================================================================

/**
 * Options for {@link McpClientHarness}. The harness is constructed
 * with a fully-built transport and auth strategy — the `withMCP()`
 * extension (#3) wires these from declarative server configs.
 */
export interface McpClientHarnessOptions {
  /**
   * Server id surfaced as the harness's scope (`mcp:<serverId>`).
   * Used for envelope routing + tool-registration keys downstream.
   */
  readonly serverId: string;

  /**
   * Pluggable transport. Pass a `Transport` from the SDK (StdioClientTransport,
   * StreamableHTTPClientTransport, ...) or a workspace-local impl
   * (`InMemoryMcpTransport`, etc.).
   */
  readonly transport: Transport;

  /**
   * Authentication strategy. {@link NoneAuth} for stdio, {@link BearerAuth}
   * for static API keys, OAuth21 (lands in #5) for hosted servers.
   */
  readonly auth: McpAuth;

  /**
   * MCP era codec. Defaults to the draft passthrough; older eras
   * codec to/from canonical at the wire edge.
   */
  readonly codec?: EraCodec;

  /**
   * Client identity surfaced in the `initialize` handshake. Defaults
   * to `@agentick/mcp-client` / `1.0.0`.
   */
  readonly clientInfo?: {
    readonly name: string;
    readonly version: string;
  };

  /**
   * Client capability declaration sent in the `initialize` handshake.
   * Defaults declare elicitation (`form` mode) — the substrate's
   * required surface. URL mode + roots / sampling capabilities get
   * mixed in by `withMCP()` based on the server config.
   */
  readonly capabilities?: Readonly<Record<string, unknown>>;

  /**
   * Reconnect policy. Disabled by default for stdio (subprocess died
   * → escalate to caller). For HTTP transports the `withMCP()`
   * extension flips it on.
   */
  readonly reconnect?: ReconnectPolicy;

  /**
   * Fixed inbox address of the elicit harness this client routes
   * inbound `elicitation/create` messages to. Per-session
   * construction (`withMCP` as SessionExtension) wires the session's
   * elicit harness here — one address per harness, no cross-session
   * routing, no slot.
   *
   * Omitted → inbound elicits cancel cleanly + emit
   * `mcp:warning:routing-dropped` on the bus. Safe default for
   * harness instances that aren't expected to receive
   * server-initiated elicits.
   */
  readonly elicitAddress?: string;

  /**
   * Default timeout (ms) for inbound elicit round-trips. Bounds the
   * Deferred the SDK handler awaits. Defaults to 5 minutes — long
   * enough for a human-in-the-loop, short enough to free the call's
   * fiber on user inactivity.
   */
  readonly elicitTimeoutMs?: number;
}

export interface ReconnectPolicy {
  /** Maximum reconnect attempts before transitioning to `degraded`. Default: 10. */
  readonly maxAttempts?: number;
  /** Initial backoff (ms). Default: 1000. */
  readonly initialDelayMs?: number;
  /** Cap on the backoff (ms). Default: 30_000. */
  readonly maxDelayMs?: number;
}

// ============================================================================
// Tool descriptors (canonical shape)
// ============================================================================

/**
 * Canonical discovered tool descriptor — the harness's view of a
 * single tool advertised by an MCP server. The era codec maps
 * server-side variants to this shape on `tools/list` responses.
 *
 * Distinct from `@agentick/spec-next`'s `ToolDeclaration` because the
 * server-supplied shape carries no `handlerRef` (the handler is the
 * MCP server itself, reachable via `callTool`). #3 bridges
 * `McpToolDescriptor` to `ToolDeclaration` + a synthesized
 * handlerRef when registering with the local `ToolExecutor`.
 */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
}
