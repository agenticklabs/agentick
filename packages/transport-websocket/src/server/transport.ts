/**
 * `webSocketServerTransport(config)` — the {@link ServerTransport} wrapper
 * over {@link websocketServer} (ADR 84 §2).
 *
 * `websocketServer` ATTACHES WebSocket upgrade handling to an existing Node
 * `http.Server`; it never binds a port. So the common `{ port }` path makes the
 * transport own the whole listener: in `listen(host)` it creates a Node
 * `http.Server`, attaches `websocketServer` to it, then `server.listen(port)`;
 * `close()` tears down BOTH the WS handle and the Node server it created.
 *
 * An adopter with an existing Node server (shared with an HTTP transport, an
 * `https.Server`, Express's underlying server) passes `{ httpServer }` instead
 * of `{ port }`. The wrapper attaches to it and, since it did not create it,
 * does NOT close it. It also passes `ownsServer: false` so the upgrade handler
 * leaves non-matching upgrades (socket.io, another transport) untouched — a
 * shared server may carry many `upgrade` listeners, and destroying a
 * non-matching socket would kill the other consumers. The `{ port }` branch
 * passes `ownsServer: true`: it owns the listener, so a non-matching upgrade
 * can be safely destroyed.
 *
 * @see docs/proposals/v2/blueprint/84-gateway-lifecycle-and-transports.md §2
 */

import { createServer, type Server as NodeHttpServer } from "node:http";
import type { GatewayHarnessProtocol, ServerTransport } from "@agentick/spec";
import { DEFAULT_BIND_HOST } from "@agentick/transport";
import {
  websocketServer,
  type WebSocketServerHandle,
  type WebSocketServerOptions,
} from "./server.js";

/** Port-owning config — the wrapper creates and binds the Node server. */
export interface WebSocketServerTransportPortConfig extends Omit<
  WebSocketServerOptions,
  "gateway" | "httpServer" | "ownsServer"
> {
  readonly port: number;
  /**
   * Bind address for the created server. Default: `127.0.0.1` (loopback only)
   * — the security boundary (STATUS A2 §4c). Widen to a public interface
   * (`0.0.0.0` / a specific NIC) deliberately, behind a reviewed auth story.
   */
  readonly host?: string;
}

/**
 * Config for {@link webSocketServerTransport}. Either the common `{ port }`
 * shape (wrapper owns the Node server) or `{ httpServer }` (adopter owns it).
 */
export type WebSocketServerTransportConfig =
  | WebSocketServerTransportPortConfig
  | Omit<WebSocketServerOptions, "gateway" | "ownsServer">;

export function webSocketServerTransport(config: WebSocketServerTransportConfig): ServerTransport {
  let wsHandle: WebSocketServerHandle | undefined;
  // The Node server WE created, if any — closed in close(). An
  // adopter-supplied server is never touched.
  let ownedServer: NodeHttpServer | undefined;

  // Stable transport id — also threaded into each connection's `gateway:accept`
  // op (ADR 84 §4) so `onBeforeGatewayAccept` sees which transport admitted it.
  const id = "httpServer" in config ? "websocket:attached" : `websocket:${config.port}`;

  return {
    id,

    async listen(host: GatewayHarnessProtocol): Promise<void> {
      if (wsHandle) return; // idempotent — already bound

      if ("httpServer" in config) {
        // Adopter owns the Node server; just attach the WS upgrade handler.
        // `ownsServer: false` — leave non-matching upgrades for other
        // listeners on the shared server (see server.ts module doc).
        wsHandle = websocketServer({
          ...config,
          gateway: host,
          transportId: id,
          ownsServer: false,
        });
        return;
      }

      const { port, host: bindHost, ...rest } = config;
      const server = createServer();
      ownedServer = server;
      // `ownsServer: true` — we created + own this listener, so destroying a
      // non-matching upgrade is correct (nothing else can claim it).
      wsHandle = websocketServer({
        ...rest,
        httpServer: server,
        gateway: host,
        transportId: id,
        ownsServer: true,
      });
      const listenHost = bindHost ?? DEFAULT_BIND_HOST;
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once("error", onError);
        server.listen(port, listenHost, () => {
          server.removeListener("error", onError);
          resolve();
        });
      });
    },

    async close(): Promise<void> {
      await wsHandle?.close();
      wsHandle = undefined;
      if (ownedServer) {
        const server = ownedServer;
        ownedServer = undefined;
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );
      }
    },
  };
}
