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
  ExtensionsListResult,
  GatewayHandle,
  InitializeResult,
  SendInput,
  ServerInfo,
  WireMethod,
  WireParams,
  WireResult,
} from "@agentick/spec-next";
import { EMPTY_CLIENT_CAPABILITIES, ErrorCode } from "@agentick/spec-next";
import { createNotifier } from "@agentick/pubsub-next";
import { buildClientCapabilities } from "./capabilities.js";
import { ClientHandlerRegistry } from "./handler-registry.js";
import { makeAppHandle, makeGatewayHandle, makeSessionHandle } from "./handles.js";
import { composeRequest } from "./pipeline.js";

/** Fixed client identity broadcast in `initialize.clientInfo`. */
const CLIENT_NAME = "@agentick/client-next";
const CLIENT_VERSION = "0.0.0";

let clientCounter = 0;

export interface CreateClientOptions {
  readonly transport: ClientTransport;
  readonly extensions?: readonly ClientExtension[];
  readonly id?: string;
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
  await client.installExtensions();
  return client as unknown as Client;
}

class AgentickClient implements ClientProtocol {
  readonly id: string;
  readonly transport: ClientTransport;
  readonly auth: ClientAuthSurface;

  private readonly extensions: readonly ClientExtension[];
  private readonly handlerRegistry = new ClientHandlerRegistry();
  private readonly clientBus: LocalEventBus;
  private readonly composedRequest: ReturnType<typeof composeRequest>;
  private readonly stateListeners = createNotifier<ClientState>();
  private readonly capabilityListeners = createNotifier<ClientCapabilities>();
  private readonly closeHandlers: Array<() => void | Promise<void>> = [];
  private readonly namespaces = new Map<string, unknown>();
  /** Unsubscribe for the `notifications/capabilities/changed` observer,
   *  set on connect(), cleared on close(). Null when no observer is armed. */
  private capabilityNotifUnsubscribe: (() => void) | null = null;

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
    this.composedRequest = composeRequest(this.extensions, (req) =>
      this.transport.request(req.method, req.params, req.signal),
    );

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
        this._capabilities = EMPTY_CLIENT_CAPABILITIES;
        this._serverInfo = undefined;
        this.reconnectHandshakePending = true;
        this.capabilityListeners.notify(this._capabilities);
      }
      if (s === "closed" || isFailedState(s)) {
        this._capabilities = EMPTY_CLIENT_CAPABILITIES;
        this._serverInfo = undefined;
        // Terminal — no reconnect coming, no handshake to owe.
        this.reconnectHandshakePending = false;
        this.capabilityListeners.notify(this._capabilities);
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
    // Arm the capability-refresh observer BEFORE the handshake — a
    // server that emits `notifications/capabilities/changed` between
    // `initialize` and `_extensions/list` (unlikely but legal) still
    // triggers our refetch path. The observer stays armed across
    // reconnects; the transport preserves subscribers through its
    // state machine.
    if (!this.capabilityNotifUnsubscribe) {
      this.capabilityNotifUnsubscribe = this.transport.onNotification(
        "notifications/capabilities/changed",
        () => {
          void this.refetchCapabilities();
        },
      );
    }
    await this.runHandshake();
  }

  /**
   * Await any in-flight post-reconnect handshake. Resolves immediately
   * when none is pending. Useful for adopters (and tests) that need to
   * synchronize on the moment `capabilities` becomes valid again after
   * a reconnect.
   *
   * The initial connect handshake is awaited by `connect()` itself —
   * this method is only load-bearing for the reconnect path.
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
    if (initResult) this.applyInitializeResult(initResult);

    try {
      const listResult = await this.request("_extensions/list", {});
      this.applyExtensionsList(initResult?.capabilities ?? {}, listResult);
    } catch (err) {
      if (!isMethodNotFound(err)) throw err;
    }
  }

  private applyInitializeResult(result: InitializeResult): void {
    this._serverInfo = {
      name: result.serverInfo.name,
      version: result.serverInfo.version,
      protocolVersion: result.protocolVersion,
      connectionId: result.connectionId,
    };
    this._capabilities = buildClientCapabilities(result.capabilities, []);
    // Don't fire capability subscribers yet — `applyExtensionsList`
    // fires the definitive event once discovery completes. Firing
    // here would yield an intermediate "framework-only, no extensions"
    // snapshot that adopters would then have to reconcile against a
    // second fire moments later.
  }

  private applyExtensionsList(
    framework: import("@agentick/spec-next").ServerCapabilities,
    listResult: ExtensionsListResult,
  ): void {
    this._capabilities = buildClientCapabilities(framework, listResult.extensions);
    this.capabilityListeners.notify(this._capabilities);
  }

  /**
   * Refetch `_extensions/list` in response to
   * `notifications/capabilities/changed` and swap the resulting
   * capabilities snapshot in. Framework flags from the last
   * `initialize` response are reused — the notification signals an
   * extension-set delta, not a framework-version delta. A concurrent
   * refetch (e.g., the server bursts multiple notifications) is
   * benign: each completes with the current server view and each
   * notifies listeners; later completions overwrite earlier ones.
   *
   * `MethodNotFound` from `_extensions/list` is tolerated silently
   * for parity with the initial handshake — a server that stops
   * implementing discovery mid-connection leaves an empty extension
   * set, with subscribers still notified so adopters can react.
   */
  private async refetchCapabilities(): Promise<void> {
    try {
      const listResult = await this.request("_extensions/list", {});
      this.applyExtensionsList(this._capabilities.framework, listResult);
    } catch (err) {
      if (!isMethodNotFound(err)) return;
      // Server dropped support mid-connection. Best-effort — leave
      // the current capabilities in place. Adopters relying on the
      // notification for feature discovery will still see a stale
      // set, but at least nothing crashes.
    }
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
    if (this.capabilityNotifUnsubscribe) {
      this.capabilityNotifUnsubscribe();
      this.capabilityNotifUnsubscribe = null;
    }
    await this.transport.close();
  }

  onStateChange(handler: (state: ClientState) => void): () => void {
    return this.stateListeners.subscribe(handler);
  }

  onCapabilitiesChange(listener: (capabilities: ClientCapabilities) => void): () => void {
    return this.capabilityListeners.subscribe(listener);
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
    return this.composedRequest({ method, params, signal } as never) as Promise<WireResult<M>>;
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
   *             `ClientSessionExecutionHandle` shape (AsyncIterable +
   *             `.result` + `abort()`).
   */
  send<P = unknown>(sessionId: string, input: SendInput<P>) {
    return makeSessionHandle(this, sessionId).send(input);
  }

  events(
    _filter?: ClientEventFilter,
    _fromCursor?: Cursor,
  ): AsyncIterable<ClientEvent> & { close(): Promise<void> } {
    // Phase 33.B ships the type surface + client-bus + extension registration.
    // The bus-Stream → AsyncIterable<ClientEvent> adapter lands in a follow-up
    // once the client `EventSurface` registration extends `@agentick/spec-next`'s
    // bus event-surface union. Today's bus is typed against `ProtocolEvent`;
    // client events are a separate surface family.
    return new ClientEventStream();
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

  private publishConnectionEvent(_from: ClientState, _to: ClientState): void {
    // Deferred — see events() comment. State listeners (added via
    // onStateChange) work today; bus-emitted events arrive in follow-up.
  }
}

/** True when the ClientState value is the failed-object variant. */
function isFailedState(s: ClientState): boolean {
  return typeof s === "object" && s !== null && "kind" in s && s.kind === "failed";
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
 * Reserved AsyncIterable for `client.events()`. The bus-Stream →
 * AsyncIterable adapter lands when client event surfaces are
 * registered on `@agentick/spec-next`'s `EventSurface` union.
 */
class ClientEventStream implements AsyncIterable<ClientEvent> {
  [Symbol.asyncIterator](): AsyncIterator<ClientEvent> {
    return {
      next: async () => ({ done: true, value: undefined as unknown as ClientEvent }),
    };
  }

  async close(): Promise<void> {
    /* no-op */
  }
}
