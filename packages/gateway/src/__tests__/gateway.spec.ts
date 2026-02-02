/**
 * Gateway Integration Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Gateway, createGateway } from "../gateway.js";
import type { App, Session } from "@tentickle/core";
import WebSocket from "ws";

// Mock App for testing
function createMockApp(name: string): App {
  const mockSession = {
    id: `session-${Date.now()}`,
    status: "idle",
    currentTick: 0,
    isAborted: false,
    queuedMessages: [],
    schedulerState: null,
    queue: { exec: vi.fn() } as any,
    send: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "content_delta", delta: "Hello" };
        yield { type: "message_end" };
      },
      then: (resolve: any) =>
        Promise.resolve({ response: "Hello", outputs: {}, usage: {} }).then(resolve),
    }),
    tick: vi.fn(),
    interrupt: vi.fn(),
    clearAbort: vi.fn(),
    events: vi.fn(),
    snapshot: vi.fn(),
    hibernate: vi.fn(),
    inspect: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    getRecording: vi.fn(),
    getSnapshotAt: vi.fn(),
    channel: vi.fn(),
    submitToolResult: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
  } as unknown as Session;

  return {
    session: vi.fn().mockReturnValue(mockSession),
    run: vi.fn() as any,
    send: vi.fn() as any,
    close: vi.fn(),
    sessions: [],
    has: vi.fn(),
    isHibernated: vi.fn(),
    hibernate: vi.fn(),
    hibernatedSessions: vi.fn(),
    onSessionCreate: vi.fn(),
    onSessionClose: vi.fn(),
  } as unknown as App;
}

describe("Gateway", () => {
  const TEST_PORT = 19998;
  const TEST_HOST = "127.0.0.1";
  let gateway: Gateway;
  let chatApp: App;
  let researchApp: App;

  beforeEach(() => {
    chatApp = createMockApp("chat");
    researchApp = createMockApp("research");
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
        agents: { chat: chatApp },
        defaultAgent: "chat",
      });

      expect(gateway).toBeInstanceOf(Gateway);
      expect(gateway.id).toBeDefined();
    });

    it("throws if no agents provided", () => {
      expect(() =>
        createGateway({
          agents: {},
          defaultAgent: "chat",
        }),
      ).toThrow("At least one agent is required");
    });

    it("throws if default agent not found", () => {
      expect(() =>
        createGateway({
          agents: { chat: chatApp },
          defaultAgent: "research",
        }),
      ).toThrow('Default agent "research" not found');
    });
  });

  describe("start/stop", () => {
    it("starts and stops gateway", async () => {
      gateway = createGateway({
        port: TEST_PORT,
        host: TEST_HOST,
        agents: { chat: chatApp },
        defaultAgent: "chat",
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
        agents: { chat: chatApp },
        defaultAgent: "chat",
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
        agents: { chat: chatApp },
        defaultAgent: "chat",
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
        agents: { chat: chatApp, research: researchApp },
        defaultAgent: "chat",
      });

      await gateway.start();

      const status = gateway.status;
      expect(status.id).toBeDefined();
      expect(status.uptime).toBeGreaterThanOrEqual(0);
      expect(status.clients).toBe(0);
      expect(status.sessions).toBe(0);
      expect(status.agents).toEqual(["chat", "research"]);
    });
  });

  describe("client connection", () => {
    it("accepts client and emits connected event", async () => {
      gateway = createGateway({
        port: TEST_PORT,
        host: TEST_HOST,
        agents: { chat: chatApp },
        defaultAgent: "chat",
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
        agents: { chat: chatApp },
        defaultAgent: "chat",
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
        agents: { chat: chatApp, research: researchApp },
        defaultAgent: "chat",
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

    it("lists agents", async () => {
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
          method: "agents",
          params: {},
        }),
      );

      const response = await responsePromise;
      expect(response.ok).toBe(true);
      expect(response.payload.agents).toHaveLength(2);
      expect(response.payload.agents[0].id).toBeDefined();
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
      expect(response.payload.gateway.agents).toContain("chat");
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
      expect(chatApp.session).toHaveBeenCalled();
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
  });

  describe("authentication", () => {
    it("requires auth when configured", async () => {
      gateway = createGateway({
        port: TEST_PORT,
        host: TEST_HOST,
        agents: { chat: chatApp },
        defaultAgent: "chat",
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
        agents: { chat: chatApp },
        defaultAgent: "chat",
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
          method: "agents",
          params: {},
        }),
      );

      const response = await responsePromise;
      expect(response.ok).toBe(true);

      client.close();
    });
  });
});
