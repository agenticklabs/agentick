/**
 * `Connection` / `Listener` / `Connector` — wire-agnostic primitives
 * that concrete wire packages (@agentick/cluster-net, @agentick/cluster-ws)
 * implement.
 *
 * Critical design point: `Connection` is **message-oriented**, not
 * byte-stream-oriented. Each `send(bytes)` ships ONE logical message;
 * `onMessage(handler)` fires per-message. The wire impl handles its
 * own delimiting:
 *
 *   - **TCP / Unix socket** — wraps the raw socket with the
 *     length-prefix framing helper from `./framing.ts` to recover
 *     message boundaries from a byte stream.
 *   - **WebSocket** — uses native WS message boundaries directly; no
 *     length-prefix needed.
 *
 * This separation lets the base broker / base client work uniformly
 * over any wire — they think in messages, never in bytes.
 */

export type ConnectionCloseReason =
  | "remote-graceful"
  | "remote-abort"
  | "local-close"
  | "transport-error";

/**
 * Message-oriented duplex channel between two endpoints (broker ↔
 * client). The wire impl decides what "message" means at the byte
 * level; consumers see `Uint8Array` messages in and out.
 */
export interface Connection {
  /**
   * Local-unique connection id. Used by the broker to route messages
   * back to a specific client; opaque to base-level code.
   *
   * TODO(phase-4b): formalize id allocation convention across wire
   * impls. Currently each wire picks its own scheme — risk of
   * collision if multiple listeners share a process. Candidates:
   * `${wireType}:${remote}:${monotonic}` or just `generateId()`. Decide
   * once TCP + Unix-socket impls both exist.
   */
  readonly id: string;

  /**
   * Best-effort peer descriptor for diagnostics (e.g.,
   * `"127.0.0.1:54321"`, `"/tmp/agentick.sock"`,
   * `"ws://example.com/cluster"`). Optional; not used for routing.
   */
  readonly remote?: string;

  /** Send one logical message. Rejects on transport-level failure. */
  send(message: Uint8Array): Promise<void>;

  /**
   * Register the message handler. EXACTLY ONE handler may be
   * attached at a time — attempting to register a second handler
   * before the first detaches throws (the wire impls would otherwise
   * silently fan out, which the base classes never want). The
   * returned function detaches the handler.
   *
   * Single-handler semantics match how the base classes actually use
   * the Connection: `BaseBroker` attaches exactly one
   * `onClientMessage` per accepted connection; `BaseClusterClient`
   * attaches exactly one `onInbound` per connection. Multi-handler
   * support was dead-design code — removed in Phase 4a.2.
   */
  onMessage(handler: (message: Uint8Array) => void): () => void;

  /**
   * Register a close handler. Multiple close handlers MAY be
   * attached (e.g., one for logging, one for state-machine
   * transitions); each fires exactly once per Connection when the
   * underlying wire transitions to closed. Registrations after the
   * close handler has fired SHOULD fire immediately (synchronously)
   * with the recorded reason.
   */
  onClose(handler: (reason: ConnectionCloseReason) => void): () => void;

  /**
   * Cooperative close. Drops handlers, signals graceful shutdown to
   * the peer if the wire supports it (e.g., WS close frame; TCP
   * half-close), releases resources. Idempotent.
   */
  close(): Promise<void>;
}

/**
 * Server-side: accepts incoming connections. Concrete wire impls
 * subclass via the broker's `start()` lifecycle; the broker reads
 * from `onConnection` to track every new peer.
 */
export interface Listener {
  /** Begin accepting connections. Idempotent on repeated calls. */
  start(): Promise<void>;

  /**
   * Register an accept handler. The handler receives a freshly-opened
   * `Connection` per accepted peer. Returned function detaches.
   */
  onConnection(handler: (conn: Connection) => void): () => void;

  /**
   * Local descriptor for diagnostics (e.g., `"tcp://127.0.0.1:9876"`,
   * `"unix:///tmp/agentick.sock"`). Optional.
   */
  readonly bound?: string;

  /**
   * Stop accepting + close every currently-open accepted connection.
   * Idempotent.
   */
  close(): Promise<void>;
}

/**
 * Client-side: establishes ONE connection. Concrete wire impls
 * implement `connect()` to perform the wire-specific handshake; the
 * base client uses the resulting `Connection` for its lifecycle.
 *
 * The base client owns reconnect — on `Connection` close, it calls
 * `connector.connect()` again with backoff. Connectors MUST be
 * idempotent across calls (each `connect()` produces a fresh
 * `Connection`).
 */
export interface Connector {
  connect(): Promise<Connection>;

  /**
   * Local descriptor for diagnostics (e.g., what we're trying to
   * connect to). Optional.
   */
  readonly target?: string;
}
