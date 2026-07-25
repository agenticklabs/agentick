/**
 * `AgentickClient` — canonical TypeScript implementation of
 * `ClientProtocol`.
 *
 * Wraps any `ClientTransport`. Composes adopter-supplied extensions
 * into request + subscribe middleware pipelines, runs lifecycle
 * handlers through the `ClientHandlerRegistry`, exposes a client-bus
 * for observability, and exports gateway / app / session handles
 * matching the in-process harness API.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import { LocalEventBus } from "@agentick/runtime-next";
import type {
  ChannelView,
  ChannelViewConfig,
  Client,
  ClientAuthSurface,
  ClientCapabilities,
  ClientEvent,
  ClientEventFilter,
  ClientExtension,
  ClientInstaller,
  ClientProtocol,
  ClientState,
  ClientTransport,
  Cursor,
  EventBus,
  GatewayHandle,
  InitializeResult,
  ClientHookContext,
  ClientHooks,
  ClientMiddleware,
  ClientMiddlewareContext,
  ClientMiddlewareNext,
  ClientRegistrars,
  OnSignalOptions,
  ReceivedLog,
  ReceivedProgress,
  SendInput,
  ServerInfo,
  SubscriptionScope,
  Unsubscribe,
  WireMethod,
  WireParams,
  WireResult,
} from "@agentick/spec-next";
import {
  EMPTY_CLIENT_CAPABILITIES,
  ErrorCode,
  deserializeAgentickError,
  parseHookKey,
} from "@agentick/spec-next";
import { onLog as onLogSignal, onProgress as onProgressSignal } from "./signals.js";
import { channelView as channelViewFn } from "./channel-view.js";
import { createLocalPubSub, createNotifier, type LocalPubSub } from "@agentick/pubsub-next";
import { Deferred, Effect, Stream } from "effect";
import { buildClientCapabilities } from "./capabilities.js";
import { ClientHandlerRegistry } from "./handler-registry.js";
import { commandForMethod } from "./hook-keys.js";
import { makeAppHandle, makeGatewayHandle, makeSessionHandle } from "./handles.js";
import { composeRequest } from "./pipeline.js";

/** Fixed client identity broadcast in `initialize.clientInfo`. */
const CLIENT_NAME = "@agentick/client-core-next";
const CLIENT_VERSION = "0.0.0";

let clientCounter = 0;

export interface CreateClientOptions {
  readonly transport: ClientTransport;
  readonly extensions?: readonly ClientExtension[];
  readonly id?: string;
  /**
   * Client-LOCAL observer of connection-state transitions. Registered
   * for the client's lifetime via {@link ClientProtocol.onStateChange}.
   * Convenience for the common "wire a status indicator at construction"
   * case — equivalent to calling `client.onStateChange(fn)` yourself.
   */
  readonly onStateChange?: (state: ClientState) => void;
  /**
   * Client-LOCAL observer of capability-set changes. Registered for the
   * client's lifetime via {@link ClientProtocol.onCapabilitiesChange}.
   * Fires after each handshake / reconnect with the fresh snapshot.
   */
  readonly onCapabilitiesChange?: (caps: ClientCapabilities) => void;
}

/**
 * Construct a client. The returned object satisfies `ClientProtocol`
 * widened with any extension-registered namespaces (via
 * `ClientNamespaces` declaration merging).
 *
 * The client does NOT auto-connect — call `client.connect()`
 * explicitly. (This matches WebSocket / SSE semantics where adopters
 * typically want to control when the wire opens.)
 */
export async function createClient(options: CreateClientOptions): Promise<Client> {
  const client = new AgentickClient(options);
  // Client-LOCAL lifetime observers, if the adopter supplied them at
  // construction. They live for the client's lifetime (no unsubscribe
  // surfaced — the client owning them is the lifetime boundary).
  if (options.onStateChange) client.onStateChange(options.onStateChange);
  if (options.onCapabilitiesChange) client.onCapabilitiesChange(options.onCapabilitiesChange);
  await client.installExtensions();
  return client as unknown as Client;
}

class AgentickClient implements ClientProtocol {
  readonly id: string;
  readonly transport: ClientTransport;
  readonly auth: ClientAuthSurface;

