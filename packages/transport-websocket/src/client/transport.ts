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
  DEFAULT_RECONNECT_POLICY,
  type ReconnectPolicy,
} from "@agentick/transport/client";
import { AGENTICK_SUBPROTOCOL, decodeFrame, encodeFrame } from "../shared/codec.js";

// ── WebSocket constructor type — matches both browser native and `ws` ─────

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
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
  readonly id?: string;
}

export type { ReconnectPolicy };

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

  // ── WS-specific machinery ────────────────────────────────────────────

  private async openSocket(): Promise<void> {
    this.setState("connecting");

    return new Promise<void>((resolve, reject) => {
      const socket = new this.ctor(this.url, this.subprotocols);
      this.socket = socket;

      socket.addEventListener("open", () => {
        this.resetReconnectAttempts();
        this.setState("open");
        this.resubscribeAfterReconnect();
        resolve();
      });

      socket.addEventListener("message", (ev) => {
        this.handleMessage(ev.data);
      });

      socket.addEventListener("error", (err) => {
        if (this.currentState !== "open") {
          reject({ kind: "connection", message: "WebSocket error before open", cause: err });
        }
      });

      socket.addEventListener("close", () => {
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
