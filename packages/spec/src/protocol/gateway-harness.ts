/**
 * `GatewayHarnessProtocol` — top-level harness in the v2 hierarchy.
 *
 * Per ADR 31, the harness graph is `GatewayHarness → AppHarness →
 * SessionHarness`. Gateway is the **runtime root** — owns the
 * top-level substrate (bus/inbox/journal) that Apps and Sessions
 * below inherit or wrap.
 *
 * Per `blueprint/12-gateway.md`, Gateway is useful in every
 * deployment tier:
 *   - Tier 0 (embedded library) — constructed in-process, no transports
 *   - Tier 1 (local single-user agent) — OpenClaw / Hermes style
 *   - Tier 2 (single-tenant cloud) — co-located gateway + runtime
 *   - Tier 3 (multi-tenant distributed) — cluster substrate at gateway slots
 *
 * **Network transports + plugins + auth are extensions**, not the
 * Gateway itself. This protocol defines the runtime-root surface;
 * each transport / plugin ships as its own package satisfying the
 * `GatewayExtension` shape (see `app-extension.ts`).
 *
 * Phase 4 of the v2 build ships the thin GatewayHarness — items
 * GG1–GG4 + GE1–GE2 in V1-GATEWAY-PARITY-TRACKER.md. Transports,
 * plugins, auth, methods, etc. defer to Phase 5+ in their own
 * packages.
 */

import type { EventQuery, ProtocolEvent } from "../data/events.js";
import type { EventBus, EventBusFactory, ScopeNodeLease, SubscribeOptions } from "./bus.js";
import type { OperationJournal, OperationJournalFactory } from "./journal.js";
import type { MessageInbox, MessageInboxFactory } from "./inbox.js";
import type {
  AppHarnessProtocol,
  DestroySessionInput,
  DestroySessionResult,
  IdentityScopedApp,
  SessionEntry,
} from "./app-harness.js";
import type { IngressIdentity } from "../wire/authorizer.js";
import type { IdentityScoped } from "./identity.js";
import type { Connectors } from "./connectors-harness.js";
import type { SessionRecord, SessionStoreQuery } from "./session-store.js";
import type { CursorPage, PageRequest } from "./paging.js";
import type { WireExtensionRegistry } from "../wire/registry.js";
import type { WireExtensionContext } from "../wire/extension.js";
import type { WireMethod } from "../wire/params.js";
import type {
  AuthorizeInput,
  AuthorizeResult,
  ConnectionInfo,
  IngressContext,
} from "../wire/authorizer.js";

// ============================================================================
// Gateway substrate parent
// ============================================================================

/**
 * Substrate parent shape exposed to gateway-level factories. Mirror of
 * `SessionSubstrateParent` / app's installer-substrate; same fields,
 * different scope.
 *
 * Factories at gateway substrate slots receive this; they can read
 * `parent.metadata` (adopter-supplied) for tenancy-aware
 * construction, wrap the parent's bus/inbox/journal for fan-in
 * composition, etc.
 */
export interface GatewaySubstrateParent {
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly bus: EventBus;
  readonly inbox: MessageInbox;
  readonly journal: OperationJournal;
  onClose(handler: () => void | Promise<void>): void;
}

// ============================================================================
// CreateAppInput — input to gateway.createApp(input)
// ============================================================================

/**
 * Input shape for `gateway.createApp(input)`. Mirrors the App-level
 * construction options, with the addition that the App's substrate
 * slots default to Gateway's substrate (fan-in writes, isolated
 * reads — the canonical composition).
 *
 * `rootElement` is required and matches the App-level field of the
 * same name. `options` is opaque to spec — concrete shape lives in
 * `@agentick/app`'s `AppHarnessOptions<P>`. Spec defines the gateway-
 * level fields (id, metadata, substrate) and routes the rest opaquely.
 */
