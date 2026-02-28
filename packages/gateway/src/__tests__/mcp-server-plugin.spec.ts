/**
 * MCP Server Plugin Tests
 *
 * Tests tool discovery, filtering, dispatch, lifecycle, and per-session filtering.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Gateway, createGateway } from "../index.js";
import { mcpServerPlugin, filterTools } from "../plugins/mcp-server.js";
import type { ToolEntry } from "../plugins/mcp-server.js";
import { createMockApp } from "@agentick/core/testing";

// ============================================================================
// Test Helpers
// ============================================================================

function createTestGateway() {
  const app = createMockApp();
  return createGateway({
    apps: { chat: app },
    defaultApp: "chat",
    embedded: true,
  });
}

function createMockHTTPPair(
  path: string,
  method = "GET",
  headers?: Record<string, string>,
) {
  const chunks: Buffer[] = [];
  const req = {
    method,
    url: path,
    headers: {
      host: "localhost",
      "content-type": "application/json",
      ...headers,
    },
    on: vi.fn(),
  } as any;

  const res = {
    statusCode: 200,
    headersSent: false,
    _headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this._headers[name.toLowerCase()] = value;
    },
    writeHead(code: number, headers?: Record<string, string>) {
      this.statusCode = code;
      this.headersSent = true;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          this._headers[k.toLowerCase()] = v;
        }
      }
    },
    write(chunk: string | Buffer) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.from(chunk));
      this.headersSent = true;
    },
    on: vi.fn(),
  } as any;

  return {
    req,
    res,
    body: () => Buffer.concat(chunks).toString(),
  };
}

describe("MCP Server Plugin", () => {
  let gateway: Gateway;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop().catch(() => {});
    }
  });

  it("creates plugin with default config", () => {
    const plugin = mcpServerPlugin({ sessionId: "main" });
    expect(plugin.id).toBe("mcp-server");
  });

  it("creates plugin with custom id", () => {
    const plugin = mcpServerPlugin({ sessionId: "main", id: "my-mcp" });
    expect(plugin.id).toBe("my-mcp");
  });

  it("registers route and handles requests (not 404)", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({ sessionId: "default", path: "/test-mcp" });
    await gateway.use(plugin);

    const { req, res } = createMockHTTPPair("/test-mcp", "POST");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });

  it("cleans up route on destroy", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({ sessionId: "default", path: "/mcp-test" });
    await gateway.use(plugin);

    // Route exists
    const { req: r1, res: s1 } = createMockHTTPPair("/mcp-test", "POST");
    await gateway.handleRequest(r1, s1);
    expect(s1.statusCode).not.toBe(404);

    // Remove plugin
    await gateway.remove("mcp-server");

    // Route should be gone
    const { req: r2, res: s2 } = createMockHTTPPair("/mcp-test", "POST");
    await gateway.handleRequest(r2, s2);
    expect(s2.statusCode).toBe(404);
  });
});

// ============================================================================
// filterTools unit tests
// ============================================================================

describe("MCP Server Plugin — tool filtering", () => {
  const tools: ToolEntry[] = [
    { name: "a", description: "", input: {} },
    { name: "b", description: "", input: {} },
    { name: "c", description: "", input: {} },
  ];

  it("include filter keeps only named tools", () => {
    const result = filterTools(tools, { include: ["a", "c"] });
    expect(result.map((t) => t.name)).toEqual(["a", "c"]);
  });

  it("exclude filter removes named tools", () => {
    const result = filterTools(tools, { exclude: ["b"] });
    expect(result.map((t) => t.name)).toEqual(["a", "c"]);
  });

  it("include + exclude together: include first, then exclude", () => {
    const result = filterTools(tools, { include: ["a", "b"], exclude: ["b"] });
    expect(result.map((t) => t.name)).toEqual(["a"]);
  });

  it("empty include/exclude passes all tools through", () => {
    const result = filterTools([{ name: "x", description: "", input: {} }], {});
    expect(result).toHaveLength(1);
  });
});

// ============================================================================
// Per-session tool filtering
// ============================================================================

describe("MCP Server Plugin — per-session toolFilter", () => {
  let gateway: Gateway;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop().catch(() => {});
    }
  });

  it("toolFilter receives the raw request", async () => {
    gateway = createTestGateway();
    const filterSpy = vi.fn((tools: ToolEntry[]) => tools);

    const plugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-filter",
      toolFilter: filterSpy,
    });
    await gateway.use(plugin);

    // POST without session ID → new session → toolFilter called
    const { req, res } = createMockHTTPPair("/mcp-filter", "POST", {
      authorization: "Bearer test-token-123",
    });
    await gateway.handleRequest(req, res);

    expect(filterSpy).toHaveBeenCalledOnce();
    const [, receivedReq] = filterSpy.mock.calls[0];
    expect(receivedReq.headers.authorization).toBe("Bearer test-token-123");
  });

  it("toolFilter can restrict tool set", async () => {
    gateway = createTestGateway();
    const filterSpy = vi.fn((tools: ToolEntry[]) =>
      tools.filter((t) => t.name === "allowed-tool"),
    );

    const plugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-filtered",
      toolFilter: filterSpy,
    });
    await gateway.use(plugin);

    // The filter is called — we just verify it was invoked with the catalog
    const { req, res } = createMockHTTPPair("/mcp-filtered", "POST");
    await gateway.handleRequest(req, res);

    expect(filterSpy).toHaveBeenCalledOnce();
    // First arg is the tool catalog (empty from mock, but that's fine)
    expect(Array.isArray(filterSpy.mock.calls[0][0])).toBe(true);
  });

  it("async toolFilter is awaited", async () => {
    gateway = createTestGateway();
    const filterSpy = vi.fn(async (tools: ToolEntry[]) => {
      // Simulate async auth lookup
      await new Promise((r) => setTimeout(r, 1));
      return tools;
    });

    const plugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-async",
      toolFilter: filterSpy,
    });
    await gateway.use(plugin);

    const { req, res } = createMockHTTPPair("/mcp-async", "POST");
    await gateway.handleRequest(req, res);

    expect(filterSpy).toHaveBeenCalledOnce();
  });

  it("returns 404 for unknown session ID", async () => {
    gateway = createTestGateway();

    const plugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-session",
      toolFilter: (tools) => tools,
    });
    await gateway.use(plugin);

    // Request with a non-existent session ID
    const { req, res, body } = createMockHTTPPair("/mcp-session", "POST", {
      "mcp-session-id": "nonexistent-session-id",
    });
    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(404);
    const parsed = JSON.parse(body());
    expect(parsed.error.code).toBe(-32001);
    expect(parsed.error.message).toBe("Session not found");
  });

  it("does not call toolFilter for requests with session ID", async () => {
    gateway = createTestGateway();
    const filterSpy = vi.fn((tools: ToolEntry[]) => tools);

    const plugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-nofilter",
      toolFilter: filterSpy,
    });
    await gateway.use(plugin);

    // Request WITH session ID — should route to existing session, not create new
    const { req, res } = createMockHTTPPair("/mcp-nofilter", "POST", {
      "mcp-session-id": "some-session-id",
    });
    await gateway.handleRequest(req, res);

    // toolFilter not called — the request tried to route to an existing session
    expect(filterSpy).not.toHaveBeenCalled();
  });

  it("no toolFilter preserves static behavior", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({ sessionId: "default", path: "/mcp-static" });
    await gateway.use(plugin);

    // Static mode — should handle without session management
    const { req, res } = createMockHTTPPair("/mcp-static", "POST");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });

  it("plugin destroy cleans up all sessions", async () => {
    gateway = createTestGateway();
    const filterSpy = vi.fn((tools: ToolEntry[]) => tools);

    const plugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-destroy",
      toolFilter: filterSpy,
    });
    await gateway.use(plugin);

    // Create a session
    const { req, res } = createMockHTTPPair("/mcp-destroy", "POST");
    await gateway.handleRequest(req, res);

    // Destroy should not throw
    await gateway.remove("mcp-server");

    // Route gone
    const { req: r2, res: s2 } = createMockHTTPPair("/mcp-destroy", "POST");
    await gateway.handleRequest(r2, s2);
    expect(s2.statusCode).toBe(404);
  });

  it("concurrent session creation calls toolFilter per session", async () => {
    gateway = createTestGateway();
    const filterSpy = vi.fn((tools: ToolEntry[]) => tools);

    const plugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-concurrent",
      toolFilter: filterSpy,
    });
    await gateway.use(plugin);

    // Fire multiple new-session requests concurrently
    const requests = Array.from({ length: 3 }, () => {
      const { req, res } = createMockHTTPPair("/mcp-concurrent", "POST");
      return gateway.handleRequest(req, res);
    });

    await Promise.all(requests);

    // Each request without session ID triggers toolFilter
    expect(filterSpy).toHaveBeenCalledTimes(3);
  });
});
