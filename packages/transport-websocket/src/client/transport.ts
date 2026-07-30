/**
 * WebSocket `ClientTransport`.
 *
 * Subclasses `BaseClientTransport` and supplies WS-specific connection
 * management — subprotocol negotiation, the WebSocket constructor
 * (defaults to `globalThis.WebSocket`), and decode of inbound frames.
 *
 * Reconnect, RPC correlation, subscription multiplexing, cursor-aware
 * resubscribe all live in the base. Phase 33.C.2 consolidation moved
 * the reconnect machinery (exponential backoff with full jitter,
 * scheduleReconnect, computeBackoff, handleConnectionDrop) into the
 * base so it's shared with the Unix-socket and HTTP transports.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import type { ClientTransport, JsonRpcFrame, TransportCapabilities } from "@agentick/spec";
import {
  BaseClientTransport,
  DEFAULT_KEEPALIVE_POLICY,
  DEFAULT_RECONNECT_POLICY,
  transportError,
  type KeepalivePolicy,
  type ReconnectPolicy,
} from "@agentick/transport/client";
import { AGENTICK_SUBPROTOCOL, decodeFrame, encodeFrame } from "../shared/codec.js";

// ── WebSocket constructor type — matches both browser native and `ws` ─────

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** `ws` library only — an abrupt teardown with no close handshake. */
  terminate?: () => void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
  addEventListener(type: "close", listener: (ev: { code: number; reason: string }) => void): void;
  removeEventListener?: (...args: unknown[]) => void;
};

type WebSocketConstructor = new (
  url: string,
  protocols?: string | readonly string[],
) => WebSocketLike;

export interface WebSocketTransportOptions {
  readonly url: string;
  /**
   * Defaults to `globalThis.WebSocket`. Pass `(await import("ws")).WebSocket`
   * for Node 18/20 or when you need custom headers in Node.
   */
  readonly WebSocket?: WebSocketConstructor;
  /** Additional subprotocols offered at the upgrade. E.g. ["mcp"] for
   *  bilingual servers. */
  readonly extraSubprotocols?: readonly string[];
  /** Exponential backoff (100ms → 30s cap) with full jitter by default. */
  readonly reconnect?: ReconnectPolicy;
  /**
   * How a silently-dead wire is detected — a `ping` RPC every 30s with a 10s
   * deadline by default. Without it, a blackholed path (sleep, NAT eviction,
   * a load balancer that stops forwarding) leaves the socket in `OPEN` and no
   * `close` event ever arms the reconnect loop. See {@link KeepalivePolicy}.
   */
  readonly keepalive?: KeepalivePolicy;
  readonly id?: string;
}

export type { KeepalivePolicy, ReconnectPolicy };

const CAPABILITIES: TransportCapabilities = {
  bidirectional: true,
  streamingRequest: true,
  reconnectable: true,
  binaryFrames: false,
  media: false,
};

let transportCounter = 0;

export function websocket(options: WebSocketTransportOptions): ClientTransport {
  return new WebSocketTransport(options);
}

class WebSocketTransport extends BaseClientTransport {
  readonly id: string;
  readonly capabilities = CAPABILITIES;

  private readonly url: string;
  private readonly ctor: WebSocketConstructor;
  private readonly subprotocols: readonly string[];

  private socket: WebSocketLike | null = null;

  constructor(options: WebSocketTransportOptions) {
    super();
    this.id = options.id ?? `ws-${++transportCounter}`;
    this.url = options.url;
    this.ctor = options.WebSocket ?? resolveDefaultWebSocketCtor();
    this.subprotocols = [AGENTICK_SUBPROTOCOL, ...(options.extraSubprotocols ?? [])];
    this.reconnectPolicy = { ...DEFAULT_RECONNECT_POLICY, ...(options.reconnect ?? {}) };
    this.keepalivePolicy = { ...DEFAULT_KEEPALIVE_POLICY, ...(options.keepalive ?? {}) };
  }

  protected async openConnection(): Promise<void> {
    this.explicitClose = false;
    await this.openSocket();
  }