export interface CreateAppInput<P = unknown> {
  /** Stable app id within this Gateway. Defaults to `app:${generateId()}`. */
  readonly appId?: string;
  /** Per-app metadata bag. Surfaces to App-level substrate factories. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Root agent element passed to every session's compiler mount.
   * Opaque to spec (avoids a React dep); concrete type contract lives
   * in `@agentick/app`'s compiler.
   */
  readonly rootElement: unknown;
  /**
   * Opaque App-level construction options sans `rootElement` /
   * `appId` (supplied at the gateway level). Concrete shape is
   * `Omit<AppHarnessOptions<P>, "rootElement" | "appId">` from
   * `@agentick/app`; spec accepts it as opaque to avoid pulling the
   * App package into spec's dep graph.
   */
  readonly options: AppOptionsOpaque<P>;
  /**
   * Per-app substrate overrides. When omitted, the App inherits the
   * Gateway's substrate by default (BaseHarness slot pattern handles
   * factory resolution).
   */
  readonly bus?: EventBus | EventBusFactory<GatewaySubstrateParent>;
  readonly inbox?: MessageInbox | MessageInboxFactory<GatewaySubstrateParent>;
  readonly journal?: OperationJournal | OperationJournalFactory<GatewaySubstrateParent>;
}

/**
 * Opaque marker for the App-level options. Concrete shape lives in
 * `@agentick/app`'s `AppHarnessOptions<P>`. Cast at the
 * `GatewayHarness` implementation boundary.
 */
export type AppOptionsOpaque<P = unknown> = unknown & { readonly __appOptionsBrand?: P };

// ============================================================================
// GatewayHarnessProtocol
// ============================================================================

/**
 * Gateway error envelope — migrated to class hierarchy (ADR 41
 * cluster 2). Re-exports from `../errors/lifecycle.js`.
 */
export {
  AppAlreadyExistsError,
  AppNotFoundError,
  GatewayClosedError,
  GatewayError,
  type GatewayErrorChannel,
  GatewayLifecycleError,
  GatewayNotStartedError,
} from "../errors/lifecycle.js";

/**
 * What the gateway's {@link GatewayHarnessProtocol.destroySession} did — the
 * app-level {@link DestroySessionResult} plus the app the gateway RESOLVED the
 * session to.
 *
 * `appId` is the whole point of the gateway-level verb: the caller addressed a
 * session without naming an app, so the answer has to say which app owned it.
 * Absent when no app claimed the id — the idempotent miss.
 */
export interface GatewayDestroySessionResult extends DestroySessionResult {
  readonly appId?: string;
}

/**
 * A {@link SessionRecord} from the gateway's cross-app list, with the app that
 * answered for it NAMED — `appId` narrowed from optional to required.
 *
 * The gateway stamps it from the app whose store produced the record, not from
 * the record's own field: the app is a fact about where the row was read, and
 * reading it from the row would let a stale or unstamped record misattribute a
 * session the gateway just resolved correctly.
 */
export interface GatewaySessionRecord extends SessionRecord {
  readonly appId: string;
}

/**
 * The wire projection of a {@link GatewaySessionRecord} — a {@link SessionEntry}
 * plus its `appId`.
 *
 * `SessionEntry` deliberately carries no `appId`, because a client reaching
 * sessions THROUGH an app handle already knows which app answered. A cross-app
 * list is precisely the case that reasoning does not cover: the caller asked the
 * gateway, so nothing but the row itself can say which app the session belongs
 * to — and without it the caller cannot address the session's app-scoped verbs
 * or join the app's `title` to render who answered.
 */
export interface GatewaySessionEntry extends SessionEntry {
  readonly appId: string;
}

/**
 * The runtime-root harness protocol.
 */
/**
 * What a gateway does with a caller's `_meta.traceparent`.
 *
 * @see {@link GatewayHarnessProtocol.remoteParent}
 */
export type RemoteParentPolicy = "ignore" | "link" | "parent";

/**
 * A gateway handle scoped to an authenticated identity — the return of
 * {@link GatewayHarnessProtocol.as}, and the local pole's door onto the SAME
 * mechanism a transport dispatch runs.
 *
 * "Wire" in agentick was never the socket — it is the trust boundary: a
 * dispatch whose authority comes from an authenticated identity rather than
 * from being the host. This handle is that boundary without the framing:
 * calls route through the gateway's wire dispatch seam (`wire:app/…` op →
 * `onBeforeWire…` hooks → authorizer → ADR-48 principal stamp), then land on
 * the LOCAL harness — so the session that comes back keeps full local powers
 * (structured `output`, handler-carrying `tools`) that the serialized wire
 * cannot carry. One policy chokepoint, both doors.
 */
