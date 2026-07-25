/**
 * `httpServerTransport(config)` — the {@link ServerTransport} wrapper over
 * {@link httpServer} (ADR 84 §2).
 *
 * `httpServer` mounts on a caller-supplied Node `http.Server` (it attaches an
 * `on("request")` handler and never binds a port itself). The transport wrapper
 * therefore owns the port: given `{ port }` it creates the Node server in
 * `listen(host)`, mounts `httpServer` on it, and calls `server.listen(port)`;
 * `close()` tears down both the request handler and the Node server it created.
 *
 * An adopter that already has a Node `http.Server` (Express's underlying
 * server, an `https.Server`, a shared listener) passes `{ httpServer }` instead
 * of `{ port }` — the wrapper mounts on it and, since it did not create it,
 * does NOT close it.
 *
 * @see docs/proposals/v2/blueprint/84-gateway-lifecycle-and-transports.md §2
 */

import { createServer, type Server as NodeHttpServer } from "node:http";
import type { GatewayHarnessProtocol, ServerTransport } from "@agentick/spec";
import { DEFAULT_BIND_HOST } from "@agentick/transport";
import { httpServer, type HttpServerHandle, type HttpServerOptions } from "./server.js";

/** Port-owning config — the wrapper creates and binds the Node server. */
export interface HttpServerTransportPortConfig extends Omit<
  HttpServerOptions,
  "gateway" | "httpServer"
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
 * Config for {@link httpServerTransport}. Either the common `{ port }` shape
 * (wrapper owns the Node server) or `{ httpServer }` (adopter owns it).
 */
export type HttpServerTransportConfig =
  | HttpServerTransportPortConfig
  | Omit<HttpServerOptions, "gateway">;

export function httpServerTransport(config: HttpServerTransportConfig): ServerTransport {
  let handle: HttpServerHandle | undefined;
  // The Node server WE created, if any — closed in close(). An
  // adopter-supplied server is never touched.
  let ownedServer: NodeHttpServer | undefined;

  return {
    id: "httpServer" in config ? "http:attached" : `http:${config.port}`,

    async listen(host: GatewayHarnessProtocol): Promise<void> {
      if (handle) return; // idempotent — already bound

      if ("httpServer" in config) {
        // Adopter owns the Node server; just mount and route.
        handle = httpServer({ ...config, gateway: host });
        return;
      }

      const { port, host: bindHost, ...rest } = config;
      const server = createServer();
      ownedServer = server;
      handle = httpServer({ ...rest, httpServer: server, gateway: host });
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
      await handle?.close();
      handle = undefined;
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
