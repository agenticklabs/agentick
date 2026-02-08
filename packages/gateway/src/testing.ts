/**
 * Gateway Testing Utilities
 *
 * Provides helpers for testing gateway interactions.
 *
 * @example
 * ```typescript
 * import { createTestGateway, createMockApp } from '@agentick/gateway/testing';
 *
 * test('gateway handles messages', async () => {
 *   const mockApp = createMockApp({
 *     response: 'Hello!',
 *   });
 *
 *   const { gateway, client, cleanup } = await createTestGateway({
 *     agents: { chat: mockApp },
 *     defaultAgent: 'chat',
 *   });
 *
 *   try {
 *     const response = await client.send('main', 'Hi there');
 *     expect(response.payload.messageId).toBeDefined();
 *   } finally {
 *     await cleanup();
 *   }
 * });
 * ```
 *
 * @module @agentick/gateway/testing
 */

import WebSocket from "ws";
import type { Gateway } from "./gateway.js";
import { createGateway } from "./gateway.js";
import type { GatewayConfig, GatewayEvents } from "./types.js";

// Re-export mock factories from core
export {
  createMockApp,
  createMockSession,
  createMockExecutionHandle,
  createTestProcedure,
  type MockAppOptions,
  type MockSessionOptions,
  type MockSession,
  type MockApp,
  type MockSessionExecutionHandle,
  type MockExecutionHandleOptions,
  type TestProcedure,
  type TestProcedureOptions,
} from "@agentick/core/testing";

// ============================================================================
// Test Gateway Factory
// ============================================================================

export interface TestGatewayOptions extends Omit<GatewayConfig, "port" | "host"> {
  /** Custom port (default: random available port) */
  port?: number;
}

export interface TestGatewayClient {
  /** Send a request to the gateway */
  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{
    ok: boolean;
    payload?: T;
    error?: { code: string; message: string };
  }>;

  /** Send a message to a session */
  send(
    sessionId: string,
    message: string,
  ): Promise<{
    ok: boolean;
    payload?: { messageId: string };
    error?: { code: string; message: string };
  }>;

  /** Collect events for a session */
  collectEvents(
    sessionId: string,
    timeout?: number,
  ): Promise<Array<{ type: string; data: unknown }>>;

  /** Close the client connection */
  close(): void;

  /** The raw WebSocket */
  ws: WebSocket;
}

export interface TestGatewayResult {
  /** The gateway instance */
  gateway: Gateway;

  /** A connected test client */
  client: TestGatewayClient;

  /** Gateway URL */
  url: string;

  /** Port the gateway is running on */
  port: number;

  /** Clean up resources */
  cleanup: () => Promise<void>;
}

/**
 * Create a test gateway with a connected client.
 *
 * Automatically handles port allocation, client connection, and cleanup.
 */
export async function createTestGateway(options: TestGatewayOptions): Promise<TestGatewayResult> {
  // Use random high port to avoid conflicts
  const port = options.port ?? 19000 + Math.floor(Math.random() * 1000);
  const host = "127.0.0.1";
  const url = `ws://${host}:${port}`;

  const gateway = createGateway({
    ...options,
    port,
    host,
  });

  await gateway.start();

  // Create and connect client
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });

  // Authenticate
  ws.send(JSON.stringify({ type: "connect", clientId: "test-client" }));
  await new Promise((r) => setTimeout(r, 50));

  let requestId = 0;
  const pendingRequests = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
    }
  >();

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "res" && pendingRequests.has(msg.id)) {
      const { resolve } = pendingRequests.get(msg.id)!;
      pendingRequests.delete(msg.id);
      resolve({ ok: msg.ok, payload: msg.payload, error: msg.error });
    }
  });

  const client: TestGatewayClient = {
    ws,

    async request(method, params = {}) {
      const id = `req-${++requestId}`;
      return new Promise((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });
        ws.send(JSON.stringify({ type: "req", id, method, params }));

        // Timeout after 5s
        setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            reject(new Error(`Request ${method} timed out`));
          }
        }, 5000);
      });
    },

    async send(sessionId, message) {
      return this.request("send", { sessionId, message });
    },

    async collectEvents(sessionId, timeout = 1000) {
      const events: Array<{ type: string; data: unknown }> = [];

      const handler = (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "event" && msg.sessionId === sessionId) {
          events.push({ type: msg.event, data: msg.data });
        }
      };

      ws.on("message", handler);
      await new Promise((r) => setTimeout(r, timeout));
      ws.off("message", handler);

      return events;
    },

    close() {
      ws.close();
    },
  };

  const cleanup = async () => {
    client.close();
    await gateway.stop();
  };

  return { gateway, client, url, port, cleanup };
}

// ============================================================================
// Event Helpers
// ============================================================================

/**
 * Wait for a specific gateway event.
 */
export function waitForGatewayEvent<K extends keyof GatewayEvents>(
  gateway: Gateway,
  event: K,
  timeout = 5000,
): Promise<GatewayEvents[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for gateway event: ${event}`));
    }, timeout);

    gateway.on(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}