export interface IdentityScopedGateway extends IdentityScoped {
  /**
   * The identity-scoped twin of {@link GatewayHarnessProtocol.app}: resolve a
   * mounted app, `undefined` when no app claims the id. The returned handle's
   * verbs run as the scoped identity.
   */
  app(appId: string): IdentityScopedApp | undefined;
}

export interface GatewayHarnessProtocol {
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Resolved after construction substrate slots are wired. */
  readonly ready: Promise<void>;

  // Substrate (bus/inbox/journal) is protected on the impl, matching
  // AppHarnessProtocol / SessionHarnessProtocol. Adopters access
  // substrate through methods like `events(filter, options)` rather
  // than the slots directly.

  // ─── Apps (read-side) ───────────────────────────────────────────
  //
  // The construction side (`createApp(input)`) is impl-specific —
  // each concrete `GatewayHarness` exposes its own typed input shape
  // matching its App factory. The protocol declares the read-side
  // accessors so adopters typed against `GatewayHarnessProtocol`
  // can enumerate + look up apps. To construct apps, type against
  // the concrete impl (e.g., `GatewayHarness` from
  // `@agentick/gateway/v2`) rather than the protocol.

  /** Look up a registered App by id. */
  app(appId: string): AppHarnessProtocol | undefined;

  /**
   * Act as an authenticated identity — see {@link IdentityScopedGateway}.
   *
   * Trust contract: does NOT authenticate. Verify the credential first (an
   * `AuthSource`); the identity handed here is taken as the authority, and
   * from here on stamping + policy are the framework's job.
   */
  as(identity: IngressIdentity): IdentityScopedGateway;

  // ─── Connectors (ADR 104) ───────────────────────────────────────

  /**
   * The built-in connectors harness — external event sources bound to hosted
   * apps. Always present (empty when no connectors are configured). Populated
   * via `createGateway({ connectors: [...] })` or `connectors.register(spec)`.
   */
  readonly connectors: Connectors;

  /** Enumerate all registered Apps. */
  apps(): readonly AppHarnessProtocol[];

  // ─── Scope nodes (ADR 102) ──────────────────────────────────────
  //
  // The gateway is the single source of the tree: it derives every hosted
  // app's session placement from `sessionNodeFor` and hands out attachments
  // against the same registry, so a subscriber attaches where sessions land.

  /**
   * The scope-node path this identity's sessions live on. `[]` is the root —
   * an unauthenticated caller at the local pole sees everything.
   */
  sessionNodeFor(identity: IngressIdentity | undefined): readonly string[];

  /**
   * Every node this identity may attach to. Widening it beyond
   * {@link sessionNodeFor} — a tenant node for an operator, a room node for a
   * member — is one decision made once at attachment.
   */
  attachableNodesFor(identity: IngressIdentity | undefined): readonly (readonly string[])[];

  /**
   * Hold the node at `path` open and read its subtree. The caller releases the
   * lease when its attachment ends; the last release out closes the node.
   */
  attachScopeNode(path: readonly string[]): ScopeNodeLease;

  /**
   * Which mounted app owns this session — gateway-level ADDRESS RESOLUTION, so a
   * caller holding only a `sessionId` can reach it without knowing (or being
   * told) the app.
   *
   * Two passes, in this order: the apps' LIVE registries first (the cheap
   * synchronous read), then their durable session stores. The second pass is
   * what makes the resolution honest for a paged-out or closed session — the
   * ones a live-only lookup silently reports as unknown. `undefined` when no
   * mounted app claims the id.
   */
  appForSession(sessionId: string): Promise<AppHarnessProtocol | undefined>;

  /**
   * Destroy a session by id, WITHOUT the caller naming its app — the
   * gateway-level twin of {@link AppHarnessProtocol.destroySession}, and the
   * same verb in every respect but addressing. Resolves the owning app via
   * {@link appForSession}, then delegates; the destruction semantics (transitive
   * abort, detached-task reap, subtree disposal, record delete) are the app's,
   * unchanged.
   *
   * Idempotent for the same reason the app-level verb is, one level further out:
   * a session no mounted app claims resolves to nothing, and the result reports
   * `live.found: false` / `record.existed: false` with no `appId` rather than
   * raising.
   *
   * NOT wrapped in a gateway op: the destruction it delegates to IS an op
   * (`app:command:destroy-session`), so wrapping here would mint a second
   * envelope for one destruction. The wire boundary journals the call itself.
   */
  destroySession(
    sessionId: string,
    opts?: DestroySessionInput,
  ): Promise<GatewayDestroySessionResult>;

