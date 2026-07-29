/**
 * Security stage signatures + result types.
 *
 * Five named stages, ported from v1's `packages/mcp/src/server/security/`:
 *
 *   ConnectionGuard  →  once per transport connection
 *   Authenticator    →  per request (must come BEFORE authorizer)
 *   Authorizer       →  per request
 *   RateLimiter      →  per request
 *   InputSanitizer   →  tool-call only, after rate limit
 *
 * Each is a plain async function. v1 chose this over a middleware-
 * chain abstraction; v2 preserves the choice — composition isn't
 * needed at this layer (the pipeline runner runs them sequentially in
 * a fixed order; adopters swap entire stages, not insert into the
 * middle of a chain).
 */

import type { McpAuthenticatedUser, McpRequestContext } from "@agentick/spec";

// ============================================================================
// Connection-level info — passed to ConnectionGuard before request context exists
// ============================================================================

/**
 * Snapshot of an incoming connection before the request pipeline
 * runs. Built by the transport layer at accept time.
 */
export interface McpConnectionInfo {
  readonly transportKind: string;
  /** Remote address (IPv4 / IPv6 / "stdio" / "in-memory"). */
  readonly remoteAddress?: string;
  /** Origin header for HTTP/WS transports. */
  readonly origin?: string;
  /** Free-form headers / metadata the transport surfaced. */
  readonly headers?: Readonly<Record<string, string | undefined>>;
  /**
   * Identity the HTTP auth pre-gate ({@link import("../transports/types.js").AuthPreGate})
   * resolved for this crossing, FORWARD-DERIVED onto the info handed to
   * `accept` (ADR 91 §Phase-2 single-authenticator). Present ⇒ the pre-gate
   * already ran the `Authenticator`, so instructions resolution seeds
   * `ctx.mcp.user` from this instead of running the authenticator a second
   * time. `null` = pre-gate ran and the crossing was anonymous; `undefined` =
   * no pre-gate ran (trusted transport / no OAuth), so instructions resolution
   * falls back to its own best-effort authenticator run.
   */
  readonly authenticatedUser?: McpAuthenticatedUser | null;
  /**
   * Does each inbound MESSAGE on this connection carry its own credential material?
   *
   * `true` for HTTP — every request has an `Authorization` header, so the crossing
   * re-authenticates and a token that expires mid-connection is caught. `false` for
   * stdio and in-memory, where there is nothing per-message to re-read and the identity
   * the connection was established with is the only truth there is.
   *
   * The crossing uses {@link authenticatedUser} instead of authenticating **only** when
   * this is `false` AND an identity was forwarded. Both halves matter: `false` alone
   * would break the case where an in-process caller deliberately states no identity and
   * wants the configured authenticator to decide.
   *
   * **Absent means `true`** — authenticate. Fail-closed, so a transport that says
   * nothing keeps the re-authenticating behaviour.
   */
  readonly credentialsPerRequest?: boolean;
}

// ============================================================================
// Operation info — passed to Authorizer + RateLimiter
// ============================================================================

/**
 * What's being authorized + rate-limited. Authorizers + limiters
 * branch on `type` + `name` to gate per-tool / per-prompt / etc.
 */
export interface OperationInfo {
  readonly type:
    | "tool_call"
    | "tool_list"
    | "resource_read"
    | "resource_list"
    | "prompt_get"
    | "prompt_list"
    | "completion"
    | "initialize"
    | "ping";
  readonly name?: string;
}

// ============================================================================
// Stage result shapes
// ============================================================================

export type AuthnResult =
  | { readonly authenticated: true; readonly user: McpAuthenticatedUser }
  | { readonly authenticated: false; readonly reason: string };

export type AuthzResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export type RateLimitResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs?: number };

// ============================================================================
// Stage signatures
// ============================================================================

/**
 * Called once per transport connection, before request processing.
 * Returns `true` to accept; `false` to reject the connection. Default
 * for trusted transports (stdio, in-memory) is `allowAll`; default for
 * untrusted (HTTP, WebSocket) is `localOnly` (127.0.0.1, ::1).
 */
export type ConnectionGuard = (info: McpConnectionInfo) => Promise<boolean>;

/**
 * Per-request authentication. Reads identity material from
 * `ctx` (usually headers, supplied by the transport via
 * `ctx.metadata.headers`). Returns `{ authenticated, user }` on
 * success; `{ authenticated: false, reason }` on rejection.
 */
export type Authenticator = (ctx: McpRequestContext) => Promise<AuthnResult>;

/**
 * Per-request authorization. Sees the authenticated user (from the
 * Authenticator stage) + the operation being performed. Branches on
 * `operation.type` + `operation.name` to gate.
 */
export type Authorizer = (ctx: McpRequestContext, operation: OperationInfo) => Promise<AuthzResult>;

/**
 * Per-request rate limit. Sees the authenticated context (key by
 * `ctx.user.id` or `ctx.connectionId` for per-user / per-connection
 * limits). `retryAfterMs` lands in the `Retry-After` JSON-RPC error.
 */
export type RateLimiter = (
  ctx: McpRequestContext,
  operation: OperationInfo,
) => Promise<RateLimitResult>;

/**
 * Per-tool-call input sanitizer. Sees the tool name + the raw input
 * about to be dispatched. Returns the sanitized input — strip secrets,
 * canonicalize paths, drop fields the user shouldn't be able to
 * supply, etc. Returning the input unchanged is the default
 * (`passthroughSanitizer`).
 */
export type InputSanitizer = (
  ctx: McpRequestContext,
  toolName: string,
  input: Readonly<Record<string, unknown>>,
) => Promise<Record<string, unknown>>;

/**
 * Resolved + defaulted security configuration. Adopter `auth` config
 * + transport-aware defaults produce one of these per harness at
 * construction; the pipeline runner reads it on every request.
 */
export interface ResolvedSecurity {
  readonly connectionGuard: ConnectionGuard;
  readonly authenticator: Authenticator;
  readonly authorizer: Authorizer;
  readonly rateLimiter: RateLimiter;
  readonly inputSanitizer: InputSanitizer;
}
