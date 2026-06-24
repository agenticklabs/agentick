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
  SendInput,
  WireMethod,
  WireParams,
  WireResult,
} from "@agentick/spec-next";
import { createNotifier } from "@agentick/pubsub-next";
import { ClientHandlerRegistry } from "./handler-registry.js";
import { makeAppHandle, makeGatewayHandle, makeSessionHandle } from "./handles.js";
import { composeRequest } from "./pipeline.js";

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

  async connect(): Promise<void> {
    await this.transport.connect();
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
