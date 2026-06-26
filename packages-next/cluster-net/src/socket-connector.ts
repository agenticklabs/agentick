/**
 * Shared connector core for `node:net.Socket`-based wires (TCP, Unix
 * socket). Both flavors do exactly the same thing — `createConnection`
 * the appropriate target shape, await `ready`, wrap via
 * `socketToConnection`, return a `Connector`. The ONLY difference is
 * the target spec (`{host, port}` vs `{path}`) and the diagnostic
 * labels.
 *
 * `createTcpConnector` and `createUnixConnector` are now thin wrappers
 * that pass the right target shape + labels to this core.
 *
 * Phase 4.7 — DRY consolidation. The wire-specific files (tcp-connector
 * .ts, unix-connector.ts) keep their adopter-facing option types
 * (`TcpConnectorOptions`, `UnixConnectorOptions`) for type-precision at
 * the public API.
 */

import { createConnection, type Socket } from "node:net";

import type { Connection, Connector } from "@agentick/cluster-broker-next";
import { omitUndefined } from "@agentick/utils-next";

import { socketToConnection } from "./socket-connection.js";

/**
 * Discriminated bind target — either an IP `host:port` (TCP) or a
 * filesystem `socketPath` (Unix). `node:net.createConnection` accepts
 * both shapes natively.
 */
export type SocketConnectTarget =
  | { readonly kind: "tcp"; readonly host: string; readonly port: number }
  | { readonly kind: "unix"; readonly socketPath: string };

export interface SocketConnectorCoreOptions {
  readonly target: SocketConnectTarget;
  readonly maxFrameBytes?: number;
  readonly connectTimeoutMs: number;
  readonly onDiagnostic: (name: string, payload?: unknown) => void;
}

/**
 * Wire-agnostic connector body. `kind` in the target discriminates
 * for diagnostic labeling; createConnection accepts either shape
 * directly.
 */
export function createSocketConnector(opts: SocketConnectorCoreOptions): Connector {
  const { target, connectTimeoutMs, onDiagnostic } = opts;
  const label =
    target.kind === "tcp" ? `tcp://${target.host}:${target.port}` : `unix://${target.socketPath}`;
  const diagPayload =
    target.kind === "tcp"
      ? { host: target.host, port: target.port }
      : { socketPath: target.socketPath };

  return {
    target: label,
    connect(): Promise<Connection> {
      return new Promise<Connection>((resolve, reject) => {
        let settled = false;
        const socket: Socket =
          target.kind === "tcp"
            ? createConnection({ host: target.host, port: target.port })
            : createConnection({ path: target.socketPath });
        // setNoDelay is a TCP concern; Unix sockets ignore it
        // gracefully, but setting it on Unix is wasted. Branch.
        if (target.kind === "tcp") socket.setNoDelay(true);

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          onDiagnostic("cluster:broker:net:connect-timeout", {
            ...diagPayload,
            timeoutMs: connectTimeoutMs,
          });
          socket.destroy();
          reject(new Error(`cluster-net: connect to ${label} timed out`));
        }, connectTimeoutMs);

        const onError = (cause: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          onDiagnostic("cluster:broker:net:connect-failed", {
            ...diagPayload,
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
            ...omitUndefined({ maxFrameBytes: opts.maxFrameBytes }),
            onDiagnostic,
          });
          onDiagnostic("cluster:broker:net:connected", { ...diagPayload, remote: conn.remote });
          resolve(conn);
        };

        socket.once("error", onError);
        socket.once("ready", onReady);
      });
    },
  };
}
