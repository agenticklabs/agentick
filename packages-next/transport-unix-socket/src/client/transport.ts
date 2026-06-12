/**
 * Unix-socket `ClientTransport`. Newline-delimited JSON-RPC over a
 * Node `net.Socket`. Required for tentickle-class local-IPC shapes
 * (TUI ↔ same-host daemon) and any single-host adopter who wants the
 * lowest-latency wire without HTTP/WS framing overhead.
 *
 * Subclasses `BaseClientTransport` — gets state machine, RPC
 * correlation, subscription multiplexing, cursor-aware resubscribe
 * for free.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import { connect as netConnect, type Socket } from "node:net";
import type { ClientTransport, JsonRpcFrame, TransportCapabilities } from "@agentick/spec-next";
import { BaseClientTransport } from "@agentick/transport-next";
import { NdjsonDecoder, encodeNdjson } from "../shared/ndjson.js";

export interface UnixSocketTransportOptions {
  /** Absolute path to the Unix socket. */
  readonly path: string;
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

export function unixSocket(options: UnixSocketTransportOptions): ClientTransport {
  return new UnixSocketTransport(options);
}

class UnixSocketTransport extends BaseClientTransport {
  readonly id: string;
  readonly capabilities = CAPABILITIES;

  private readonly socketPath: string;
  private readonly reconnect: Required<ReconnectPolicy>;

  private socket: Socket | null = null;
  private decoder = new NdjsonDecoder();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitClose = false;

  constructor(options: UnixSocketTransportOptions) {
    super();
    this.id = options.id ?? `unix-${++transportCounter}`;
    this.socketPath = options.path;
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
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    this.decoder = new NdjsonDecoder();
  }

  protected sendFrame(frame: JsonRpcFrame): void {
    if (!this.socket || this.currentState !== "open") return;
    this.socket.write(encodeNdjson(frame));
  }

  private async openSocket(): Promise<void> {
    this.setState("connecting");
    return new Promise<void>((resolve, reject) => {
      const socket = netConnect(this.socketPath);

      const onError = (err: unknown) => {
        if (this.currentState !== "open") {
          socket.removeAllListeners();
          reject({
            kind: "connection",
            message: `unix socket connect failed (${String(err)})`,
            cause: err,
          });
        }
      };

      socket.once("error", onError);

      socket.once("connect", () => {
        socket.removeListener("error", onError);
        this.socket = socket;
        this.reconnectAttempts = 0;
        this.decoder = new NdjsonDecoder();
        this.setState("open");
        this.resubscribeAfterReconnect();
        resolve();
      });

      socket.on("data", (chunk: Buffer) => {
        for (const result of this.decoder.push(chunk)) {
          if (!result.ok) continue;
          const frame = result.frame;
          if (Array.isArray(frame)) {
            for (const f of frame) this.routeFrame(f as JsonRpcFrame);
          } else {
            this.routeFrame(frame as JsonRpcFrame);
          }
        }
      });

      socket.on("close", () => {
        const wasOpen = this.currentState === "open";
        if (wasOpen) {
          for (const p of this.pending.values()) {
            p.reject({ kind: "closed", message: "unix socket closed mid-request" });
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
        // openSocket's reject path is handled via the close handler chain
      });
    }, delay);
  }

  /**
   * Exponential backoff with full jitter per AWS Builder's Library
   * "Timeouts, retries, and backoff with jitter".
   */
  private computeBackoff(attempt: number): number {
    const exp = Math.min(this.reconnect.maxDelayMs, this.reconnect.initialDelayMs * 2 ** attempt);
    return Math.random() * exp;
  }
}
