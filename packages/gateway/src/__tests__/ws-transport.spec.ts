/**
 * WebSocket Transport Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WSTransport } from "../ws-transport.js";
import WebSocket from "ws";

describe("WSTransport", () => {
  let server: WSTransport;
  let client: WebSocket;
  const TEST_PORT = 19999;
  const TEST_HOST = "127.0.0.1";

  beforeEach(async () => {
    server = new WSTransport({
      port: TEST_PORT,
      host: TEST_HOST,
    });
    await server.start();
  });

  afterEach(async () => {
    if (client && client.readyState === WebSocket.OPEN) {
      client.close();
    }
    await server.stop();
  });

  describe("start/stop", () => {
    it("starts and stops server", async () => {
      const anotherServer = new WSTransport({
        port: TEST_PORT + 1,
        host: TEST_HOST,
      });

      await anotherServer.start();
      expect(anotherServer.clientCount).toBe(0);

      await anotherServer.stop();
    });
  });

  describe("connections", () => {
    it("accepts client connection", async () => {
      const connectionPromise = new Promise<void>((resolve) => {
        server.on("connection", () => resolve());
      });

      client = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
      await connectionPromise;

      expect(server.clientCount).toBe(1);
    });

    it("handles client disconnect", async () => {
      const disconnectPromise = new Promise<string>((resolve) => {
        server.on("disconnect", (clientId) => resolve(clientId));
      });

      client = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
      await new Promise<void>((resolve) => {
        client.on("open", () => resolve());
      });

      client.close();
      const disconnectedId = await disconnectPromise;

      expect(disconnectedId).toBeDefined();
      expect(server.clientCount).toBe(0);
    });
  });

  describe("authentication", () => {
    it("authenticates with valid token", async () => {
      await server.stop();

      server = new WSTransport({
        port: TEST_PORT,
        host: TEST_HOST,
        auth: { type: "token", token: "secret123" },
      });
      await server.start();

      client = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
      await new Promise<void>((resolve) => {
        client.on("open", () => resolve());
      });

      // Track any error responses
      let gotError = false;
      client.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "error") gotError = true;
      });

      client.send(
        JSON.stringify({
          type: "connect",
          clientId: "test-client",
          token: "secret123",
        }),
      );

      // Wait a bit and verify no error was received
      await new Promise((r) => setTimeout(r, 100));
      expect(gotError).toBe(false);
      expect(server.clientCount).toBe(1);
    });

    it("rejects invalid token", async () => {
      await server.stop();

      server = new WSTransport({
        port: TEST_PORT,
        host: TEST_HOST,
        auth: { type: "token", token: "secret123" },
      });
      await server.start();

      client = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
      await new Promise<void>((resolve) => {
        client.on("open", () => resolve());
      });

      const responsePromise = new Promise<{ type: string; code?: string }>((resolve) => {
        client.on("message", (data) => {
          resolve(JSON.parse(data.toString()));
        });
      });

      client.send(
        JSON.stringify({
          type: "connect",
          clientId: "test-client",
          token: "wrong-token",
        }),
      );

      const response = await responsePromise;
      expect(response.type).toBe("error");
      expect(response.code).toBe("AUTH_FAILED");
    });

    it("allows connection without auth when not configured", async () => {
      client = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
      await new Promise<void>((resolve) => {
        client.on("open", () => resolve());
      });

      const responsePromise = new Promise<{ type: string }>((resolve) => {
        client.on("message", (data) => {
          resolve(JSON.parse(data.toString()));
        });
      });

      client.send(
        JSON.stringify({
          type: "connect",
          clientId: "test-client",
        }),
      );

      // Should not get auth error
      // Since no auth configured, any connect should work
      await new Promise((r) => setTimeout(r, 100));
      expect(server.clientCount).toBe(1);
    });
  });

  describe("ping/pong", () => {
    it("responds to ping with pong", async () => {
      client = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
      await new Promise<void>((resolve) => {
        client.on("open", () => resolve());
      });

      // Connect first
      client.send(
        JSON.stringify({
          type: "connect",
          clientId: "test-client",
        }),
      );

      const pongPromise = new Promise<{ type: string; timestamp: number }>((resolve) => {
        client.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "pong") {
            resolve(msg);
          }
        });
      });

      const timestamp = Date.now();
      client.send(
        JSON.stringify({
          type: "ping",
          timestamp,
        }),
      );

      const pong = await pongPromise;
      expect(pong.type).toBe("pong");
      expect(pong.timestamp).toBe(timestamp);
    });
  });

  describe("broadcast", () => {
    it("broadcasts to authenticated clients", async () => {
      // Connect two clients
      const client1 = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
      const client2 = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);

      await Promise.all([
        new Promise<void>((r) => client1.on("open", () => r())),
        new Promise<void>((r) => client2.on("open", () => r())),
      ]);

      // Authenticate both
      client1.send(JSON.stringify({ type: "connect", clientId: "c1" }));
      client2.send(JSON.stringify({ type: "connect", clientId: "c2" }));

      await new Promise((r) => setTimeout(r, 50));

      const messages: unknown[] = [];
      client1.on("message", (data) => messages.push(JSON.parse(data.toString())));
      client2.on("message", (data) => messages.push(JSON.parse(data.toString())));

      server.broadcast({
        type: "event",
        event: "test_event",
        sessionId: "test",
        data: { foo: "bar" },
      });

      await new Promise((r) => setTimeout(r, 50));

      const events = messages.filter((m: any) => m.type === "event");
      expect(events.length).toBeGreaterThanOrEqual(2);

      client1.close();
      client2.close();
    });
  });
});
