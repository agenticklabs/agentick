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
import type { ClientTransport, JsonRpcFrame, TransportCapabilities } from "@agentick/spec";
import {
  BaseClientTransport,
  DEFAULT_RECONNECT_POLICY,
  transportError,
  type ReconnectPolicy,
} from "@agentick/transport/client";
import { NdjsonDecoder, encodeNdjson, type NdjsonDecoderOptions } from "../shared/ndjson.js";

export interface UnixSocketTransportOptions {
  /** Absolute path to the Unix socket. */
  readonly path: string;
  readonly reconnect?: ReconnectPolicy;
  readonly id?: string;
  /**
   * Bytes one inbound NDJSON line may occupy before the decoder refuses it.
   * Defaults to `DEFAULT_MAX_LINE_BYTES` (16 MiB). A server is usually more
   * trusted than a client, but the framing bound is symmetric — an unbounded
   * decoder is unbounded in both directions.
   */
  readonly maxLineBytes?: number;
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
  private readonly decoderOptions: NdjsonDecoderOptions;
  private socket: Socket | null = null;
  private decoder: NdjsonDecoder;

  constructor(options: UnixSocketTransportOptions) {
    super();
    this.id = options.id ?? `unix-${++transportCounter}`;
    this.socketPath = options.path;
    this.decoderOptions =
      options.maxLineBytes !== undefined ? { maxLineBytes: options.maxLineBytes } : {};
    this.decoder = new NdjsonDecoder(this.decoderOptions);
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
    this.decoder = new NdjsonDecoder(this.decoderOptions);
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
          // An `Error` (stack, `instanceof`, logger-friendly) that is still
          // structurally a `TransportError` — callers keep switching on `kind`.
          reject(
            transportError({
              kind: "connection",
              message: `unix socket connect failed (${String(err)})`,
              cause: err,
            }),
          );
        }
      };

      socket.once("error", onError);

      socket.once("connect", () => {
        socket.removeListener("error", onError);
        this.socket = socket;
        this.resetReconnectAttempts();
        this.decoder = new NdjsonDecoder(this.decoderOptions);
        this.setState("open");
        this.resubscribeAfterReconnect();
        resolve();
      });

      socket.on("data", (chunk: Buffer) => {
        for (const result of this.decoder.push(chunk)) {
          if (!result.ok) {
            // Framing lost (an oversized line) — nothing further on this socket
            // can be trusted to start at a frame boundary. Drop it and let the
            // base class's reconnect machinery decide what happens next.
            if (result.fatal === true) {
              socket.destroy();
              return;
            }
            continue;
          }
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