  /**
   * Every session across every mounted app, as ONE list — the gateway-level
   * twin of {@link AppHarnessProtocol.listSessions}, and the enumeration half of
   * the pair {@link destroySession} completes (a caller that can delete a
   * session by id without naming its app must be able to FIND one the same way).
   *
   * The union of the mounted apps' session stores, each record stamped with the
   * app that produced it and the whole merged and sorted by last activity
   * (`updatedAt` descending, `id` then `appId` breaking ties) — one total order
   * over the union, so a page taken from it is a page of the same list every
   * time. A store that throws contributes nothing rather than failing the
   * enumeration, matching {@link appForSession}: one sick app must not blind the
   * gateway to the rest.
   *
   * **Two modes, and which one you get is a deployment decision.** When a
   * {@link SessionIndex} is mounted (`createGateway({ sessionIndex })`) this
   * delegates to it: ONE query per page, one cursor the index minted, and the
   * index's own ordering. When none is mounted it falls back to reading every
   * mounted app's store and merging them — correct, but N reads per page, and
   * the framework imposes the merged order because a merge over independently
   * ordered sources has no other option. The fallback is the degraded mode; an
   * adopter at any scale mounts the index.
   *
   * Either way the cursor is opaque and the envelope is identical, so a caller
   * cannot tell which mode answered — only how fast.
   *
   * Paged rather than a bounded snapshot, unlike
   * {@link AppHarnessProtocol.listSessions}: the whole point of the index seam
   * is that paging reaches the source, and a snapshot-returning verb would have
   * to read everything before the index could help.
   *
   * @see docs/proposals/v2/blueprint — `SessionIndex` and the gateway-index pattern.
   */
  listSessions(
    query?: SessionStoreQuery,
    page?: PageRequest,
  ): Promise<CursorPage<GatewaySessionRecord>>;

  /**
   * The gateway's identity-authorization policy (ADR 51 §4). The wire
   * dispatch choke point reads it — EVERY wire method (porcelain and
   * dynamic) is authorized with its verb-derived scope label before the
   * handler runs (§3.3 anti-bypass: one gate, both lanes).
   */
  readonly authorizer?: import("../wire/authorizer.js").Authorizer;

  /**
   * Client tool-output projection policy (ROADMAP A3) — STRICTLY OPT-IN.
   * When present, the wire dispatch boundary (`dispatchRequest` in
   * `@agentick/transport`) bounds oversized tool-result content on
   * EVERY client-facing frame (RPC results + progress/subscription
   * notifications) — never the model path, never the durable store.
   * Configured once on the gateway (via
   * {@link import("../data/tool-output-bound.js").resolveTruncateToolResults}
   * from the user-facing `truncateToolResults` setting), so all attached
   * transports inherit one policy (no straddle).
   *
   * Absent (`undefined`) is the DEFAULT and means OFF: the dispatcher does
   * ZERO projection work — the result and notifications flow through
   * untouched (zero overhead). A bare stub host that omits it is off too.
   * Bounding is app-UX policy the adopter opts into, not a framework default
   * (unlike security defaults, which protect the operator and ship on).
   */
  readonly clientProjection?: import("../data/tool-output-bound.js").ToolOutputBounder;
  /**
   * What to do with a `_meta.traceparent` on an inbound request.
   *
   * The caller is UNTRUSTED and the header is caller-controlled, so this is a
   * trust decision and it lives at the wire boundary rather than in the span
   * machinery:
   *
   *   - `"link"` (default) — record the caller's span as a LINK. The two traces
   *     stay joinable in a backend without adopting the caller's sampling
   *     choice, which is what stops a browser forcing 100% sampling and driving
   *     someone else's telemetry bill.
   *   - `"parent"` — adopt it as the parent. ONE tree end to end, and the right
   *     answer for a first-party client you control. A deliberate widening, the
   *     way `web-security` ships closed and is opened explicitly.
   *   - `"ignore"` — drop it. Two independent trees.
   *
   * OTel's own guidance for public endpoints is not to trust a remote parent by
   * default, which is why `link` is the floor rather than `parent`.
   */
  readonly remoteParent?: RemoteParentPolicy;

