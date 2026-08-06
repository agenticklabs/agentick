/**
 * `ClientProtocol` — the TypeScript contract every agentick TS client
 * implementation satisfies.
 *
 * `@agentick/client-core` ships the canonical impl. Other impls
 * (Worker-thread proxy, test mocks) conform to the same interface.
 *
 * The wire is the language-agnostic contract; this is the TypeScript
 * surface on top.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import type { Observability, SpanContext } from "../data/observability.js";
import type { Unsubscribe } from "../protocol/inbox.js";
import type { Cursor } from "../protocol/event-log.js";
import type { SendInput } from "../protocol/session-harness.js";
import type { WireMethod, WireParams, WireResult } from "../wire/params.js";
import type { SubscriptionScope } from "../wire/scope.js";
import type { ReceivedLog, ReceivedProgress, OnSignalOptions } from "./signals.js";
import type { ChannelView, ChannelViewConfig } from "./channel.js";
import type { ClientEvent, ClientEventFilter } from "./events.js";
import type { ClientNamespaces } from "./extension.js";
import type { ClientHooks, ClientRegistrars } from "./hooks.js";
import type { ClientMiddleware } from "./middleware.js";
import type {
  AppHandle,
  ClientSessionExecutionHandle,
  GatewayHandle,
  SessionHandle,
} from "./handles.js";
import type { ClientCapabilities, ServerInfo } from "./capabilities.js";
import type { ClientReadiness, ClientState } from "./state.js";
import type { ClientTransport } from "./transport.js";

/**
 * Auth surface seed. ADR 34 widens this; for now it's `unknown` so the
 * type compiles without forcing ADR 34's shape.
 */
export interface ClientAuthSurface {
  current(): unknown;
  onChange(handler: (auth: unknown) => void): () => void;
  reauthenticate(): Promise<void>;
  signOut(): Promise<void>;
}

/**
 * Core client interface. The methods every TS client implementation
 * exposes, regardless of how it talks to the gateway underneath.
 *
 * Extension-installed namespaces appear on the concrete client type
 * via `ClientNamespaces` declaration merging — see
 * `@agentick/spec/client/extension.ts`.
 */
/**
 * The trunk every client-side context extends.
 *
 * Deliberately small: identity only the framework can mint, plus the three
 * {@link Observability} facets. Anything an adopter's closure already reaches
 * (a router, an injector, a store) stays out — a ctx that carries app services
 * stops being a framework contract and becomes a service locator.
 */
export interface ClientRuntimeContext extends Observability {
  /** Stable for the client's lifetime. */
  readonly clientId: string;
  /**
   * The current connection, or `undefined` before the first handshake.
   *
   * READ IT, do not capture it: a reconnect mints a new one, so a value copied
   * at construction is stale for the rest of the session — and a stale
   * connection id is how a targeted tool call gets addressed to a connection
   * that no longer exists.
   */
  readonly connectionId: string | undefined;
  /** The innermost span in progress, or `undefined` outside any `trace`. */
  activeSpan(): SpanContext | undefined;
}

export interface ClientProtocol {
  /**
   * The client's ambient context — identity plus the `log`/`trace`/`metrics`
   * facets. The same shape the server ctx carries, so an adopter writing both
   * sides reads one contract.
   */
  readonly runtime: ClientRuntimeContext;
  readonly id: string;
  readonly state: ClientState;
  readonly transport: ClientTransport;

  // ── capability surface (populated by connect handshake) ────────────────

  /**
   * Server identity + protocol version + connection id, populated by
   * the `initialize` handshake in `connect()`. `undefined` before
   * connect resolves and after disconnect.
   *
   * @see docs/proposals/v2/blueprint/46-wire-extensions.md §"Capability discovery"
   */
  readonly serverInfo: ServerInfo | undefined;

  /**
   * View of what the connected gateway supports — framework-level
   * flags from `initialize` and wire-extension enumeration from
   * `_extensions/list`. Empty before connect / after disconnect;
   * repopulated on reconnect.
   *
   * Adopter usage pattern:
   *
   * ```ts
   * if (client.capabilities.hasMethod("mcpClients/reauthenticate")) {
   *   showConnectButton();
   * }
   * ```
   */
  readonly capabilities: ClientCapabilities;

  // ── connection lifecycle ────────────────────────────────────────────────
  connect(): Promise<void>;
  close(): Promise<void>;
  onStateChange(handler: (state: ClientState) => void): () => void;

