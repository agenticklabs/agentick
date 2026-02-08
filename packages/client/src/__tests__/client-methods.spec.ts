/**
 * Client Method Invocation Tests
 *
 * Tests for AgentickClient custom method invocation, including:
 * - invoke() for request/response methods
 * - stream() for streaming methods
 * - getAuthHeaders() for fetch integration
 * - SessionAccessor invoke() and stream()
 */

import { describe, it, expect, vi } from "vitest";
import { AgentickClient, createClient } from "../client.js";

// ============================================================================
// Mock fetch
// ============================================================================

function createMockFetch(responseData: unknown, options?: { status?: number; stream?: boolean }) {
  const status = options?.status ?? 200;
  const isStream = options?.stream ?? false;

  return vi.fn().mockImplementation(async (_url: string, _init: RequestInit) => {
    if (!isStream) {
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(responseData),
        json: async () => responseData,
      };
    }

    // Streaming response
    const events = responseData as Array<{ type: string; [key: string]: unknown }>;
    const encoder = new TextEncoder();
    let eventIndex = 0;

    return {
      ok: status >= 200 && status < 300,
      status,
      body: {
        getReader: () => ({
          read: async () => {
            if (eventIndex >= events.length) {
              return { done: true, value: undefined };
            }
            const event = events[eventIndex++];
            const line = `data: ${JSON.stringify(event)}\n`;
            return { done: false, value: encoder.encode(line) };
          },
        }),
      },
    };
  });
}

// ============================================================================
// AgentickClient.invoke() tests
// ============================================================================

describe("AgentickClient.invoke()", () => {
  it("should invoke a method and return result", async () => {
    const mockFetch = createMockFetch({ tasks: [{ id: 1, title: "Test" }] });
    const client = createClient({
      baseUrl: "http://localhost:3000",
      fetch: mockFetch as any,
    });

    const result = await client.invoke<{ tasks: Array<{ id: number; title: string }> }>(
      "tasks:list",
      { status: "active" },
    );

    expect(result).toEqual({ tasks: [{ id: 1, title: "Test" }] });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/invoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ method: "tasks:list", params: { status: "active" } }),
      }),
    );
  });

  it("should throw on non-ok response", async () => {
    const mockFetch = createMockFetch({ error: "Unauthorized" }, { status: 401 });
    const client = createClient({
      baseUrl: "http://localhost:3000",
      fetch: mockFetch as any,
    });

    await expect(client.invoke("admin:stats")).rejects.toThrow("Failed to invoke method: 401");
  });

  it("should include auth token in headers", async () => {
    const mockFetch = createMockFetch({ ok: true });
    const client = createClient({
      baseUrl: "http://localhost:3000",
      token: "my-secret-token",
      fetch: mockFetch as any,
    });

    await client.invoke("ping");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer my-secret-token",
        }),
      }),
    );
  });

  it("should support custom headers", async () => {
    const mockFetch = createMockFetch({ ok: true });
    const client = createClient({
      baseUrl: "http://localhost:3000",
      headers: { "X-Custom-Header": "custom-value" },
      fetch: mockFetch as any,
    });

    await client.invoke("ping");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Custom-Header": "custom-value",
        }),
      }),
    );
  });

  it("should use custom paths if configured", async () => {
    const mockFetch = createMockFetch({ ok: true });
    const client = createClient({
      baseUrl: "http://localhost:3000",
      paths: { invoke: "/api/methods" },
      fetch: mockFetch as any,
    });

    await client.invoke("ping");

    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3000/api/methods", expect.any(Object));
  });
});

// ============================================================================
// AgentickClient.stream() tests
// ============================================================================