  /**
   * The **fine contextual** authorization layer (ADR 84 §5). Wraps
   * {@link authorizer}.authorize in the hookable `authorizer:authorize` op,
   * so `onBeforeAuthorizerAuthorize` can augment the {@link AuthorizeInput}
   * from request context (grant a contextual scope) or throw to deny, and
   * `onAfterAuthorizerAuthorize` can observe/audit the decision. The wire
   * dispatch gate (`authorizeDispatch` in `@agentick/transport`) routes
   * its policy calls through THIS method rather than {@link authorizer}
   * directly.
   *
   * The **structural ceiling** (`SessionHarnessProtocol.requiredScopes`)
   * stays un-waivable and OUTSIDE this seam — it is checked BEFORE this op
   * ever fires, so no hook can widen it. This method is only the policy
   * layer that sits ON TOP of that floor.
   *
   * A stub host may implement it as a pass-through to its authorizer; the
   * reference `GatewayHarness` routes through `runOperation`.
   */
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;

  /**
   * Per-connection admission (ADR 84 §4). Fired ONCE per newly-accepted
   * persistent connection by a connection-oriented transport (WebSocket, Unix
   * socket) — AFTER ingress-authn and BEFORE the connection is wired to receive
   * frames. Wraps a `gateway:accept` op through `runOperation`, so
   * `onBeforeGatewayAccept` sees the {@link ConnectionInfo} and can gate /
   * rate-limit / observe (throw to REJECT the connection — the transport drops
   * it), and `onAfterGatewayAccept` observes the admission.
   *
   * A **connection** concept, deliberately distinct from {@link authorize}
   * (the per-request policy layer): request-oriented HTTP does NOT call this —
   * its admission is per-request `authorize`, not per-connection `accept`. Only
   * a bound transport calls it, and a transport only accepts connections after
   * `listen()`, so a live connection already implies a started gateway (no
   * redundant started-gate here).
   *
   * A stub host may implement it as a no-op; the reference `GatewayHarness`
   * routes through `runOperation`.
   */
  accept(info: ConnectionInfo): Promise<void>;

  // ─── Lifecycle ──────────────────────────────────────────────────

  /**
   * Bind the gateway's server transports and flip ready (ADR 84 §1). The
   * canonical server start verb — pairs with {@link close}, reads identically
   * to each `transport.listen()`. Fans out to every owned `ServerTransport`
   * (that abstraction lands in a later arc); `listen()` on zero transports is
   * a no-op that just flips ready. Idempotent — a second call is a safe no-op.
   *
   * Runs as the hookable `gateway:start` op, so `onBeforeGatewayStart` can
   * gate/feature-flag transports and `onAfterGatewayStart` can observe bound
   * addresses.
   *
   * REQUIRED before app hosting (ADR 84 §1): `createApp` is gated on it and
   * throws `GatewayNotStartedError` until `listen()` has run, so the
   * `gateway:start` seam is guaranteed to fire before any app mounts.
   *
   * @see docs/proposals/v2/blueprint/84-gateway-lifecycle-and-transports.md
   */
  listen(): Promise<void>;

  /**
   * Terminal teardown, symmetric with {@link listen} (ADR 84 §1). The sole
   * terminal verb: closes every App, runs substrate teardown, and emits
   * `gateway:lifecycle:closed`. Takes the graceful-vs-forced `{ drain }`
   * argument: `close({ drain: false })` forces teardown. Drain-by-default.
   * There is NO `destroy()` twin — graceful-vs-forced is a parameter, not a
   * second verb. Subsequent app-hosting calls reject with `GatewayClosedError`.
   *
   * Close-op envelopes are bus-only per the Operation framework's
   * `JournalingPolicy.override` (matches `app.closeApp` semantics).
   */
  close(opts?: { readonly drain?: boolean }): Promise<void>;

  // ─── Observation ────────────────────────────────────────────────

  /**
   * Subscribe to events across every App. Same shape as
   * `app.events(filter, options)` — Phase C's cursor surface
   * (`SubscribeOptions.fromCursor`) flows through.
   */
  events(filter?: EventQuery, options?: SubscribeOptions): AsyncIterable<ProtocolEvent>;

