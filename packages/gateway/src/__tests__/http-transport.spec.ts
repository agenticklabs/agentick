/**
 * HTTP Transport Integration Tests
 *
 * Real HTTP requests → real HTTPTransport → real SSE streams.
 * No mocking of the transport layer. These test the actual HTTP
 * round-trip that the dashboard/client uses.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import { createGateway, type Gateway } from "../gateway.js";
import { createMockApp, type MockApp } from "@agentick/core/testing";

// ============================================================================
// Test Helpers
// ============================================================================

const TEST_HOST = "127.0.0.1";

/** Allocate a random high port to avoid test collisions */
function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 10000);
}

interface HTTPResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Make a JSON POST request and return the full response */
function post(
  url: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<HTTPResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => {
          responseBody += chunk.toString();
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: responseBody,
          });
        });
      },
    );

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

/** Establish an SSE connection and collect events */
function connectSSE(
  url: string,
  options?: { clientId?: string; token?: string },
): {
  events: Array<{ type: string; [k: string]: unknown }>;
  close: () => void;
  waitForEvent: (type: string, timeout?: number) => Promise<Record<string, unknown>>;
  waitForConnection: () => Promise<string>;
} {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  let connectionId: string | undefined;
  let connectionResolve: ((id: string) => void) | null = null;
  const eventWaiters: Array<{
    type: string;
    resolve: (data: Record<string, unknown>) => void;
    reject: (err: Error) => void;
  }> = [];

  const parsed = new URL(url);
  const params = new URLSearchParams();
  if (options?.clientId) params.set("clientId", options.clientId);
  if (options?.token) params.set("token", options.token);
  const path = `${parsed.pathname}?${params.toString()}`;

  const req = http.get(
    {
      hostname: parsed.hostname,
      port: parsed.port,
      path,
      headers: { Accept: "text/event-stream" },
    },
    (res) => {
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk.toString();
        // Parse SSE frames
        const lines = buffer.split("\n\n");
        // Keep last partial frame in buffer
        buffer = lines.pop() ?? "";
        for (const frame of lines) {
          if (frame.startsWith(":")) continue; // heartbeat
          const match = frame.match(/^data:\s*(.+)$/m);
          if (!match) continue;
          try {
            const parsed = JSON.parse(match[1]);
            events.push(parsed);
            // Resolve connection waiter
            if (parsed.type === "connection" && parsed.connectionId) {
              connectionId = parsed.connectionId;
              connectionResolve?.(connectionId);
              connectionResolve = null;
            }
            // Resolve event waiters
            for (let i = eventWaiters.length - 1; i >= 0; i--) {
              if (eventWaiters[i].type === parsed.type || eventWaiters[i].type === parsed.event) {
                eventWaiters[i].resolve(parsed);
                eventWaiters.splice(i, 1);
              }
            }
          } catch {
            // Ignore non-JSON
          }
        }
      });
    },
  );

  return {
    events,
    close: () => req.destroy(),

    waitForConnection: () =>
      new Promise((resolve) => {
        if (connectionId) {
          resolve(connectionId);
        } else {
          connectionResolve = resolve;
        }
      }),

    waitForEvent: (type: string, timeout = 5000) =>
      new Promise((resolve, reject) => {
        // Check if already received
        const existing = events.find((e) => e.type === type || e.event === type);
        if (existing) {
          resolve(existing);
          return;
        }
        const timer = setTimeout(() => {
          const idx = eventWaiters.findIndex((w) => w.type === type);
          if (idx >= 0) eventWaiters.splice(idx, 1);
          reject(new Error(`Timeout waiting for event: ${type}`));
        }, timeout);
        eventWaiters.push({
          type,
          resolve: (data) => {
            clearTimeout(timer);
            resolve(data);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
      }),
  };
}

/**
 * Collect SSE events from a POST /send response.
 * Returns when the stream closes.
 */
function postSSE(
  url: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{
  status: number;
  events: Array<Record<string, unknown>>;
}> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        const events: Array<Record<string, unknown>> = [];
        let buffer = "";

        res.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";
          for (const frame of lines) {
            if (frame.startsWith(":")) continue;
            const match = frame.match(/^data:\s*(.+)$/m);
            if (!match) continue;
            try {
              events.push(JSON.parse(match[1]));
            } catch {
              // skip
            }
          }
        });

        res.on("end", () => {
          // Parse any remaining buffer
          if (buffer.trim()) {
            const match = buffer.match(/^data:\s*(.+)$/m);
            if (match) {
              try {
                events.push(JSON.parse(match[1]));
              } catch {
                // skip
              }
            }
          }
          resolve({ status: res.statusCode!, events });
        });
      },
    );

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("HTTP Transport E2E", () => {
  let gateway: Gateway;
  let app: MockApp;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    port = randomPort();
    baseUrl = `http://${TEST_HOST}:${port}`;
    app = createMockApp();
  });

  afterEach(async () => {
    if (gateway?.running) {
      await gateway.stop();
    }
  });

  async function startGateway(config?: { auth?: { type: "token"; token: string } }): Promise<void> {
    gateway = createGateway({
      port,
      host: TEST_HOST,
      transport: "http",
      apps: { main: app },
      defaultApp: "main",
      ...config,
    });
    await gateway.start();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SSE Connection (/events)
  // ══════════════════════════════════════════════════════════════════════════

  describe("/events SSE connection", () => {
    it("establishes SSE connection and receives connection event", async () => {
      await startGateway();

      const sse = connectSSE(`${baseUrl}/events`);
      try {
        const connectionId = await sse.waitForConnection();
        expect(connectionId).toBeDefined();
        expect(typeof connectionId).toBe("string");

        // Should have received a connection event
        const connEvent = sse.events.find((e) => e.type === "connection");
        expect(connEvent).toBeDefined();
        expect(connEvent!.connectionId).toBe(connectionId);
      } finally {
        sse.close();
      }
    });

    it("assigns custom clientId via query parameter", async () => {
      await startGateway();

      const sse = connectSSE(`${baseUrl}/events`, { clientId: "my-client" });
      try {
        const connectionId = await sse.waitForConnection();
        expect(connectionId).toBe("my-client");
      } finally {
        sse.close();
      }
    });

    it("rejects unauthenticated connections when auth is configured", async () => {
      await startGateway({ auth: { type: "token", token: "secret" } });

      const result = await new Promise<number>((resolve) => {
        http.get(
          {
            hostname: TEST_HOST,
            port,
            path: "/events",
            headers: { Accept: "text/event-stream" },
          },
          (res) => resolve(res.statusCode!),
        );
      });

      expect(result).toBe(401);
    });

    it("accepts authenticated connections", async () => {
      await startGateway({ auth: { type: "token", token: "secret" } });

      const sse = connectSSE(`${baseUrl}/events`, { token: "secret" });
      try {
        const connectionId = await sse.waitForConnection();
        expect(connectionId).toBeDefined();
      } finally {
        sse.close();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Send (/send)
  // ══════════════════════════════════════════════════════════════════════════

  describe("/send streaming", () => {
    it("sends a message and receives SSE events back", async () => {
      await startGateway();

      const { status, events } = await postSSE(`${baseUrl}/send`, {
        sessionId: "test",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(status).toBe(200);
      expect(events.length).toBeGreaterThan(0);

      // Should have content_delta events from mock
      const deltas = events.filter((e) => e.event === "content_delta");
      expect(deltas.length).toBeGreaterThan(0);

      // Should end with message_end
      const messageEnd = events.find((e) => e.event === "message_end");
      expect(messageEnd).toBeDefined();
    });

    it("accepts legacy single-message format", async () => {
      await startGateway();

      const { status, events } = await postSSE(`${baseUrl}/send`, {
        sessionId: "test",
        message: { role: "user", content: "Hello" },
      });

      expect(status).toBe(200);
      expect(events.length).toBeGreaterThan(0);
    });

    it("rejects invalid send format", async () => {
      await startGateway();

      const result = await post(`${baseUrl}/send`, {
        sessionId: "test",
        // No messages or message field
      });

      expect(result.status).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain("Invalid send format");
    });

    it("rejects non-POST requests", async () => {
      await startGateway();

      const result = await new Promise<number>((resolve) => {
        http.get({ hostname: TEST_HOST, port, path: "/send" }, (res) => resolve(res.statusCode!));
      });

      expect(result).toBe(405);
    });

    it("rejects unauthenticated send when auth is configured", async () => {
      await startGateway({ auth: { type: "token", token: "secret" } });

      const result = await post(`${baseUrl}/send`, {
        sessionId: "test",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(result.status).toBe(401);
    });

    it("streams events with custom response text", async () => {
      app = createMockApp({
        executionOptions: {
          response: "Custom response!",
          streamDeltas: ["Custom ", "response!"],
        },
      });

      port = randomPort();
      baseUrl = `http://${TEST_HOST}:${port}`;
      gateway = createGateway({
        port,
        host: TEST_HOST,
        transport: "http",
        apps: { main: app },
        defaultApp: "main",
      });
      await gateway.start();

      const { events } = await postSSE(`${baseUrl}/send`, {
        sessionId: "test",
        messages: [{ role: "user", content: "Hello" }],
      });

      const deltas = events.filter((e) => e.event === "content_delta");
      expect(deltas.length).toBe(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Subscribe (/subscribe)
  // ══════════════════════════════════════════════════════════════════════════

  describe("/subscribe", () => {
    it("subscribes SSE client to a session and receives broadcast events", async () => {
      await startGateway();

      // 1. Establish SSE connection
      const sse = connectSSE(`${baseUrl}/events`, { clientId: "sub-client" });
      const connectionId = await sse.waitForConnection();
      expect(connectionId).toBe("sub-client");

      // 2. Subscribe to session
      const subResult = await post(`${baseUrl}/subscribe`, {
        connectionId: "sub-client",
        add: ["test-session"],
      });
      expect(subResult.status).toBe(200);

      // 3. Send a message to that session (from a different "client")
      //    The SSE subscriber should receive broadcast events
      const sendPromise = postSSE(`${baseUrl}/send`, {
        sessionId: "test-session",
        messages: [{ role: "user", content: "Hello" }],
        connectionId: "other-client", // exclude this from broadcast
      });

      // 4. Wait for events on the subscriber
      try {
        const event = await sse.waitForEvent("content_delta", 3000);
        expect(event).toBeDefined();
        expect(event.sessionId).toBe("test-session");
      } finally {
        sse.close();
        await sendPromise;
      }
    });

    it("returns 404 for unknown connectionId", async () => {
      await startGateway();

      const result = await post(`${baseUrl}/subscribe`, {
        connectionId: "nonexistent",
        add: ["test"],
      });

      expect(result.status).toBe(404);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Invoke (/invoke)
  // ══════════════════════════════════════════════════════════════════════════

  describe("/invoke", () => {
    it("invokes a registered method and returns JSON", async () => {
      await startGateway();

      // "status" is a built-in gateway method
      const result = await post(`${baseUrl}/invoke`, {
        method: "status",
        params: {},
      });

      expect(result.status).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.gateway).toBeDefined();
      expect(body.gateway.id).toBeDefined();
    });

    it("returns error for unknown method", async () => {
      await startGateway();

      const result = await post(`${baseUrl}/invoke`, {
        method: "nonexistent:method",
        params: {},
      });

      expect(result.status).toBe(400);
    });

    it("rejects requests without method", async () => {
      await startGateway();

      const result = await post(`${baseUrl}/invoke`, {
        params: {},
      });

      expect(result.status).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain("method is required");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Abort (/abort)
  // ══════════════════════════════════════════════════════════════════════════

  describe("/abort", () => {
    it("aborts a running session", async () => {
      // Use a delay so the session is still running when we abort
      app = createMockApp({
        executionOptions: {
          response: "Slow response",
          delay: 2000,
        },
      });

      port = randomPort();
      baseUrl = `http://${TEST_HOST}:${port}`;
      gateway = createGateway({
        port,
        host: TEST_HOST,
        transport: "http",
        apps: { main: app },
        defaultApp: "main",
      });
      await gateway.start();

      // Start a send that will take 2s
      const sendPromise = postSSE(`${baseUrl}/send`, {
        sessionId: "slow-session",
        messages: [{ role: "user", content: "Hello" }],
      });

      // Give the session time to start
      await new Promise((r) => setTimeout(r, 100));

      // Abort it
      const abortResult = await post(`${baseUrl}/abort`, {
        sessionId: "slow-session",
        reason: "User cancelled",
      });

      expect(abortResult.status).toBe(200);
      const body = JSON.parse(abortResult.body);
      expect(body.ok).toBe(true);

      // The send should complete (with error or truncated)
      await sendPromise;
    });

    it("returns error for missing sessionId", async () => {
      await startGateway();

      const result = await post(`${baseUrl}/abort`, {});

      expect(result.status).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain("Missing sessionId");
    });

    it("returns error for unknown session", async () => {
      await startGateway();

      const result = await post(`${baseUrl}/abort`, {
        sessionId: "nonexistent",
      });

      expect(result.status).toBe(500);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Tool Response (/tool-response)
  // ══════════════════════════════════════════════════════════════════════════

  describe("/tool-response", () => {
    it("rejects missing fields", async () => {
      await startGateway();

      const result = await post(`${baseUrl}/tool-response`, {
        sessionId: "test",
        // Missing toolUseId and result
      });

      expect(result.status).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain("Missing");
    });

    it("rejects non-POST", async () => {
      await startGateway();

      const result = await new Promise<number>((resolve) => {
        http.get({ hostname: TEST_HOST, port, path: "/tool-response" }, (res) =>
          resolve(res.statusCode!),
        );
      });

      expect(result).toBe(405);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CORS
  // ══════════════════════════════════════════════════════════════════════════

  describe("CORS", () => {
    it("handles OPTIONS preflight", async () => {
      await startGateway();

      const result = await new Promise<HTTPResponse>((resolve, reject) => {
        const req = http.request(
          {
            hostname: TEST_HOST,
            port,
            path: "/send",
            method: "OPTIONS",
          },
          (res) => {
            let body = "";
            res.on("data", (c) => {
              body += c;
            });
            res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
          },
        );
        req.on("error", reject);
        req.end();
      });

      expect(result.status).toBe(204);
      expect(result.headers["access-control-allow-origin"]).toBeDefined();
      expect(result.headers["access-control-allow-methods"]).toContain("POST");
    });

    it("sets CORS headers on responses", async () => {
      await startGateway();

      const result = await post(`${baseUrl}/invoke`, {
        method: "status",
        params: {},
      });

      expect(result.headers["access-control-allow-origin"]).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 404 handling
  // ══════════════════════════════════════════════════════════════════════════

  describe("404 handling", () => {
    it("returns 404 for unknown paths", async () => {
      await startGateway();

      const result = await new Promise<number>((resolve) => {
        http.get({ hostname: TEST_HOST, port, path: "/nonexistent" }, (res) =>
          resolve(res.statusCode!),
        );
      });

      expect(result).toBe(404);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // WebSocket upgrades on HTTP port
  // ══════════════════════════════════════════════════════════════════════════

  describe("WebSocket upgrade on HTTP port", () => {
    it("accepts WebSocket connections alongside HTTP", async () => {
      await startGateway();

      // HTTPTransport creates a WSS on the same port
      const { default: WebSocket } = await import("ws");
      const ws = new WebSocket(`ws://${TEST_HOST}:${port}`);

      const connected = await new Promise<boolean>((resolve) => {
        ws.on("open", () => resolve(true));
        ws.on("error", () => resolve(false));
      });

      expect(connected).toBe(true);

      // Authenticate
      ws.send(JSON.stringify({ type: "connect", clientId: "ws-test" }));
      await new Promise((r) => setTimeout(r, 100));

      ws.close();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Session consistency
  // ══════════════════════════════════════════════════════════════════════════

  describe("session consistency", () => {
    it("uses the same session for repeated sends with same sessionId", async () => {
      await startGateway();

      // First send
      const { events: events1 } = await postSSE(`${baseUrl}/send`, {
        sessionId: "persistent",
        messages: [{ role: "user", content: "First" }],
      });

      // Second send to same session
      const { events: events2 } = await postSSE(`${baseUrl}/send`, {
        sessionId: "persistent",
        messages: [{ role: "user", content: "Second" }],
      });

      // Both should succeed
      expect(events1.find((e) => e.event === "message_end")).toBeDefined();
      expect(events2.find((e) => e.event === "message_end")).toBeDefined();

      // Gateway should have only one session for this ID
      const statusResult = await post(`${baseUrl}/invoke`, {
        method: "status",
        params: {},
      });
      const status = JSON.parse(statusResult.body);
      // Count sessions with "persistent" in the ID
      const sessionCount =
        status.sessions?.filter((s: { id: string }) => s.id.includes("persistent"))?.length ?? 0;
      expect(sessionCount).toBeLessThanOrEqual(1);
    });

    it("creates separate sessions for different sessionIds", async () => {
      await startGateway();

      const [resultA, resultB] = await Promise.all([
        postSSE(`${baseUrl}/send`, {
          sessionId: "session-a",
          messages: [{ role: "user", content: "Hello A" }],
        }),
        postSSE(`${baseUrl}/send`, {
          sessionId: "session-b",
          messages: [{ role: "user", content: "Hello B" }],
        }),
      ]);

      // Both should complete independently
      expect(resultA.events.find((e) => e.event === "message_end")).toBeDefined();
      expect(resultB.events.find((e) => e.event === "message_end")).toBeDefined();

      // Both should report their respective sessionIds
      const aSessionIds = new Set(resultA.events.map((e) => e.sessionId).filter(Boolean));
      const bSessionIds = new Set(resultB.events.map((e) => e.sessionId).filter(Boolean));
      expect(aSessionIds.has("session-a")).toBe(true);
      expect(bSessionIds.has("session-b")).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Concurrent operations
  // ══════════════════════════════════════════════════════════════════════════

  describe("concurrent operations", () => {
    it("handles multiple SSE connections simultaneously", async () => {
      await startGateway();

      const sse1 = connectSSE(`${baseUrl}/events`, { clientId: "client-1" });
      const sse2 = connectSSE(`${baseUrl}/events`, { clientId: "client-2" });
      const sse3 = connectSSE(`${baseUrl}/events`, { clientId: "client-3" });

      try {
        const [id1, id2, id3] = await Promise.all([
          sse1.waitForConnection(),
          sse2.waitForConnection(),
          sse3.waitForConnection(),
        ]);

        expect(id1).toBe("client-1");
        expect(id2).toBe("client-2");
        expect(id3).toBe("client-3");
      } finally {
        sse1.close();
        sse2.close();
        sse3.close();
      }
    });

    it("handles concurrent sends to different sessions", async () => {
      await startGateway();

      const results = await Promise.all([
        postSSE(`${baseUrl}/send`, {
          sessionId: "concurrent-1",
          messages: [{ role: "user", content: "Hello 1" }],
        }),
        postSSE(`${baseUrl}/send`, {
          sessionId: "concurrent-2",
          messages: [{ role: "user", content: "Hello 2" }],
        }),
        postSSE(`${baseUrl}/send`, {
          sessionId: "concurrent-3",
          messages: [{ role: "user", content: "Hello 3" }],
        }),
      ]);

      for (const result of results) {
        expect(result.status).toBe(200);
        expect(result.events.find((e) => e.event === "message_end")).toBeDefined();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Internal event filtering
  // ══════════════════════════════════════════════════════════════════════════

  describe("internal event filtering", () => {
    it("does not leak internal events through /send stream", async () => {
      await startGateway();

      const { events } = await postSSE(`${baseUrl}/send`, {
        sessionId: "filter-test",
        messages: [{ role: "user", content: "Hello" }],
      });

      // Internal events should be filtered out
      const internalTypes = new Set([
        "compiled",
        "model_request",
        "model_response",
        "provider_request",
        "provider_response",
      ]);
      const leaked = events.filter((e) => internalTypes.has(e.event as string));
      expect(leaked).toHaveLength(0);
    });
  });
});
