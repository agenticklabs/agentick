/**
 * `wsToConnection` — wrap a `ws` library `WebSocket` in the
 * message-oriented {@link Connection} interface from
 * `@agentick/cluster-broker`.
 *
 * **Key difference from TCP/Unix**: WebSocket is message-framed at
 * the protocol level. Each `ws.send(bytes)` ships one frame; each
 * `'message'` event delivers one frame. Length-prefix wrapping is
 * REDUNDANT — base broker / base client speak in messages already,
 * and WS preserves boundaries natively. @agentick/cluster-broker's
 * length-prefix helper is bypassed entirely on the WS wire.
 *
 * Inbound binary frames are passed through as `Uint8Array`. WS can
 * also deliver text frames; those are treated as malformed at the
 * wire boundary (cluster protocol uses binary codec output) — we
 * emit `cluster:broker:ws:text-frame-rejected` and drop.
 */

import type { WebSocket as WSConnection } from "ws";

import type { Connection, ConnectionCloseReason } from "@agentick/cluster-broker";
import { generateId } from "@agentick/utils";

export interface WsConnectionOptions {
  /** Optional connection id; defaults to a fresh ULID. */
  readonly id?: string;
  /** Optional remote descriptor (e.g., `req.socket.remoteAddress:port`). */
  readonly remote?: string;
  /** Diagnostic emitter. */
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
}

export function wsToConnection(ws: WSConnection, opts: WsConnectionOptions = {}): Connection {
  const id = opts.id ?? `ws-${generateId()}`;
  const remote = opts.remote;
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
        onDiagnostic("cluster:broker:ws:close-handler-threw", {
          id,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    closeHandlers.clear();
    messageHandler = null;
  }

  ws.on("message", (data: unknown, isBinary?: boolean) => {
    if (closed) return;
    // The `ws` library hands us Buffer / ArrayBuffer / Buffer[]
    // depending on the message. Normalize to Uint8Array.
    // Cluster wire uses binary frames only; text frames are
    // adopter content protocol pollution.
    if (isBinary === false) {
      onDiagnostic("cluster:broker:ws:text-frame-rejected", { id });
      return;
    }
    const bytes = normalizeBinary(data);
    if (!bytes) {
      onDiagnostic("cluster:broker:ws:unrecognized-payload", { id });
      return;
    }
    if (messageHandler) {
      try {
        messageHandler(bytes);
      } catch (cause) {
        onDiagnostic("cluster:broker:ws:message-handler-threw", {
          id,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  });

  ws.on("close", (code: number) => {
    // WS close code 1000 = normal closure; 1001 = peer going away.
    // Both are graceful. Anything else is treated as abort/error.
    const reason: ConnectionCloseReason =
      code === 1000 || code === 1001 ? "remote-graceful" : "remote-abort";
    recordClose(reason);
  });
  ws.on("error", (cause: Error) => {
    onDiagnostic("cluster:broker:ws:socket-error", { id, reason: cause.message });
    recordClose("transport-error");
  });

  return {
    id,
    remote,
    async send(message) {
      if (closed) throw new Error(`cluster-ws: send on closed connection ${id}`);
      // Slice to a fresh Uint8Array so the ws library can take
      // ownership without disturbing the caller's buffer.
      const snapshot = message.slice();
      await new Promise<void>((resolve, reject) => {
        // `ws` accepts ArrayBufferView; binary: true forces a
        // binary frame.
        ws.send(snapshot, { binary: true }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    onMessage(handler) {
      if (messageHandler !== null) {
        throw new Error(`cluster-ws: connection ${id} already has a message handler attached`);
      }
      messageHandler = handler;
      return () => {
        if (messageHandler === handler) messageHandler = null;
      };
    },
    onClose(handler) {
      if (closed && closeReason) {
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
      // 1000 = normal closure — signals "we're done, peer should
      // also close cleanly." `ws` flushes pending sends before
      // emitting 'close'.
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        try {
          ws.close(1000);
        } catch {
          // Already closed by underlying socket — resolve.
          resolve();
        }
      });
      if (!closed) recordClose("local-close");
    },
  };
}

function normalizeBinary(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data.slice();
  if (data instanceof ArrayBuffer) return new Uint8Array(data).slice();
  if (Array.isArray(data)) {
    // ws library hands us Buffer[] for fragmented messages.
    const total = data.reduce<number>(
      (acc, chunk) => acc + (chunk instanceof Uint8Array ? chunk.length : 0),
      0,
    );
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of data) {
      if (chunk instanceof Uint8Array) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
    }
    return out;
  }
  return null;
}
