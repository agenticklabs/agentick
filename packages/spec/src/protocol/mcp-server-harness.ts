/**
 * `McpServerHarnessProtocol` — exposes Agentick as an MCP server.
 *
 * Symmetric inbound counterpart to the outbound `McpClientHarness`
 * (in `@agentick/mcp/client`): the same wire vocabulary, the
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

import type {
  McpAuthenticatedUser,
  McpRequestExtras,
  ToolHandlerCtx,
} from "../data/tool-handler.js";
import type { LogLevel } from "../data/signals.js";
import type { McpServerError } from "../errors/harnesses.js";
import type { Unsubscribe } from "./inbox.js";
import type { Prompts } from "./prompts-harness.js";
import type { Resources } from "./resources-harness.js";

// Re-export from data/tool-handler so adopters who import McpAuthenticatedUser
// / McpRequestExtras from this module's historical path keep working.
export type { McpAuthenticatedUser, McpRequestExtras };

// ============================================================================
// Request context — the central flow-through type
// ============================================================================

/**
 * MCP-transport request context for tool handlers, security stages,
 * and projection code. Structural type alias of {@link ToolHandlerCtx}
 * narrowed to `transport: "mcp"` with the `mcp` extras non-optional
 * (definitely populated at MCP request handling time).
 *
 * ADR 43 unified ctx across transports — what used to be a standalone
 * interface here is now {@link ToolHandlerCtx} with a discriminator.
 * `McpRequestContext` stays as the named import path for code paths
 * that are intrinsically MCP-only (security stages, projection
 * builders), but at runtime / type-system level there is ONE ctx
 * shape; tool handlers should target `ToolHandlerCtx`.
 *
 * Migration note: ports from v1 `MCPRequestContext` previously lived
 * here as a flat interface — `serverId`, `connectionId`, etc. were
 * top-level. After ADR 43 they live under `ctx.mcp.*`. Adopter code
 * that destructures from `ctx` directly needs to update; code that
 * passes the whole `ctx` through doesn't.
 */
export type McpRequestContext = ToolHandlerCtx & {
  readonly transport: "mcp";
  readonly mcp: McpRequestExtras;
};

/**
 * Syslog-derived severity levels for MCP structured logging.
 *
 * Re-export alias of the framework-general {@link LogLevel} (ADR 64) —
 * ONE source of truth. The MCP wire `logging/setLevel` +
 * `notifications/message` `level` enum is exactly the syslog severity
 * ladder that every surface's `ctx.log` uses; the MCP name is kept for
 * MCP-local readability at projection call sites.
 */
export type McpLogLevel = LogLevel;

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
   * The Resources source this server projects onto the wire, or `null`
   * if no resources are wired (ADR 62). Adopter-owned — the server
   * never constructs one internally (a resource binding needs a
   * resolver function, so there is no declarative-array shorthand as
   * there is for prompts). Read surface for runtime registration.
   */
  readonly resources: Resources | null;

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