  private readonly extensions: readonly ClientExtension[];
  private readonly handlerRegistry = new ClientHandlerRegistry();
  private _hookRegistrars?: ClientRegistrars;
  /**
   * Client-scoped {@link ClientMiddleware} chain (B2 slice 4 §7) — the ONE
   * interception seam. Read LIVE per request; a middleware added after
   * construction takes effect on the next request. Empty by default, so
   * `request()` fast-paths straight past it.
   */
  private readonly middlewares: ClientMiddleware[] = [];
  private readonly clientBus: LocalEventBus;
  /**
   * Dedicated client-event emitter. Deliberately DECOUPLED from
   * `clientBus` (the `ProtocolEvent` observability bus) and from the
   * substrate's `EventSurface` union — `ClientEvent` is its own
   * augmentable surface family (`ClientEventSurfaces`). `events()`
   * subscribes THIS pubsub; nothing on the wire flows through it.
   *
   * Elements are `SequencedClientEvent` (not bare `ClientEvent`) so a
   * monotonic, client-scoped `Cursor` can be threaded to every stream
   * without mutating the `ClientEvent` shape.
   */
  private readonly clientEvents: LocalPubSub<SequencedClientEvent>;
  /** Monotonic, client-scoped cursor counter. Advanced per publish. */
  private clientEventSeq = 0;
  private readonly composedRequest: ReturnType<typeof composeRequest>;
  private readonly stateListeners = createNotifier<ClientState>();
  private readonly capabilityListeners = createNotifier<ClientCapabilities>();
  private readonly closeHandlers: Array<() => void | Promise<void>> = [];
  private readonly namespaces = new Map<string, unknown>();

  private currentState: ClientState = "idle";
  private _capabilities: ClientCapabilities = EMPTY_CLIENT_CAPABILITIES;
  private _serverInfo: ServerInfo | undefined = undefined;
  /** Set when a `reconnecting` transition fires; cleared when the
   *  post-reconnect handshake kicks off. */
  private reconnectHandshakePending = false;
  /**
   * Promise for the in-flight post-reconnect handshake, exposed on the
   * `whenReady()` seam so tests (and adopters that care) can await
   * it. Undefined when no post-reconnect handshake has ever fired.
   */
  private postReconnectHandshake: Promise<void> | undefined = undefined;

  constructor(options: CreateClientOptions) {
    this.id = options.id ?? `client-${++clientCounter}`;
    this.transport = options.transport;
    this.extensions = options.extensions ?? [];

    this.clientBus = new LocalEventBus();
    // closeDrainTimeoutMs: 0 — client-event delivery is best-effort
    // observability. At client teardown we don't block on flushing
    // buffered events to subscribers (and a lagging/late subscriber must
    // never stall `client.close()`); iterators end via their own
    // `interruptWhen` on `ClientEventStream.close()`.
    this.clientEvents = createLocalPubSub<SequencedClientEvent>({ closeDrainTimeoutMs: 0 });
    // G2-wire-errors: rehydrate typed AgentickErrors ABOVE the extension
    // pipeline. The server's dispatch stamps a thrown AgentickError's
    // `toJSON()` into JSON-RPC `error.data` ({ _tag, message, ...fields });
    // the transport surfaces it as the raw `{ kind: "rpc", error }` envelope.
    // Extensions (retry/offline) keep classifying by the WIRE envelope's
    // code — that layer speaks JSON-RPC. Everything above (adopter
    // middleware, handles, application catch blocks) gets the typed error
    // back: `e instanceof GateNotFound` holds on both sides of the wire.
    // Protocol-level errors (MethodNotFound, parse errors) carry no `_tag`
    // and pass through as the envelope.
    const piped = composeRequest(this.extensions, (req) =>
      this.transport.request(req.method, req.params, req.signal),
    );
    this.composedRequest = (async (req: Parameters<typeof piped>[0]) => {
      try {
        return await piped(req);
      } catch (e) {
        throw rehydrateWireError(e);
      }
    }) as typeof piped;

    for (const ext of this.extensions) {
      this.handlerRegistry.registerFrom(ext);
    }

    // Mirror transport state onto the client state.
    this.currentState = this.transport.state;
    this.transport.onStateChange((s) => {
      const previous = this.currentState;
      this.currentState = s;
      this.publishConnectionEvent(previous, s);
      this.stateListeners.notify(s);
      // Clear stale capabilities when the wire drops. Reconnecting
      // ALSO clears — the peer we come back to may have restarted
      // with a different extension set. Mark that a fresh handshake
      // is owed once the transport comes back to `open`.
      if (s === "reconnecting") {
        this._serverInfo = undefined;
        this.reconnectHandshakePending = true;
        this.commitCapabilities({}, []);
      }
      if (s === "closed" || isFailedState(s)) {
        this._serverInfo = undefined;
        // Terminal — no reconnect coming, no handshake to owe.
        this.reconnectHandshakePending = false;
        this.commitCapabilities({}, []);
      }
      // Post-reconnect: re-run the handshake so `capabilities` +
      // `serverInfo` reflect whoever we came back to. Initial connect
      // handles the FIRST `open` transition explicitly via
      // `connect()`, so we only re-handshake when
      // `reconnectHandshakePending` was set by the reconnecting
      // transition above.
      if (s === "open" && this.reconnectHandshakePending) {
        this.reconnectHandshakePending = false;
        this.postReconnectHandshake = this.runHandshake().catch(() => {
          // Best-effort — a failed post-reconnect handshake leaves
          // capabilities empty, but the wire is otherwise open.
          // Adopters observe the empty capabilities via `hasMethod`
          // returning `false`. Rethrowing would swallow into an
          // uncaught rejection on a state-change tick.
        });
      }
    });

    // Auth surface seed — ADR 34 fills this in.
    this.auth = {
      current: () => null,
      onChange: () => () => {},
      reauthenticate: async () => {},
      signOut: async () => {
        await this.composedRequest({ method: "auth/signOut", params: {} });
      },
    };
  }

