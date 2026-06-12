/**
 * WebSocket `ClientTransport` implementation.
 *
 * Subclasses `BaseClientTransport` from `@agentick/transport-next`;
 * supplies WS-specific connection management — subprotocol negotiation,
 * the WebSocket constructor (defaults to `globalThis.WebSocket`),
 * exponential-backoff-with-full-jitter reconnect, and cursor-aware
 * resubscribe after reconnect.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import type { ClientTransport, JsonRpcFrame, TransportCapabilities } from "@agentick/spec-next";
import { BaseClientTransport } from "@agentick/transport-next";
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

export interface ReconnectPolicy {
  readonly enabled?: boolean;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxAttempts?: number;
}

const DEFAULT_RECONNECT: Required<ReconnectPolicy> = {
  enabled: true,
  initialDelayMs: 100,
  maxDelayMs: 30_000,
  maxAttempts: Infinity,
};

const CAPABILITIES: TransportCapabilities = {
  bidirectional: true,
  streamingRequest: true,
  reconnectable: true,
  binaryFrames: false,
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
  private readonly reconnect: Required<ReconnectPolicy>;

  private socket: WebSocketLike | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitClose = false;

  constructor(options: WebSocketTransportOptions) {
    super();
    this.id = options.id ?? `ws-${++transportCounter}`;
    this.url = options.url;
    this.ctor = options.WebSocket ?? resolveDefaultWebSocketCtor();
    this.subprotocols = [AGENTICK_SUBPROTOCOL, ...(options.extraSubprotocols ?? [])];
    this.reconnect = { ...DEFAULT_RECONNECT, ...(options.reconnect ?? {}) };
  }

  protected async openConnection(): Promise<void> {
    this.explicitClose = false;
    await this.openSocket();
  }

  protected async closeConnection(): Promise<void> {
    this.explicitClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
        this.reconnectAttempts = 0;
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
        // While open: errors are logged via state; close event handles cleanup
      });

      socket.addEventListener("close", () => {
        const wasOpen = this.currentState === "open";
        if (wasOpen) {
          for (const p of this.pending.values()) {
            p.reject({ kind: "closed", message: "WebSocket closed mid-request" });
          }
          this.pending.clear();
        }
        if (this.explicitClose) {
          this.setState("closed");
          return;
        }
        if (!this.reconnect.enabled) {
          this.setState("closed");
          return;
        }
        if (this.reconnectAttempts >= this.reconnect.maxAttempts) {
          this.setState({
            kind: "failed",
            error: { kind: "connection", message: "reconnect attempts exhausted" },
          });
          return;
        }
        this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    this.setState("reconnecting");
    const delay = this.computeBackoff(this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket().catch(() => {
        // openSocket's reject path is handled by the close event chain
      });
    }, delay);
  }

  /**
   * Exponential backoff with full jitter per AWS Builder's Library
   * "Timeouts, retries, and backoff with jitter". Returns a uniform
   * random delay in [0, min(maxDelayMs, initialDelayMs * 2^attempt)).
   *
   * @verifiedBy src/__tests__/reconnect.spec.ts — reconnect transitions
   *             through "reconnecting" → "open" after server bounce.
   *             Jitter distribution properties (uniform [0, exp)) not
   *             yet under property-based test; deferred.
   */
  private computeBackoff(attempt: number): number {
    const exp = Math.min(this.reconnect.maxDelayMs, this.reconnect.initialDelayMs * 2 ** attempt);
    return Math.random() * exp;
  }

  private handleMessage(raw: unknown): void {
    const decoded = decodeFrame(raw as string | ArrayBuffer | Buffer);
    if (!decoded.ok) {
      // Server sent garbage — swallow. ADR 33 §5 open question on
      // validator-error notification routing.
      return;
    }
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
