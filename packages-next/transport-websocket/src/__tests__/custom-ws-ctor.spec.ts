/**
 * The README claims adopters on Node 18/20 or who need custom HTTP
 * upgrade headers can pass `(await import("ws")).WebSocket` via the
 * `WebSocket` option. Verifies the constructor-override path.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket as WsLib } from "ws";
import { createGateway } from "@agentick/gateway-next";
import { createClient } from "@agentick/client-next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { websocket } from "../client/index.js";
import { websocketServer } from "../server/index.js";

describe("WebSocket transport — custom WebSocket constructor", () => {
  let gateway: Awaited<ReturnType<typeof createGateway>>;
  let server: ReturnType<typeof websocketServer>;
  let httpServer: ReturnType<typeof createServer>;
  let port = 0;

  beforeEach(async () => {
    gateway = await createGateway();
    httpServer = createServer();
    server = websocketServer({ httpServer, gateway });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await server.close();
    await new Promise<void>((resolve, reject) =>
      httpServer.close((err) => (err ? reject(err) : resolve())),
    );
    await gateway.closeGateway();
  });

  it("works with the `ws` library WebSocket as the constructor override", async () => {
    const client = await createClient({
      transport: websocket({
        url: `ws://127.0.0.1:${port}`,
        WebSocket: WsLib as unknown as new (
          url: string,
          protocols?: string | readonly string[],
        ) => InstanceType<typeof WsLib>,
      }),
    });
    await client.connect();
    expect(client.state).toBe("open");
    await client.request("ping", {});
    await client.close();
    expect(client.state).toBe("closed");
  });
});