  async installExtensions(): Promise<void> {
    for (const ext of this.extensions) {
      if (!ext.install) continue;
      await ext.install(this.makeInstaller());
    }
  }

  // ── ClientProtocol surface ────────────────────────────────────────────

  get state(): ClientState {
    return this.currentState;
  }

  get capabilities(): ClientCapabilities {
    return this._capabilities;
  }

  get serverInfo(): ServerInfo | undefined {
    return this._serverInfo;
  }

  /**
   * Open the transport, run the post-connect handshake, and populate
   * `client.capabilities` + `client.serverInfo`.
   *
   * The handshake is TWO RPCs, in order:
   *
   *   1. `initialize` — protocol-version negotiation + framework-flag
   *      capabilities + server info.
   *   2. `_extensions/list` — wire-extension enumeration for feature-
   *      gating.
   *
   * Failure semantics:
   *   - `initialize` failure rejects `connect()` — the client can't
   *     talk to the gateway without a completed handshake.
   *   - `_extensions/list` `MethodNotFound` is tolerated silently —
   *     older gateways don't implement the discovery method; the
   *     extension list stays empty and `hasMethod`/`hasNamespace`
   *     return false.
   *
   * @verifiedBy src/__tests__/capabilities.spec.ts
   */
  async connect(): Promise<void> {
    await this.transport.connect();
    await this.runHandshake();
  }

  /**
   * Await any in-flight post-reconnect handshake. Resolves immediately
   * when none is pending. The initial `connect()` handshake is awaited
   * by `connect()` itself; this covers the reconnect path where the
   * transport transitions `open → reconnecting → open` without an
   * explicit `connect()` call.
   *
   * (Live runtime capability-change reactivity — a client-side
   * subscription that refetches on `gateway:capabilities:changed` —
   * is deferred to #308, when dynamic wire extensions make that event
   * fire. Today the extension set is sealed at gateway construction,
   * so `capabilities` only changes across handshake / reconnect,
   * which this covers. See ADR 47.)
   */
  async whenReady(): Promise<void> {
    if (this.postReconnectHandshake) await this.postReconnectHandshake;
  }

  /**
   * Issue the `initialize` + `_extensions/list` handshake pair.
   * Shared between the initial `connect()` and the post-reconnect
   * state-change hook. Tolerates `MethodNotFound` on either RPC —
   * see the failure-semantics doc on `connect()`.
   */
  private async runHandshake(): Promise<void> {
    let initResult: InitializeResult | undefined;
    try {
      initResult = await this.request("initialize", {
        protocolVersion: "v1",
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      });
    } catch (err) {
      if (!isMethodNotFound(err)) throw err;
    }

    // Framework flags from `initialize` are held aside; the definitive
    // capability commit happens once `_extensions/list` resolves so
    // subscribers see one atomic snapshot per handshake instead of a
    // "framework-only, no extensions" intermediate.
    const framework = initResult?.capabilities ?? {};
    if (initResult) {
      this._serverInfo = {
        name: initResult.serverInfo.name,
        version: initResult.serverInfo.version,
        protocolVersion: initResult.protocolVersion,
        connectionId: initResult.connectionId,
      };
    }

    let extensions: readonly import("@agentick/spec-next").WireExtensionInfo[] = [];
    try {
      const listResult = await this.request("_extensions/list", {});
      extensions = listResult.extensions;
    } catch (err) {
      if (!isMethodNotFound(err)) throw err;
      // Old server; leave extensions empty and commit the framework-only
      // snapshot below so subscribers still fire exactly once.
    }
    this.commitCapabilities(framework, extensions);
  }

