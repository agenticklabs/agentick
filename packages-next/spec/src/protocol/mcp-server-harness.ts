/**
 * `McpServerHarnessProtocol` — exposes Agentick as an MCP server.
 *
 * Symmetric inbound counterpart to the outbound `McpClientHarness`
 * (in `@agentick/mcp-next/client`): the same wire vocabulary, the
 * opposite direction. Hosted at GATEWAY scope (NOT session) because
 * MCP servers are long-lived multi-tenant infrastructure that many
 * unrelated clients connect to concurrently; sessions are
 * single-conversation.
 *
 * Shape: full harness (per ADR 32 §Shape 1).
 *   - Audit envelopes for connection accept / reject / drop, tool
 *     call dispatch, prompt invoke, capability negotiation
 *   - Per-connection projection of the gateway's tool / prompt /
 *     resource registries (no server-owned state — projects what the
 *     existing harnesses provide)
 *   - Swappable transport / auth / projection layers via config
 *
 * @see docs/proposals/v2/blueprint/40-mcp-server-harness.md
 * @see docs/proposals/v2/blueprint/23-mcp-as-harness.md
 */

import type { Effect } from "effect";

import type { McpServerError } from "../errors/harnesses.js";
import type { Elicit } from "./elicit-api.js";
import type { Unsubscribe } from "./inbox.js";
import type { Prompts } from "./prompts-harness.js";

// ============================================================================
// Request context — the central flow-through type
// ============================================================================

/**
 * The per-request context every projection stage sees. Built once per
 * incoming request from the connection's transport-level identity
 * material + the JSON-RPC envelope.
 *
 * Ported from v1 `packages/mcp/src/protocol/types.ts` `MCPRequestContext`
 * with minimal renaming for v2 conventions. The shape is intentionally
 * narrow — adopter-specific extension goes in `metadata`, not as
 * top-level slots.
 */
export interface McpRequestContext {
  /** Identifier of the McpServerHarness instance the request reached. */
  readonly serverId: string;
  /** Identifier of the underlying transport connection. */
  readonly connectionId: string;
  /** Transport kind ("stdio" / "http" / "ws" / "in-memory" / ...). */
  readonly transportKind: string;
  /** Time the connection was established, wall-clock ms. */
  readonly connectedAt: number;
  /**
   * Authenticated principal. Populated by the `Authenticator` stage.
   * `null` for connections that pass `ConnectionGuard` but have no
   * explicit authentication (default-allow transports).
   */
  readonly user: McpAuthenticatedUser | null;
  /** Client identification from `initialize` handshake. */
  readonly clientInfo: { readonly name: string; readonly version: string } | null;
  /** Capability map the client advertised in `initialize`. */
  readonly clientCapabilities: Readonly<Record<string, unknown>> | null;
  /** AbortSignal that fires on client cancellation or transport disconnect. */
  readonly signal: AbortSignal;
  /** Send a `notifications/progress` to this connection for the in-flight request. */
  readonly sendProgress?: (progress: number, total?: number, message?: string) => Promise<void>;
  /**
   * Sugar surface for prompting the connected end-user via the MCP
   * `elicitation/create` server→client request. Present only when:
   *   1. The server config wired the `elicit` slot, AND
   *   2. The connected client advertised the `elicitation` capability.
   * Tool handlers must check for presence before calling.
   */
  readonly elicit?: Elicit;
  /** Free-form metadata — adopter extension point. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Authenticated principal. Adopter `Authenticator` stages populate
 * this. The `roles` + `scopes` fields are conventional but unenforced
 * at the spec layer — adopters' `Authorizer` stage decides how to use
 * them.
 */
export interface McpAuthenticatedUser {
  readonly id: string;
  readonly displayName?: string;
  readonly roles?: readonly string[];
  readonly scopes?: readonly string[];
  readonly [key: string]: unknown;
}

// ============================================================================
// Protocol — the harness surface
// ============================================================================

/**
 * Public protocol of a single mounted MCP server. Adopters reach it
 * via `gateway.mcpServers.get(name)`; the gateway holds the canonical
 * registry of mounted servers.
 *
 * Most operations are observation-only (read connection state,
 * subscribe to events). Mutation happens by reconfiguring the server
 * + restarting transports — config is declarative, not imperatively
 * modified at runtime.
 */
export interface McpServerHarnessProtocol {
  readonly id: string;
  readonly ready: Promise<void>;

