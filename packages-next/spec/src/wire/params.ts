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
import type { ClientToolDeclaration } from "../data/declarations.js";
import type { ToolResultInput } from "../data/tool-result.js";
import type { EventQuery } from "../data/events.js";
import type { ExecutionResult } from "../data/execution-result.js";
import type { ExecutionTarget } from "../data/execution-target.js";
import type { SessionEntry, SessionFilter } from "../protocol/app-harness.js";
import type { Cursor } from "../protocol/event-log.js";
import type { TimelineEntry } from "../protocol/session-harness.js";
import type {
  SendDelivery,
  SendMessageInput,
  SendResult,
  SendTelemetry,
} from "../protocol/session-harness.js";
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
  /**
   * Delivery semantics for a send that races an in-flight execution
   * (queue-item 4b). `"steer"` (default) injects into the running turn
   * at the next tick boundary; `"followUp"` waits for the session to
   * quiesce then runs a fresh turn. JSON-clean string enum — crosses the
   * wire trivially. See {@link SendInput.delivery} for full semantics.
   */
  readonly delivery?: SendDelivery;
  /**
   * Per-call telemetry identity (rung 2). JSON-clean (`functionId` string +
   * `metadata` bag) so it crosses the wire trivially. See
   * {@link SendInput.telemetry} for semantics (incl. the app-name default).
   */
  readonly telemetry?: SendTelemetry;
}

/**
 * `session/send` returns the session-scope {@link SendResult} —
 * session-level fields (`stopReason`, `ticks`, `response`) that the
 * client-side handle exposes on `.result`. `app/run_once` uses the
 * broader {@link ExecutionResult} shape instead — the two RPCs
 * return different projections deliberately.
 */
