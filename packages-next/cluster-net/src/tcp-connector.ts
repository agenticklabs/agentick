/**
 * `createTcpConnector(opts)` — opens a `net.Socket` to the target
 * host:port, returns a {@link Connection}-wrapped result.
 *
 * Used by the client side of the TCP wire. The base client's
 * reconnect loop calls `connector.connect()` on each attempt; each
 * call produces a FRESH `Connection` (per the Connector contract).
 */

import { createConnection, type Socket } from "node:net";

import type { Connection, Connector } from "@agentick/cluster-broker-next";

import { socketToConnection } from "./socket-connection.js";

export interface TcpConnectorOptions {
  /** Target host. Default: `"127.0.0.1"`. */
  readonly host?: string;
  /** Target port. Required. */
  readonly port: number;
  /** Optional max frame bytes for this connection's decoder. */
  readonly maxFrameBytes?: number;
  /**
   * Optional connection-establishment timeout (ms). If the socket
   * doesn't reach `ready` within this window, the attempt rejects
   * + the socket is destroyed. Default: 5_000 ms.
   */
  readonly connectTimeoutMs?: number;
  /** Optional diagnostic emitter for connector + per-conn framing diagnostics. */
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
}

export function createTcpConnector(opts: TcpConnectorOptions): Connector {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 5_000;
  const onDiagnostic = opts.onDiagnostic ?? (() => {});

  return {
    target: `tcp://${host}:${port}`,
    connect(): Promise<Connection> {
      return new Promise<Connection>((resolve, reject) => {
        let settled = false;
        const socket: Socket = createConnection({ host, port });
        socket.setNoDelay(true);

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          onDiagnostic("cluster:broker:net:connect-timeout", {
            host,
            port,
            timeoutMs: connectTimeoutMs,
          });
          socket.destroy();
          reject(new Error(`cluster-net: TCP connect to ${host}:${port} timed out`));
        }, connectTimeoutMs);

        const onError = (cause: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          onDiagnostic("cluster:broker:net:connect-failed", {
            host,
            port,
            reason: cause.message,
          });
          reject(cause);
        };

        const onReady = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.off("error", onError);
          const conn = socketToConnection(socket, {
            ...(opts.maxFrameBytes !== undefined ? { maxFrameBytes: opts.maxFrameBytes } : {}),
            onDiagnostic,
          });
          onDiagnostic("cluster:broker:net:connected", { host, port, remote: conn.remote });
          resolve(conn);
        };

        socket.once("error", onError);
        socket.once("ready", onReady);
      });
    },
  };
}