  // ─── Wire extensions (ADR 46) ───────────────────────────────────

  /**
   * The gateway's registry of {@link WireExtension} values. The wire
   * dispatcher (in `@agentick/transport`) consults it to route
   * incoming JSON-RPC frames to extension-registered handlers.
   *
   * Optional on the protocol so lightweight test stubs and older
   * gateway impls don't need to implement it — dispatchers fall back
   * to the hardcoded built-in switch when the registry is absent.
   * Real gateway impls (`@agentick/gateway`) always populate
   * one.
   *
   * The returned registry is sealed by construction time — callers
   * cannot register new extensions post-hoc.
   *
   * @see docs/proposals/v2/blueprint/46-wire-extensions.md
   */
  wireExtensions?(): WireExtensionRegistry;

  /**
   * Run a wire (JSON-RPC) dispatch through the gateway's operation seam
   * (ADR 83 §"Wire dispatch through the seam"). The transport dispatcher
   * routes the resolved handler call through this so the wire method
   * fires the gateway's interceptor seam (gateway-scoped guards/hooks)
   * — op name = the `wire:`-prefixed wire method (`wire:session/send`),
   * which `deriveHookNames` Pascalizes to `WireSessionSend`, minting
   * `onBeforeWireSessionSend` at the gateway scope.
   *
   * `authorizeDispatch` stays the un-waivable pre-gate: it runs BEFORE
   * this op, so authz composes ahead of any userland wire hook. The
   * `wire:` prefix (ADR 83 wire section) keeps the wire boundary op name
   * DISTINCT from the `session:send` op it delegates to, so a gateway
   * `onBeforeSessionSend` (which now folds down LIVE to the session,
   * ADR 83 §4) fires once at the session op and the wire hook
   * `onBeforeWireSessionSend` fires once at the boundary — two distinct
   * seams, no collision.
   *
   * The `ctx` handed to the resolved handler is enriched IN-FIBER here with the
   * gateway's {@link import("../data/observability.js").Observability} +
   * {@link import("../data/ops.js").Ops} facets (ADR 64/78/19/83), built from
   * the captured op runtime + the gateway's telemetry provider: the wire
   * handler's `ctx.trace` then parents under this wire dispatch op and its
   * `ctx.metrics` reaches the gateway meter with the ambient `{ method }` label.
   * A stub host that does no telemetry may leave the facets untouched (the
   * dispatcher pre-seeds off-path no-ops).
   *
   * `run` receives the op's INPUT — the params AFTER the interceptor cascade's
   * before-hooks ran, so a `onBeforeWire<...>` hook that RESHAPES the params is
   * honored: the reshaped value is what reaches the resolved handler. (A hook
   * that only observes returns `void`, and `run` receives the original params.)
   *
   * Required — the seam is part of the gateway contract, not an optional
   * capability. A stub host implements it as a pass-through
   * (`(_m, params, _ctx, run) => run(params)`); the reference `GatewayHarness`
   * routes through `runOperation`.
   *
   * @param method - the raw wire method being dispatched (op name).
   * @param params - the request params (the op's input).
   * @param ctx - the wire-extension handler context to enrich in-fiber with facets.
   * @param run - invokes the resolved handler with the (possibly hook-reshaped)
   *   params; its result is the op result.
   */
  runWireDispatch<R>(
    method: WireMethod,
    params: unknown,
    ctx: WireExtensionContext,
    run: (params: unknown) => Promise<R>,
  ): Promise<R>;

  /**
   * Emit the control-plane signal that the gateway's wire-extension
   * set changed (ADR 47). Appends a {@link GATEWAY_CAPABILITIES_CHANGED}
   * event to the gateway bus on the gateway scope; clients subscribed
   * to the gateway control-plane scope (every `@agentick/client-core`
   * does so on connect) receive it via `notifications/subscription/event`
   * and refetch `_extensions/list`.
   *
   * Optional on the protocol so lightweight stubs need not implement
   * it — real gateways always do. #308 (dynamic wire extensions) is
   * the primary caller; today it's driven manually / in tests.
   *
   * Replaces the ripped-out `notify` / `acceptConnection` bespoke
   * fan-out: server→client reactive signals ride the bus, delivered
   * over the existing `sub/subscribe` channel, isolated per-instance
   * (per-tenant / per-principal child bus) rather than by a runtime
   * filter predicate.
   */
  emitCapabilitiesChanged?(): void;