  /**
   * Subscribe to capability-set changes. Fires whenever the client
   * swaps its `capabilities` snapshot — after the initial handshake,
   * after a post-reconnect handshake, and after every inbound
   * `notifications/capabilities/changed` refetch (#311).
   *
   * Payload is the fresh snapshot (equivalent to `client.capabilities`
   * at the moment the listener fires). Cleared subscribers on `close()`.
   *
   * Returns an unsubscribe. Symmetric with {@link onStateChange}.
   */
  onCapabilitiesChange(listener: (capabilities: ClientCapabilities) => void): () => void;

  // ── runtime signals (ADR 64) ───────────────────────────────────────────

  /**
   * Subscribe to `log` runtime signals for `scope` (a session / app /
   * gateway subscription target). `handler` fires once per event with the
   * decoded payload plus its origin scope. Returns an {@link Unsubscribe}
   * that closes the underlying subscription.
   *
   * The instance-method twin of the tree-shakeable `onLog(client, …)` free
   * function in `@agentick/client-core` — both take a client, so the method
   * simply delegates. Symmetric with {@link onCapabilitiesChange}.
   */
  onLog(
    scope: SubscriptionScope,
    handler: (event: ReceivedLog) => void,
    opts?: OnSignalOptions,
  ): Unsubscribe;

  /** Subscribe to `progress` runtime signals for `scope`. See {@link onLog}. */
  onProgress(
    scope: SubscriptionScope,
    handler: (event: ReceivedProgress) => void,
    opts?: OnSignalOptions,
  ): Unsubscribe;

  // ── channel views (ADR 33) ─────────────────────────────────────────────

  /**
   * Open a live reduced view over one `session:channel:<channel>` — a pure
   * FOLD over the channel subscription. The stream opens with a snapshot
   * frame, then streams deltas on the same ordered stream; `config.reduce`
   * seeds on the snapshot and folds the deltas. The returned
   * {@link ChannelView} exposes the held state via the `useSyncExternalStore`
   * contract (`get()` / `subscribe()`); `close()` tears down the subscription.
   *
   * The instance-method twin of the tree-shakeable `channelView(client, …)`
   * free function in `@agentick/client-core` — both take a client, so the
   * method simply delegates. This is the LOW-LEVEL escape hatch: the typed
   * façades `knobsStateView` / `taskStatusView` (in their harness packages)
   * are the sugar on top, supplying the channel name and `reduce`.
   *
   * `config` is OPTIONAL. Omitted, the default fold is
   * LAST-FRAME-PAYLOAD-WINS (`initial = undefined`, `reduce = (_p, f) => f`):
   * the view holds the latest frame payload, `undefined` before the first
   * frame. Suits FULL-OBJECT-per-frame channels (`task-status`);
   * snapshot+delta channels (knobs) still need an explicit `reduce`.
   */
  channelView<T, F>(
    scope: SubscriptionScope,
    channel: string,
    config: ChannelViewConfig<T, F>,
  ): ChannelView<T>;
  channelView<T = unknown>(scope: SubscriptionScope, channel: string): ChannelView<T | undefined>;

  /**
   * Resolve when the client is USABLE — that is, when a handshake has
   * SUCCEEDED and `capabilities` / `serverInfo` reflect the peer currently on
   * the other end. Resolves immediately when {@link readiness} is already
   * `"ready"`.
   *
   * **Resolve-on-success only.** It does not resolve because an attempt
   * finished; it resolves because an attempt worked. A handshake that fails
   * while the wire stays up leaves this pending and retries underneath (#263) —
   * the alternative, resolving anyway, is what let adopters `await` their way
   * into an open wire with empty capabilities and no stated reason.
   *
   * It rejects for exactly one reason: nothing further will ever make it
   * resolve — the client was closed, or the transport reached a terminal
   * state (`closed`, or `failed` with its reconnect budget spent). It does NOT
   * reject on a failed handshake, because another attempt is coming.
   *
   * Pending until the first success, so `await client.whenReady()` on a client
   * that has never connected waits for `connect()`. Race it against your own
   * deadline if you need one; watch {@link onReadinessChange} to show progress
   * meanwhile.
   */
  whenReady(): Promise<void>;

  /**
   * Whether the client is usable, as opposed to merely wired up — see
   * {@link ClientReadiness} for why that is a separate question from
   * {@link state}.
   */
  readonly readiness: ClientReadiness;

  /**
   * Subscribe to {@link readiness} transitions. Returns an unsubscribe.
   * Symmetric with {@link onStateChange}, and the pair a status indicator
   * wants: `state` says whether the wire is up, this says whether the client
   * behind it can be used.
   */
  onReadinessChange(handler: (readiness: ClientReadiness) => void): () => void;

