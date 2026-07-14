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
import type { EventBus, EventBusFactory, SubscribeOptions } from "./bus.js";
import type { OperationJournal, OperationJournalFactory } from "./journal.js";
import type { MessageInbox, MessageInboxFactory } from "./inbox.js";
import type { AppHarnessProtocol } from "./app-harness.js";
import type { WireExtensionRegistry } from "../wire/registry.js";
import type { WireMethod } from "../wire/params.js";
import type { AuthorizeInput, AuthorizeResult } from "../wire/authorizer.js";

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
 * `@agentick/app-next`'s `AppHarnessOptions<P>`. Spec defines the gateway-
 * level fields (id, metadata, substrate) and routes the rest opaquely.
 */
export interface CreateAppInput<P = unknown> {
  /** Stable app id within this Gateway. Defaults to `app:${ulid()}`. */
  readonly appId?: string;
  /** Per-app metadata bag. Surfaces to App-level substrate factories. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Root agent element passed to every session's reconciler mount.
   * Opaque to spec (avoids a React dep); concrete type contract lives
   * in `@agentick/app-next`'s reconciler.
   */
  readonly rootElement: unknown;
  /**
   * Opaque App-level construction options sans `rootElement` /
   * `appId` (supplied at the gateway level). Concrete shape is
   * `Omit<AppHarnessOptions<P>, "rootElement" | "appId">` from
   * `@agentick/app-next`; spec accepts it as opaque to avoid pulling the
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
 * `@agentick/app-next`'s `AppHarnessOptions<P>`. Cast at the
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
 * The runtime-root harness protocol.
 */
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

  /** Enumerate all registered Apps. */
  apps(): readonly AppHarnessProtocol[];

  /**
   * The gateway's identity-authorization policy (ADR 51 §4). The wire
   * dispatch choke point reads it — EVERY wire method (porcelain and
   * dynamic) is authorized with its verb-derived scope label before the
   * handler runs (§3.3 anti-bypass: one gate, both lanes).
   */
  readonly authorizer?: import("../wire/authorizer.js").Authorizer;

  /**
   * The **fine contextual** authorization layer (ADR 84 §5). Wraps
   * {@link authorizer}.authorize in the hookable `authorizer:authorize` op,
   * so `onBeforeAuthorizerAuthorize` can augment the {@link AuthorizeInput}
   * from request context (grant a contextual scope) or throw to deny, and
   * `onAfterAuthorizerAuthorize` can observe/audit the decision. The wire
   * dispatch gate (`authorizeDispatch` in `@agentick/transport-next`) routes
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
   * dispatcher (in `@agentick/transport-next`) consults it to route
   * incoming JSON-RPC frames to extension-registered handlers.
   *
   * Optional on the protocol so lightweight test stubs and older
   * gateway impls don't need to implement it — dispatchers fall back
   * to the hardcoded built-in switch when the registry is absent.
   * Real gateway impls (`@agentick/gateway-next`) always populate
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
   * Required — the seam is part of the gateway contract, not an optional
   * capability. A stub host implements it as a pass-through
   * (`(_m, _p, run) => run()`); the reference `GatewayHarness` routes
   * through `runOperation`.
   *
   * @param method - the raw wire method being dispatched (op name).
   * @param params - the request params (the op's input).
   * @param run - invokes the resolved handler; its result is the op result.
   */
  runWireDispatch<R>(method: WireMethod, params: unknown, run: () => Promise<R>): Promise<R>;

  /**
   * Emit the control-plane signal that the gateway's wire-extension
   * set changed (ADR 47). Appends a {@link GATEWAY_CAPABILITIES_CHANGED}
   * event to the gateway bus on the gateway scope; clients subscribed
   * to the gateway control-plane scope (every `@agentick/client-next`
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
 *   declare module "@agentick/spec-next" {
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
