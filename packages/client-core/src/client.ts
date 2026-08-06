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

import { LocalEventBus } from "@agentick/runtime";
import type {
  ChannelView,
  ChannelViewConfig,
  Client,
  ClientAuthSurface,
  ClientCapabilities,
  ClientEvent,
  ClientEventFilter,
  ClientExtension,
  ClientHandshakeCapabilities,
  ClientInstaller,
  ClientProtocol,
  ClientReadiness,
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
  ClientRuntimeContext,
  ClientTelemetryOptions,
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
} from "@agentick/spec";
import {
  EMPTY_CLIENT_CAPABILITIES,
  ErrorCode,
  WIRE_PROTOCOL_VERSION,
  WireRpcError,
  deserializeAgentickError,
  isClientStateFailed,
  parseHookKey,
} from "@agentick/spec";
import { computeFullJitterBackoff } from "@agentick/utils";
import { onLog as onLogSignal, onProgress as onProgressSignal } from "./signals.js";
import { channelView as channelViewFn } from "./channel-view.js";
import { clientObservability } from "./observability.js";
import type { ClientObservability } from "./observability.js";
import { clientRuntimeContext } from "./runtime-context.js";
import { createLocalPubSub, createNotifier, type LocalPubSub } from "@agentick/pubsub";
import { Deferred, Effect, Stream } from "effect";
import { buildClientCapabilities } from "./capabilities.js";
import { ClientHandlerRegistry } from "./handler-registry.js";
import { commandForMethod } from "./hook-keys.js";
import { makeAppHandle, makeGatewayHandle, makeSessionHandle } from "./handles.js";
import { composeRequest } from "./pipeline.js";

/** Fixed client identity broadcast in `initialize.clientInfo`. */
const CLIENT_NAME = "@agentick/client-core";
const CLIENT_VERSION = "0.0.0";

/**
 * What this client tells the server it can do — the client's half of the
 * handshake, and only what is actually implemented here.
 *
 * `cursorResume` is the one claim: every client transport extends
 * `BaseClientTransport`, which tracks each live subscription's `lastCursor`
 * and resends it as `fromCursor` when the wire comes back. That half is real
 * and stays real whether or not the peer honors it (no server does yet —
 * `ServerCapabilities.cursorResume` is false; see the `TODO(wire-resume)`
 * trailhead in `@agentick/gateway`).
 *
 * `batch` and `streamableHttp` are unclaimed on purpose. They are facts about
 * a WIRE, not about this object — the HTTP transport speaks SSE and the
 * WebSocket one does not — and `ClientTransport.capabilities` has no slot for
 * either, so client-core cannot answer for whichever transport it was handed.
 * TODO(wire-client-handshake-flags): give `TransportCapabilities` the two
 * flags (the server-side twin exists — `WireServerDescriptor`) and derive
 * them from `this.transport.capabilities` here.
 */
const CLIENT_HANDSHAKE_CAPABILITIES: ClientHandshakeCapabilities = Object.freeze({
  cursorResume: true,
});

let clientCounter = 0;

/**
 * How a handshake that failed on a LIVE wire is retried.
 *
 * The wire's own {@link ReconnectPolicy} does not cover this. That loop is
 * armed by the wire dying; a handshake can fail with the socket perfectly
 * healthy — a gateway that accepted the connection before it could serve
 * `initialize`, a peer mid-restart, a transient `InternalError`. Left alone
 * that state never heals, which is the whole of #263.
 *
 * Same curve as the transports (exponential backoff with full jitter, 100ms →
 * 30s), and the same default budget: `Infinity`. The client does not stop
 * trying while the wire is up.
 *
 * A wire that DROPS supersedes this loop rather than competing with it: the
 * transport's reconnect owns recovery from there, and the `open` transition on
 * the way back arms a fresh handshake.
 */
export interface HandshakeRetryPolicy {
  readonly enabled?: boolean;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  /**
   * Finite budgets are for adopters who prefer a hard stop to an indefinite
   * retry. Spending one is observable: `readiness` settles on
   * `{ kind: "handshake-failed", retrying: false }` and `whenReady()` stays
   * pending until the next `connect()`.
   */
  readonly maxAttempts?: number;
}

export const DEFAULT_HANDSHAKE_RETRY_POLICY: Required<HandshakeRetryPolicy> = {
  enabled: true,
  initialDelayMs: 100,
  maxDelayMs: 30_000,
  maxAttempts: Infinity,
};

