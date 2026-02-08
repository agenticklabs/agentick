/**
 * Gateway Testing Utilities
 *
 * Provides helpers for testing gateway interactions.
 *
 * @example
 * ```typescript
 * import { createTestGateway, createMockApp } from '@tentickle/gateway/testing';
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
 * @module @tentickle/gateway/testing
 */

import WebSocket from "ws";
import type { Gateway } from "./gateway.js";
import { createGateway } from "./gateway.js";
import type { GatewayConfig, GatewayEvents } from "./types.js";
import type { App, Session, SessionExecutionHandle, SendResult } from "@tentickle/core";

// ============================================================================
// Mock App Factory
// ============================================================================

export interface MockAppOptions {
  /** Response text from model */
  response?: string;
  /** Simulate streaming with these deltas */
  streamDeltas?: string[];
  /** Simulate tool calls */
  toolCalls?: Array<{ name: string; input: unknown; result: unknown }>;
  /** Error to throw */
  error?: Error;
  /** Delay before responding (ms) */
  delay?: number;
}

/**
 * Create a mock App for testing.
 *
 * The mock app simulates model responses without requiring actual API calls.
 */
export function createMockApp(options: MockAppOptions = {}): App {
  const { response = "Mock response", streamDeltas, toolCalls, error, delay } = options;

  const createMockExecution = (): SessionExecutionHandle => {
    const events: Array<{ type: string; [key: string]: unknown }> = [];

    if (streamDeltas) {
      for (const delta of streamDeltas) {
        events.push({ type: "content_delta", delta });
      }
    } else if (response) {
      events.push({ type: "content_delta", delta: response });
    }

    if (toolCalls) {
      for (const call of toolCalls) {
        events.push({ type: "tool_call_start", name: call.name, input: call.input });
        events.push({ type: "tool_result", name: call.name, result: call.result });
      }
    }

    events.push({ type: "message_end" });

    // Create a minimal mock that satisfies the interface
    const handle = {
      sessionId: "mock-session",
      currentTick: 1,
      queueMessage: () => {},
      submitToolResult: () => {},
      abort: () => {},
      isRunning: () => false,
      isCompleted: () => true,
      isAborted: () => false,
      status: "completed" as const,
      traceId: "mock-trace",
      events: async function* () {
        for (const event of events) {
          yield event;
        }
      },
      eventBuffer: { events: [] },
      result: Promise.resolve({
        response,
        outputs: {},
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        raw: {} as any,
      }),
      [Symbol.asyncIterator]: async function* () {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (error) throw error;
        for (const event of events) {
          yield event;
        }
      },
      then: async <T>(
        resolve?: ((value: SendResult) => T | PromiseLike<T>) | null,
        reject?: ((reason: unknown) => T | PromiseLike<T>) | null,
      ): Promise<T> => {
        try {
          if (delay) await new Promise((r) => setTimeout(r, delay));
          if (error) throw error;
          const result: SendResult = {
            response,
            outputs: {},
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
            raw: {} as any,
          };
          return resolve ? resolve(result) : (result as unknown as T);
        } catch (e) {
          if (reject) return reject(e);
          throw e;
        }
      },
    };

    return handle as unknown as SessionExecutionHandle;
  };

  async function createMockExecutionProcedure() {
    return await createMockExecution();
  }

  createMockExecutionProcedure.exec = createMockExecutionProcedure;

  const mockSession: Partial<Session> = {
    id: "mock-session",
    status: "idle",
    currentTick: 0,
    isAborted: false,
    queuedMessages: [],
    schedulerState: null,
    queue: { exec: async () => {} } as any,
    send: createMockExecutionProcedure as any,
    render: createMockExecutionProcedure as any,
    interrupt: () => {},
    clearAbort: () => {},
    events: async function* () {},
    snapshot: () => ({
      version: "1.0",
      sessionId: "mock-session",
      tick: 0,
      timeline: [],
      componentState: {},
      timestamp: Date.now(),
    }),
    hibernate: async () => null,
    inspect: () => ({
      id: "mock-session",
      status: "idle" as const,
      currentTick: 0,
      queuedMessages: [],
      isAborted: false,
      lastOutput: null,
      lastModelOutput: null,
      lastToolCalls: [],
      lastToolResults: [],
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      tickCount: 0,
      components: { count: 0, names: [] },
      hooks: { count: 0, byType: {} },
    }),
    startRecording: () => {},
    stopRecording: () => {},
    getRecording: () => null,
    getSnapshotAt: () => null,
    channel: () => ({ publish: () => {}, subscribe: () => () => {} }) as any,
    submitToolResult: () => {},
    close: () => {},
    on: () => mockSession as Session,
    emit: () => true,
    off: () => mockSession as Session,
  };

  return {
    session: () => mockSession as Session,
    run: Object.assign(() => createMockExecution(), {
      exec: () => createMockExecution(),
      withContext: () => ({}) as any,
      use: () => ({}) as any,
    }) as any,
    send: () => createMockExecution(),
    close: async () => {},
    sessions: [],
    has: () => false,
    isHibernated: async () => false,
    hibernate: async () => null,
    hibernatedSessions: async () => [],
    onSessionCreate: () => () => {},
    onSessionClose: () => () => {},
  } as unknown as App;
}

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