export interface SessionSendResult {
  readonly executionId: string;
  readonly finalCursor: Cursor;
  readonly result: SendResult;
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
// session/respond_to_elicitation — client → server elicitation reply
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
// session/set_client_tools — DECLARE a client's CLIENT-HANDLED tool set
// ============================================================================

/**
 * Client → server: DECLARE the client's full client-handled tool set for a
 * session. A client is a declarative tool SOURCE that owns a slice: it sends
 * its ENTIRE set, and the framework REPLACES the client slice wholesale — the
 * wire twin of the compiler's `replaceCompilerTools`. This one verb
 * subsumes register (a tool present in the set), unregister (a tool absent
 * from it), and idempotency (the set IS the truth — it's a replace, not an
 * accumulate). Reconnect = re-declare; drift-free by construction.
 *
 * Each `declarations` element is the serializable {@link ClientToolDeclaration}
 * slice (raw JSON-Schema `inputSchema`, no `handlerRef`). The gateway clears
 * the `{ scope: "client", sessionId }` slice
 * (`removeBoundTools({ binding: { scope: "client", sessionId } })`) then folds
 * each declaration into a client-handled `ToolRegistration` (via
 * `toClientToolRegistration`, `client` binding) and registers it. The tools
 * enter the model's tool list on the next `compileForTick`; a model call is
 * relayed to the client over the tool-call channel (answered with
 * {@link SessionRespondToToolCallParams}).
 *
 * The declarations carry no live validators — a wire client can't serialize a
 * function; each raw JSON Schema is wrapped server-side. This is the
 * JSON-Schema-not-StandardSchema wire constraint.
 *
 * **Multi-client caveat.** The client slice is keyed by `sessionId`, not by
 * connection — every client on a session shares ONE slice, so concurrent
 * `set_client_tools` calls are last-write-wins over the whole set. Coordinating
 * which client owns the tools (and handling unsupported-tool fallbacks) is the
 * APP's concern; the framework presumes nothing. Per-connection sub-slices are
 * a future extension.
 */
export interface SessionSetClientToolsParams extends WireRequestParams {
  readonly sessionId: string;
  readonly declarations: readonly ClientToolDeclaration[];
}

export interface SessionSetClientToolsResult {
  /** Number of client tools now installed in the slice (= `declarations.length`). */
  readonly count: number;
}

// ============================================================================
// session/respond_to_tool_call — relay a client's tool-call result back
// ============================================================================

/**
 * Client → server: deliver the result for a CLIENT-HANDLED tool call the
 * server relayed on `session:channel:tool_call`. The gateway routes this RPC
 * to the session tool executor's `respondToToolCall({ correlationId, result })`
 * — the same `request-response` resolution path elicitation replies use, so
 * the suspended `this.request(TOOL_CALL_CHANNEL, …)` dispatch resumes with the
 * client's result.
 *
 * `correlationId` is the value carried on the tool-call REQUEST envelope's
 * `metadata.correlationId`. `result` is the ADR 70 result currency
 * (`string` | `ContentBlock[]` | envelope). Idempotent: unknown /
 * already-resolved correlationIds are silent no-ops (first-write-wins).
 */
export interface SessionRespondToToolCallParams extends WireRequestParams {
  readonly sessionId: string;
  readonly correlationId: string;
  readonly result: ToolResultInput;
}

export type SessionRespondToToolCallResult = null;

// ============================================================================
// session/timeline_history — cursored read over TimelineStore.history (§6.3)
// ============================================================================

/**
 * Client → server: read a CURSORED, BOUNDED page of a session's durable
 * timeline log (friction #2). The wire read RPC over `TimelineStore.history`
 * (the `LogStore` cursored read) — side-effect-free, req-res. The gateway
 * routes it to the session timeline's `history({ fromSeq, limit })`, which
 * flushes the write-behind buffer first so the page reflects every completed
 * append.
 *
 * `fromSeq` is the cursor lower bound — entries with absolute `seq >= fromSeq`
 * (omit → from the log's start). `limit` caps the page (omit → the store's
 * own cap / no cap). Page forward by passing the previous result's
 * {@link SessionTimelineHistoryResult.nextFromSeq}. `session.timeline.prepend`
 * builds its lazy `loadOlder()` on this.
 */
export interface SessionTimelineHistoryParams extends WireRequestParams {
  readonly sessionId: string;
  /** Cursored lower bound — entries with absolute `seq >= fromSeq`. Omit → from the start. */
  readonly fromSeq?: number;
  /** Cap on entries returned in this page. Omit → no cap (the store's default). */
  readonly limit?: number;
}

/**
 * One entry of a timeline-history page — the store's seq-tagged entry, plus
 * the OPTIONAL co-located bus cursor (friction #3, §6.4). `seq` is the
 * `LogStore` ordering identity (strictly increasing, never reused, stable
 * across prune). `cursor` is the event-BUS position, returned ALONGSIDE `seq`
 * ONLY where the server co-locates the two — the honest Cursor-vs-seq
 * mitigation, NOT a unification (they remain distinct concepts). The bundled
 * `MemoryTimelineStore` does not co-locate a bus cursor, so `cursor` is absent
 * there; a store that persists both populates it.
 */
export interface SessionTimelineHistoryEntry {
  readonly seq: number;
  readonly entry: TimelineEntry;
  readonly cursor?: Cursor;
}

/**
 * A cursored page of timeline history. `entries` are seq-ordered. `nextFromSeq`
 * is the cursor to pass as the next `fromSeq` to continue paging; it is present
 * IFF the page was capped by `limit` (so there may be more) and absent when the
 * page reached the log's tail. Because `seq` is strictly-increasing but may be
 * sparse (a `BIGSERIAL` gap), `nextFromSeq` is `lastSeq + 1` — a valid lower
 * bound the next `seq >= fromSeq` query resolves correctly.
 */
export interface SessionTimelineHistoryResult {
  readonly entries: readonly SessionTimelineHistoryEntry[];
  readonly nextFromSeq?: number;
}

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
  readonly capabilities: ClientHandshakeCapabilities;
  readonly clientInfo: { readonly name: string; readonly version: string };
  /**
   * Scopes this client intends to use (#198, least privilege). The
   * connection's effective identity scopes become the cover-aware
   * INTERSECTION of the credential's claims and this request — a client
   * cannot widen its grants, only narrow its own blast radius. Omitted
   * = the credential's claims apply unnarrowed.
   *
   * Effective on transports that establish a connection identity
   * (WebSocket today); HTTP/UDS connections are currently anonymous
   * (TODO(trail-http-per-request-auth)) so there is nothing to narrow.
   * Meaningful under claims-consuming authorizers; the grant-table
   * staticAuthorizer ignores identity scopes by design.
   */
  readonly scopes?: readonly string[];
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
 * Handshake capability flags the client advertises to the server in
 * the `initialize.capabilities` field. Distinct from the client-side
 * aggregation type `ClientCapabilities` (see
 * `@agentick/spec-next/client/capabilities.ts`) which is the CLIENT's
 * view of the SERVER's capabilities plus registered extensions.
 *
 * Open for declaration-merge extension as adopters add new
 * capabilities.
 */
export interface ClientHandshakeCapabilities {
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
// _extensions/* — framework-internal capability discovery (ADR 46)
// ============================================================================

/**
 * Discovery info for a single wire extension registered on the gateway.
 * Returned by `_extensions/list`. Adopters / SDKs read this to gate
 * UI on feature availability.
 */
export interface ExtensionsListEntry {
  readonly name: string;
  readonly namespace: string;
  readonly version?: string;
  readonly methods: readonly string[];
  readonly notifications: readonly string[];
}

export type ExtensionsListParams = WireRequestParams;

export interface ExtensionsListResult {
  readonly extensions: readonly ExtensionsListEntry[];
}

// ============================================================================
// Method registry — exhaustive map for OpenRPC generation + type safety
// ============================================================================

/**
 * Canonical map of every wire method to its (params, result) tuple.
 * Used by `@agentick/client-core-next` for typed `client.request(method, ...)`
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

  "gateway/list_apps": { params: GatewayListAppsParams; result: GatewayListAppsResult };
  "gateway/get_app": { params: GatewayGetAppParams; result: GatewayGetAppResult };

  "app/create_session": { params: AppCreateSessionParams; result: AppCreateSessionResult };
  "app/get_session": { params: AppGetSessionParams; result: AppGetSessionResult };
  "app/list_sessions": { params: AppListSessionsParams; result: AppListSessionsResult };
  "app/run_once": { params: AppRunOnceParams; result: AppRunOnceResult };
  "app/close": { params: AppCloseParams; result: AppCloseResult };

  "session/send": { params: SessionSendParams; result: SessionSendResult };
  "session/dispatch": { params: SessionDispatchParams; result: SessionDispatchResult };
  "session/abort": { params: SessionAbortParams; result: SessionAbortResult };
  "session/queue": { params: SessionQueueParams; result: SessionQueueResult };
  "session/snapshot": { params: SessionSnapshotParams; result: SessionSnapshotResult };
  "session/rebind": { params: SessionRebindParams; result: SessionRebindResult };
  "session/close": { params: SessionCloseParams; result: SessionCloseResult };
  "session/respond_to_elicitation": {
    params: SessionRespondToElicitationParams;
    result: SessionRespondToElicitationResult;
  };
  /**
   * DECLARE a client's full CLIENT-HANDLED tool set into a session (raw
   * JSON-Schema inputs, no handlers) — a whole-slice replace, the wire twin
   * of the compiler's `replaceCompilerTools`. Session-namespace +
   * gateway-resident handler, so the row lives here (spec) rather than a
   * harness `declare module` augment — the gateway that owns
   * `sessionWireExtension` is harness-agnostic and can't depend on
   * `@agentick/tool-executor-next` to see an augment. Mirrors
   * `session/respond_to_elicitation`.
   */
  "session/set_client_tools": {
    params: SessionSetClientToolsParams;
    result: SessionSetClientToolsResult;
  };
  /** Relay a client's result for a suspended client-handled tool call. */
  "session/respond_to_tool_call": {
    params: SessionRespondToToolCallParams;
    result: SessionRespondToToolCallResult;
  };
  /**
   * Read a cursored, bounded page of a session's durable timeline log (§6.3 —
   * the deferred wire read over `TimelineStore.history`). Session-namespace +
   * gateway-resident handler, so the row lives here (spec) rather than a
   * `@agentick/timeline-next` `declare module` augment — the gateway that owns
   * `sessionWireExtension` is harness-agnostic and can't depend on the timeline
   * package to see an augment. Same rationale as `session/set_client_tools`.
   */
  "session/timeline_history": {
    params: SessionTimelineHistoryParams;
    result: SessionTimelineHistoryResult;
  };