export interface CreateClientOptions {
  readonly transport: ClientTransport;
  readonly extensions?: readonly ClientExtension[];
  readonly id?: string;
  /**
   * The telemetry switch — the twin of `createApp({ telemetry })`.
   *
   * THIS package reads `adapter` only, to build `client.runtime`'s facets; it
   * does not install the wire-span extension, because the lean core does not
   * depend on it. `@agentick/client` takes the same option and ALSO installs
   * that extension from the same object, so `sample` / `serviceName` apply
   * there and the adapter is never passed twice.
   *
   * Omitted, `log` is still callable (it reaches nothing) and `trace` runs on
   * the passthrough path with zero span machinery — instrumented code costs
   * nothing until an adapter exists.
   *
   * Distinct from `onLog` / `onProgress`, which RECEIVE the server's signals.
   * This is the client speaking, not listening.
   */
  readonly telemetry?: ClientTelemetryOptions;
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
  /**
   * Client-LOCAL observer of readiness transitions. Registered for the
   * client's lifetime via {@link ClientProtocol.onReadinessChange}.
   */
  readonly onReadinessChange?: (readiness: ClientReadiness) => void;
  /** See {@link HandshakeRetryPolicy}. Defaults to retry-forever with jitter. */
  readonly handshakeRetry?: HandshakeRetryPolicy;
}

