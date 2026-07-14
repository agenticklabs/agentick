/**
 * `unixSocketServerTransport(config)` — the {@link ServerTransport} wrapper
 * over {@link unixSocketServer} (ADR 84 §2).
 *
 * Inverts the raw factory's shape: wire config (the socket `path`) binds at
 * construction; the dispatch host arrives at `listen(host)`, injected by the
 * gateway when it fans out. The gateway owns this the way it owns apps.
 *
 * The Unix socket is the simplest of the network transports — the underlying
 * `net.Server` binds itself (`server.listen(path)` inside `unixSocketServer`),
 * so the wrapper only defers the host and awaits the `listening` event so that
 * a resolved `listen()` means a client can connect.
 *
 * @see docs/proposals/v2/blueprint/84-gateway-lifecycle-and-transports.md §2
 */

import type { GatewayHarnessProtocol, ServerTransport } from "@agentick/spec-next";
import {
  unixSocketServer,
  type UnixSocketServerHandle,
  type UnixSocketServerOptions,
} from "./server.js";

/** Wire config for {@link unixSocketServerTransport} — everything the raw
 * factory takes except the `gateway`, which the gateway injects at `listen`. */
export type UnixSocketServerTransportConfig = Omit<UnixSocketServerOptions, "gateway">;

export function unixSocketServerTransport(
  config: UnixSocketServerTransportConfig,
): ServerTransport {
  let handle: UnixSocketServerHandle | undefined;

  // Stable transport id — also threaded into each connection's `gateway:accept`
  // op (ADR 84 §4) so `onBeforeGatewayAccept` sees which transport admitted it.
  const id = `unix-socket:${config.path}`;

  return {
    id,

    async listen(host: GatewayHarnessProtocol): Promise<void> {
      if (handle) return; // idempotent — already bound
      const bound = unixSocketServer({ ...config, gateway: host, transportId: id });
      handle = bound;
      // `unixSocketServer` calls `server.listen(path)` for us; wait for the
      // socket to actually be accepting so a resolved `listen()` is honest.
      await new Promise<void>((resolve, reject) => {
        if (bound.server.listening) {
          resolve();
          return;
        }
        const onError = (err: Error): void => {
          bound.server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = (): void => {
          bound.server.removeListener("error", onError);
          resolve();
        };
        bound.server.once("listening", onListening);
        bound.server.once("error", onError);
      });
    },

    async close(): Promise<void> {
      await handle?.close();
      handle = undefined;
    },
  };
}
