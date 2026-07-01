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

  // ─── Lifecycle ──────────────────────────────────────────────────

  /**
   * Close every App, run substrate teardown, and emit
   * `gateway:lifecycle:closed`. Subsequent calls reject with
   * `GatewayClosedError`.
   *
   * Close-op envelopes are bus-only per the Operation framework's
   * `JournalingPolicy.override` (matches `app.closeApp` semantics).
   */
  closeGateway(): Promise<void>;

  /** Alias for {@link closeGateway} — symmetry with `app.close()`. */
  close(): Promise<void>;

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
   * Accept a per-client connection so the gateway can push server-
   * initiated notifications to it (#311). Transport servers call this
   * at connection-accept time, supplying a {@link ClientConnection}
   * that pairs the wire-writer with opaque metadata (transport kind,
   * connection id, later auth principal). Returns an unsubscribe the
   * transport invokes on connection close.
   *
   * Independent of the request-dispatch path. Optional on the
   * protocol so pre-#311 stubs don't need to implement it — real
   * gateways always populate one.
   */
  acceptConnection?(connection: ClientConnection): () => void;

  /**
   * Notify connected clients of a server-initiated event (#311).
   * `options.to` receives each connection's metadata and returns
   * `true` to include, `false` to skip — an auth-scoped push targets
   * connections whose principal matches; a per-tenant push filters
   * on a transport-supplied tenant discriminator. No `to` = every
   * connected client.
   *
   * A connection whose `deliver` throws is caught (so one broken
   * client cannot poison the fan-out) and routed to the adopter-
   * supplied `onDeliveryError` diagnostic hook on
   * {@link GatewayHarnessOptions}. `notify` is best-effort and never
   * rejects the caller.
   */
  notify?(
    notification: { method: string; params: unknown },
    options?: { to?: (metadata: ClientConnectionMetadata) => boolean },
  ): void;
}

// ============================================================================
// Client-connection types (#311)
// ============================================================================

/**
 * Opaque metadata every {@link ClientConnection} carries. The
 * gateway treats this as an unstructured bag — it never inspects
 * fields — but the recommended shape lets filters, telemetry, and
 * observability tooling reason about connected clients uniformly.
 *
 * Transport servers fill this in at accept time; future extensions
 * (auth #302, per-tenant `notify` filtering #308) augment it with
 * additional discriminators via declaration merging or convention.
 */
export interface ClientConnectionMetadata {
  /**
   * Transport-kind discriminator: `"websocket"`, `"unix-socket"`,
   * `"in-process"`, `"http-sse"`, or an adopter-supplied string.
   * Enables filters like `metadata.transport === "websocket"` for
   * transport-specific pushes.
   */
  readonly transport: string;

  /**
   * Stable per-connection id assigned by the transport. Format is
   * transport-specific — WS may use remote-address+port, HTTP its
   * session id, in-process a ulid. Meaningful only within the same
   * transport-server instance.
   */
  readonly connectionId: string;

  /** Room for auth principals, tenant ids, custom flags. Read via type-narrowing. */
  readonly [k: string]: unknown;
}

/**
 * A single connected client from the gateway's perspective —
 * metadata (transport, id, principal, ...) plus a synchronous
 * `deliver` callback that writes one JSON-RPC notification frame
 * to the wire.
 *
 * `deliver` MUST NOT throw for expected wire-drop conditions —
 * "wire already closed" is swallowed internally by the transport.
 * A throw signals a bug and routes to the gateway's `onDeliveryError`
 * diagnostic hook.
 */
export interface ClientConnection {
  readonly metadata: ClientConnectionMetadata;
  readonly deliver: (notification: { method: string; params: unknown }) => void;
}

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
