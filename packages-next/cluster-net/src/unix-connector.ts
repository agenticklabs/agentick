/**
 * `createUnixConnector(opts)` — opens a `net.Socket` to a Unix
 * socket path, returns a {@link Connection}-wrapped result.
 *
 * Mirror of `createTcpConnector` — same `socketToConnection`
 * wrapping, same timeout handling. Different addressing (path
 * instead of host:port) is the only meaningful difference.
 */

import { createConnection, type Socket } from "node:net";
import { platform } from "node:os";

import type { Connection, Connector } from "@agentick/cluster-broker-next";

import { socketToConnection } from "./socket-connection.js";

export interface UnixConnectorOptions {
  /** Filesystem path to the Unix socket. Required. */
  readonly socketPath: string;
  /** Optional max frame bytes for this connection's decoder. */
  readonly maxFrameBytes?: number;
  /**
   * Connection-establishment timeout. Unix sockets connect or
   * refuse fast (no SYN retry), so this defaults shorter than TCP's
   * 5s — adopters can override.
   */
  readonly connectTimeoutMs?: number;
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
}

export function createUnixConnector(opts: UnixConnectorOptions): Connector {
  const socketPath = opts.socketPath;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 2_000;
  const onDiagnostic = opts.onDiagnostic ?? (() => {});

  return {
    target: `unix://${socketPath}`,
    connect(): Promise<Connection> {
      if (platform() === "win32") {
        return Promise.reject(
          new Error(
            "cluster-net: Unix-socket connector is not supported on Windows. " +
              "Use createTcpConnector instead.",
          ),
        );
      }
      return new Promise<Connection>((resolve, reject) => {
        let settled = false;
        const socket: Socket = createConnection({ path: socketPath });

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          onDiagnostic("cluster:broker:net:connect-timeout", {
            socketPath,
            timeoutMs: connectTimeoutMs,
          });
          socket.destroy();
          reject(new Error(`cluster-net: Unix connect to ${socketPath} timed out`));
        }, connectTimeoutMs);

        const onError = (cause: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          onDiagnostic("cluster:broker:net:connect-failed", {
            socketPath,
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
          onDiagnostic("cluster:broker:net:connected", { socketPath, remote: conn.remote });
          resolve(conn);
        };

        socket.once("error", onError);
        socket.once("ready", onReady);
      });
    },
  };
}