  /**
   * Atomic capability commit. Single source of truth: rebuild the
   * snapshot, swap it in, fire subscribers. Every code path that
   * changes `_capabilities` goes through here — connect-handshake,
   * reconnect-handshake, and the empty-snapshot reset on wire drop.
   */
  private commitCapabilities(
    framework: import("@agentick/spec-next").ServerCapabilities,
    extensions: readonly import("@agentick/spec-next").WireExtensionInfo[],
  ): void {
    this._capabilities = buildClientCapabilities(framework, extensions);
    this.capabilityListeners.notify(this._capabilities);
  }

  async close(): Promise<void> {
    // Fire onClose handlers (LIFO so extensions clean up in reverse install order).
    for (const handler of this.closeHandlers.slice().reverse()) {
      try {
        await handler();
      } catch {
        /* swallow — close must not throw */
      }
    }
    // Drain + shut down the client-event emitter so any live
    // `events()` iterators end and no subscription leaks.
    await this.clientEvents.close();
    await this.transport.close();
  }

  onStateChange(handler: (state: ClientState) => void): () => void {
    return this.stateListeners.subscribe(handler);
  }

  onCapabilitiesChange(listener: (capabilities: ClientCapabilities) => void): () => void {
    return this.capabilityListeners.subscribe(listener);
  }

  // Runtime signals (ADR 64) — instance sugar delegating to the tree-shakeable
  // free functions (both take a client as the first arg, so `this` threads
  // straight through). Keeps `client.onLog(scope, cb)` next to
  // `client.onCapabilitiesChange`; `onLog(client, scope, cb)` stays exported.
  onLog(
    scope: SubscriptionScope,
    handler: (event: ReceivedLog) => void,
    opts?: OnSignalOptions,
  ): Unsubscribe {
    return onLogSignal(this, scope, handler, opts);
  }

  onProgress(
    scope: SubscriptionScope,
    handler: (event: ReceivedProgress) => void,
    opts?: OnSignalOptions,
  ): Unsubscribe {
    return onProgressSignal(this, scope, handler, opts);
  }

  // Channel views (ADR 33) — instance sugar delegating to the tree-shakeable
  // free function (it takes a client as the first arg, so `this` threads
  // straight through). The low-level escape hatch; the typed façades
  // `knobsStateView` / `taskStatusView` are the sugar on top.
  channelView<T, F>(
    scope: SubscriptionScope,
    channel: string,
    config: ChannelViewConfig<T, F>,
  ): ChannelView<T>;
  channelView<T = unknown>(scope: SubscriptionScope, channel: string): ChannelView<T | undefined>;
  channelView(
    scope: SubscriptionScope,
    channel: string,
    config?: ChannelViewConfig<unknown, unknown>,
  ): ChannelView<unknown> {
    return config === undefined
      ? channelViewFn(this, scope, channel)
      : channelViewFn(this, scope, channel, config);
  }

  /**
   * @verifiedBy
   *   - ../transport-in-process/src/__tests__/smoke.spec.ts — request
   *     middleware sees the call before the terminal transport, in
   *     outer→inner order
   *   - ../transport-websocket/src/__tests__/cancellation.spec.ts —
   *     passing an AbortSignal that fires triggers `notifications/cancelled`
   *     emit and rejects the returned Promise with `kind: "cancelled"`
   */
  async request<M extends WireMethod>(
    method: M,
    params: WireParams<M>,
    signal?: AbortSignal,
  ): Promise<WireResult<M>> {
    // Fast-path: nothing registered on the ONE interception seam → straight to
    // the extension pipeline + transport, zero per-request overhead.
    if (this.middlewares.length === 0) {
      return this.composedRequest({ method, params, signal } as never) as Promise<WireResult<M>>;
    }
    // The ONE interception seam (B2 slice 4 §7). `client.use(...)` and the
    // before/after `client.hook(...)` sugar BOTH live here — one chain, no second
    // path. Compose them AROUND the extension pipeline; first registered is
    // outermost. `ctx` names the method + the bound sessionId (lifted from params)
    // so a handle-scoped middleware can filter on its namespace.
    const sessionId = readSessionId(params);
    const ctx: ClientMiddlewareContext = {
      method,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(signal !== undefined ? { signal } : {}),
    };
    const terminal: ClientMiddlewareNext = (p) =>
      this.composedRequest({ method, params: p, signal } as never) as Promise<unknown>;
    const chain = this.middlewares.reduceRight<ClientMiddlewareNext>(
      (next, mw) => (p) => mw(p, next, ctx),
      terminal,
    );
    return chain(params) as Promise<WireResult<M>>;
  }

