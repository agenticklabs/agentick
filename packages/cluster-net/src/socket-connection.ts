/**
 * `socketToConnection` — wrap a Node `net.Socket` in the
 * message-oriented {@link Connection} interface from
 * `@agentick/cluster-broker`.
 *
 * The base broker / base client speak in messages; TCP delivers
 * bytes. This adapter:
 *
 *   - Feeds inbound bytes through {@link createLengthPrefixedDecoder};
 *     fires the message handler once per complete length-prefixed
 *     frame.
 *   - Wraps outbound messages with {@link encodeLengthPrefixed} and
 *     writes them to the socket.
 *   - Translates socket lifecycle events into a single
 *     {@link ConnectionCloseReason}.
 *
 * Used by BOTH the listener (per accepted socket) and the connector
 * (per outbound dial). Same wire format, same framing in both
 * directions.
 *
 * Phase 4f.4 resolved per-connection backpressure at the broker
 * layer (`BoundedWriteQueue` in `@agentick/cluster-broker`).
 * Below the broker, `writeToSocket` already awaits `socket.drain`
 * before resolving — `socket.write` returns false → we await drain
 * → resolve. The bounded queue caps the broker-side buffer; the
 * kernel buffer + drain handles the in-flight write back-pressure.
 */

import type { Socket } from "node:net";

import type { Connection, ConnectionCloseReason } from "@agentick/cluster-broker";
import { createLengthPrefixedDecoder, encodeLengthPrefixed } from "@agentick/cluster-broker";
import { generateId, omitUndefined } from "@agentick/utils";

export interface SocketConnectionOptions {
  /** Optional id; defaults to a fresh ULID. Used by BaseBroker for routing. */
  readonly id?: string;
  /** Optional max frame bytes; passed through to the length-prefix decoder. */
  readonly maxFrameBytes?: number;
  /**
   * Optional diagnostic emitter for framing-layer errors (decoder
   * poisoned, oversized frame, etc.). Concrete wire factories
   * (`tcpListener`, `tcpConnector`) bridge this into their parent's
   * `onDiagnostic`.
   */
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
}

export function socketToConnection(socket: Socket, opts: SocketConnectionOptions = {}): Connection {
  const id = opts.id ?? `tcp-${generateId()}`;
  const remote = describeRemote(socket);
  const decoder = createLengthPrefixedDecoder({
    ...omitUndefined({ maxFrameBytes: opts.maxFrameBytes }),
  });
  const onDiagnostic = opts.onDiagnostic ?? (() => {});

  let messageHandler: ((message: Uint8Array) => void) | null = null;
  const closeHandlers = new Set<(reason: ConnectionCloseReason) => void>();
  let closed = false;
  let closeReason: ConnectionCloseReason | undefined;

  function recordClose(reason: ConnectionCloseReason): void {
    if (closed) return;
    closed = true;
    closeReason = reason;
    for (const handler of [...closeHandlers]) {
      try {
        handler(reason);
      } catch (cause) {
        onDiagnostic("cluster:broker:net:close-handler-threw", {
          id,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    closeHandlers.clear();
    messageHandler = null;
  }

  socket.on("data", (chunk: Buffer) => {
    if (closed) return;
    // Node `Buffer` is a Uint8Array subclass; slice to a plain
    // Uint8Array to free the underlying pool buffer.
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice();
    const { frames, error } = decoder.feed(bytes);
    if (error) {
      onDiagnostic("cluster:broker:net:decoder-poisoned", {
        id,
        reason: error._tag,
        declaredBytes: error.declaredBytes,
        maxBytes: error.maxBytes,
      });
      // Decoder is poisoned — close the socket. The base classes
      // observe via their close handler.
      socket.destroy();
      return;
    }
    if (messageHandler) {
      for (const frame of frames) {
        try {
          messageHandler(frame);
        } catch (cause) {
          onDiagnostic("cluster:broker:net:message-handler-threw", {
            id,
            reason: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    }
  });

  socket.on("end", () => recordClose("remote-graceful"));
  socket.on("close", () => recordClose(closed ? closeReason! : "remote-abort"));
  socket.on("error", (cause) => {
    onDiagnostic("cluster:broker:net:socket-error", {
      id,
      reason: cause.message,
    });
    recordClose("transport-error");
  });

  return {
    id,
    remote,
    async send(message) {
      if (closed) throw new Error(`cluster-net: send on closed connection ${id}`);
      const framed = encodeLengthPrefixed(message);
      await writeToSocket(socket, framed);
    },
    onMessage(handler) {
      if (messageHandler !== null) {
        throw new Error(`cluster-net: connection ${id} already has a message handler attached`);
      }
      messageHandler = handler;
      return () => {
        if (messageHandler === handler) messageHandler = null;
      };
    },
    onClose(handler) {
      if (closed && closeReason) {
        // Fire synchronously next tick; matches the Connection
        // contract.
        queueMicrotask(() => handler(closeReason!));
        return () => {};
      }
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },
    async close() {
      if (closed) return;
      // Half-close gracefully — sends a TCP FIN so the peer's
      // `end` event fires before its `close`. Some peers
      // distinguish "remote sent FIN" (graceful) from "socket
      // dropped" (abort); the half-close is the cooperative
      // signal.
      await new Promise<void>((resolve) => {
        socket.end(() => resolve());
      });
      // `close` event will fire and trigger recordClose; if it
      // doesn't fire promptly, force the destroy + record.
      if (!closed) {
        socket.destroy();
        recordClose("local-close");
      }
    },
  };
}

/**
 * Promise-wrapped `socket.write(bytes)`. Awaits `drain` if the
 * kernel buffer is full so the caller's Promise resolves only when
 * bytes have been handed to the kernel.
 */
function writeToSocket(socket: Socket, bytes: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ok = socket.write(bytes, (err) => {
      if (err) reject(err);
      else if (ok) resolve();
    });
    if (!ok) {
      // Wait for drain before resolving so back-pressure is
      // observable to the caller.
      socket.once("drain", () => resolve());
    }
  });
}

function describeRemote(socket: Socket): string | undefined {
  const addr = socket.remoteAddress;
  const port = socket.remotePort;
  if (addr === undefined || port === undefined) return undefined;
  return `${addr}:${port}`;
}
