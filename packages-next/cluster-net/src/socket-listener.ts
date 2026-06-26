/**
 * Shared listener core for `node:net.Server`-based wires (TCP, Unix
 * socket). Both flavors do the same fundamentals — `createServer`,
 * accept incoming sockets, wrap via `socketToConnection`, fan out to
 * registered handlers. They differ in:
 *
 *   - Bind target shape: `{host, port}` vs `{socketPath}`
 *   - Pre-bind hook: TCP has none; Unix probes for stale socket files
 *     and unlinks them before binding
 *   - Post-bind hook: TCP has none; Unix runs `fs.chmod` to lock down
 *     filesystem permissions (LOUD — chmod failure tears down the
 *     listener)
 *   - setNoDelay is meaningful for TCP only (Unix ignores)
 *
 * `createSocketListener` accepts those divergences as injection
 * points: a discriminated `bind` target + optional pre/post-bind hooks.
 * The wire-specific listener files (`tcp-listener.ts`, `unix-listener
 * .ts`) become thin wrappers that compose the hooks for their wire.
 *
 * Phase 4.7 — DRY consolidation. TCP listener was 155 LOC; Unix
 * listener was 301 LOC. Shared core lifts ~100 LOC of duplicate
 * server-acceptance machinery into one place.
 */

import { createServer, type Server, type Socket } from "node:net";

import type { Connection, Listener } from "@agentick/cluster-broker-next";
import { omitUndefined } from "@agentick/utils-next";

import { socketToConnection } from "./socket-connection.js";

/**
 * Discriminated bind target — what the listener will (or has)
 * `listen()`-ed on.
 */
export type SocketBindTarget =
  | { readonly kind: "tcp"; readonly host: string; readonly port: number }
  | { readonly kind: "unix"; readonly socketPath: string };

export interface SocketListenerCoreOptions {
  /**
   * Bind target. Required UNLESS `adoptServer` is provided (in which
   * case the adopted server's address determines the binding).
   */
  readonly bind?: SocketBindTarget;
  /**
   * Adopt a pre-bound `net.Server` (typically from `tryBindOrConnect`
   * /`tryBindOrConnectUnix`). Skips the `listen()` step + pre/post
   * bind hooks.
   */
  readonly adoptServer?: Server;
  /** Optional max frame bytes for each accepted connection's decoder. */
  readonly maxFrameBytes?: number;
  readonly onDiagnostic: (name: string, payload?: unknown) => void;
  /**
   * Run before `server.listen()`. Unix uses this for stale-socket
   * cleanup. Throw to abort the start; the listener won't be created.
   */
  readonly preBindHook?: (bind: SocketBindTarget) => Promise<void>;
  /**
   * Run after successful `listen()`. Unix uses this for `fs.chmod`.
   * If the hook throws, the listener is torn down (server closed)
   * before the error is re-thrown to the caller — adopters never see
   * a half-configured listener.
   */
  readonly postBindHook?: (bind: SocketBindTarget, server: Server) => Promise<void>;
  /**
   * Called if the listener fails to start AND was responsible for
   * binding (not in adoptServer mode). Unix uses this to unlink the
   * socket file. Best-effort; failures here are swallowed.
   */
  readonly cleanupHook?: (bind: SocketBindTarget) => Promise<void>;
}

/**
 * Format a `SocketBindTarget` for the `bound` URL string.
 */
export function formatBoundUrl(target: SocketBindTarget): string {
  return target.kind === "tcp"
    ? `tcp://${target.host}:${target.port}`
    : `unix://${target.socketPath}`;
}

/**
 * Wire-agnostic listener body. Wire-specific wrappers
 * (`createTcpListener`, `createUnixListener`) compose this with the
 * right `bind` target + hooks.
 */
export function createSocketListener(opts: SocketListenerCoreOptions): Listener {
  const adopted = opts.adoptServer;
  const onDiagnostic = opts.onDiagnostic;
  const bind = opts.bind;

  let server: Server | null = adopted ?? null;
  const acceptHandlers = new Set<(conn: Connection) => void>();
  let started = false;
  let closed = false;

  function handleSocket(socket: Socket): void {
    if (closed) {
      socket.destroy();
      return;
    }
    // setNoDelay is a TCP concern; harmless on Unix but skipping it
    // saves a syscall.
    if (bind?.kind === "tcp" || (adopted && socket.localPort !== undefined)) {
      socket.setNoDelay(true);
    }
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

  const diagPayload = (): Record<string, unknown> => {
    if (bind?.kind === "tcp") return { host: bind.host, port: bind.port };
    if (bind?.kind === "unix") return { socketPath: bind.socketPath };
    return {};
  };

  return {
    bound: adopted
      ? formatBoundFromAddress(adopted)
      : bind !== undefined
        ? formatBoundUrl(bind)
        : undefined,

    async start() {
      if (started) return;
      started = true;
      if (adopted) {
        adopted.on("connection", handleSocket);
        adopted.on("error", (cause) => {
          onDiagnostic("cluster:broker:net:listener-error", {
            ...diagPayload(),
            reason: cause.message,
          });
        });
        onDiagnostic("cluster:broker:net:listener-adopted", diagPayload());
        return;
      }
      if (bind === undefined) {
        throw new Error("cluster-net: SocketListener requires either bind or adoptServer");
      }
      if (opts.preBindHook) await opts.preBindHook(bind);
      server = createServer({ allowHalfOpen: false }, handleSocket);
      server.on("error", (cause) => {
        onDiagnostic("cluster:broker:net:listener-error", {
          ...diagPayload(),
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
        if (bind.kind === "tcp") s.listen(bind.port, bind.host);
        else s.listen(bind.socketPath);
      });
      if (opts.postBindHook) {
        try {
          await opts.postBindHook(bind, server);
        } catch (cause) {
          // Tear down so we don't leak a partially-configured listener.
          try {
            await new Promise<void>((resolve) => server!.close(() => resolve()));
            if (opts.cleanupHook) await opts.cleanupHook(bind);
          } catch {
            // Silent — the post-bind error is what matters.
          }
          throw cause;
        }
      }
      onDiagnostic("cluster:broker:net:listener-bound", diagPayload());
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
      onDiagnostic("cluster:broker:net:listener-closed", diagPayload());
    },
  };
}

function formatBoundFromAddress(server: Server): string | undefined {
  const addr = server.address();
  if (!addr) return undefined;
  if (typeof addr === "string") return `unix://${addr}`;
  return `tcp://${addr.address}:${addr.port}`;
}
