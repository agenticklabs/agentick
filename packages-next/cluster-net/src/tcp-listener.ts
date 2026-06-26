/**
 * `createTcpListener(opts)` — Node `net.Server` wrapped in the
 * `Listener` interface from `@agentick/cluster-broker-next`.
 *
 * Phase 4.7 — thin wrapper around `createSocketListener`. TCP doesn't
 * need pre/post-bind hooks (no stale-file cleanup, no chmod); this
 * file owns the adopter-facing option shape + default host.
 */

import type { Server } from "node:net";

import type { Listener } from "@agentick/cluster-broker-next";

import { createSocketListener, type SocketBindTarget } from "./socket-listener.js";
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
  const onDiagnostic = opts.onDiagnostic ?? (() => {});
  if (opts.adoptServer) {
    return createSocketListener({
      adoptServer: opts.adoptServer,
      ...omitUndefined({ maxFrameBytes: opts.maxFrameBytes }),
      onDiagnostic,
    });
  }
  const bind: SocketBindTarget = {
    kind: "tcp",
    host: opts.host ?? "127.0.0.1",
    port: opts.port,
  };
  return createSocketListener({
    bind,
    ...omitUndefined({ maxFrameBytes: opts.maxFrameBytes }),
    onDiagnostic,
  });
}