  /**
   * Register a {@link ClientMiddleware} at client scope (B2 slice 4 §7). It
   * wraps EVERY derived wire method — `session.knobs.set`,
   * `session.billing.approve`, and every namespace that doesn't exist yet.
   * Returns an {@link Unsubscribe} that removes it (leased).
   */
  use(middleware: ClientMiddleware): Unsubscribe {
    this.middlewares.push(middleware);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const i = this.middlewares.indexOf(middleware);
      if (i >= 0) this.middlewares.splice(i, 1);
    };
  }

  /**
   * Adapt one before/after wire hook (ADR 83) into an around
   * {@link ClientMiddleware} on the single seam, method-SCOPED via the shared
   * command derivation. A before-hook transforms params (or throws to abort)
   * on the way out; an after-hook transforms the result on the way back. This
   * is why `client.hook` / `client.hooks` need no second registry — they ARE
   * `client.use` with a command guard and a before/after adapter.
   */
  private registerHookMiddleware(
    kind: "before" | "after",
    command: string,
    fn: (value: unknown, ctx: ClientHookContext) => unknown,
  ): Unsubscribe {
    const middleware: ClientMiddleware = async (params, next, ctx) => {
      if (commandForMethod(ctx.method) !== command) return next(params);
      const hookCtx: ClientHookContext =
        ctx.signal !== undefined
          ? { method: ctx.method as WireMethod, signal: ctx.signal }
          : { method: ctx.method as WireMethod };
      if (kind === "before") {
        // A throw aborts the request; a returned value reshapes params.
        const reshaped = await fn(params, hookCtx);
        return next(reshaped !== undefined ? reshaped : params);
      }
      const result = await next(params);
      const reshaped = await fn(result, hookCtx);
      return reshaped !== undefined ? reshaped : result;
    };
    return this.use(middleware);
  }

  /**
   * Register client hooks declaratively (ADR 83) — method-scoped before/after
   * sugar over the single {@link use} seam. Returns an {@link Unsubscribe}
   * removing every hook in the config. `around`-kind keys are inert (the around
   * shape IS `client.use`).
   */
  hook(config: ClientHooks): Unsubscribe {
    const unsubs: Unsubscribe[] = [];
    for (const [key, fn] of Object.entries(config as Record<string, unknown>)) {
      if (fn === undefined) continue;
      const off = this.registerHookKey(key, fn);
      if (off) unsubs.push(off);
    }
    if (unsubs.length === 0) return () => {};
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      for (const off of unsubs) off();
    };
  }

  /** Parse a hook key (`onBeforeSessionSend`) and register it on the seam. */
  private registerHookKey(key: string, fn: unknown): Unsubscribe | undefined {
    const parsed = parseHookKey(key);
    if (parsed === undefined || (parsed.kind !== "before" && parsed.kind !== "after")) {
      return undefined;
    }
    return this.registerHookMiddleware(
      parsed.kind,
      parsed.command,
      fn as (value: unknown, ctx: ClientHookContext) => unknown,
    );
  }

  /**
   * Per-method imperative registrars (ADR 83) — a typed Proxy over single-hook
   * registration, mirroring the server's `harness.hooks`.
   * `client.hooks.onBeforeSessionSend(fn)` registers a before/after hook on the
   * single {@link use} seam and returns its {@link Unsubscribe}.
   */
  get hooks(): ClientRegistrars {
    return (this._hookRegistrars ??= new Proxy({} as ClientRegistrars, {
      get: (_target, name) =>
        typeof name === "string"
          ? (fn: unknown) => this.registerHookKey(name, fn) ?? (() => {})
          : undefined,
    }));
  }

  gateway(): GatewayHandle {
    return makeGatewayHandle(this);
  }

  app(id: string) {
    return makeAppHandle(this, id);
  }

  session(id: string) {
    return makeSessionHandle(this, id);
  }

  /**
   * @verifiedBy ../transport-in-process/src/__tests__/send-shortcut.spec.ts —
   *             emits the same `session/send` RPC params as
   *             `client.session(id).send(input)` and returns the canonical
   *             `ClientSessionExecutionHandle` shape (`events()` +
   *             `.result` + `abort()`).
   */
  send<P = unknown>(sessionId: string, input: SendInput<P>) {
    return makeSessionHandle(this, sessionId).send(input);
  }

  /**
   * Subscribe to events ABOUT this client. Returns a live
   * `AsyncIterable<ClientEvent>` fed by the dedicated `clientEvents`
   * emitter — NOT the `ProtocolEvent` observability bus and NOT the
   * wire. Each call yields an independent stream with its own
   * subscription; multiple concurrent iterators do not interfere.
   *
   * **Filter.** `filter.surface` (single or array) and `filter.phase`
   * (single or array) narrow the stream; both are AND-ed. Omit either
   * to match all.
   *
   * **Cursor semantics — LIVE-ONLY.** The stream starts at
   * subscribe-time; there is NO replay buffer, so `fromCursor` is
   * accepted for forward-compatibility but IGNORED — a caller can
   * never rewind past the moment it subscribed. The returned stream's
   * `cursor` advances monotonically (client-scoped sequence) to the
   * position of the most recently yielded event, so a caller can
   * observe progress and correlate events across streams from the same
   * client. When a bounded replay ring lands (#308-followup),
   * `fromCursor` becomes best-effort resume.
   *
   * **Close.** `close()` interrupts the underlying stream, ending every
   * active `for await` cleanly and releasing the pubsub subscription
   * (no leak). Idempotent.
   *
   * @verifiedBy src/__tests__/events.spec.ts
   */
  events(
    filter?: ClientEventFilter,
    _fromCursor?: Cursor,
  ): AsyncIterable<ClientEvent> & { close(): Promise<void>; readonly cursor: Cursor } {
    // fromCursor is intentionally unused: live-only, no replay buffer.
    // See the doc-comment above and TODO(#308-followup) at the ring.
    return new ClientEventStream(this.clientEvents, filter);
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private makeInstaller(): ClientInstaller {
    return {
      clientId: this.id,
      transport: this.transport,
      bus: this.clientBus as EventBus,
      registerNamespace: (name, ns) => {
        this.namespaces.set(name, ns);
        (this as unknown as Record<string, unknown>)[name] = ns;
      },
      onClose: (h) => this.closeHandlers.push(h),
    };
  }

  /**
   * Publish a `connection`-surface `ClientEvent` for a transport state
   * transition onto the dedicated client-event emitter. The `connection`
   * surface's only phase in the spec vocabulary is `"transition"`; the
   * started/opened/closed/failed distinctions live in the `ClientState`
   * values carried by `from`/`to`, not in a phase field. We therefore
   * emit `phase: "transition"` and let subscribers switch on
   * `to` (`"open"`, `"closed"`, `{ kind: "failed" }`, …).
   *
   * TODO(#308-followup): the other `ClientEvent` surfaces —
   * `request` / `subscription` / `auth` / `wire` / `extension` — need
   * their own emit sites (the request pipeline, the subscribe RPC
   * family, the auth surface, the `wireMirror()` extension). Those
   * sources are not wired here; only `connection` has a live source
   * today.
   */
  private publishConnectionEvent(from: ClientState, to: ClientState): void {
    this.publishClientEvent({
      surface: "connection",
      phase: "transition",
      clientId: this.id,
      timestamp: Date.now(),
      from,
      to,
    });
  }

  /** Stamp a monotonic client-scoped cursor and publish to the emitter. */
  private publishClientEvent(event: ClientEvent): void {
    const cursor: Cursor = { value: ++this.clientEventSeq };
    this.clientEvents.publish({ cursor, event });
  }
}

