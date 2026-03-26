/**
 * MCP Server Plugin Tests
 *
 * Tests tool discovery, filtering, dispatch, lifecycle, and per-session filtering.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Gateway, createGateway } from "../index.js";
import { mcpServerPlugin, filterTools } from "../plugins/mcp-server.js";
import type { ToolEntry, MCPStaticResource, MCPResourceTemplate } from "../plugins/mcp-server.js";
import { createMockApp } from "@agentick/core/testing";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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

function createMockHTTPPair(path: string, method = "GET", headers?: Record<string, string>) {
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
    const filterSpy = vi.fn((tools: ToolEntry[]) => tools.filter((t) => t.name === "allowed-tool"));

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

// ============================================================================
// Resources-only mode (no sessionId)
// ============================================================================

describe("MCP Server Plugin — resources-only mode", () => {
  let gateway: Gateway;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop().catch(() => {});
    }
  });

  it("initializes without sessionId", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({ path: "/mcp-resources-only" });
    // Should not throw — sessionId is optional
    await gateway.use(plugin);
    expect(plugin.id).toBe("mcp-server");
  });

  it("route is registered and responds (not 404)", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({ path: "/mcp-res-route" });
    await gateway.use(plugin);

    const { req, res } = createMockHTTPPair("/mcp-res-route", "POST");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });

  it("cleanup works after destroy", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({ id: "res-only", path: "/mcp-res-cleanup" });
    await gateway.use(plugin);

    // Route exists
    const { req: r1, res: s1 } = createMockHTTPPair("/mcp-res-cleanup", "POST");
    await gateway.handleRequest(r1, s1);
    expect(s1.statusCode).not.toBe(404);

    // Remove plugin
    await gateway.remove("res-only");

    // Route should be gone
    const { req: r2, res: s2 } = createMockHTTPPair("/mcp-res-cleanup", "POST");
    await gateway.handleRequest(r2, s2);
    expect(s2.statusCode).toBe(404);
  });
});

// ============================================================================
// Static resources
// ============================================================================

describe("MCP Server Plugin — static resources", () => {
  let gateway: Gateway;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop().catch(() => {});
    }
  });

  it("registers static resources on the McpServer", async () => {
    const registerResourceSpy = vi.spyOn(McpServer.prototype, "registerResource");

    const resources: MCPStaticResource[] = [
      {
        name: "schema-doc",
        uri: "docs://schema",
        title: "Schema Documentation",
        description: "The database schema",
        read: () => ({ text: "# Schema\nUsers table..." }),
      },
    ];

    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      path: "/mcp-static-res",
      resources,
    });
    await gateway.use(plugin);

    expect(registerResourceSpy).toHaveBeenCalled();
    const call = registerResourceSpy.mock.calls.find(
      (args) => args[0] === "schema-doc",
    );
    expect(call).toBeDefined();
    // Second arg is the URI string for static resources
    expect(call![1]).toBe("docs://schema");

    registerResourceSpy.mockRestore();
  });

  it("route responds when only resources are configured", async () => {
    const resources: MCPStaticResource[] = [
      {
        name: "readme",
        uri: "docs://readme",
        read: () => ({ text: "Hello" }),
      },
    ];

    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      path: "/mcp-res-only-route",
      resources,
    });
    await gateway.use(plugin);

    const { req, res } = createMockHTTPPair("/mcp-res-only-route", "POST");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });
});

// ============================================================================
// Resource templates
// ============================================================================

describe("MCP Server Plugin — resource templates", () => {
  let gateway: Gateway;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop().catch(() => {});
    }
  });

  it("registers template resources with list/read/complete callbacks", async () => {
    const registerResourceSpy = vi.spyOn(McpServer.prototype, "registerResource");

    const resourceTemplates: MCPResourceTemplate[] = [
      {
        name: "project",
        uriTemplate: "projects://{projectId}",
        title: "Project Details",
        description: "Fetch a project by ID",
        list: () => [
          { uri: "projects://1", title: "Project Alpha" },
          { uri: "projects://2", title: "Project Beta" },
        ],
        read: (variables) => ({ text: `Project ${variables.projectId}` }),
        complete: {
          projectId: (value) => ["1", "2", "3"].filter((id) => id.startsWith(value)),
        },
      },
    ];

    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      path: "/mcp-templates",
      resourceTemplates,
    });
    await gateway.use(plugin);

    expect(registerResourceSpy).toHaveBeenCalled();
    const call = registerResourceSpy.mock.calls.find(
      (args) => args[0] === "project",
    );
    expect(call).toBeDefined();
    // Second arg is a ResourceTemplate instance for template resources
    expect(call![1]).toBeInstanceOf(Object);
    expect(call![1]).not.toBeTypeOf("string");

    registerResourceSpy.mockRestore();
  });
});

// ============================================================================
// Tool annotations
// ============================================================================

describe("MCP Server Plugin — tool annotations", () => {
  let gateway: Gateway;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop().catch(() => {});
    }
  });

  it("annotations are passed through to registerTool", async () => {
    const registerToolSpy = vi.spyOn(McpServer.prototype, "registerTool");

    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-annotations",
    });
    await gateway.use(plugin);

    // The mock app exposes tools through tool-catalog. Since the mock
    // returns an empty catalog, we verify the spy was set up. For a more
    // targeted test, we use filterTools + createMcpServer indirectly by
    // checking that annotations in the tool entry reach registerTool.
    // We need to destroy and recreate with a toolFilter that injects annotations.
    await gateway.remove("mcp-server");
    registerToolSpy.mockClear();

    const annotatedPlugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-annotated",
      toolFilter: () => [
        {
          name: "read-data",
          description: "Read some data",
          input: { type: "object", properties: {} },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
          },
        },
      ],
    });
    await gateway.use(annotatedPlugin);

    // Trigger a new session to invoke toolFilter → createMcpServer
    const { req, res } = createMockHTTPPair("/mcp-annotated", "POST");
    await gateway.handleRequest(req, res);

    // Find the registerTool call for "read-data"
    const toolCall = registerToolSpy.mock.calls.find(
      (args) => args[0] === "read-data",
    );
    expect(toolCall).toBeDefined();
    // Second arg is the tool config object
    const toolConfig = toolCall![1] as Record<string, unknown>;
    expect(toolConfig.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });

    registerToolSpy.mockRestore();
  });

  it("tools without annotations do not include annotations key", async () => {
    const registerToolSpy = vi.spyOn(McpServer.prototype, "registerTool");

    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-no-annotations",
      toolFilter: () => [
        {
          name: "plain-tool",
          description: "No annotations",
          input: { type: "object", properties: {} },
        },
      ],
    });
    await gateway.use(plugin);

    const { req, res } = createMockHTTPPair("/mcp-no-annotations", "POST");
    await gateway.handleRequest(req, res);

    const toolCall = registerToolSpy.mock.calls.find(
      (args) => args[0] === "plain-tool",
    );
    expect(toolCall).toBeDefined();
    const toolConfig = toolCall![1] as Record<string, unknown>;
    expect(toolConfig.annotations).toBeUndefined();

    registerToolSpy.mockRestore();
  });
});

// ============================================================================
// Parsed body passthrough
// ============================================================================

describe("MCP Server Plugin — parsed body passthrough", () => {
  let gateway: Gateway;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop().catch(() => {});
    }
  });

  it("passes (req as any).body to transport.handleRequest as third argument", async () => {
    const handleRequestSpy = vi.spyOn(
      (await import("@modelcontextprotocol/sdk/server/streamableHttp.js")).StreamableHTTPServerTransport.prototype,
      "handleRequest",
    );

    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-body",
    });
    await gateway.use(plugin);

    const { req, res } = createMockHTTPPair("/mcp-body", "POST");
    const parsedBody = { jsonrpc: "2.0", method: "initialize", id: 1 };
    (req as any).body = parsedBody;

    await gateway.handleRequest(req, res);

    expect(handleRequestSpy).toHaveBeenCalled();
    // Third argument to handleRequest should be the parsed body
    const call = handleRequestSpy.mock.calls[0];
    expect(call[2]).toBe(parsedBody);

    handleRequestSpy.mockRestore();
  });

  it("passes undefined body when req.body is not set", async () => {
    const handleRequestSpy = vi.spyOn(
      (await import("@modelcontextprotocol/sdk/server/streamableHttp.js")).StreamableHTTPServerTransport.prototype,
      "handleRequest",
    );

    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-nobody",
    });
    await gateway.use(plugin);

    const { req, res } = createMockHTTPPair("/mcp-nobody", "POST");
    // Do not set req.body

    await gateway.handleRequest(req, res);

    expect(handleRequestSpy).toHaveBeenCalled();
    const call = handleRequestSpy.mock.calls[0];
    expect(call[2]).toBeUndefined();

    handleRequestSpy.mockRestore();
  });
});
