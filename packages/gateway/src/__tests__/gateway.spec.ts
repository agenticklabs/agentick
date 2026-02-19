/**
 * Gateway Integration Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Gateway, createGateway } from "../gateway.js";
import { createMockApp as createCoreMockApp, type MockApp } from "@agentick/core/testing";
import WebSocket from "ws";

describe("Gateway", () => {
  const TEST_PORT = 19998;
  const TEST_HOST = "127.0.0.1";
  let gateway: Gateway;
  let chatApp: MockApp;
  let researchApp: MockApp;

  beforeEach(() => {
    chatApp = createCoreMockApp();
    researchApp = createCoreMockApp();
  });

  afterEach(async () => {
    if (gateway?.running) {
      await gateway.stop();
    }
  });

  describe("createGateway", () => {
    it("creates gateway with config", () => {
      gateway = createGateway({
        port: TEST_PORT,
        host: TEST_HOST,
        apps: { chat: chatApp },
        defaultApp: "chat",
      });

      expect(gateway).toBeInstanceOf(Gateway);
      expect(gateway.id).toBeDefined();
    });

    it("throws if no apps provided", () => {
      expect(() =>
        createGateway({
          apps: {},
          defaultApp: "chat",
        }),
      ).toThrow("At least one app is required");
    });

    it("throws if default app not found", () => {
      expect(() =>
        createGateway({
          apps: { chat: chatApp },
          defaultApp: "research",
        }),
      ).toThrow('Default app "research" not found');
    });
  });

  describe("start/stop", () => {
    it("starts and stops gateway", async () => {
      gateway = createGateway({
        port: TEST_PORT,
        host: TEST_HOST,
        apps: { chat: chatApp },
        defaultApp: "chat",
      });

      await gateway.start();
      expect(gateway.running).toBe(true);

      await gateway.stop();
      expect(gateway.running).toBe(false);
    });

    it("emits started event", async () => {
      gateway = createGateway({
        port: TEST_PORT,
        host: TEST_HOST,
        apps: { chat: chatApp },
        defaultApp: "chat",
      });

      const startedPromise = new Promise<{ port: number; host: string }>((resolve) => {
        gateway.on("started", resolve);
      });

      await gateway.start();
      const event = await startedPromise;

      expect(event.port).toBe(TEST_PORT);
      expect(event.host).toBe(TEST_HOST);
    });

    it("throws if started twice", async () => {
      gateway = createGateway({
        port: TEST_PORT,
        host: TEST_HOST,
        apps: { chat: chatApp },
        defaultApp: "chat",
      });

      await gateway.start();
      await expect(gateway.start()).rejects.toThrow("already running");
    });
  });

  describe("status", () => {
    it("reports gateway status", async () => {
      gateway = createGateway({
        port: TEST_PORT,
        host: TEST_HOST,
        apps: { chat: chatApp, research: researchApp },
        defaultApp: "chat",
      });

      await gateway.start();

      const status = gateway.status;
      expect(status.id).toBeDefined();
      expect(status.uptime).toBeGreaterThanOrEqual(0);
      expect(status.clients).toBe(0);
      expect(status.sessions).toBe(0);
      expect(status.apps).toEqual(["chat", "research"]);
    });
  });

  describe("client connection", () => {
    it("accepts client and emits connected event", async () => {
      gateway = createGateway({
        port: TEST_PORT,
        host: TEST_HOST,
        apps: { chat: chatApp },
        defaultApp: "chat",
      });

      await gateway.start();

      const connectedPromise = new Promise<{ clientId: string }>((resolve) => {
        gateway.on("client:connected", resolve);
      });

      const client = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
      await new Promise<void>((r) => client.on("open", () => r()));

      const event = await connectedPromise;
      expect(event.clientId).toBeDefined();

      client.close();
    });

    it("handles client disconnect", async () => {
      gateway = createGateway({
        port: TEST_PORT,
        host: TEST_HOST,
        apps: { chat: chatApp },
        defaultApp: "chat",
      });

      await gateway.start();

      const disconnectedPromise = new Promise<{ clientId: string }>((resolve) => {
        gateway.on("client:disconnected", resolve);
      });

      const client = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
      await new Promise<void>((r) => client.on("open", () => r()));

      // Connect
      client.send(JSON.stringify({ type: "connect", clientId: "test" }));
      await new Promise((r) => setTimeout(r, 50));

      client.close();

      const event = await disconnectedPromise;
      expect(event.clientId).toBeDefined();
    });
  });

  describe("RPC methods", () => {
    let client: WebSocket;

    beforeEach(async () => {
      gateway = createGateway({
        port: TEST_PORT,
        host: TEST_HOST,
        apps: { chat: chatApp, research: researchApp },
        defaultApp: "chat",
      });

      await gateway.start();

      client = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
      await new Promise<void>((r) => client.on("open", () => r()));

      // Authenticate
      client.send(JSON.stringify({ type: "connect", clientId: "test" }));
      await new Promise((r) => setTimeout(r, 50));
    });

    afterEach(() => {
      client?.close();
    });

    it("lists apps", async () => {
      const responsePromise = new Promise<any>((resolve) => {
        client.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "res") resolve(msg);
        });
      });

      client.send(
        JSON.stringify({
          type: "req",
          id: "req-1",
          method: "apps",
          params: {},
        }),
      );

      const response = await responsePromise;
      expect(response.ok).toBe(true);
      expect(response.payload.apps).toHaveLength(2);
      expect(response.payload.apps[0].id).toBeDefined();
    });

    it("lists sessions", async () => {
      const responsePromise = new Promise<any>((resolve) => {
        client.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "res") resolve(msg);
        });
      });

      client.send(
        JSON.stringify({
          type: "req",
          id: "req-1",
          method: "sessions",
          params: {},
        }),
      );

      const response = await responsePromise;
      expect(response.ok).toBe(true);
      expect(response.payload.sessions).toEqual([]);
    });

    it("returns gateway status", async () => {
      const responsePromise = new Promise<any>((resolve) => {
        client.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "res") resolve(msg);
        });
      });

      client.send(
        JSON.stringify({
          type: "req",
          id: "req-1",
          method: "status",
          params: {},
        }),
      );

      const response = await responsePromise;
      expect(response.ok).toBe(true);
      expect(response.payload.gateway).toBeDefined();
      expect(response.payload.gateway.apps).toContain("chat");
    });

    it("sends message to session", async () => {
      const messages: any[] = [];
      client.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
      });

      client.send(
        JSON.stringify({
          type: "req",
          id: "req-1",
          method: "send",
          params: {
            sessionId: "main",
            message: "Hello!",
          },
        }),
      );

      // Wait for response and events
      await new Promise((r) => setTimeout(r, 200));

      const response = messages.find((m) => m.type === "res" && m.id === "req-1");
      expect(response?.ok).toBe(true);
      expect(response?.payload?.messageId).toBeDefined();

      // Should have created a session and sent to it
      expect(chatApp._sessions.size).toBeGreaterThan(0);
    });

    it("emits session:message for WS send", async () => {
      const sessionMessages: any[] = [];
      gateway.on("session:message", (payload) => sessionMessages.push(payload));

      client.send(
        JSON.stringify({
          type: "req",
          id: "req-msg",
          method: "send",
          params: {
            sessionId: "main",
            message: "WS state test",
          },
        }),
      );

      await new Promise((r) => setTimeout(r, 200));

      expect(sessionMessages).toHaveLength(1);
      expect(sessionMessages[0].sessionId).toBe("main");
      expect(sessionMessages[0].role).toBe("user");
      expect(sessionMessages[0].content).toBe("WS state test");
    });

    it("WS subscriber receives broadcast events through buffer", async () => {
      // Subscribe first
      const subPromise = new Promise<any>((resolve) => {
        const handler = (data: any) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "res" && msg.id === "req-sub") {
            client.off("message", handler);
            resolve(msg);
          }
        };
        client.on("message", handler);
      });

      client.send(
        JSON.stringify({
          type: "req",
          id: "req-sub",
          method: "subscribe",
          params: { sessionId: "main" },
        }),
      );
      await subPromise;

      // Now send — should get events back via subscription broadcast
      const events: any[] = [];
      const handler = (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "event" && msg.sessionId === "main") {
          events.push(msg);
        }
      };
      client.on("message", handler);

      client.send(
        JSON.stringify({
          type: "req",
          id: "req-send",
          method: "send",
          params: {
            sessionId: "main",
            message: "broadcast test",
          },
        }),
      );

      await new Promise((r) => setTimeout(r, 200));
      client.off("message", handler);

      // WS sender auto-subscribes AND gets events via subscription
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].event).toBeDefined();
    });

    it("handles unknown method", async () => {
      const responsePromise = new Promise<any>((resolve) => {
        client.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "res") resolve(msg);
        });
      });

      client.send(
        JSON.stringify({
          type: "req",
          id: "req-1",
          method: "unknown_method" as any,
          params: {},
        }),
      );

      const response = await responsePromise;
      expect(response.ok).toBe(false);
      expect(response.error.message).toContain("Unknown method");
    });

    it("subscribes to channel via channel-subscribe method", async () => {
      const responsePromise = new Promise<any>((resolve) => {
        client.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "res" && msg.id === "req-ch-sub") resolve(msg);
        });
      });

      client.send(
        JSON.stringify({
          type: "req",
          id: "req-ch-sub",
          method: "channel-subscribe",
          params: {
            sessionId: "main",
            channel: "updates",
          },
        }),
      );

      const response = await responsePromise;
      expect(response.ok).toBe(true);
      expect(response.payload.ok).toBe(true);
    });

    it("publishes to channel via channel method", async () => {
      const responsePromise = new Promise<any>((resolve) => {
        client.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "res" && msg.id === "req-ch-pub") resolve(msg);
        });
      });

      client.send(
        JSON.stringify({
          type: "req",
          id: "req-ch-pub",
          method: "channel",
          params: {
            sessionId: "main",
            channel: "updates",
            payload: { text: "hello channel" },
          },
        }),
      );

      const response = await responsePromise;
      expect(response.ok).toBe(true);
      expect(response.payload.ok).toBe(true);
    });

    it("channel-subscribe requires sessionId and channel", async () => {
      const responsePromise = new Promise<any>((resolve) => {
        client.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "res" && msg.id === "req-bad") resolve(msg);
        });
      });

      client.send(
        JSON.stringify({
          type: "req",
          id: "req-bad",
          method: "channel-subscribe",
          params: { sessionId: "main" }, // missing channel
        }),
      );

      const response = await responsePromise;
      expect(response.ok).toBe(false);
      expect(response.error.message).toContain("channel");
    });

    it("channel publish requires sessionId and channel", async () => {
      const responsePromise = new Promise<any>((resolve) => {
        client.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "res" && msg.id === "req-bad2") resolve(msg);
        });
      });

      client.send(
        JSON.stringify({
          type: "req",
          id: "req-bad2",
          method: "channel",
          params: { payload: "data" }, // missing sessionId and channel
        }),
      );

      const response = await responsePromise;
      expect(response.ok).toBe(false);
      expect(response.error.message).toContain("channel");
    });
  });

  describe("authentication", () => {
    it("requires auth when configured", async () => {
      gateway = createGateway({
        port: TEST_PORT,
        host: TEST_HOST,
        apps: { chat: chatApp },
        defaultApp: "chat",
        auth: { type: "token", token: "secret123" },
      });

      await gateway.start();

      const client = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
      await new Promise<void>((r) => client.on("open", () => r()));

      const errorPromise = new Promise<any>((resolve) => {
        client.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "error") resolve(msg);
        });
      });

      // Try to connect without token
      client.send(JSON.stringify({ type: "connect", clientId: "test" }));

      const error = await errorPromise;
      expect(error.code).toBe("AUTH_FAILED");

      client.close();
    });

    it("allows auth with valid token", async () => {
      gateway = createGateway({
        port: TEST_PORT,
        host: TEST_HOST,
        apps: { chat: chatApp },
        defaultApp: "chat",
        auth: { type: "token", token: "secret123" },
      });

      await gateway.start();

      const client = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
      await new Promise<void>((r) => client.on("open", () => r()));

      // Connect with valid token
      client.send(
        JSON.stringify({
          type: "connect",
          clientId: "test",
          token: "secret123",
        }),
      );

      // Should be able to make requests now
      await new Promise((r) => setTimeout(r, 50));

      const responsePromise = new Promise<any>((resolve) => {
        client.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "res") resolve(msg);
        });
      });

      client.send(
        JSON.stringify({
          type: "req",
          id: "req-1",
          method: "apps",
          params: {},
        }),
      );

      const response = await responsePromise;
      expect(response.ok).toBe(true);

      client.close();
    });
  });
});