/** A `ClientEvent` paired with its monotonic client-scoped cursor. */
interface SequencedClientEvent {
  readonly cursor: Cursor;
  readonly event: ClientEvent;
}

/**
 * Build the subscribe-side predicate for a `ClientEventFilter`. Matches
 * on `surface` and `phase` (both single or array; AND-ed). Undefined
 * facets match everything.
 */
function matchesFilter(event: ClientEvent, filter?: ClientEventFilter): boolean {
  if (!filter) return true;
  if (filter.surface !== undefined && !includesValue(filter.surface, event.surface)) return false;
  if (filter.phase !== undefined && !includesValue(filter.phase, event.phase)) return false;
  return true;
}

/** True when `needle` equals `spec` or is contained in the `spec` array. */
function includesValue<T>(spec: T | readonly T[], needle: T): boolean {
  return Array.isArray(spec) ? spec.includes(needle) : spec === needle;
}

/** Lift the bound `sessionId` off request params for the middleware ctx, if present. */
function readSessionId(params: unknown): string | undefined {
  if (params !== null && typeof params === "object" && "sessionId" in params) {
    const id = (params as { sessionId?: unknown }).sessionId;
    if (typeof id === "string") return id;
  }
  return undefined;
}

/** True when the ClientState value is the failed-object variant. */
function isFailedState(s: ClientState): boolean {
  return typeof s === "object" && s !== null && "kind" in s && s.kind === "failed";
}

