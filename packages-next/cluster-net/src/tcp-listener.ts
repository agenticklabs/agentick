/**
 * `createTcpListener(opts)` — Node `net.Server` wrapped in the
 * `Listener` interface from `@agentick/cluster-broker-next`.
 *
 * Used by the broker side of the TCP wire. The base broker
 * subscribes via `onConnection` to receive freshly-accepted
 * `Connection`s, each of which is a `socketToConnection`-wrapped
 * `net.Socket`.
 */

import { createServer, type Server, type Socket } from "node:net";

import type { Connection, Listener } from "@agentick/cluster-broker-next";

import { socketToConnection } from "./socket-connection.js";
import { omitUndefined } from "@agentick/utils-next";

export type TcpListenerOptions =
  | {
      /** Bind host. Default: `"127.0.0.1"` (loopback-only for safety). */
      readonly host?: string;
      /** Bind port. Required. */
      readonly port: number;
      /** Optional max frame bytes per inbound connection. */
      readonly maxFrameBytes?: number;
      /** Optional diagnostic emitter for listener + per-conn framing diagnostics. */
      readonly onDiagnostic?: (name: string, payload?: unknown) => void;
      readonly adoptServer?: undefined;
    }
  | {
      /**
       * Adopt a pre-bound `net.Server` (typically from {@link tryBindOrConnect}).
       * The listener skips its own bind step and just wires the
       * connection handler.
       */
      readonly adoptServer: Server;
      readonly maxFrameBytes?: number;
      readonly onDiagnostic?: (name: string, payload?: unknown) => void;
      readonly host?: undefined;
      readonly port?: undefined;
    };

export function createTcpListener(opts: TcpListenerOptions): Listener {
  const adopted = opts.adoptServer;
  const host = adopted ? extractBindHost(adopted) : (opts.host ?? "127.0.0.1");
  const port = adopted ? extractBindPort(adopted) : opts.port;
  const onDiagnostic = opts.onDiagnostic ?? (() => {});

  let server: Server | null = adopted ?? null;
  const acceptHandlers = new Set<(conn: Connection) => void>();
  let started = false;
  let closed = false;

  function handleSocket(socket: Socket): void {
    if (closed) {
      socket.destroy();
      return;
    }
    // TCP_NODELAY off would buffer small writes — for cluster traffic
    // (small frames, latency-sensitive), keep it on.
    socket.setNoDelay(true);
    const conn = socketToConnection(socket, {
      ...omitUndefined({ maxFrameBytes: opts.maxFrameBytes }),
      onDiagnostic,
    });
    for (const handler of [...acceptHandlers]) {
      try {
        handler(conn);
      } catch (cause) {
        onDiagnostic("cluster:broker:net:accept-handler-threw", {
          remote: conn.remote,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }

  return {
    bound: `tcp://${host}:${port}`,

    async start() {
      if (started) return;
      started = true;
      if (adopted) {
        // Adopted-server mode: the caller (typically tryBindOrConnect)
        // already bound. Just wire the connection handler.
        adopted.on("connection", handleSocket);
        adopted.on("error", (cause) => {
          onDiagnostic("cluster:broker:net:listener-error", {
            host,
            port,
            reason: cause.message,
          });
        });
        onDiagnostic("cluster:broker:net:listener-adopted", { host, port });
        return;
      }
      server = createServer({ allowHalfOpen: false }, handleSocket);
      server.on("error", (cause) => {
        onDiagnostic("cluster:broker:net:listener-error", {
          host,
          port,
          reason: cause.message,
        });
      });
      await new Promise<void>((resolve, reject) => {
        const s = server!;
        const onError = (err: Error): void => {
          s.off("listening", onListening);
          reject(err);
        };
        const onListening = (): void => {
          s.off("error", onError);
          resolve();
        };
        s.once("error", onError);
        s.once("listening", onListening);
        s.listen(port, host);
      });
      onDiagnostic("cluster:broker:net:listener-bound", { host, port });
    },

    onConnection(handler) {
      acceptHandlers.add(handler);
      return () => {
        acceptHandlers.delete(handler);
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      acceptHandlers.clear();
      const s = server;
      server = null;
      if (!s) return;
      await new Promise<void>((resolve) => {
        s.close(() => resolve());
      });
      onDiagnostic("cluster:broker:net:listener-closed", { host, port });
    },
  };
}

function extractBindHost(server: Server): string {
  const addr = server.address();
  if (addr && typeof addr === "object" && "address" in addr) return addr.address;
  return "127.0.0.1";
}

function extractBindPort(server: Server): number {
  const addr = server.address();
  if (addr && typeof addr === "object" && "port" in addr) return addr.port;
  return 0;
}
