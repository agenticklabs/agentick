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

import type { ToolDeclaration } from "../data/declarations.js";
import type { JournalError } from "../data/errors.js";
import type { Unsubscribe } from "./inbox.js";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Identifier for a transport in `McpServerConfig.transports`. Concrete
 * transport factories (`stdioTransport()`, `httpTransport({ port })`,
 * `wsTransport({ port })`) return objects of this shape. The harness
 * does not introspect — adopters pass whatever factory returns.
 *
 * Transport-implementing packages can augment this seed if they need
 * stronger typing at the slot level.
 */
export interface McpServerTransportSpec {
  /** Transport kind discriminator. Useful for diagnostics + defaults. */
  readonly kind: string;
  readonly [key: string]: unknown;
}

/**
 * Per-connection tool projection. The harness applies `filter` first,
 * then runs `transforms` left-to-right against the live
 * {@link McpRequestContext}. Both are evaluated per request, not
 * pre-baked at connection setup. See ADR 40 §3.
 *
 * Concrete types use `@agentick/tool-next/transforms.ToolTransform`;
 * the spec layer types this as `unknown` to avoid pulling a runtime
 * dependency into the spec.
 */
export interface McpServerToolsConfig {
  /**
   * Per-request predicate. Tools where the predicate returns `false`
   * are hidden from `tools/list` and rejected from `tools/call`.
   */
  readonly filter?: (tool: ToolDeclaration, ctx: McpRequestContext) => boolean;
  /**
   * Tool transforms applied in array order. Implementations type this
   * as `ToolTransform<McpRequestContext>[]` from
   * `@agentick/tool-next/transforms`; at the spec layer the slot is
   * typed as `unknown[]` so the spec doesn't import the runtime
   * transforms package.
   */
  readonly transforms?: readonly unknown[];
}

/**
 * Per-connection prompts projection. Same pattern as tools: the
 * harness consults `filter` per request against the live
 * {@link McpRequestContext}.
 */
export interface McpServerPromptsConfig {
  readonly filter?: (decl: unknown, ctx: McpRequestContext) => boolean;
}

/**
 * Capability advertisement overrides. Defaults are HARNESS-DRIVEN —
 * the server advertises exactly what's wired (tools registry present →
 * advertise tools; PromptsHarness mounted → advertise prompts; etc.).
 * Adopters override an entry to opt OUT of an otherwise-available
 * capability. Setting an entry to `true` does NOT enable capabilities
 * the framework can't actually serve — wire your harnesses first.
 */
export interface McpServerCapabilitiesConfig {
  readonly tools?: boolean;
  readonly prompts?: boolean;
  readonly resources?: boolean;
  readonly elicitation?: boolean;
  readonly sampling?: boolean;
  readonly tasks?: boolean;
}

/**
 * Pluggable security stages — ported verbatim from v1
 * `packages/mcp/src/server/security/`. Each stage is a swappable async
 * function. Defaults are transport-aware (HTTP/WS = localOnly +
 * rejectAll until auth is configured; stdio + in-memory = allowAll).
 * See ADR 40 §5.
 *
 * Concrete stage signatures live in `@agentick/mcp-next/server/security`;
 * the spec layer types them as `unknown` to avoid a runtime dep cycle.
 */
export interface McpServerAuthConfig {
  readonly connectionGuard?: unknown;
  readonly authenticator?: unknown;
  readonly authorizer?: unknown;
  readonly rateLimiter?: unknown;
  readonly inputSanitizer?: unknown;
}

/**
 * One MCP server's full configuration. Hosted at gateway scope; many
 * can coexist on a single gateway, each with its own name, transports,
 * projections, and auth. See ADR 40 §2.
 */
export interface McpServerConfig {
  /** Unique server name within the gateway. Used in observability + URL routing. */
  readonly name: string;
  /** One or more transports the server accepts connections on. */
  readonly transports: readonly McpServerTransportSpec[];
  /** Tool projection (filter + transforms). Optional — defaults to "all tools, no transforms". */
  readonly tools?: McpServerToolsConfig;
  /** Prompts projection. Optional — defaults to "all prompts". */
  readonly prompts?: McpServerPromptsConfig;
  /** Resources projection slot — populated when #123 lands. Absent here means "don't advertise resources capability". */
  readonly resources?: unknown;
  /** Capability advertisement overrides. Default: harness-driven (only advertise what's wired). */
  readonly capabilities?: McpServerCapabilitiesConfig;
  /** Security pipeline. Stages port from v1 verbatim. */
  readonly auth?: McpServerAuthConfig;
  /** Adopter-defined metadata (logging context, deployment tier, etc.). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

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
 * Typed errors emitted from harness operations and projection. Each
 * tag is a discriminator usable in `_tag`-based switches.
 */
export type McpServerError =
  | { readonly _tag: "McpServerNotFound"; readonly name: string }
  | {
      readonly _tag: "McpServerConfigInvalid";
      readonly reason: string;
      readonly path?: readonly string[];
    }
  | {
      readonly _tag: "McpServerTransportFailed";
      readonly transportKind: string;
      readonly cause: unknown;
    }
  | { readonly _tag: "McpServerAuthRejected"; readonly reason: string }
  | { readonly _tag: "McpServerRateLimited"; readonly retryAfterMs?: number }
  | { readonly _tag: "McpServerClosed"; readonly serverId: string }
  | JournalError;

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
