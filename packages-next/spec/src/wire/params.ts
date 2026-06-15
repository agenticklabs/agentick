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
import type { ExecutionTarget } from "../data/execution-target.js";
import type { SessionEntry, SessionFilter } from "../protocol/app-harness.js";
import type { Cursor } from "../protocol/event-log.js";
import type { SendMessageInput } from "../protocol/session-harness.js";
import type { RequestMeta } from "./json-rpc.js";
import type { SubscriptionScope } from "./scope.js";

/**
 * Base shape every wire request params extends. MCP allows `_meta` on
 * any request; we make that uniform so adopters can pass progress
 * tokens (or any future meta) on any method without forcing me to
 * remember which methods need it.
 */
export interface WireRequestParams {
  readonly _meta?: RequestMeta;
}

// ============================================================================
// gateway/* — runtime root methods
// ============================================================================

export interface GatewayListAppsParams extends WireRequestParams {}

export interface GatewayListAppsResult {
  readonly apps: readonly {
    readonly id: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }[];
}

export interface GatewayGetAppParams extends WireRequestParams {
  readonly appId: string;
}

export interface GatewayGetAppResult {
  readonly id: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// app/* — multi-session host methods
// ============================================================================

export interface AppCreateSessionParams extends WireRequestParams {
  readonly appId: string;
  readonly sessionId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AppCreateSessionResult {
  readonly sessionId: string;
}

export interface AppGetSessionParams extends WireRequestParams {
  readonly appId: string;
  readonly sessionId: string;
}

/**
 * Wire result reuses the canonical in-process `SessionEntry` type —
 * the shape is JSON-safe (string id, numeric timestamps, plain object
 * metadata) so it crosses the wire without translation.
 */
export type AppGetSessionResult = SessionEntry;

export interface AppListSessionsParams extends WireRequestParams {
  readonly appId: string;
  readonly filter?: SessionFilter;
}

export interface AppListSessionsResult {
  readonly sessions: readonly SessionEntry[];
}

/**
 * App-level one-shot send. Mirrors the in-process `RunOnceInput` shape
 * (`SendInput` minus non-wire fields like `signal`, `executor` reference,
 * `target` reference — those are server-side concerns).
 */
export interface AppRunOnceParams extends WireRequestParams {
  readonly appId: string;
  readonly messages?: ReadonlyArray<SendMessageInput>;
  readonly props?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly maxTicks?: number;
  readonly stream?: boolean;
  /** Per-call execution target by reference. Targets are JSON-shaped
   *  (model id + capabilities + provider options) so they cross the wire
   *  cleanly. */
  readonly target?: ExecutionTarget;
}

export interface AppRunOnceResult {
  readonly executionId: string;
  readonly finalCursor: Cursor;
  readonly result: ExecutionResult;
}

export interface AppCloseParams extends WireRequestParams {
  readonly appId: string;
}

export type AppCloseResult = null;

// ============================================================================
// session/* — execution + state methods
// ============================================================================

/**
 * Wire equivalent of the in-process `SendInput` shape. Drops non-wire
 * fields (`signal` — use `notifications/cancelled`; `executor` reference
 * — server-side only). `messages` carries `SendMessageInput[]` so role
 * and content cross the wire.
 *
 * `_meta.progressToken` opts the call into the LSP `$/progress` pattern:
 * server streams `notifications/progress` frames correlated by the token
 * while the RPC is in flight; final result returns on the original id.
 */
export interface SessionSendParams extends WireRequestParams {
  readonly sessionId: string;
  readonly messages?: ReadonlyArray<SendMessageInput>;
  readonly props?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly maxTicks?: number;
  readonly stream?: boolean;
  readonly target?: ExecutionTarget;
}

export interface SessionSendResult {
  readonly executionId: string;
  readonly finalCursor: Cursor;
  readonly result: ExecutionResult;
}

export interface SessionDispatchParams extends WireRequestParams {
  readonly sessionId: string;
  readonly tool: string;
  readonly input: unknown;
}

export interface SessionDispatchResult {
  readonly content: readonly ContentBlock[];
}

export interface SessionAbortParams extends WireRequestParams {
  readonly sessionId: string;
  readonly reason?: string;
}

export type SessionAbortResult = null;

export interface SessionQueueParams extends WireRequestParams {
  readonly sessionId: string;
  readonly messages: ReadonlyArray<SendMessageInput>;
}

export interface SessionQueueResult {
  readonly queuedIds: readonly string[];
}

export interface SessionSnapshotParams extends WireRequestParams {
  readonly sessionId: string;
}

export interface SessionSnapshotResult {
  readonly snapshot: unknown;
}

export interface SessionRebindParams extends WireRequestParams {
  readonly sessionId: string;
  /** Opaque to spec — adopter-typed; ADR 34 will tighten when auth lands. */
  readonly auth: unknown;
}

export type SessionRebindResult = null;

export interface SessionCloseParams extends WireRequestParams {
  readonly sessionId: string;
}

export type SessionCloseResult = null;

// ============================================================================
// session/respondToElicitation — client → server elicitation reply
// ============================================================================

/**
 * Client → server: delivers a structured response to an in-flight
 * elicitation prompt the server published on
 * `session:channel:elicitation`. The gateway routes this RPC to the
 * session's `ElicitationHarnessProtocol.respond({ correlationId,
 * outcome, value?, reason? })` — same `request-response` resolution
 * path cross-process inbox replies use.
 *
 * `correlationId` is the value carried on the request envelope's
 * `metadata.correlationId` field (the elicitation harness exposes it
 * to subscribers when publishing). `value` is required when
 * `outcome === "accepted"` for form-mode elicitations; the harness
 * re-validates it against the request's schema and surfaces schema
 * violations as `{ outcome: "failed", failure.kind:
 * "schema_violation" }` on the calling fiber.
 *
 * Idempotent: unknown / already-resolved correlationIds are silent
 * no-ops. First-write-wins on the registry.
 */
export interface SessionRespondToElicitationParams extends WireRequestParams {
  readonly sessionId: string;
  readonly correlationId: string;
  readonly outcome: "accepted" | "declined" | "cancelled";
  readonly value?: unknown;
  readonly reason?: string;
}

export type SessionRespondToElicitationResult = null;

// ============================================================================
// subscribe / unsubscribe — persistent (non-execution-bound) subscriptions
// ============================================================================

export interface SubscribeParams extends WireRequestParams {
  readonly scope: SubscriptionScope;
  readonly query?: EventQuery;
  /** Resume from a previously-observed cursor. Omit to start from the
   *  log's head (live tail). */
  readonly fromCursor?: Cursor;
}

export interface SubscribeResult {
  /** Server-allocated. Notifications correlate via this id. */
  readonly subscriptionId: string;
}

export interface UnsubscribeParams extends WireRequestParams {
  readonly subscriptionId: string;
}

export type UnsubscribeResult = null;

// ============================================================================
// auth/* — auth lifecycle methods (full subsystem in ADR 34)
// ============================================================================

export interface AuthRefreshParams extends WireRequestParams {
  readonly refreshToken?: string;
}

export interface AuthRefreshResult {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly refreshToken?: string;
}

export interface AuthCompleteChallengeParams extends WireRequestParams {
  readonly challengeId: string;
  readonly proof: unknown;
}

export interface AuthCompleteChallengeResult {
  readonly elevated: boolean;
  readonly validUntil?: number;
}

export interface AuthSignOutParams extends WireRequestParams {}

export type AuthSignOutResult = null;

// ============================================================================
// initialize / initialized — handshake (MCP convention)
// ============================================================================

/**
 * Capability handshake. First RPC after a connection opens. Mirrors
 * MCP's `initialize` — client advertises what it speaks; server
 * responds with what it speaks. The wire-version-negotiation parallel
 * to the WebSocket subprotocol, but works on every transport.
 *
 * Capabilities are declared structurally so adopters can extend via
 * declaration merging without breaking the wire.
 */
export interface InitializeParams extends WireRequestParams {
  /** Wire protocol version client speaks. Currently the only value is
   *  the literal "v1"; future incompatible changes bump. */
  readonly protocolVersion: "v1";
  readonly capabilities: ClientCapabilities;
  readonly clientInfo: { readonly name: string; readonly version: string };
}

export interface InitializeResult {
  readonly protocolVersion: "v1";
  readonly capabilities: ServerCapabilities;
  readonly serverInfo: { readonly name: string; readonly version: string };
  /** Server-allocated session-level context. Use on subsequent RPCs to
   *  pin to this gateway node (sticky session affinity). */
  readonly connectionId: string;
}

/**
 * Capability flags advertised by either side. Open for declaration-merge
 * extension as adopters add new capabilities.
 */
export interface ClientCapabilities {
  /** Client supports cursor-based resume on reconnect. */
  readonly cursorResume?: boolean;
  /** Client can render Streamable HTTP SSE responses. */
  readonly streamableHttp?: boolean;
  /** Client supports JSON-RPC 2.0 batch requests. */
  readonly batch?: boolean;
}

export interface ServerCapabilities {
  readonly cursorResume?: boolean;
  readonly streamableHttp?: boolean;
  readonly batch?: boolean;
  /** Server supports the `subscribe`/`unsubscribe` persistent subscription methods. */
  readonly subscriptions?: boolean;
  /** Server supports `_meta.progressToken` and emits `notifications/progress`. */
  readonly progress?: boolean;
  /** Server supports `notifications/cancelled`. */
  readonly cancellation?: boolean;
  /** Server hosts MCP methods (`tools/*`, `resources/*`, `prompts/*`) via
   *  `@agentick/mcp-surface-next` or equivalent. */
  readonly mcpSurface?: boolean;
}

// ============================================================================
// ping — keepalive (MCP convention; either direction)
// ============================================================================

export type PingParams = WireRequestParams;
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
  initialize: { params: InitializeParams; result: InitializeResult };

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
  "session/respondToElicitation": {
    params: SessionRespondToElicitationParams;
    result: SessionRespondToElicitationResult;
  };

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
