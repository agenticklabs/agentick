/**
 * `createTcpConnector(opts)` — opens a `net.Socket` to the target
 * host:port, returns a {@link Connection}-wrapped result.
 *
 * Phase 4.7 — thin wrapper around `createSocketConnector`. The shared
 * connector body lives there; this file owns the TCP-specific
 * adopter-facing option shape + default values.
 */

import type { Connector } from "@agentick/cluster-broker";

import { createSocketConnector } from "./socket-connector.js";
import { omitUndefined } from "@agentick/utils";

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
  return createSocketConnector({
    target: { kind: "tcp", host: opts.host ?? "127.0.0.1", port: opts.port },
    ...omitUndefined({ maxFrameBytes: opts.maxFrameBytes }),
    connectTimeoutMs: opts.connectTimeoutMs ?? 5_000,
    onDiagnostic: opts.onDiagnostic ?? (() => {}),
  });
}
