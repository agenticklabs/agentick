/**
 * Reconnect behavior — client survives a server-side connection drop
 * and re-establishes the wire.
 *
 * Cursor-aware resubscribe is verified by the smoke + future subscription
 * tests; this file covers the reconnect machinery itself.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createGateway } from "@agentick/gateway-next";
import { createClient } from "@agentick/client-core-next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { websocket } from "../client/index.js";
import { websocketServer } from "../server/index.js";

describe("WebSocket transport — reconnect", () => {
  let gateway: Awaited<ReturnType<typeof createGateway>>;
  let server: ReturnType<typeof websocketServer>;
  let httpServer: ReturnType<typeof createServer>;
  let port = 0;

  beforeEach(async () => {
    gateway = await createGateway();
    httpServer = createServer();
    server = websocketServer({ httpServer, gateway });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await server.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    await gateway.close();
  });

  it("client transitions through reconnecting → open on server bounce", async () => {
    const client = await createClient({
      transport: websocket({
        url: `ws://127.0.0.1:${port}`,
        reconnect: { initialDelayMs: 50, maxDelayMs: 200 },
      }),
    });

    const states: string[] = [];
    client.onStateChange((s) => {
      states.push(typeof s === "string" ? s : `failed:${s.kind}`);
    });

    await client.connect();
    expect(client.state).toBe("open");

    // Bounce the server.
    await server.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));

    // Stand a new server back up on the same port.
    httpServer = createServer();
    server = websocketServer({ httpServer, gateway });
    await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", () => resolve()));

    // Wait for client to reconnect.
    await new Promise<void>((resolve) => {
      if (client.state === "open" && states.includes("reconnecting")) return resolve();
      const off = client.onStateChange((s) => {
        if (s === "open" && states.includes("reconnecting")) {
          off();
          resolve();
        }
      });
    });

    expect(states).toContain("reconnecting");
    expect(client.state).toBe("open");

    // Verify the wire is actually working post-reconnect.
    const result = await client.request("ping", {});
    expect(result).toEqual({});

    await client.close();
  });

  it("explicit close() does not trigger reconnect", async () => {
    const client = await createClient({
      transport: websocket({
        url: `ws://127.0.0.1:${port}`,
        reconnect: { initialDelayMs: 50 },
      }),
    });

    const states: string[] = [];
    client.onStateChange((s) => states.push(typeof s === "string" ? s : `failed:${s.kind}`));

    await client.connect();
    await client.close();

    // Wait a moment to confirm no reconnect attempt fires.
    await new Promise((r) => setTimeout(r, 150));

    expect(states[states.length - 1]).toBe("closed");
    expect(states).not.toContain("reconnecting");
  });

  it("disabled reconnect transitions straight to closed on drop", async () => {
    const client = await createClient({
      transport: websocket({
        url: `ws://127.0.0.1:${port}`,
        reconnect: { enabled: false },
      }),
    });
    await client.connect();
    expect(client.state).toBe("open");

    await server.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));

    // Wait for the close event to propagate.
    await new Promise<void>((resolve) => {
      if (client.state === "closed") return resolve();
      const off = client.onStateChange((s) => {
        if (s === "closed") {
          off();
          resolve();
        }
      });
    });

    expect(client.state).toBe("closed");

    // Restore server for afterEach teardown.
    httpServer = createServer();
    server = websocketServer({ httpServer, gateway });
    await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", () => resolve()));
  });
});
