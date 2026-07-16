/**
 * Unix-socket `ClientTransport`.
 *
 * Subclasses `BaseClientTransport` and supplies socket-specific
 * connection management. Reconnect, RPC correlation, subscription
 * multiplexing, cursor-aware resubscribe all live in the base.
 * Phase 33.C.2 moved the reconnect machinery (exponential backoff
 * with full jitter, scheduleReconnect, computeBackoff,
 * handleConnectionDrop) into the base so it's shared with the
 * WebSocket and HTTP transports.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import { connect as netConnect, type Socket } from "node:net";
import type { ClientTransport, JsonRpcFrame, TransportCapabilities } from "@agentick/spec-next";
import {
  BaseClientTransport,
  DEFAULT_RECONNECT_POLICY,
  type ReconnectPolicy,
} from "@agentick/transport-next";
import { NdjsonDecoder, encodeNdjson } from "../shared/ndjson.js";

export interface UnixSocketTransportOptions {
  /** Absolute path to the Unix socket. */
  readonly path: string;
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

export function unixSocket(options: UnixSocketTransportOptions): ClientTransport {
  return new UnixSocketTransport(options);
}

class UnixSocketTransport extends BaseClientTransport {
  readonly id: string;
  readonly capabilities = CAPABILITIES;

  private readonly socketPath: string;
  private socket: Socket | null = null;
  private decoder = new NdjsonDecoder();

  constructor(options: UnixSocketTransportOptions) {
    super();
    this.id = options.id ?? `unix-${++transportCounter}`;
    this.socketPath = options.path;
    this.reconnectPolicy = { ...DEFAULT_RECONNECT_POLICY, ...(options.reconnect ?? {}) };
  }

  protected async openConnection(): Promise<void> {
    this.explicitClose = false;
    await this.openSocket();
  }

  protected async closeConnection(): Promise<void> {
    this.explicitClose = true;
    this.cancelReconnect();
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
        this.resetReconnectAttempts();
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
        this.handleConnectionDrop();
      });
    });
  }
}
