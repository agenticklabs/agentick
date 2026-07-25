/**
 * `tryBindOrConnect` — first-to-bind broker election helper.
 *
 * Multiple processes start up racing for the same `host:port`.
 * The OS only lets ONE bind succeed; everyone else gets
 * `EADDRINUSE`. The winner becomes the broker; losers fall back
 * to connecting as clients.
 *
 * Phase 4 default broker recovery is external supervisor restart
 * (PM2 / systemd / k8s) — if the broker dies, the supervisor
 * brings a new process up, which retries the bind. The cluster
 * heals naturally. Internal re-election (Phase 4+ optional) would
 * have clients race to bind after detecting broker loss; tracked
 * but not wired here.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §8.a
 */

import { stat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { platform } from "node:os";

export type AutoElectMode = "broker" | "client" | "broker-explicit" | "client-explicit";

export interface AutoElectOptions {
  readonly host?: string;
  readonly port: number;
  /**
   * Explicit override. `"auto"` (default) races to bind; `"broker"`
   * forces this process to be the broker (fails loudly on
   * EADDRINUSE); `"client"` forces it to connect as a client
   * (assumes the broker already exists elsewhere).
   */
  readonly mode?: "auto" | "broker" | "client";
}

export interface AutoElectResult {
  /** Resolved role. */
  readonly role: AutoElectMode;
  /**
   * For role === "broker"/"broker-explicit": the bound `net.Server`
   * the caller should hand to a TcpListener. The listener will
   * adopt this server rather than re-binding.
   *
   * For role === "client"/"client-explicit": undefined.
   */
  readonly server?: Server;
}

/**
 * Race to bind `host:port`. Returns the discriminated role + the
 * `Server` if this process is the broker (so the listener can
 * adopt it without re-binding).
 *
 * Errors:
 *   - `mode: "broker"` (explicit) + EADDRINUSE → throws.
 *   - `mode: "client"` (explicit) — never tries to bind; returns
 *     immediately with role: "client-explicit".
 *   - `mode: "auto"` + EADDRINUSE → returns role: "client".
 *   - Any other bind error → throws.
 */
export function tryBindOrConnect(opts: AutoElectOptions): Promise<AutoElectResult> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port;
  const mode = opts.mode ?? "auto";

  if (mode === "client") {
    return Promise.resolve({ role: "client-explicit" });
  }

  return new Promise<AutoElectResult>((resolve, reject) => {
    const server = createServer({ allowHalfOpen: false });
    let settled = false;

    const onError = (err: NodeJS.ErrnoException): void => {
      if (settled) return;
      settled = true;
      server.off("listening", onListening);
      // EADDRINUSE — someone else won the race.
      if (err.code === "EADDRINUSE") {
        if (mode === "broker") {
          reject(new Error(`cluster-net: explicit broker mode but port ${host}:${port} is in use`));
          return;
        }
        // Auto mode — fall back to client.
        resolve({ role: "client" });
        return;
      }
      // Any other error → propagate.
      reject(err);
    };

    const onListening = (): void => {
      if (settled) return;
      settled = true;
      server.off("error", onError);
      resolve({
        role: mode === "broker" ? "broker-explicit" : "broker",
        server,
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

// ============================================================================
// Unix-socket variant
// ============================================================================

export interface AutoElectUnixOptions {
  readonly socketPath: string;
  readonly mode?: "auto" | "broker" | "client";
  /**
   * Auto-unlink stale socket files before bind. Default `true`. A
   * stale socket = filesystem entry exists but no listener (a
   * crashed predecessor); detected via connect-refuse probe.
   */
  readonly cleanupStaleSocket?: boolean;
}

/**
 * Race to bind a Unix socket path. Same shape as
 * {@link tryBindOrConnect} but for filesystem-addressed sockets.
 *
 * Stale-cleanup is the only meaningful operational difference vs.
 * TCP: filesystem entries from crashed predecessors persist, and
 * naive bind fails with EADDRINUSE even though no listener exists.
 * The default `cleanupStaleSocket: true` probes via connect-refuse
 * before binding.
 */
export function tryBindOrConnectUnix(opts: AutoElectUnixOptions): Promise<AutoElectResult> {
  if (platform() === "win32") {
    return Promise.reject(
      new Error(
        "cluster-net: tryBindOrConnectUnix is not supported on Windows. " +
          "Use tryBindOrConnect (TCP) instead.",
      ),
    );
  }
  const socketPath = opts.socketPath;
  const mode = opts.mode ?? "auto";
  const cleanupStale = opts.cleanupStaleSocket !== false;

  if (mode === "client") {
    return Promise.resolve({ role: "client-explicit" });
  }

  return (async (): Promise<AutoElectResult> => {
    if (cleanupStale) {
      await unlinkIfStale(socketPath);
    }
    return new Promise<AutoElectResult>((resolve, reject) => {
      const server = createServer({ allowHalfOpen: false });
      let settled = false;

      const onError = (err: NodeJS.ErrnoException): void => {
        if (settled) return;
        settled = true;
        server.off("listening", onListening);
        if (err.code === "EADDRINUSE") {
          if (mode === "broker") {
            reject(
              new Error(`cluster-net: explicit broker mode but socket ${socketPath} is in use`),
            );
            return;
          }
          resolve({ role: "client" });
          return;
        }
        reject(err);
      };

      const onListening = (): void => {
        if (settled) return;
        settled = true;
        server.off("error", onError);
        resolve({
          role: mode === "broker" ? "broker-explicit" : "broker",
          server,
        });
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
    });
  })();
}

/** Probe + unlink a stale Unix socket file. */
async function unlinkIfStale(socketPath: string): Promise<void> {
  try {
    await stat(socketPath);
  } catch {
    return; // doesn't exist
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
  } catch {
    // ignore — adjacent bind will fail with a real error if needed
  }
}
