/**
 * Method-bound param and result shapes for every agentick wire method.
 *
 * Names follow the `/` separator convention shared with MCP. Notification
 * payloads live in `notifications.ts`. JSON-RPC envelope types live in
 * `json-rpc.ts`. Subscription scope discriminator lives in `scope.ts`.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md §"Method namespaces"
 */

import type { ContentBlock } from "../data/content-blocks.js";
import type { EventQuery } from "../data/events.js";
import type { ExecutionResult } from "../data/execution-result.js";
import type { Cursor } from "../protocol/event-log.js";
import type { RequestMeta } from "./json-rpc.js";
import type { SubscriptionScope } from "./scope.js";

// ============================================================================
// gateway/* — runtime root methods
// ============================================================================

export interface GatewayListAppsParams {
  readonly _meta?: RequestMeta;
}

export interface GatewayListAppsResult {
  readonly apps: readonly { readonly id: string; readonly metadata?: Readonly<Record<string, unknown>> }[];
}

export interface GatewayGetAppParams {
  readonly appId: string;
}

export interface GatewayGetAppResult {
  readonly id: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// app/* — multi-session host methods
// ============================================================================

export interface AppCreateSessionParams {
  readonly appId: string;
  readonly sessionId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AppCreateSessionResult {
  readonly sessionId: string;
}

export interface AppGetSessionParams {
  readonly appId: string;
  readonly sessionId: string;
}

export interface AppGetSessionResult {
  readonly sessionId: string;
  readonly status: "active" | "closed";
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AppListSessionsParams {
  readonly appId: string;
  readonly filter?: Readonly<Record<string, unknown>>;
}

export interface AppListSessionsResult {
  readonly sessions: readonly AppGetSessionResult[];
}

export interface AppRunOnceParams {
  readonly appId: string;
  readonly messages: readonly ContentBlock[];
  readonly _meta?: RequestMeta;
}

export interface AppRunOnceResult {
  readonly executionId: string;
  readonly finalCursor: Cursor;
  readonly result: ExecutionResult;
}

export interface AppCloseParams {
  readonly appId: string;
}

export type AppCloseResult = null;

// ============================================================================
// session/* — execution + state methods
// ============================================================================

export interface SessionSendParams {
  readonly sessionId: string;
  readonly messages: readonly ContentBlock[];
  /**
   * MCP-style `_meta` carrying the client-allocated progress token.
   * When present, the server streams `notifications/progress` frames
   * correlated by `progressToken` while the RPC is in flight.
   */
  readonly _meta?: RequestMeta;
}

export interface SessionSendResult {
  readonly executionId: string;
  readonly finalCursor: Cursor;
  readonly result: ExecutionResult;
}

export interface SessionDispatchParams {
  readonly sessionId: string;
  readonly tool: string;
  readonly input: unknown;
  readonly _meta?: RequestMeta;
}

export interface SessionDispatchResult {
  readonly content: readonly ContentBlock[];
}

export interface SessionAbortParams {
  readonly sessionId: string;
  readonly reason?: string;
}

export type SessionAbortResult = null;

export interface SessionQueueParams {
  readonly sessionId: string;
  readonly messages: readonly ContentBlock[];
}

export interface SessionQueueResult {
  readonly queuedIds: readonly string[];
}

export interface SessionSnapshotParams {
  readonly sessionId: string;
}

export interface SessionSnapshotResult {
  readonly snapshot: unknown;
}

export interface SessionRebindParams {
  readonly sessionId: string;
  /** Opaque to spec — adopter-typed; ADR 34 will tighten when auth lands. */
  readonly auth: unknown;
}

export type SessionRebindResult = null;

export interface SessionCloseParams {
  readonly sessionId: string;
}

export type SessionCloseResult = null;

// ============================================================================
// subscribe / unsubscribe — persistent (non-execution-bound) subscriptions
// ============================================================================

export interface SubscribeParams {
  readonly scope: SubscriptionScope;
  readonly query?: EventQuery;
  /** Resume from a previously-observed cursor. Omit to start from the
   *  log's head (live tail). */
  readonly fromCursor?: Cursor;
  readonly _meta?: RequestMeta;
}

export interface SubscribeResult {
  /** Server-allocated. Notifications correlate via this id. */
  readonly subscriptionId: string;
}

export interface UnsubscribeParams {
  readonly subscriptionId: string;
}

export type UnsubscribeResult = null;

// ============================================================================
// auth/* — auth lifecycle methods (full subsystem in ADR 34)
// ============================================================================

export interface AuthRefreshParams {
  readonly refreshToken?: string;
  readonly _meta?: RequestMeta;
}

export interface AuthRefreshResult {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly refreshToken?: string;
}

export interface AuthCompleteChallengeParams {
  readonly challengeId: string;
  readonly proof: unknown;
}

export interface AuthCompleteChallengeResult {
  readonly elevated: boolean;
  readonly validUntil?: number;
}

export interface AuthSignOutParams {
  readonly _meta?: RequestMeta;
}

export type AuthSignOutResult = null;

// ============================================================================
// ping — keepalive (MCP convention; either direction)
// ============================================================================

export type PingParams = Record<string, never>;
export type PingResult = Record<string, never>;

// ============================================================================
// Method registry — exhaustive map for OpenRPC generation + type safety
// ============================================================================

/**
 * Canonical map of every wire method to its (params, result) tuple.
 * Used by `@agentick/client-next` for typed `client.request(method, ...)`
 * and by `@agentick/wire-openrpc-next` (deferred) for schema export.
 *
 * Adopters extending the wire add entries via declaration merging:
 *
 * ```ts
 * declare module "@agentick/spec-next" {
 *   interface WireMethods {
 *     "tenant/list": { params: TenantListParams; result: TenantListResult };
 *   }
 * }
 * ```
 */
export interface WireMethods {
  "gateway/listApps": { params: GatewayListAppsParams; result: GatewayListAppsResult };
  "gateway/getApp": { params: GatewayGetAppParams; result: GatewayGetAppResult };