  /**
   * Publish the {@link GATEWAY_ADMISSION_FAILED} event for an ingress crossing
   * that was REFUSED at admission (ADR 92 §Family 1.3). A transport edge calls
   * this from its rejection path — `authenticateIngress` reports the failure to
   * the caller, which forwards it here.
   *
   * Deliberately an EVENT, not an operation: admission denied means no work
   * unit exists, so there is nothing to journal as one. But the audit trail
   * must still see the attempt — a probing client that never gets past 401
   * would otherwise leave no trace at all. Twin of the MCP server's
   * `mcpServer:admission:failed`.
   *
   * Optional on the protocol so lightweight stub hosts need not implement it
   * (same convention as {@link emitCapabilitiesChanged}); the reference
   * `GatewayHarness` always does.
   */
  emitAdmissionFailure?(failure: IngressAdmissionFailure): void;
}

/**
 * Event name for the ingress admission-failure signal (ADR 92 §Family 1.3).
 * Published on `surface: "gateway"` with `phase: "terminal"` /
 * `outcome: "failed"`; payload is {@link IngressAdmissionFailure}.
 */
export const GATEWAY_ADMISSION_FAILED = "gateway:admission:failed";

/**
 * How an inbound crossing failed admission at a transport edge.
 *
 * One member today: the configured {@link import("../wire/authorizer.js").AuthSource}
 * refused the crossing. Kept a union because the edge has other admission
 * gates that are candidates for the same visibility (the web-security
 * origin/host check ahead of authn) — see the TODO at the http/ws edges.
 */
export type IngressAdmissionFailureClass = "authenticate";

/**
 * The admission-failure payload — the connection SHAPE plus why it was
 * refused.
 *
 * **Never credential material.** No token, no `Authorization` header, no
 * header bag: the credentials-never-cross-the-wire law extends to the audit
 * trail, which is exactly where a leaked bearer would be most durable. The
 * `reason` is the rejecting `AuthSource`'s own message, reduced to a string —
 * an AuthSource that puts a token in its error message leaks it into its own
 * error either way; the framework adds nothing.
 */
export interface IngressAdmissionFailure {
  readonly failureClass: IngressAdmissionFailureClass;
  /** Which edge produced the refused crossing. */
  readonly transportKind: IngressContext["transportKind"];
  /** Connection id where the transport has one (stateful edges). */
  readonly connectionId?: string;
  /** Peer address, when the edge knows one — the audit trail's attribution. */
  readonly remoteAddress?: string;
  /** Short, non-sensitive description of the refusal. */
  readonly reason?: string;
}

/**
 * Event name for the control-plane "wire-extension set changed"
 * signal (ADR 47). Published on `surface: "gateway"`. Clients match
 * on this to trigger an `_extensions/list` refetch.
 */
export const GATEWAY_CAPABILITIES_CHANGED = "gateway:capabilities:changed";

// ============================================================================
// Gateway extension protocol
// ============================================================================

/**
 * Typed bag of extension-installed harnesses reachable via
 * `gateway.extensions.<name>`. Extension packages augment this
 * interface via TypeScript module augmentation:
 *
 *   declare module "@agentick/spec" {
 *     interface GatewayExtensions {
 *       readonly httpSse?: HttpSseTransport;
 *     }
 *   }
 *
 * Slots are optional — adopters who don't install the extension see
 * `undefined` at the type level too.
 */
export interface GatewayExtensions {}

// ============================================================================
// GatewayHarnessFactory — per-child construction
// ============================================================================

import type { Factory } from "./factory.js";

/**
 * Per-child factory shape for `GatewayHarness`. Mostly useful for
 * tests + multi-gateway compositions (a parent test harness
 * constructs a child gateway).
 *
 * Adopters typically use the top-level `createGateway(options)`
 * factory function exported by `@agentick/gateway` rather than this
 * factory type directly.
 */
export type GatewayHarnessFactory<P = unknown> = Factory<GatewayHarnessProtocol, P>;
