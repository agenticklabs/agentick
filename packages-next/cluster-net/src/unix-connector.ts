/**
 * `createUnixConnector(opts)` — opens a `net.Socket` to a Unix socket
 * path, returns a {@link Connection}-wrapped result.
 *
 * Phase 4.7 — thin wrapper around `createSocketConnector`. The shared
 * connector body lives there; this file owns the Unix-specific
 * adopter-facing option shape, default values, and Windows guard.
 */

import { platform } from "node:os";

import type { Connection, Connector } from "@agentick/cluster-broker-next";

import { createSocketConnector } from "./socket-connector.js";
import { omitUndefined } from "@agentick/utils-next";

export interface UnixConnectorOptions {
  /** Filesystem path to the Unix socket. Required. */
  readonly socketPath: string;
  /** Optional max frame bytes for this connection's decoder. */
  readonly maxFrameBytes?: number;
  /**
   * Connection-establishment timeout. Unix sockets connect or refuse
   * fast (no SYN retry), so this defaults shorter than TCP's 5s —
   * adopters can override.
   */
  readonly connectTimeoutMs?: number;
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
}

export function createUnixConnector(opts: UnixConnectorOptions): Connector {
  const onDiagnostic = opts.onDiagnostic ?? (() => {});
  // Windows guard — Unix sockets aren't supported via Node's `net`
  // module on Win32 (different ipc API). Surface a clear error
  // EAGERLY at connector construction; don't wait for connect().
  if (platform() === "win32") {
    return {
      target: `unix://${opts.socketPath}`,
      connect(): Promise<Connection> {
        return Promise.reject(
          new Error(
            "cluster-net: Unix-socket connector is not supported on Windows. " +
              "Use createTcpConnector instead.",
          ),
        );
      },
    };
  }
  return createSocketConnector({
    target: { kind: "unix", socketPath: opts.socketPath },
    ...omitUndefined({ maxFrameBytes: opts.maxFrameBytes }),
    connectTimeoutMs: opts.connectTimeoutMs ?? 2_000,
    onDiagnostic,
  });
}