  /** Server's name from `McpServerConfig.name`. */
  readonly name: string;

  /** Snapshot the currently-open connections. */
  readonly connections: () => readonly McpServerConnectionInfo[];

  /** Subscribe to connection lifecycle changes. */
  readonly onConnectionChange: (listener: () => void) => Unsubscribe;

  /**
   * The Prompts source this server projects onto the wire, or `null`
   * if no prompts are wired. Whether the server constructed it
   * internally (from a declarations array on the options) or the
   * adopter supplied an existing one, this is the single read surface
   * for runtime mutation (`register` / `update` / `remove` / `reload`).
   */
  readonly prompts: Prompts | null;

  /**
   * Direct-projection handle for in-process clients. Returns a
   * `McpClientHandle`-shaped object (typed loosely here to avoid a
   * cross-package dep) that runs the full projection chain
   * (auth → filter → transforms) without serialization. See ADR 40 §7.
   *
   * The `principalOverride` parameter selects the synthetic identity
   * used; defaults to a `service-account` principal.
   */
  readonly asClient: (principalOverride?: McpAuthenticatedUser) => unknown;

  /** Close all connections + stop accepting new ones. Idempotent. */
  readonly close: () => Promise<void>;
}

/**
 * Snapshot of one open connection. Exposed via
 * `harness.connections()` for observability + debugging.
 */
export interface McpServerConnectionInfo {
  readonly connectionId: string;
  readonly transportKind: string;
  readonly connectedAt: number;
  readonly user: McpAuthenticatedUser | null;
  readonly clientInfo: { readonly name: string; readonly version: string } | null;
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Typed errors emitted from harness operations + projection +
 * security pipeline. Each tag is a discriminator usable in
 * `_tag`-based switches.
 *
 * Security-pipeline rejections use this same union — the transport
 * layer maps each tag to an HTTP-equivalent code + JSON-RPC error:
 *
 *   McpServerConnectionRejected → 403 / JSON-RPC -32000
 *   McpServerAuthRejected       → 401
 *   McpServerAuthzDenied        → 403
 *   McpServerRateLimited        → 429 / Retry-After
 *
 * TODO(error-infra): when the AgentickError class hierarchy lands
 * (filed), every tag here becomes `instanceof`-checkable AgentickError
 * subclass while preserving the `_tag` discriminator for switch-style
 * handling. The shape on the wire stays identical.
 */
/** Migrated to class hierarchy (ADR 41). Re-exports from `../errors/harnesses.js`. */
export {
  McpServerAuthRejected,
  McpServerAuthzDenied,
  McpServerClosed,
  McpServerConfigInvalid,
  McpServerConnectionRejected,
  McpServerError,
  type McpServerErrorChannel,
  McpServerNotFound,
  McpServerRateLimited,
  McpServerTransportFailed,
} from "../errors/harnesses.js";

/**
 * Effect-typed error union for harness operations. Use in
 * `runOperation`-style call sites:
 *
 *   Effect.Effect<R, McpServerErrorEffect, never>
 */
export type McpServerErrorEffect = Effect.Effect<never, McpServerError, never>;

// ============================================================================
// Slot integration
// ============================================================================

/**
 * The harness installs under `gateway.mcpServers` — a typed bag keyed
 * by server name. Concrete `GatewayHarness` impls augment this slot to
 * wire it into the gateway's discoverable surface. Per ADR 27.
 */
export interface McpServerRegistry {
  /** Look up a mounted server by name. */
  readonly get: (name: string) => McpServerHarnessProtocol | undefined;
  /** Enumerate every mounted server. */
  readonly list: () => readonly McpServerHarnessProtocol[];
  /** Subscribe to registry-level changes (server mounted / unmounted). */
  readonly onRegistryChange: (listener: () => void) => Unsubscribe;
}