  "app/createSession": { params: AppCreateSessionParams; result: AppCreateSessionResult };
  "app/getSession": { params: AppGetSessionParams; result: AppGetSessionResult };
  "app/listSessions": { params: AppListSessionsParams; result: AppListSessionsResult };
  "app/runOnce": { params: AppRunOnceParams; result: AppRunOnceResult };
  "app/close": { params: AppCloseParams; result: AppCloseResult };

  "session/send": { params: SessionSendParams; result: SessionSendResult };
  "session/dispatch": { params: SessionDispatchParams; result: SessionDispatchResult };
  "session/abort": { params: SessionAbortParams; result: SessionAbortResult };
  "session/queue": { params: SessionQueueParams; result: SessionQueueResult };
  "session/snapshot": { params: SessionSnapshotParams; result: SessionSnapshotResult };
  "session/rebind": { params: SessionRebindParams; result: SessionRebindResult };
  "session/close": { params: SessionCloseParams; result: SessionCloseResult };

  subscribe: { params: SubscribeParams; result: SubscribeResult };
  unsubscribe: { params: UnsubscribeParams; result: UnsubscribeResult };

  "auth/refresh": { params: AuthRefreshParams; result: AuthRefreshResult };
  "auth/completeChallenge": {
    params: AuthCompleteChallengeParams;
    result: AuthCompleteChallengeResult;
  };
  "auth/signOut": { params: AuthSignOutParams; result: AuthSignOutResult };

  ping: { params: PingParams; result: PingResult };
}

export type WireMethod = keyof WireMethods;
export type WireParams<M extends WireMethod> = WireMethods[M]["params"];
export type WireResult<M extends WireMethod> = WireMethods[M]["result"];
