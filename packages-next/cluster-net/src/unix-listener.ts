/**
 * `createUnixListener(opts)` — Node `net.Server` listening on a Unix
 * socket path, wrapped as the `Listener` interface from
 * `@agentick/cluster-broker-next`.
 *
 * Unix sockets vs TCP differ in two operational ways:
 *
 *   1. The socket is a filesystem entry. A previous process that
 *      crashed without cleanup leaves a stale file; subsequent
 *      `listen()` calls fail with `EADDRINUSE` even though no real
 *      listener exists. The auto-cleanup machinery here probes via
 *      a quick connect-refuse check and `fs.unlink`s confirmed-dead
 *      sockets before binding.
 *
 *   2. Permissions are filesystem permissions. The `mode` option
 *      runs `fs.chmod` after bind so adopters can lock the socket
 *      to specific user/group access (defaults to umask-controlled).
 */

import { chmod, stat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { platform } from "node:os";

import type { Connection, Listener } from "@agentick/cluster-broker-next";

import { socketToConnection } from "./socket-connection.js";

// TODO(phase-4e-followup): consolidate TCP + Unix listener/connector/
// cluster modules. unix-listener.ts and tcp-listener.ts are ~80%
// identical (same socketToConnection wiring, same diagnostic
// emission, same lifecycle). Same for *-connector and *-cluster.
// The right time to extract a shared base is AFTER Phase 4e
// (cluster-ws-next) lands so we can see what genuinely
// generalizes across all three wire impls — WS shares ~20% with
// net (Connection wrapper) but the listener/connector/cluster
// shapes diverge. Don't refactor pre-4e or we'll over-fit to
// TCP/Unix similarity.

/**
 * Throws on Windows. Unix sockets exist on Win32 in principle but
 * via a different API (named pipes vs AF_UNIX) — Node's `net`
 * module's behavior on Windows for filesystem paths is undefined.
 * Adopters on Windows should use `tcpBroker` / `tcpClusterNode`
 * from the same package.
 */
function assertNotWindows(): void {
  if (platform() === "win32") {
    throw new Error(
      "cluster-net: Unix-socket factories are not supported on Windows. " +
        "Use tcpBroker / tcpClusterNode / defineTcpCluster instead.",
    );
  }
}

export type UnixListenerOptions =
  | {
      /** Filesystem path to bind. Required. */
      readonly socketPath: string;
      /**
       * Optional filesystem permission mode applied after bind via
       * `fs.chmod`. Use to lock the socket to specific access
       * (e.g., `0o600` for owner-only).
       */
      readonly mode?: number;
      /**
       * Auto-unlink a stale socket file before binding. Defaults to
       * `true` — Unix sockets crash-left-over are the common case.
       * Set `false` when running with a supervisor that promises to
       * clean up.
       */
      readonly cleanupStaleSocket?: boolean;
      readonly maxFrameBytes?: number;
      readonly onDiagnostic?: (name: string, payload?: unknown) => void;
      readonly adoptServer?: undefined;
    }
  | {
      /**
       * Adopt a pre-bound `net.Server` (typically from a Unix-flavored
       * auto-elect). Skips the bind step entirely.
       */
      readonly adoptServer: Server;
      readonly socketPath?: string;
      readonly maxFrameBytes?: number;
      readonly onDiagnostic?: (name: string, payload?: unknown) => void;
      readonly mode?: undefined;
      readonly cleanupStaleSocket?: undefined;
    };

export function createUnixListener(opts: UnixListenerOptions): Listener {
  const adopted = opts.adoptServer;
  const socketPath = adopted ? extractBoundPath(adopted) : opts.socketPath;
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
    const conn = socketToConnection(socket, {
      ...(opts.maxFrameBytes !== undefined ? { maxFrameBytes: opts.maxFrameBytes } : {}),
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
    bound: socketPath !== undefined ? `unix://${socketPath}` : undefined,

    async start() {
      if (started) return;
      started = true;
      assertNotWindows();
      if (adopted) {
        adopted.on("connection", handleSocket);
        adopted.on("error", (cause) => {
          onDiagnostic("cluster:broker:net:listener-error", {
            socketPath,
            reason: cause.message,
          });
        });
        onDiagnostic("cluster:broker:net:listener-adopted", { socketPath });
        return;
      }
      if (socketPath === undefined) {
        throw new Error("cluster-net unix: socketPath required when adoptServer is not supplied");
      }
      // Stale-socket cleanup — probe + unlink if dead.
      if (opts.cleanupStaleSocket !== false) {
        await tryCleanupStaleSocket(socketPath, onDiagnostic);
      }
      server = createServer({ allowHalfOpen: false }, handleSocket);
      server.on("error", (cause) => {
        onDiagnostic("cluster:broker:net:listener-error", {
          socketPath,
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
        s.listen(socketPath);
      });
      if (opts.mode !== undefined) {
        // chmod failure is loud — adopters passing `mode: 0o600`
        // for owner-only security need to know if the lock-down
        // didn't apply. Silent fallback would leave the socket
        // world-readable on chmod failure, which is a security
        // regression the adopter has no signal for. Tear down the
        // listener so the caller sees a real error.
        try {
          await chmod(socketPath, opts.mode);
        } catch (cause) {
          onDiagnostic("cluster:broker:net:chmod-failed", {
            socketPath,
            mode: opts.mode,
            reason: cause instanceof Error ? cause.message : String(cause),
          });
          // Best-effort teardown so we don't leak a misconfigured
          // socket past this error.
          try {
            await new Promise<void>((resolve) => server!.close(() => resolve()));
            await unlink(socketPath);
          } catch {
            // ignore teardown errors; the chmod throw is the real
            // signal the caller cares about.
          }
          throw new Error(
            `cluster-net: chmod ${opts.mode.toString(8)} on ${socketPath} failed: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            { cause },
          );
        }
      }
      onDiagnostic("cluster:broker:net:listener-bound", { socketPath });
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
      // Try to clean up our own socket file on graceful close.
      // Failures are silent — common cases are "already gone" (the
      // close() above unbound it on some kernels) or "permissions
      // changed mid-flight" which the adopter can recover from.
      if (socketPath !== undefined && !adopted) {
        try {
          await unlink(socketPath);
        } catch {
          // ignore
        }
      }
      onDiagnostic("cluster:broker:net:listener-closed", { socketPath });
    },
  };
}

/**
 * Detect a stale Unix socket file and remove it. "Stale" =
 * filesystem entry exists but no process is listening (a probe
 * connect refuses with ECONNREFUSED). Emits diagnostic events for
 * each outcome so operators can audit cleanup.
 *
 * **Race window**: between the probe (connect-refused → "no
 * listener"), the unlink, and the subsequent bind, another process
 * could create + listen on the same path. In practice this is
 * harmless: the bind in the caller fails with EADDRINUSE,
 * `tryBindOrConnectUnix` falls through to client mode (in auto
 * mode), and the cluster heals naturally. Documented here so the
 * non-atomicity isn't surprising on incident review.
 */
async function tryCleanupStaleSocket(
  socketPath: string,
  onDiagnostic: (name: string, payload?: unknown) => void,
): Promise<void> {
  let exists = false;
  try {
    await stat(socketPath);
    exists = true;
  } catch {
    return; // file doesn't exist; bind will create fresh.
  }
  if (!exists) return;
  // Probe: try to connect. If it refuses fast, nobody's listening
  // → unlink. If it succeeds, the socket is live → bail (the bind
  // attempt will fail with EADDRINUSE which the caller should treat
  // as auto-elect-loser).
  const alive = await probeUnixSocket(socketPath);
  if (alive) {
    onDiagnostic("cluster:broker:net:stale-socket-skipped", { socketPath, reason: "alive" });
    return;
  }
  try {
    await unlink(socketPath);
    onDiagnostic("cluster:broker:net:stale-socket-removed", { socketPath });
  } catch (cause) {
    onDiagnostic("cluster:broker:net:stale-socket-removal-failed", {
      socketPath,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/** Quick connect-refused check. Resolves true if a peer accepts our connect. */
function probeUnixSocket(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    const finish = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    // Bounded probe — Unix sockets are local, anything past 50ms
    // is broken-state.
    setTimeout(() => finish(false), 50);
  });
}

function extractBoundPath(server: Server): string | undefined {
  const addr = server.address();
  if (typeof addr === "string") return addr;
  return undefined;
}