  // ── generic RPC dispatch (typed via WireMethods) ───────────────────────
  /**
   * Issue a single JSON-RPC request. Pass an `AbortSignal` to cancel
   * in-flight — the client emits a `notifications/cancelled` frame to
   * the server and rejects the returned Promise with a `cancelled`
   * `TransportError`.
   */
  request<M extends WireMethod>(
    method: M,
    params: WireParams<M>,
    signal?: AbortSignal,
  ): Promise<WireResult<M>>;

  // ── client middleware (B2 slice 4 §7) — the ONE interception seam ──────

  /**
   * Register a {@link ClientMiddleware} at CLIENT scope — it wraps EVERY
   * derived wire method (commands + read RPCs), including verticals that don't
   * exist yet. The AROUND seam: the middleware receives `params`, a `next` to
   * continue the chain, and a `ctx` naming the `method` + bound `sessionId`.
   * Registration order is outer→inner (first registered is outermost). Returns
   * an {@link Unsubscribe} that removes it (leased, like the server's hooks).
   *
   * Auth/header injection, logging, retry, optimistic-UI bracketing, telemetry
   * propagation, capture/replay — written once, covering `session.knobs.set`,
   * `session.billing.approve`, and every future namespace uniformly.
   *
   * Per-HANDLE scoping (`session.knobs.use(mw)`) is sugar: the sub-handle wraps
   * `mw` to fire only for its own namespace, then registers it here.
   */
  use(middleware: ClientMiddleware): Unsubscribe;

  // ── client hooks (ADR 83) ──────────────────────────────────────────────

  /**
   * Register client hooks DECLARATIVELY — the runtime twin of the
   * server's `harness.hook()`, taking a {@link ClientHooks} config. Each
   * `onBefore<Method>` runs before a matching request leaves (may
   * transform `params` by returning a new value, or `throw` to abort the
   * request); each `onAfter<Method>` runs on the way back (may transform
   * the `result` the caller sees). Method-scoped: a hook fires only for
   * its wire method.
   *
   * The client hook MIRRORS the session op it initiates:
   * `onBeforeSessionSend` IS the send observed from the initiating end,
   * so it carries the same name as the session's op hook — no `wire:`
   * prefix. The `Wire*` qualifier lives on the GATEWAY's wire-dispatch
   * boundary, where the inbound `wire:session/send` and the folded
   * `session:send` op collide; the client has no such collision.
   *
   * Returns an {@link Unsubscribe} removing every hook in the config.
   */
  hook(config: ClientHooks): Unsubscribe;

  /**
   * Per-method imperative registrars — a typed Proxy over single-hook
   * registration (`client.hooks.onBeforeSessionSend(fn)`), each returning
   * its {@link Unsubscribe}. The imperative twin of {@link hook}; mirrors
   * the server's `harness.hooks`.
   */
  readonly hooks: ClientRegistrars;

  // ── resource handles ───────────────────────────────────────────────────
  gateway(): GatewayHandle;
  app(id: string): AppHandle;
  session(id: string): SessionHandle;

  // ── Vercel-style shortcuts ─────────────────────────────────────────────

  /**
   * Shortcut for `client.session(sessionId).send(input)`. Returns the
   * same `ClientSessionExecutionHandle` (AsyncIterable + `.result`).
   */
  send<P = unknown>(sessionId: string, input: SendInput<P>): ClientSessionExecutionHandle;

  // ── client-bus access ──────────────────────────────────────────────────

  /**
   * Subscribe to events ABOUT this client (connection state, request
   * lifecycle, subscription lifecycle, auth, extension-emitted).
   *
   * Wire events from the server flow through per-resource subscriptions
   * by default. The `wireMirror()` extension republishes them onto the
   * client-bus under `surface: "wire"`.
   *
   * The returned stream carries a monotonic, client-scoped `cursor`
   * that advances to the position of the most recently yielded event.
   * See the concrete `client.events()` implementation for the precise
   * `fromCursor` semantics (live-only vs. replay).
   */
  events(
    filter?: ClientEventFilter,
    fromCursor?: Cursor,
  ): AsyncIterable<ClientEvent> & { close(): Promise<void>; readonly cursor: Cursor };

  // ── auth ───────────────────────────────────────────────────────────────
  readonly auth: ClientAuthSurface;
}

/**
 * Concrete client type with extension-registered namespaces flattened
 * onto the surface via declaration merging.
 *
 * `@agentick/client-core` returns `Client` from `createClient()`. Any
 * adopter extending `ClientNamespaces` sees their namespaces typed
 * here automatically.
 */
export type Client = ClientProtocol & ClientNamespaces;
