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

  /**
   * Destroy a socket the liveness probe found dead. `end()` is the wrong verb:
   * it half-closes and waits on a peer that is not answering (a SIGSTOP'd
   * server, a filesystem that went away), which would leak the fd for as long
   * as the process lives.
   */
  protected override discardWire(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
  }

  private async openSocket(): Promise<void> {
    this.setState("connecting");
    return new Promise<void>((resolve, reject) => {
      const socket = netConnect(this.socketPath);
      // Held from the moment the dial starts, exactly as the WS transport
      // does. A socket this transport does not hold is a socket whose events
      // it must ignore, and `isCurrent` below is the whole of that rule —
      // which is what lets the `close` listener stay installed on a FAILED
      // dial and drive the reconnect loop uniformly.
      this.socket = socket;

      const isCurrent = (): boolean => this.socket === socket;

      // A failed dial reports through `close`, not here: `net` emits `error`
      // and then `close` on the same socket, and letting the drop path own the
      // reconnect keeps one loop instead of two. This listener's only job is
      // to settle the caller's promise with a reason.
      const onError = (err: unknown) => {
        if (!isCurrent() || this.currentState === "open") return;
        // An `Error` (stack, `instanceof`, logger-friendly) that is still
        // structurally a `TransportError` — callers keep switching on `kind`.
        reject(
          transportError({
            kind: "connection",
            // A rejected dial does not mean the transport gave up — with
            // reconnect enabled the backoff loop is armed and keeps dialing.
            // Say so, or adopters read this as terminal.
            message: this.reconnectPolicy.enabled
              ? `unix socket dial to ${this.socketPath} failed (${String(err)}); reconnect is armed and will keep retrying (watch onStateChange)`
              : `unix socket dial to ${this.socketPath} failed (${String(err)}) and reconnect is disabled`,
            cause: err,
          }),
        );
      };

      socket.once("error", onError);

      socket.once("connect", () => {
        if (!isCurrent()) {
          // A dial that lost the race to a later one. Release it rather than
          // leaking the fd.
          socket.destroy();
          return;
        }
        this.markWireUp();
        this.decoder = new NdjsonDecoder(this.decoderOptions);
        this.setState("open");
        this.resubscribeAfterReconnect();
        resolve();
      });

      socket.on("data", (chunk: Buffer) => {
        if (!isCurrent()) return;
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
        // Ignore a socket we no longer hold: `discardWire` already reported
        // this wire's death, and a second report would arm a competing dial
        // loop. See the note on `handleConnectionDrop`.
        if (!isCurrent()) return;
        // `reject` after `resolve` is a no-op, so an established connection
        // closing settles nothing here — it just runs the drop path. A dial
        // that never connected settles the caller's promise with the reason
        // the socket gave (ENOENT, ECONNREFUSED) via `onError` above, and
        // reaches the drop path here — which is what keeps ONE failed redial
        // from parking the transport in `connecting` forever (#262).
        this.socket = null;
        this.handleConnectionDrop();
      });
    });
  }
}
