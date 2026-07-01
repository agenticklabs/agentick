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
  private readonly closeHandlers: Array<() => void | Promise<void>> = [];
  private readonly namespaces = new Map<string, unknown>();

  private currentState: ClientState = "idle";
  private _capabilities: ClientCapabilities = EMPTY_CLIENT_CAPABILITIES;
  private _serverInfo: ServerInfo | undefined = undefined;

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
      // Clear stale capabilities when the wire drops. Repopulated by
      // the handshake on next successful connect. `reconnecting`
      // also clears — the peer we come back to may have restarted
      // with a different extension set.
      if (s === "reconnecting" || s === "closed" || isFailedState(s)) {
        this._capabilities = EMPTY_CLIENT_CAPABILITIES;
        this._serverInfo = undefined;
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

    // Both handshake methods tolerate MethodNotFound (older-server /
    // stub-transport compat): the client falls back to empty
    // capabilities and empty server info in that case. Every other
    // failure mode is propagated to the caller — we can't silently
    // paper over a broken handshake.
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
  }

  private applyExtensionsList(
    framework: import("@agentick/spec-next").ServerCapabilities,
    listResult: ExtensionsListResult,
  ): void {
    this._capabilities = buildClientCapabilities(framework, listResult.extensions);
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
    await this.transport.close();
  }

  onStateChange(handler: (state: ClientState) => void): () => void {
    return this.stateListeners.subscribe(handler);
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