/**
 * G2-wire-errors — turn a transport rejection carrying a serialized
 * AgentickError back into the typed instance (spec's registry-driven codec;
 * an unknown `_tag` degrades to `UnknownAgentickError`, never data loss).
 * Anything else — protocol-level rpc envelopes, connection/timeout/cancelled
 * shapes — is returned untouched.
 */
function rehydrateWireError(err: unknown): unknown {
  if (typeof err !== "object" || err === null) return err;
  const data = (err as { error?: { data?: unknown } }).error?.data;
  if (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { _tag?: unknown })._tag === "string"
  ) {
    return deserializeAgentickError(data);
  }
  return err;
}

/**
 * True when the caught error surfaces as a JSON-RPC `MethodNotFound`.
 * Handles the canonical `TransportError` shape from
 * `@agentick/transport-next` (`{ kind: "rpc", error: { code: -32601 } }`)
 * plus looser POJO shapes downstream adapters may throw
 * (`{ code: -32601 }`, `{ rpcError: { code: -32601 } }`).
 */
function isMethodNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    code?: unknown;
    error?: { code?: unknown };
    rpcError?: { code?: unknown };
  };
  const codes = [e.code, e.error?.code, e.rpcError?.code];
  return codes.some((c) => c === ErrorCode.MethodNotFound);
}

/**
 * Live `AsyncIterable<ClientEvent>` over the client's dedicated
 * `LocalPubSub<SequencedClientEvent>` emitter.
 *
 * Each `[Symbol.asyncIterator]()` opens an independent pubsub
 * subscription (filtered by `ClientEventFilter`), so concurrent
 * iterators do not interfere. Every stream from one `events()` call
 * shares a single interrupt `Deferred`: `close()` completes it, which
 * `Stream.interruptWhen` observes — interrupting the underlying Effect
 * stream(s), ending each consumer's `for await`, and releasing the
 * pubsub subscription scope (unsubscribe, no leak).
 *
 * The `cursor` getter reflects the monotonic, client-scoped position of
 * the most recently yielded event. Live-only: there is no replay
 * buffer, so a subscription only ever sees events published after it
 * attached. `fromCursor` resume is a #308-followup (needs a bounded
 * replay ring on the emitter).
 */
class ClientEventStream implements AsyncIterable<ClientEvent> {
  private readonly interrupt = Effect.runSync(Deferred.make<void>());
  private _cursor: Cursor = { value: 0 };
  private closed = false;

  constructor(
    private readonly source: LocalPubSub<SequencedClientEvent>,
    private readonly filter?: ClientEventFilter,
  ) {}

  /** Monotonic, client-scoped position of the most recently yielded event. */
  get cursor(): Cursor {
    return this._cursor;
  }

  [Symbol.asyncIterator](): AsyncIterator<ClientEvent> {
    const stream = this.source
      .subscribe((seq) => matchesFilter(seq.event, this.filter))
      .pipe(
        Stream.interruptWhen(Deferred.await(this.interrupt)),
        Stream.map((seq) => {
          this._cursor = seq.cursor;
          return seq.event;
        }),
      );
    return Stream.toAsyncIterable(stream)[Symbol.asyncIterator]();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Effect.runPromise(Deferred.succeed(this.interrupt, undefined));
  }
}