/**
 * Construct a client. The returned object satisfies `ClientProtocol`
 * widened with any extension-registered namespaces (via
 * `ClientNamespaces` declaration merging).
 *
 * **This is the LEAN core: no capability's client surface is registered.**
 * `session.timeline`, `session.tools`, `session.knobs` and friends exist only
 * once you `import "@agentick/<capability>/client"` for each one you use.
 * `createClient` from `@agentick/client` is this same function with every
 * built-in already imported — reach for THIS package when you are trimming a
 * bundle and will register capabilities yourself.
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
  if (options.onReadinessChange) client.onReadinessChange(options.onReadinessChange);
  await client.installExtensions();
  return client as unknown as Client;
}

class AgentickClient implements ClientProtocol {
  readonly id: string;
  readonly transport: ClientTransport;
  readonly auth: ClientAuthSurface;

  private readonly observability: ClientObservability;
  private _runtime: ClientRuntimeContext | undefined;

  /**
   * This client's own `log` / `trace` / `metrics`, with live identity.
   *
   * `connectionId` is a getter, not a captured value — a reconnect mints a new
   * one, and a stale id is how a targeted call reaches a connection that no
   * longer exists.
   */
  get runtime(): ClientRuntimeContext {
    return (this._runtime ??= clientRuntimeContext(this.observability, {
      clientId: () => this.id,
      connectionId: () => this.serverInfo?.connectionId,
    }));
  }

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

  // ── handshake readiness + retry (#263) ────────────────────────────────
  private readonly handshakeRetry: Required<HandshakeRetryPolicy>;
  private readonly readinessListeners = createNotifier<ClientReadiness>();
  private _readiness: ClientReadiness = "idle";
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive handshake failures on the CURRENT wire. */
  private handshakeAttempts = 0;
  /**
   * Stamp identifying the handshake attempt sequence for the current wire.
   * Bumped by everything that invalidates one — a wire drop, a deliberate
   * close, a fresh `connect()` — so an attempt that was in flight across the
   * change can recognise itself as superseded and neither commit its result
   * nor schedule a successor.
   */
  private handshakeEpoch = 0;
  /** Callers parked in `whenReady()`, settled only by success or by a terminal wire. */
  private readyWaiters: Array<{ resolve(): void; reject(error: unknown): void }> = [];
  private closed = false;

  constructor(options: CreateClientOptions) {
    this.id = options.id ?? `client-${++clientCounter}`;
    this.transport = options.transport;
    this.extensions = options.extensions ?? [];
    // ONE instance for the client's lifetime: span nesting lives on it, so a
    // fresh one per read would orphan every child span.
    this.observability = clientObservability(options.telemetry?.adapter);
    this.handshakeRetry = {
      ...DEFAULT_HANDSHAKE_RETRY_POLICY,
      ...(options.handshakeRetry ?? {}),
    };

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
        // The wire owns recovery from here; a handshake retry against a dead
        // socket would only fail. Invalidating drops the pending timer AND
        // stamps a new epoch, so an in-flight attempt cannot commit stale
        // capabilities against whatever we come back to.
        this.invalidateHandshake();
        this.commitCapabilities({}, []);
      }
      if (s === "closed" || isClientStateFailed(s)) {
        this._serverInfo = undefined;
        // Terminal — no reconnect coming, no handshake to owe.
        this.reconnectHandshakePending = false;
        this.invalidateHandshake();
        this.commitCapabilities({}, []);
        // Nothing further can make `whenReady()` resolve without a fresh
        // `connect()`, so parked callers are told rather than left hanging.
        this.rejectReadyWaiters(
          new Error(
            `client ${this.id}: transport reached a terminal state (${describeClientState(s)}) before a handshake succeeded`,
          ),
        );
      }
      // Post-reconnect: re-run the handshake so `capabilities` +
      // `serverInfo` reflect whoever we came back to. Initial connect
      // handles the FIRST `open` transition explicitly via
      // `connect()`, so we only re-handshake when
      // `reconnectHandshakePending` was set by the reconnecting
      // transition above.
      if (s === "open" && this.reconnectHandshakePending) {
        this.reconnectHandshakePending = false;
        // Nobody is awaiting THIS promise — the retry loop underneath is what
        // carries the failure forward, and `readiness` / `whenReady()` are
        // where an adopter observes it. The catch only keeps a failed attempt
        // from surfacing as an unhandled rejection on a state-change tick.
        void this.startHandshake().catch(() => {});
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
   * **A rejected `connect()` is an answer, not a verdict.** Same contract the
   * transports state for a failed dial: the caller gets the failure
   * immediately rather than blocking on a loop whose budget is `Infinity`, and
   * the client keeps retrying the handshake underneath (see
   * {@link HandshakeRetryPolicy}). Watch {@link onReadinessChange}, or
   * `await whenReady()`, for the recovery. Pass
   * `handshakeRetry: { enabled: false }` if you want one attempt and nothing
   * more.
   *
   * @verifiedBy src/__tests__/capabilities.spec.ts
   * @verifiedBy src/__tests__/handshake-retry.spec.ts
   */
  async connect(): Promise<void> {
    this.closed = false;
    await this.transport.connect();
    await this.startHandshake();
  }

  /**
   * Resolve when a handshake has SUCCEEDED — see
   * {@link ClientProtocol.whenReady} for the contract. Resolve-on-success
   * only: a failed handshake leaves this pending while the retry loop works,
   * and it rejects only when nothing further can resolve it (the client closed
   * or the transport went terminal).
   *
   * (Live runtime capability-change reactivity — a client-side
   * subscription that refetches on `gateway:capabilities:changed` —
   * is deferred to #308, when dynamic wire extensions make that event
   * fire. Today the extension set is sealed at gateway construction,
   * so `capabilities` only changes across handshake / reconnect,
   * which this covers. See ADR 47.)
   */
  async whenReady(): Promise<void> {
    if (this._readiness === "ready") return;
    if (this.closed) {
      throw new Error(`client ${this.id} is closed; whenReady() will never resolve`);
    }
    if (this.currentState === "closed" || isClientStateFailed(this.currentState)) {
      throw new Error(
        `client ${this.id}: transport is in a terminal state (${describeClientState(this.currentState)}); call connect() again`,
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  get readiness(): ClientReadiness {
    return this._readiness;
  }

  onReadinessChange(handler: (readiness: ClientReadiness) => void): () => void {
    return this.readinessListeners.subscribe(handler);
  }

  /**
   * Begin a handshake attempt sequence on the CURRENT wire, cancelling any
   * sequence already running. Returns the FIRST attempt's outcome so
   * `connect()` can hand its caller an answer; the retry loop continues
   * regardless of what that caller does with it.
   */
  private startHandshake(): Promise<void> {
    this.clearHandshakeTimer();
    this.handshakeAttempts = 0;
    return this.attemptHandshake(++this.handshakeEpoch);
  }

  /**
   * One handshake attempt. On success the capability commit happens and
   * readiness goes `ready`; on failure the next attempt is scheduled and the
   * error is rethrown for whoever asked for THIS attempt.
   */
  private async attemptHandshake(epoch: number): Promise<void> {
    if (epoch !== this.handshakeEpoch) return;
    this.setReadiness("handshaking");
    try {
      await this.runHandshake(epoch);
    } catch (err) {
      // Superseded mid-flight (the wire dropped, or `connect()` was called
      // again): the sequence that replaced this one owns what happens next.
      if (epoch !== this.handshakeEpoch) throw err;
      this.handshakeAttempts++;
      const retrying = this.scheduleHandshakeRetry(epoch);
      this.setReadiness({
        kind: "handshake-failed",
        error: err,
        attempts: this.handshakeAttempts,
        retrying,
      });
      throw err;
    }
    if (epoch !== this.handshakeEpoch) return;
    this.handshakeAttempts = 0;
    this.setReadiness("ready");
  }

  /**
   * Arm the next attempt. Returns whether one is coming — which is what
   * `readiness` reports, so "the client has stopped trying" is never something
   * an adopter has to infer from silence.
   */
  private scheduleHandshakeRetry(epoch: number): boolean {
    if (this.closed) return false;
    const policy = this.handshakeRetry;
    if (!policy.enabled) return false;
    if (this.handshakeAttempts >= policy.maxAttempts) return false;

    const delay = computeFullJitterBackoff(this.handshakeAttempts - 1, policy);
    this.clearHandshakeTimer();
    const timer = setTimeout(() => {
      this.handshakeTimer = null;
      if (epoch !== this.handshakeEpoch) return;
      // The wire went away while we waited. The transport's reconnect owns
      // recovery, and the `open` transition on the way back arms a fresh
      // sequence — retrying here would race it and fail on a dead socket.
      if (this.currentState !== "open") return;
      void this.attemptHandshake(epoch).catch(() => {});
    }, delay);
    // A retry timer must never be the reason a process refuses to exit.
    (timer as { unref?: () => void }).unref?.();
    this.handshakeTimer = timer;
    return true;
  }

  /**
   * Cancel any in-flight or scheduled handshake for the current wire. The
   * epoch bump is what makes an attempt already awaiting an RPC harmless: it
   * will neither commit its result nor schedule a successor.
   */
  private invalidateHandshake(): void {
    this.handshakeEpoch++;
    this.clearHandshakeTimer();
    this.handshakeAttempts = 0;
    this.setReadiness("idle");
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer === null) return;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private setReadiness(next: ClientReadiness): void {
    if (next === this._readiness) return;
    this._readiness = next;
    this.readinessListeners.notify(next);
    if (next !== "ready") return;
    for (const w of this.readyWaiters.splice(0)) w.resolve();
  }

  private rejectReadyWaiters(error: Error): void {
    for (const w of this.readyWaiters.splice(0)) w.reject(error);
  }

  /**
   * Issue the `initialize` + `_extensions/list` handshake pair.
   * Shared between the initial `connect()` and the post-reconnect
   * state-change hook. Tolerates `MethodNotFound` on either RPC —
   * see the failure-semantics doc on `connect()`.
   *
   * `epoch` guards the COMMIT: an attempt that was in flight when the wire
   * dropped must not publish capabilities describing a peer we are no longer
   * talking to.
   */
  private async runHandshake(epoch: number): Promise<void> {
    let initResult: InitializeResult | undefined;
    try {
      initResult = await this.request("initialize", {
        protocolVersion: WIRE_PROTOCOL_VERSION,
        capabilities: CLIENT_HANDSHAKE_CAPABILITIES,
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      });
    } catch (err) {
      if (!isMethodNotFound(err)) throw err;
    }

    // The client's half of version negotiation. The server rejects a request
    // it can't serve; this rejects an ANSWER it can't read — a server that
    // replies with another version has told us its frames may not match what
    // this build parses, and proceeding on that is how a protocol skew
    // becomes a mystery decode failure ten calls later. Thrown before
    // anything is committed, so it rejects `connect()` with capabilities
    // still empty.
    if (initResult && initResult.protocolVersion !== WIRE_PROTOCOL_VERSION) {
      throw WireRpcError.protocolVersionMismatch(initResult.protocolVersion, WIRE_PROTOCOL_VERSION);
    }

    // Framework flags from `initialize` are held aside; the definitive
    // capability commit happens once `_extensions/list` resolves so
    // subscribers see one atomic snapshot per handshake instead of a
    // "framework-only, no extensions" intermediate.
    const framework = initResult?.capabilities ?? {};

    let extensions: readonly import("@agentick/spec").WireExtensionInfo[] = [];
    try {
      const listResult = await this.request("_extensions/list", {});
      extensions = listResult.extensions;
    } catch (err) {
      if (!isMethodNotFound(err)) throw err;
      // Old server; leave extensions empty and commit the framework-only
      // snapshot below so subscribers still fire exactly once.
    }

    // ONE commit point, and it is the last thing that happens: `serverInfo`
    // and `capabilities` describe the same peer at the same instant, and an
    // attempt superseded while it awaited either RPC publishes nothing.
    if (epoch !== this.handshakeEpoch) return;
    if (initResult) {
      this._serverInfo = {
        name: initResult.serverInfo.name,
        version: initResult.serverInfo.version,
        protocolVersion: initResult.protocolVersion,
        connectionId: initResult.connectionId,
      };
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
    framework: import("@agentick/spec").ServerCapabilities,
    extensions: readonly import("@agentick/spec").WireExtensionInfo[],
  ): void {
    this._capabilities = buildClientCapabilities(framework, extensions);
    this.capabilityListeners.notify(this._capabilities);
  }

  async close(): Promise<void> {
    // A deliberate close cancels the handshake retry loop — "never stops
    // trying" is a promise about failures, not about instructions.
    this.closed = true;
    this.invalidateHandshake();
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
    this.rejectReadyWaiters(new Error(`client ${this.id} was closed while waiting for readiness`));
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

/** Render a `ClientState` for an error message (the failed variant is an object). */
function describeClientState(s: ClientState): string {
  if (typeof s === "string") return s;
  const e = s.error;
  return "message" in e ? `failed: ${e.kind} — ${e.message}` : `failed: ${e.kind}`;
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
 * `@agentick/transport` (`{ kind: "rpc", error: { code: -32601 } }`)
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