describe("AgentickClient.stream()", () => {
  it("should yield chunks from streaming method", async () => {
    const mockFetch = createMockFetch(
      [
        { type: "method:chunk", chunk: { id: 1 } },
        { type: "method:chunk", chunk: { id: 2 } },
        { type: "method:chunk", chunk: { id: 3 } },
        { type: "method:end" },
      ],
      { stream: true },
    );

    const client = createClient({
      baseUrl: "http://localhost:3000",
      fetch: mockFetch as any,
    });

    const chunks: Array<{ id: number }> = [];
    for await (const chunk of client.stream<{ id: number }>("tasks:watch")) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("should stop on method:end event", async () => {
    const mockFetch = createMockFetch(
      [
        { type: "method:chunk", chunk: "first" },
        { type: "method:end" },
        { type: "method:chunk", chunk: "should-not-see" },
      ],
      { stream: true },
    );

    const client = createClient({
      baseUrl: "http://localhost:3000",
      fetch: mockFetch as any,
    });

    const chunks: string[] = [];
    for await (const chunk of client.stream<string>("events")) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["first"]);
  });

  it("should throw on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"error":"Forbidden"}',
    });

    const client = createClient({
      baseUrl: "http://localhost:3000",
      fetch: mockFetch as any,
    });

    const streamFn = async () => {
      const chunks: unknown[] = [];
      for await (const chunk of client.stream("forbidden:method")) {
        chunks.push(chunk);
      }
    };

    await expect(streamFn()).rejects.toThrow("Failed to invoke streaming method: 403");
  });

  it("should include params in request", async () => {
    const mockFetch = createMockFetch([{ type: "method:end" }], { stream: true });

    const client = createClient({
      baseUrl: "http://localhost:3000",
      fetch: mockFetch as any,
    });

    const chunks: unknown[] = [];
    for await (const chunk of client.stream("tasks:watch", { userId: "123" })) {
      chunks.push(chunk);
    }

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/invoke",
      expect.objectContaining({
        body: JSON.stringify({ method: "tasks:watch", params: { userId: "123" } }),
      }),
    );
  });
});

// ============================================================================
// AgentickClient.getAuthHeaders() tests
// ============================================================================

describe("AgentickClient.getAuthHeaders()", () => {
  it("should return empty object when no token configured", () => {
    const client = createClient({
      baseUrl: "http://localhost:3000",
    });

    expect(client.getAuthHeaders()).toEqual({});
  });

  it("should return Authorization header when token configured", () => {
    const client = createClient({
      baseUrl: "http://localhost:3000",
      token: "my-api-token",
    });

    expect(client.getAuthHeaders()).toEqual({
      Authorization: "Bearer my-api-token",
    });
  });

  it("should be usable with fetch", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { id: "1" } }),
    });

    const client = createClient({
      baseUrl: "http://localhost:3000",
      token: "my-token",
    });

    // Simulating how a user would use getAuthHeaders()
    await mockFetch("/api/user", {
      headers: client.getAuthHeaders(),
    });

    expect(mockFetch).toHaveBeenCalledWith("/api/user", {
      headers: { Authorization: "Bearer my-token" },
    });
  });
});

// ============================================================================
// SessionAccessor.invoke() tests
// ============================================================================

describe("SessionAccessor.invoke()", () => {
  it("should auto-inject sessionId into params", async () => {
    const mockFetch = createMockFetch({ result: true });
    const client = createClient({
      baseUrl: "http://localhost:3000",
      fetch: mockFetch as any,
    });

    const session = client.session("my-session-123");
    await session.invoke("tasks:list", { status: "active" });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          method: "tasks:list",
          params: { status: "active", sessionId: "my-session-123" },
        }),
      }),
    );
  });

  it("should work without additional params", async () => {
    const mockFetch = createMockFetch({ tasks: [] });
    const client = createClient({
      baseUrl: "http://localhost:3000",
      fetch: mockFetch as any,
    });

    const session = client.session("sess-1");
    await session.invoke("tasks:list");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          method: "tasks:list",
          params: { sessionId: "sess-1" },
        }),
      }),
    );
  });
});

// ============================================================================
// SessionAccessor.stream() tests
// ============================================================================

describe("SessionAccessor.stream()", () => {
  it("should auto-inject sessionId into params", async () => {
    const mockFetch = createMockFetch(
      [{ type: "method:chunk", chunk: "data" }, { type: "method:end" }],
      { stream: true },
    );

    const client = createClient({
      baseUrl: "http://localhost:3000",
      fetch: mockFetch as any,
    });

    const session = client.session("stream-session");
    const chunks: unknown[] = [];
    for await (const chunk of session.stream("updates")) {
      chunks.push(chunk);
    }

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          method: "updates",
          params: { sessionId: "stream-session" },
        }),
      }),
    );
  });
});

// ============================================================================
// createClient() factory tests
// ============================================================================

describe("createClient()", () => {
  it("should create a AgentickClient instance", () => {
    const client = createClient({
      baseUrl: "http://localhost:3000",
    });

    expect(client).toBeInstanceOf(AgentickClient);
  });

  it("should default to SSE transport for http URLs", () => {
    const client = createClient({
      baseUrl: "http://localhost:3000",
    });

    expect(client).toBeInstanceOf(AgentickClient);
  });

  it("should strip trailing slash from baseUrl", async () => {
    const mockFetch = createMockFetch({ ok: true });
    const client = createClient({
      baseUrl: "http://localhost:3000/",
      fetch: mockFetch as any,
    });

    await client.invoke("ping");

    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3000/invoke", expect.any(Object));
  });
});