  /**
   * Open a durable subscription on a scope's event bus. Server
   * allocates a `subscriptionId`; the client uses `sub/unsubscribe`
   * later to tear down. Wire-namespaced (per ADR 46) so the method
   * fits under `subscriptionsWireExtension`.
   */
  "sub/subscribe": { params: SubscribeParams; result: SubscribeResult };
  "sub/unsubscribe": { params: UnsubscribeParams; result: UnsubscribeResult };

  "auth/refresh": { params: AuthRefreshParams; result: AuthRefreshResult };
  "auth/completeChallenge": {
    params: AuthCompleteChallengeParams;
    result: AuthCompleteChallengeResult;
  };
  "auth/signOut": { params: AuthSignOutParams; result: AuthSignOutResult };

  ping: { params: PingParams; result: PingResult };

  /**
   * Capability discovery (ADR 46). Returns every wire extension
   * registered on the gateway: `{ name, namespace, version, methods,
   * notifications }[]`. SDKs call this immediately after `initialize`
   * to populate `client.capabilities`.
   *
   * The `_extensions` prefix is reserved for framework-internal
   * methods — adopter wire extensions can't claim it (validator
   * rejects).
   */
  "_extensions/list": { params: ExtensionsListParams; result: ExtensionsListResult };
}

export type WireMethod = keyof WireMethods;
export type WireParams<M extends WireMethod> = WireMethods[M]["params"];
export type WireResult<M extends WireMethod> = WireMethods[M]["result"];