  protected async closeConnection(): Promise<void> {
    this.explicitClose = true;
    this.cancelReconnect();
    if (this.socket && this.socket.readyState <= 1) {
      this.socket.close(1000, "client close");
    }
    this.socket = null;
  }

  protected sendFrame(frame: JsonRpcFrame): void {
    if (!this.socket || this.currentState !== "open") return;
    this.socket.send(encodeFrame(frame));
  }

  /**
   * Drop a wire the liveness probe found dead. `close()` is the wrong verb: it
   * starts a closing handshake that waits for a peer close-frame a blackholed
   * path will never send, leaving the socket wedged in `CLOSING`. Prefer the
   * `ws` library's abrupt `terminate()`; the browser/undici `WebSocket` has no
   * equivalent, so fall back to `close()` — either way the reference is
   * dropped first, which is what makes the redial safe (see the staleness
   * guards in {@link openSocket}).
   */
  protected override discardWire(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      if (typeof socket.terminate === "function") socket.terminate();
      else socket.close();
    } catch {
      /* the wire is already gone — nothing left to release */
    }
  }

  // ── WS-specific machinery ────────────────────────────────────────────

  private async openSocket(): Promise<void> {
    this.setState("connecting");

    return new Promise<void>((resolve, reject) => {
      const socket = new this.ctor(this.url, this.subprotocols);
      this.socket = socket;

      // Every listener below is scoped to THIS socket. A redial installs a
      // fresh set, and the socket it replaced can still emit late — a zombie
      // discarded by `discardWire`, or a dial that lost the race. Acting on
      // those events would tear down the healthy connection that replaced it,
      // so each one returns early once `this.socket` has moved on.
      const isCurrent = (): boolean => this.socket === socket;

      socket.addEventListener("open", () => {
        if (!isCurrent()) return;
        this.markWireUp();
        this.setState("open");
        this.resubscribeAfterReconnect();
        resolve();
      });

      socket.addEventListener("message", (ev) => {
        if (!isCurrent()) return;
        this.handleMessage(ev.data);
      });

      // A dial can also fail with a `close` and NO `error` — a refused
      // subprotocol, an upgrade the server answered 403. Rejecting from
      // whichever arrives first is what keeps `connect()` from hanging
      // forever on those paths.
      const failDial = (cause: unknown): void => {
        reject(
          transportError({
            kind: "connection",
            // A rejected dial does not mean the transport gave up — with
            // reconnect enabled the backoff loop is already armed and will
            // keep dialing. Say so, or adopters read this as terminal.
            message: this.reconnectPolicy.enabled
              ? `WebSocket dial to ${this.url} failed; reconnect is armed and will keep retrying (watch onStateChange)`
              : `WebSocket dial to ${this.url} failed and reconnect is disabled`,
            cause,
          }),
        );
      };

      socket.addEventListener("error", (err) => {
        if (!isCurrent() || this.currentState === "open") return;
        failDial(err);
      });

      socket.addEventListener("close", (ev) => {
        if (!isCurrent()) return;
        // `reject` after `resolve` is a no-op, so an established connection
        // closing settles nothing here — it just runs the drop path.
        failDial(ev);
        this.handleConnectionDrop();
      });
    });
  }

  private handleMessage(raw: unknown): void {
    const decoded = decodeFrame(raw as string | ArrayBuffer | Buffer);
    if (!decoded.ok) return;
    const frame = decoded.value;
    if (Array.isArray(frame)) {
      for (const f of frame) this.routeFrame(f as JsonRpcFrame);
      return;
    }
    this.routeFrame(frame as JsonRpcFrame);
  }
}

function resolveDefaultWebSocketCtor(): WebSocketConstructor {
  const g = globalThis as { WebSocket?: WebSocketConstructor };
  if (typeof g.WebSocket === "function") return g.WebSocket;
  throw new Error(
    'No `globalThis.WebSocket` available. Pass `{ WebSocket: (await import("ws")).WebSocket }` to opt into the `ws` library (Node 18/20 or custom-header use cases).',
  );
}
