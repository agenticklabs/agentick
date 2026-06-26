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
 *      listener exists. The pre-bind hook probes via a quick
 *      connect-refuse check and `fs.unlink`s confirmed-dead sockets.
 *
 *   2. Permissions are filesystem permissions. The post-bind hook
 *      runs `fs.chmod` to lock the socket to specific access (e.g.,
 *      `0o600` for owner-only). chmod failure is LOUD — the
 *      listener tears down and the error propagates rather than
 *      leaving a world-readable socket.
 *
 * Phase 4.7 — thin wrapper around `createSocketListener`. Composes
 * Unix-specific pre-bind cleanup + post-bind chmod hooks; the shared
 * server-acceptance machinery lives in socket-listener.ts.
 */

import { chmod, stat, unlink } from "node:fs/promises";
import { createConnection, type Server } from "node:net";
import { platform } from "node:os";

import type { Listener } from "@agentick/cluster-broker-next";

import { omitUndefined } from "@agentick/utils-next";

import {
  createSocketListener,
  type SocketBindTarget,
  type SocketListenerCoreOptions,
} from "./socket-listener.js";

/**
 * Throws on Windows. Unix sockets exist on Win32 in principle but
 * via a different API (named pipes vs AF_UNIX) — Node's `net`
 * module's behavior on Windows for filesystem paths is undefined.
 * Adopters on Windows should use `tcpBroker` / `tcpClusterNode` /
 * `defineTcpCluster` from the same package.
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
      readonly maxFrameBytes?: number;
      readonly onDiagnostic?: (name: string, payload?: unknown) => void;
      readonly socketPath?: undefined;
      readonly mode?: undefined;
      readonly cleanupStaleSocket?: undefined;
    };

export function createUnixListener(opts: UnixListenerOptions): Listener {
  const onDiagnostic = opts.onDiagnostic ?? (() => {});
  // Eager Windows guard — surface BEFORE the listener is constructed
  // (consistent with the pre-Phase-4.7 behavior; adopters get a clear
  // error at construction rather than at start).
  assertNotWindows();

  if (opts.adoptServer) {
    return createSocketListener({
      adoptServer: opts.adoptServer,
      ...omitUndefined({ maxFrameBytes: opts.maxFrameBytes }),
      onDiagnostic,
    });
  }

  const bind: SocketBindTarget = { kind: "unix", socketPath: opts.socketPath };
  const cleanupStale = opts.cleanupStaleSocket !== false;
  const mode = opts.mode;

  const coreOpts: SocketListenerCoreOptions = {
    bind,
    ...omitUndefined({ maxFrameBytes: opts.maxFrameBytes }),
    onDiagnostic,
    preBindHook: async (b) => {
      if (b.kind !== "unix") return;
      if (cleanupStale) await tryCleanupStaleSocket(b.socketPath, onDiagnostic);
    },
    ...(mode !== undefined
      ? {
          postBindHook: async (b, _server) => {
            if (b.kind !== "unix") return;
            // chmod failure is LOUD — see the Phase 4d.1 security
            // hardening rationale. Silent fallback would leave the
            // socket world-readable on chmod failure (security
            // regression). Re-throw with a wrapped error; the core's
            // postBindHook handling tears down the listener for us.
            try {
              await chmod(b.socketPath, mode);
            } catch (cause) {
              onDiagnostic("cluster:broker:net:chmod-failed", {
                socketPath: b.socketPath,
                mode,
                reason: cause instanceof Error ? cause.message : String(cause),
              });
              throw new Error(
                `cluster-net: chmod ${mode.toString(8)} on ${b.socketPath} failed: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
                { cause },
              );
            }
          },
        }
      : {}),
    cleanupHook: async (b) => {
      // Triggered on postBindHook failure — unlink the socket so the
      // failed-and-half-bound file doesn't haunt subsequent bind
      // attempts. Best-effort.
      if (b.kind !== "unix") return;
      try {
        await unlink(b.socketPath);
      } catch {
        // ignore
      }
    },
  };

  return createSocketListener(coreOpts);
}

/**
 * Probe + unlink a stale Unix socket file. The probe: try to connect;
 * if connect refuses (no listener), the file is dead. If connect
 * succeeds OR times out, the file is alive (or undetermined) — leave
 * it alone and let bind fail with EADDRINUSE so the caller can decide.
 */
async function tryCleanupStaleSocket(
  socketPath: string,
  onDiagnostic: (name: string, payload?: unknown) => void,
): Promise<void> {
  try {
    await stat(socketPath);
  } catch {
    return; // doesn't exist; nothing to clean up
  }
  const alive = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ path: socketPath });
    let done = false;
    const finish = (v: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(v);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    setTimeout(() => finish(false), 50);
  });
  if (alive) return;
  try {
    await unlink(socketPath);
    onDiagnostic("cluster:broker:net:stale-socket-unlinked", { socketPath });
  } catch {
    // ignore — adjacent bind will fail with a real error if needed
  }
}
