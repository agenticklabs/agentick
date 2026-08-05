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
import type { ClientToolDeclaration, ToolExposure } from "../data/declarations.js";
import type { ToolInfo } from "../protocol/tool-executor.js";
import type { ToolResultInput } from "../data/tool-result.js";
import type { EventQuery } from "../data/events.js";
import type { ExecutionResult } from "../data/execution-result.js";
import type { ExecutionTarget } from "../data/execution-target.js";
import type { ModelFacts } from "../data/model-facts.js";
import type { ResponseFormat } from "../data/rendered-tree.js";
import type { DestroySessionResult, SessionEntry, SessionFilter } from "../protocol/app-harness.js";
import type {
  GatewayDestroySessionResult,
  GatewaySessionEntry,
} from "../protocol/gateway-harness.js";
import type { Cursor } from "../protocol/event-log.js";
import type {
  OnBusy,
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

/**
 * One app as a client sees it. The same `id` / `title` / `description` triple a
 * tool or a prompt declares — an app is not the one entity with a bespoke
 * identity shape.
 *
 * `title` is also how a client resolves WHO answered in a session:
 * `SessionEntry.appId` joined to this. A live join by design, so renaming an app
 * relabels its threads instead of leaving them under the old name.
 */
export interface AppInfo {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface GatewayListAppsResult {
  readonly apps: readonly AppInfo[];
}

export interface GatewayGetAppParams extends WireRequestParams {
  readonly appId: string;
}

export type GatewayGetAppResult = AppInfo;

/**
 * `gateway/destroy_session` — the same destroy verb as `app/destroy_session`,
 * addressed WITHOUT an `appId`. The gateway resolves the owning app itself
 * (live registries first, then the apps' session stores), which is the point: a
 * client holding a session id from a cross-app listing should not have to carry
 * an app id alongside it just to delete a thread.
 *
 * Same two ownership gates as the app-level verb — the dispatch gate reads
 * `sessionId` for the live target, the handler re-checks the durable record.
 */
export interface GatewayDestroySessionParams extends WireRequestParams {
  readonly sessionId: string;
  /** Attribution for the aborts destroy issues. See `DestroySessionInput.reason`. */
  readonly reason?: string;
}

// The result is the protocol's own `GatewayDestroySessionResult` (the app-level
// result plus the resolved `appId`) — plain counts, booleans and a string, so it
// crosses the wire with no translation and needs no wire-local alias.

/**
 * `gateway/list_sessions` — every session on the gateway, in ONE list, without
 * the caller walking apps. The union of the mounted apps' session stores, each
 * entry stamped with the app that answered for it.
 *
 * Deliberately no `appId` filter: narrowing to one app is
 * `app/list_sessions`, which is the same page in the same order.
 */
export interface GatewayListSessionsParams extends WireRequestParams, SessionPageRequest {
  readonly filter?: SessionFilter;
}

/**
 * One page of the cross-app session list. Same envelope as
 * {@link AppListSessionsResult} — the merged ordering and the cursor contract
 * are identical; only the entry type differs, by the `appId` a cross-app row
 * cannot do without.
 */
export interface GatewayListSessionsResult {
  readonly sessions: readonly GatewaySessionEntry[];
  /** Opaque cursor for the next page; absent on the last page. */
  readonly nextCursor?: string;
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

/**
 * Look up what the SERVER knows about a model. The client keys this off the
 * `metadata.model` provenance already stamped on every assistant entry, so it
 * never has to guess which model produced a turn.
 *
 * App-scoped because the registry is: an adopter's `models` overrides are
 * merged over the seed once, at the app, and the same answer serves every
 * session.
 */
export interface AppModelInfoParams extends WireRequestParams {
  readonly appId: string;
  readonly provider: string;
  readonly modelId: string;
}

/**
 * The request echoed back with the answer, so a cached row is self-describing
 * and a late response cannot be filed under the wrong key.
 *
 * `info: null` is a legitimate answer, not an error — no layer describes that
 * model. The catalog never fabricates, so "unknown" has to be expressible.
 */
export interface AppModelInfoResult {
  readonly provider: string;
  readonly modelId: string;
  readonly info: ModelFacts | null;
}

/**
 * The paging half of a session-list request, shared by the app-scoped and the
 * gateway-wide verb so ONE place documents the cursor contract.
 *
 * The cursor is a **keyset** cursor, not an offset: it carries the sort key of
 * the last row of the page it came from, and the next page is everything that
 * sorts strictly after it. Sessions are ordered by last activity (newest
 * first), and last activity MOVES — a thread that receives a message while a
 * client is mid-walk jumps to the front of the list. Under an offset cursor
 * that shift re-serves rows the client already has; under a keyset cursor the
 * walk keeps its place because the place is a value in the list, not a count of
 * rows before it. (This is why `paginate()` in `@agentick/utils`, the offset
 * mechanism every static catalog surface pages with, is the wrong tool here.)
 *
 * A row that moves ahead of the cursor mid-walk is not seen again — it sorted
 * into a region the walk already passed. That is the keyset guarantee and the
 * point of it: no duplicates, and nothing that stayed put is skipped.
 */
export interface SessionPageRequest {
  /**
   * Opaque cursor from a prior reply's `nextCursor`; absent starts at page one.
   * Opaque means opaque — its encoding is the server's and may change. A cursor
   * the server cannot decode yields page one rather than an error, since a
   * client holding a stale cursor has no other recovery.
   */
  readonly cursor?: string;
  /** Max entries in the page. Defaults to the framework's page size (100). */
  readonly limit?: number;
}

/**
 * `app/list_sessions` — one app's durable session registry, paged.
 *
 * Scoped to the CALLER: a record stamped with another principal is not in the
 * page (ADR 48). Absent from the list, not an error — a list answers with what
 * you may see, and someone else's threads are not evidence you are owed.
 */
export interface AppListSessionsParams extends WireRequestParams, SessionPageRequest {
  readonly appId: string;
  readonly filter?: SessionFilter;
}

export interface AppListSessionsResult {
  readonly sessions: readonly SessionEntry[];
  /**
   * Opaque cursor for the next page; absent on the last page. Its presence IS
   * the "there is more" signal — a full page is not, since a page can be
   * exactly `limit` long and still be the last one.
   */
  readonly nextCursor?: string;
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

/**
 * `app/destroy_session` — the strongest, transitive session removal projected
 * over the wire. The `sessionId` param is load-bearing beyond addressing: the
 * dispatch gate resolves the TARGET session from it and applies the
 * same-principal rule (ADR 48 / ADR 51 §4.2), so a caller cannot destroy
 * another principal's live session. The handler re-checks the DURABLE record's
 * principal, because a session that is no longer live has no target for the
 * gate to resolve and its record would otherwise be unprotected.
 */
export interface AppDestroySessionParams extends WireRequestParams {
  readonly appId: string;
  readonly sessionId: string;
  /** Attribution for the aborts destroy issues. See `DestroySessionInput.reason`. */
  readonly reason?: string;
}

/**
 * Wire result reuses the canonical in-process {@link DestroySessionResult} —
 * plain counts and booleans, JSON-safe with no translation.
 */
export type AppDestroySessionResult = DestroySessionResult;

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
   * Behavior for a send that races an in-flight execution. `"steer"`
   * injects into the running turn at the next tick boundary; `"queue"`
   * waits for the session to quiesce then runs a fresh turn. Unset
   * resolves per send shape (structured sends → `"queue"`, plain →
   * `"steer"`). JSON-clean string enum — crosses the wire trivially. See
   * {@link SendInput.onBusy} for full semantics.
   */
  readonly onBusy?: OnBusy;
  /**
   * Per-call telemetry identity (rung 2). JSON-clean (`functionId` string +
   * `metadata` bag) so it crosses the wire trivially. See
   * {@link SendInput.telemetry} for semantics (incl. the app-name default).
   */
  readonly telemetry?: SendTelemetry;
  /**
   * Structured final turn — the declarative / wire-safe `responseFormat`
   * directive (trail-response-format-send). Fully serializable JSON, so it
   * threads straight through. A wire caller declares `responseFormat` and
   * parses the returned `response` text client-side. See
   * {@link SendInput.responseFormat}. (The live-schema sugar + typed
   * `SendResult.data` are deferred pending the multi-tick structured-output
   * design; nothing schema-shaped crosses the wire regardless.)
   */
  readonly responseFormat?: ResponseFormat;
  /**
   * Widen the `_meta.progressToken` progress fan from THIS execution to its
   * whole spawn tree: a `progress` signal emitted by any live descendant
   * session whose lineage reaches this execution rides the caller's token too.
   * Without it a sub-agent's `ctx.progress` is invisible to the caller that
   * started the turn — the descendant's signals carry the descendant's own
   * execution id, which the execution-scoped subscription cannot match.
   *
   * Observation only. It changes nothing about how the execution runs, and
   * signals only: execution EVENTS are unaffected (a child's interior events
   * stay on the child's handle — see `TickEndForwardDecision` for the seam that
   * decides what a child surfaces to its parent).
   *
   * Absent or `false` ⇒ byte-identical behavior to the pre-`fanIn` verb. See
   * {@link ClientSendInput.fanIn} for the client-facing door.
   */
  readonly fanIn?: boolean;
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

/**
 * Params for the preview verbs — `session/dry_run`, `session/compile`,
 * `session/project`. Compile what a tick would send, without sending it.
 *
 * The response carries the WHOLE prompt, which makes these the most sensitive
 * reads in the session namespace: system instructions, retrieved context, and
 * the user's identity block all cross. They resolve the session through the
 * same ownership rules as every other session verb, so a caller sees only their
 * own — but a deployment that treats prompt contents as privileged should gate
 * the namespace rather than assume authentication is enough.
 */
export interface SessionPreviewParams extends WireRequestParams {
  readonly sessionId: string;
}

/**
 * The rungs that cross the wire — the projection of the harness's
 * `SessionDryRunResult`. `request` (the provider-native one) is
 * deliberately absent: it is adapter-shaped and not guaranteed JSON-clean, so
 * it stays server-side where the adapter that produced it lives.
 */
export interface SessionDryRunWireResult {
  readonly tree: unknown;
  readonly input: unknown;
}

export interface SessionCompileResult {
  readonly tree: unknown;
}

export interface SessionProjectResult {
  readonly input: unknown;
}

export interface SessionDispatchParams extends WireRequestParams {
  readonly sessionId: string;
  readonly tool: string;
  readonly input: unknown;
}

export interface SessionDispatchResult {
  readonly content: readonly ContentBlock[];
}

/**
 * Params for `session/list_tools` — the wire read behind the client
 * `ToolsClientHandle`'s enumeration (three-audiences-plan §F). A DEDICATED
 * session-namespace method rather than a dynamic-lane surface: the tool executor
 * harness's inbox address is `tool:<sessionId>` (its scopeId is the bare
 * sessionId), which does NOT match the dynamic lane's
 * `<surface>:<sessionId>:<surface>` pattern — so `tools:list` cannot route there
 * without contorting either the lane or the executor's addressing. A
 * gateway-resident handler over `sess.tools.list(query)` is the honest fit,
 * mirroring `session/set_client_tools` (session-namespace, gateway-resident,
 * harness-agnostic).
 */
export interface SessionListToolsParams extends WireRequestParams {
  readonly sessionId: string;
  /** Optional exposure filter — mirrors `ToolsHandle.list({ exposure })`. */
  readonly exposure?: ToolExposure;
  /** Opaque cursor from a prior reply's `nextCursor`; absent starts at page one. */
  readonly cursor?: string;
}

/**
 * One page of tools — MCP-shaped (named collection key + `nextCursor`), the
 * envelope `resources/list` established. The session's in-process
 * `tools.list(query)` stays an unpaginated bounded snapshot; paging is a WIRE
 * concern and lives only here.
 */
export interface SessionListToolsResult {
  readonly tools: readonly ToolInfo[];
  /** Opaque cursor for the next page; absent on the last page. */
  readonly nextCursor?: string;
}

export interface SessionAbortParams extends WireRequestParams {
  readonly sessionId: string;
  readonly reason?: string;
  /**
   * Widen the abort to the session's live spawn subtree — see
   * `SessionAbortOptions.cascade`. Omitted (the default) is byte-identical to
   * the pre-cascade verb: only the addressed session's current execution stops.
   */
  readonly cascade?: boolean;
}

export type SessionAbortResult = null;

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
// subscribe / unsubscribe — persistent (non-execution-bound) subscriptions
// ============================================================================

export interface SubscribeParams extends WireRequestParams {
  /**
   * CLIENT-allocated subscription id, and the id every
   * `notifications/subscription/*` frame for this subscription correlates by.
   * The server adopts it verbatim rather than minting one of its own.
   *
   * Required, because the alternative loses frame one. A server-allocated id
   * is not knowable until the `sub/subscribe` RESPONSE lands, so a snapshot
   * frame that overtakes that response — trivially, over
   * `@agentick/transport-http`, where the response rides the POST body and
   * notifications ride a separate SSE GET with no ordering relation to it —
   * names a subscription the client cannot yet route and is dropped. Allocated
   * client-side, the stream is registered under its final id before the
   * request frame is even written, so no frame is ever unroutable on any
   * transport.
   *
   * MUST be unique per connection: the server refuses a collision with
   * `InvalidParams` rather than hijack the live subscription already answering
   * to that id.
   */
  readonly subscriptionId: string;
  readonly scope: SubscriptionScope;
  readonly query?: EventQuery;
  /** Resume from a previously-observed cursor. Omit to start from the
   *  log's head (live tail). */
  readonly fromCursor?: Cursor;
}

export interface SubscribeResult {
  /**
   * The client's {@link SubscribeParams.subscriptionId}, echoed back as
   * confirmation that the server adopted it. A response carrying anything
   * else means the server broke the adoption contract, and the client fails
   * the subscription rather than iterate a stream nothing will ever route to.
   */
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
 * The one wire protocol version this build speaks. Both ends compare against
 * it — the server against `InitializeParams.protocolVersion`, the client
 * against `InitializeResult.protocolVersion` — and a mismatch fails the
 * handshake with `WireRpcError.protocolVersionMismatch`. Bump on an
 * incompatible frame change.
 */
export const WIRE_PROTOCOL_VERSION = "v1";

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
 * `@agentick/spec/client/capabilities.ts`) which is the CLIENT's
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
   *  `@agentick/mcp-surface` or equivalent. */
  readonly mcpSurface?: boolean;
}

/**
 * What the transport SERVING a connection says about itself, supplied to the
 * wire dispatcher so `initialize` answers with the truth about the wire the
 * caller actually reached rather than a constant.
 *
 * Two kinds of fact live here, and only these two: the transport's identity
 * (→ `InitializeResult.serverInfo`) and the wire features the transport
 * itself implements — framing concerns the dispatcher cannot see, because
 * they are decided in the connection's decode path. Every other
 * {@link ServerCapabilities} flag is derived by the dispatcher from what is
 * actually registered on the host, so it does NOT appear here.
 *
 * TODO(wire-serverinfo-version): `version` is hand-declared per transport
 * package (matching `@agentick/client-core`'s `CLIENT_VERSION`). It becomes
 * real when the build injects each package's version; the plain-`tsc` build
 * has no define seam today.
 */
export interface WireServerDescriptor {
  /** Package name of the serving transport, e.g. `@agentick/transport-http`. */
  readonly name: string;
  readonly version: string;
  /** This wire decodes JSON-RPC batch arrays. */
  readonly batch?: boolean;
  /** This wire answers RPCs as Streamable-HTTP SSE. */
  readonly streamableHttp?: boolean;
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
 * Used by `@agentick/client-core` for typed `client.request(method, ...)`
 * and by `@agentick/wire-openrpc` (deferred) for schema export.
 *
 * Adopters extending the wire add entries via declaration merging:
 *
 * ```ts
 * declare module "@agentick/spec" {
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
  "gateway/destroy_session": {
    params: GatewayDestroySessionParams;
    result: GatewayDestroySessionResult;
  };
  "gateway/list_sessions": {
    params: GatewayListSessionsParams;
    result: GatewayListSessionsResult;
  };

  "app/create_session": { params: AppCreateSessionParams; result: AppCreateSessionResult };
  "app/get_session": { params: AppGetSessionParams; result: AppGetSessionResult };
  "app/model_info": { params: AppModelInfoParams; result: AppModelInfoResult };
  "app/list_sessions": { params: AppListSessionsParams; result: AppListSessionsResult };
  "app/destroy_session": { params: AppDestroySessionParams; result: AppDestroySessionResult };
  "app/run_once": { params: AppRunOnceParams; result: AppRunOnceResult };
  "app/close": { params: AppCloseParams; result: AppCloseResult };

  "session/send": { params: SessionSendParams; result: SessionSendResult };
  "session/dry_run": { params: SessionPreviewParams; result: SessionDryRunWireResult };
  "session/compile": { params: SessionPreviewParams; result: SessionCompileResult };
  "session/project": { params: SessionPreviewParams; result: SessionProjectResult };
  "session/dispatch": { params: SessionDispatchParams; result: SessionDispatchResult };
  "session/list_tools": { params: SessionListToolsParams; result: SessionListToolsResult };
  "session/abort": { params: SessionAbortParams; result: SessionAbortResult };
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
   * `@agentick/tool-executor` to see an augment. Mirrors
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

/**
 * The GATEWAY's wire-dispatch command map — every `WireMethods` row projected to
 * its `wire:<method>` operation with `{ input; output }` shaped from the row.
 * This is the type-level twin of the runtime op the gateway mints at
 * `runWireDispatch` (op `name: "wire:<method>"`, ADR 83 §"Wire dispatch through
 * the seam"): folding it into the runtime `CommandRegistry` (which
 * interface-extends this map) makes `CommandHooks` derive the FULLY-TYPED
 * gateway wire hooks — `onBeforeWire<Ns><Method>` / `onAfterWire<Ns><Method>` —
 * for both framework rows AND adopter `WireMethods` augmentations, with zero
 * per-method wiring. The `wire:` prefix is PERMANENT (ADR 83): it keeps the
 * gateway boundary op distinct from the domain op it delegates to
 * (`wire:session/send` → `WireSessionSend`, distinct from `session:send` →
 * `SessionSend`), so the two seams never collide under live inheritance.
 *
 * The keys are statically known (`WireMethod` is a finite literal union over
 * `keyof WireMethods`), so an `interface CommandRegistry extends WireCommandMap`
 * fold is legal and re-derives lazily whenever an adopter augments
 * `WireMethods` — the same statically-known-keys property {@link SessionHandle}
 * relies on for its wire-proxy surface.
 *
 * DISTINCT from the CLIENT's derivation (`@agentick/spec` `client/hooks.ts`
 * `WireAsCommandReg`), which keys each row UNPREFIXED (`session/send` →
 * `SessionSend`) because the client hook mirrors the session op it INITIATES and
 * has no colliding op of its own. The `Wire` qualifier belongs to the gateway.
 */
export type WireCommandMap = {
  [K in WireMethod as `wire:${K}`]: { input: WireParams<K>; output: WireResult<K> };
};
