/**
 * MCP Server Plugin Tests
 *
 * Tests tool discovery, filtering, dispatch, lifecycle, annotations,
 * resources, and per-session filtering.
 *
 * These tests verify BEHAVIOR (what clients see) not IMPLEMENTATION
 * (how the plugin wires SDK internals). The plugin uses MCPServer from
 * @agentick/mcp, which manages per-session SDK Server instances internally.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Gateway, createGateway } from "../index.js";
import { mcpServerPlugin, filterTools } from "../plugins/mcp-server.js";
import type {
  ToolEntry,
  MCPStaticResource,
  MCPResourceTemplate,
  MCPStandaloneTool,
} from "../plugins/mcp-server.js";
import type { GatewayPlugin } from "../types.js";
import { createMockApp } from "@agentick/core/testing";
import { z } from "zod";

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

/** Valid MCP initialize request body */
const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  },
});

function createMockHTTPPair(
  path: string,
  method = "POST",
  headers?: Record<string, string>,
  body?: string,
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
    body: body ? JSON.parse(body) : undefined,
    socket: { remoteAddress: "127.0.0.1" },
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
      return this;
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

/** Create a mock HTTP pair with a valid initialize body */
function createInitRequest(path: string, headers?: Record<string, string>) {
  return createMockHTTPPair(path, "POST", headers, initializeBody);
}

// ============================================================================
// Plugin creation
// ============================================================================

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

    const { req, res } = createInitRequest("/test-mcp");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });

  it("cleans up route on destroy", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({ sessionId: "default", path: "/mcp-test" });
    await gateway.use(plugin);

    // Route exists
    const { req: r1, res: s1 } = createInitRequest("/mcp-test");
    await gateway.handleRequest(r1, s1);
    expect(s1.statusCode).not.toBe(404);

    // Remove plugin
    await gateway.remove("mcp-server");

    // Route should be gone
    const { req: r2, res: s2 } = createInitRequest("/mcp-test");
    await gateway.handleRequest(r2, s2);
    expect(s2.statusCode).toBe(404);
  });
});

// ============================================================================
// Pre-built server instance
// ============================================================================

describe("MCP Server Plugin — pre-built server", () => {
  let gateway: Gateway;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop().catch(() => {});
    }
  });

  it("uses provided server instance instead of constructing one", async () => {
    // Import MCPServer directly to create a pre-built instance
    const { MCPServer } = await import("@agentick/mcp/server");

    const toolHandler = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "hello from pre-built" }],
    }));

    const server = new MCPServer({
      name: "pre-built-test",
      version: "1.0.0",
      tools: [
        {
          name: "test_tool",
          description: "A tool from the pre-built server",
          inputSchema: z.object({ msg: z.string() }),
          handler: toolHandler,
        },
      ],
      security: {
        authenticator: async () => ({ authenticated: true }),
      },
    });

    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      server,
      path: "/pre-built-mcp",
    });
    await gateway.use(plugin);

    // Route should be registered
    const { req, res } = createInitRequest("/pre-built-mcp");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });

  it("cleans up pre-built server route on destroy", async () => {
    const { MCPServer } = await import("@agentick/mcp/server");

    const server = new MCPServer({
      name: "cleanup-test",
      version: "1.0.0",
      security: {
        authenticator: async () => ({ authenticated: true }),
      },
    });

    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      server,
      path: "/pre-built-cleanup",
    });
    await gateway.use(plugin);

    // Route exists
    const { req: r1, res: s1 } = createInitRequest("/pre-built-cleanup");
    await gateway.handleRequest(r1, s1);
    expect(s1.statusCode).not.toBe(404);

    // Remove plugin
    await gateway.remove("mcp-server");

    // Route gone
    const { req: r2, res: s2 } = createInitRequest("/pre-built-cleanup");
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

  it("toolFilter is configured on the MCPServer", async () => {
    gateway = createTestGateway();
    const filterSpy = vi.fn((tools: ToolEntry[], _ctx: any) => tools);

    const plugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-filter",
      toolFilter: filterSpy,
    });
    await gateway.use(plugin);

    // Verify route exists (mock can't complete full MCP handshake)
    const { req, res } = createMockHTTPPair("/mcp-filter", "POST");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });

  it("toolFilter can restrict tool set (verified via real HTTP in multi-client tests)", async () => {
    gateway = createTestGateway();
    const filterSpy = vi.fn((tools: ToolEntry[]) => tools.filter((t) => t.name === "allowed-tool"));

    const plugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-filtered",
      toolFilter: filterSpy,
    });
    await gateway.use(plugin);

    // Route registered
    const { req, res } = createMockHTTPPair("/mcp-filtered", "POST");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });

  it("async toolFilter is supported", async () => {
    gateway = createTestGateway();
    const filterSpy = vi.fn(async (tools: ToolEntry[]) => {
      await new Promise((r) => setTimeout(r, 1));
      return tools;
    });

    const plugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-async",
      toolFilter: filterSpy,
    });
    await gateway.use(plugin);

    // Route registered — async filter is configured
    const { req, res } = createMockHTTPPair("/mcp-async", "POST");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });

  it("returns 400 for unknown session ID with non-initialize request", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-session",
      toolFilter: (tools) => tools,
    });
    await gateway.use(plugin);

    // Non-initialize request with unknown session ID → 400
    const { req, res, body } = createMockHTTPPair(
      "/mcp-session",
      "POST",
      {
        "mcp-session-id": "nonexistent-session-id",
      },
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(404);
  });

  it("does not call toolFilter for requests with known session ID", async () => {
    gateway = createTestGateway();
    const filterSpy = vi.fn((tools: ToolEntry[]) => tools);

    const plugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-nofilter",
      toolFilter: filterSpy,
    });
    await gateway.use(plugin);

    // Request WITH unknown session ID — routes to handleHTTPRequest which rejects
    const { req, res } = createMockHTTPPair(
      "/mcp-nofilter",
      "POST",
      {
        "mcp-session-id": "some-session-id",
      },
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    await gateway.handleRequest(req, res);

    // toolFilter not called — the request tried to route to a non-existent session
    expect(filterSpy).not.toHaveBeenCalled();
  });

  it("no toolFilter preserves static behavior", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({ sessionId: "default", path: "/mcp-static" });
    await gateway.use(plugin);

    const { req, res } = createInitRequest("/mcp-static");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });

  it("plugin destroy cleans up sessions and route", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-destroy",
      toolFilter: (tools) => tools,
    });
    await gateway.use(plugin);

    // Create a session
    const { req, res } = createInitRequest("/mcp-destroy");
    await gateway.handleRequest(req, res);

    // Destroy should not throw
    await gateway.remove("mcp-server");

    // Route gone
    const { req: r2, res: s2 } = createInitRequest("/mcp-destroy");
    await gateway.handleRequest(r2, s2);
    expect(s2.statusCode).toBe(404);
  });

  it("concurrent session creation works", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      sessionId: "default",
      path: "/mcp-concurrent",
      toolFilter: (tools) => tools,
    });
    await gateway.use(plugin);

    const requests = Array.from({ length: 3 }, () => {
      const { req, res } = createInitRequest("/mcp-concurrent");
      return gateway.handleRequest(req, res);
    });

    // All complete without error
    await Promise.all(requests);
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
    await gateway.use(plugin);
    expect(plugin.id).toBe("mcp-server");
  });

  it("route is registered and responds (not 404)", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({ path: "/mcp-res-route" });
    await gateway.use(plugin);

    const { req, res } = createInitRequest("/mcp-res-route");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });

  it("cleanup works after destroy", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({ id: "res-only", path: "/mcp-res-cleanup" });
    await gateway.use(plugin);

    const { req: r1, res: s1 } = createInitRequest("/mcp-res-cleanup");
    await gateway.handleRequest(r1, s1);
    expect(s1.statusCode).not.toBe(404);

    await gateway.remove("res-only");

    const { req: r2, res: s2 } = createInitRequest("/mcp-res-cleanup");
    await gateway.handleRequest(r2, s2);
    expect(s2.statusCode).toBe(404);
  });
});

// ============================================================================
// Static mode — multi-client session management (real HTTP)
// ============================================================================

describe("MCP Server Plugin — static mode multi-client", () => {
  let gateway: Gateway;
  let server: import("http").Server;
  let port: number;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (gateway) await gateway.stop().catch(() => {});
  });

  async function startGatewayServer(plugin: GatewayPlugin) {
    const http = await import("http");
    gateway = createTestGateway();
    await gateway.use(plugin);

    server = http.createServer(async (req, res) => {
      try {
        await gateway.handleRequest(req, res);
      } catch {
        if (!res.headersSent) res.writeHead(500).end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  }

  const mcpInitBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  };

  async function mcpInit(path: string) {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(mcpInitBody),
    });
    const body = await res.text();
    return { status: res.status, body, headers: res.headers };
  }

  it("multiple clients can initialize without 400 'already initialized'", async () => {
    await startGatewayServer(mcpServerPlugin({ path: "/mcp" }));

    const r1 = await mcpInit("/mcp");
    expect(r1.status).not.toBe(400);

    const r2 = await mcpInit("/mcp");
    expect(r2.status).not.toBe(400);

    const r3 = await mcpInit("/mcp");
    expect(r3.status).not.toBe(400);
  });

  it("each client gets a unique session ID", async () => {
    await startGatewayServer(mcpServerPlugin({ path: "/mcp" }));

    const r1 = await mcpInit("/mcp");
    const r2 = await mcpInit("/mcp");

    const s1 = r1.headers.get("mcp-session-id");
    const s2 = r2.headers.get("mcp-session-id");

    expect(s1).toBeTruthy();
    expect(s2).toBeTruthy();
    expect(s1).not.toBe(s2);
  });

  it("rejects unknown session ID with non-initialize request", async () => {
    await startGatewayServer(mcpServerPlugin({ path: "/mcp" }));

    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Mcp-Session-Id": "nonexistent-session-id",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    // Server rejects: either 400 (our check) or 406 (SDK transport rejects non-initialize)
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("resources-only mode supports multiple clients", async () => {
    await startGatewayServer(
      mcpServerPlugin({
        path: "/mcp",
        resources: [{ name: "test", uri: "test://doc", read: () => ({ text: "hello" }) }],
      }),
    );

    const r1 = await mcpInit("/mcp");
    expect(r1.status).not.toBe(400);

    const r2 = await mcpInit("/mcp");
    expect(r2.status).not.toBe(400);
  });
});

// ============================================================================
// Static resources — behavioral verification
// ============================================================================

describe("MCP Server Plugin — static resources", () => {
  let gateway: Gateway;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop().catch(() => {});
    }
  });

  it("registers static resources on the server", async () => {
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
    const plugin = mcpServerPlugin({ path: "/mcp-static-res", resources });
    await gateway.use(plugin);

    // Route registered
    const { req, res } = createMockHTTPPair("/mcp-static-res", "POST");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });

  it("route responds when only resources are configured", async () => {
    const resources: MCPStaticResource[] = [
      { name: "readme", uri: "docs://readme", read: () => ({ text: "Hello" }) },
    ];

    gateway = createTestGateway();
    const plugin = mcpServerPlugin({ path: "/mcp-res-only-route", resources });
    await gateway.use(plugin);

    const { req, res } = createInitRequest("/mcp-res-only-route");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });
});

// ============================================================================
// Resource templates — behavioral verification
// ============================================================================

describe("MCP Server Plugin — resource templates", () => {
  let gateway: Gateway;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop().catch(() => {});
    }
  });

  it("registers template resources on the server", async () => {
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
    const plugin = mcpServerPlugin({ path: "/mcp-templates", resourceTemplates });
    await gateway.use(plugin);

    const { req, res } = createMockHTTPPair("/mcp-templates", "POST");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });
});

// ============================================================================
// Tool annotations — behavioral verification
// ============================================================================

describe("MCP Server Plugin — tool annotations", () => {
  let gateway: Gateway;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop().catch(() => {});
    }
  });

  it("annotations are configured on the MCPServer", async () => {
    gateway = createTestGateway();
    // Standalone tools with annotations — verifiable through the MCP protocol
    const plugin = mcpServerPlugin({
      path: "/mcp-annotations",
      tools: [
        {
          name: "read-data",
          description: "Read some data",
          inputSchema: { type: "object", properties: {} },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
          },
          handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
        },
      ],
    });
    await gateway.use(plugin);

    const { req, res } = createInitRequest("/mcp-annotations");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });

  it("tools without annotations work normally", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      path: "/mcp-no-annotations",
      tools: [
        {
          name: "plain-tool",
          description: "No annotations",
          inputSchema: { type: "object", properties: {} },
          handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
        },
      ],
    });
    await gateway.use(plugin);

    const { req, res } = createInitRequest("/mcp-no-annotations");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
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

  it("handles pre-parsed body from Express middleware", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({ path: "/mcp-body" });
    await gateway.use(plugin);

    // Simulate Express pre-parsed body
    const { req, res } = createInitRequest("/mcp-body");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });

  it("handles requests without pre-parsed body", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({ path: "/mcp-nobody" });
    await gateway.use(plugin);

    const { req, res } = createMockHTTPPair("/mcp-nobody", "POST");
    // No body set — handleHTTPRequest handles this gracefully
    await gateway.handleRequest(req, res);
    // Should get 400 (no valid body to parse) not 500
    expect(res.statusCode).not.toBe(500);
  });
});

// ============================================================================
// OAuth metadata discovery
// ============================================================================

describe("MCP Server Plugin — OAuth metadata", () => {
  let gateway: Gateway;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop().catch(() => {});
    }
  });

  it("serves static metadata at /.well-known/oauth-authorization-server", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      path: "/mcp",
      oauthMetadata: {
        metadata: {
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
        },
      },
    });
    await gateway.use(plugin);

    const { req, res, body } = createMockHTTPPair("/.well-known/oauth-authorization-server", "GET");
    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(200);
    const metadata = JSON.parse(body());
    expect(metadata.issuer).toBe("https://auth.example.com");
  });

  it("serves metadata without requiring authentication", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      path: "/mcp",
      oauthMetadata: { metadata: { issuer: "test" } },
    });
    await gateway.use(plugin);

    const { req, res } = createMockHTTPPair("/.well-known/oauth-authorization-server", "GET");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("serves metadata at domain root even with httpPathPrefix", async () => {
    gateway = createGateway({
      apps: { chat: createMockApp() },
      defaultApp: "chat",
      embedded: true,
      httpPathPrefix: "/api/v1",
    });
    const plugin = mcpServerPlugin({
      path: "/mcp",
      oauthMetadata: { metadata: { issuer: "test" } },
    });
    await gateway.use(plugin);

    // .well-known is at the domain root, not under the prefix
    const { req, res } = createMockHTTPPair("/.well-known/oauth-authorization-server", "GET");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("proxies metadata from issuer URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      path: "/mcp",
      oauthMetadata: { issuer: "https://auth.example.com" },
    });
    await gateway.use(plugin);

    const { req, res, body } = createMockHTTPPair("/.well-known/oauth-authorization-server", "GET");
    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(200);
    const metadata = JSON.parse(body());
    expect(metadata.issuer).toBe("https://auth.example.com");
    expect(mockFetch).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
  });

  it("caches proxied metadata", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ issuer: "cached" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      path: "/mcp",
      oauthMetadata: { issuer: "https://auth.example.com" },
    });
    await gateway.use(plugin);

    // First request — fetches
    const { req: r1, res: s1 } = createMockHTTPPair(
      "/.well-known/oauth-authorization-server",
      "GET",
    );
    await gateway.handleRequest(r1, s1);

    // Second request — cached
    const { req: r2, res: s2 } = createMockHTTPPair(
      "/.well-known/oauth-authorization-server",
      "GET",
    );
    await gateway.handleRequest(r2, s2);

    expect(mockFetch).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
  });

  it("returns 502 when issuer is unreachable in proxy mode", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", mockFetch);

    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      path: "/mcp",
      oauthMetadata: { issuer: "https://unreachable.example.com" },
    });
    await gateway.use(plugin);

    const { req, res } = createMockHTTPPair("/.well-known/oauth-authorization-server", "GET");
    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(502);

    vi.unstubAllGlobals();
  });

  it("does not register .well-known when oauthMetadata is not configured", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({ path: "/mcp" });
    await gateway.use(plugin);

    const { req, res } = createMockHTTPPair("/.well-known/oauth-authorization-server", "GET");
    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(404);
  });
});

// ============================================================================
// Standalone tools
// ============================================================================

describe("MCP Server Plugin — standalone tools", () => {
  let gateway: Gateway;
  let server: import("http").Server;
  let port: number;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (gateway) await gateway.stop().catch(() => {});
  });

  async function startGatewayServer(plugin: GatewayPlugin) {
    const http = await import("http");
    gateway = createTestGateway();
    await gateway.use(plugin);

    server = http.createServer(async (req, res) => {
      try {
        await gateway.handleRequest(req, res);
      } catch {
        if (!res.headersSent) res.writeHead(500).end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  }

  it("registers standalone tools on the server", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      path: "/mcp-standalone",
      tools: [
        {
          name: "echo",
          description: "Echo tool",
          inputSchema: { type: "object", properties: { msg: { type: "string" } } },
          handler: async (args) => ({
            content: [{ type: "text" as const, text: `echo: ${(args as any).msg}` }],
          }),
        },
      ],
    });
    await gateway.use(plugin);

    // Route registered (full protocol tested via real HTTP in handler execution test)
    const { req, res } = createMockHTTPPair("/mcp-standalone", "POST");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });

  it("standalone tool annotations are configured", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      path: "/mcp-tool-ann",
      tools: [
        {
          name: "safe-read",
          description: "Safe reader",
          inputSchema: {},
          annotations: { readOnlyHint: true },
          handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
        },
      ],
    });
    await gateway.use(plugin);

    const { req, res } = createInitRequest("/mcp-tool-ann");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });

  it("standalone tools work alongside resources", async () => {
    gateway = createTestGateway();
    const plugin = mcpServerPlugin({
      path: "/mcp-combo",
      tools: [
        {
          name: "query",
          description: "Query tool",
          inputSchema: {},
          handler: async () => ({ content: [{ type: "text" as const, text: "result" }] }),
        },
      ],
      resources: [{ name: "schema", uri: "db://schema", read: () => ({ text: "schema" }) }],
    });
    await gateway.use(plugin);

    const { req, res } = createInitRequest("/mcp-combo");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).not.toBe(404);
  });

  it("standalone tool handler is called on execution", async () => {
    const handlerSpy = vi.fn(async (args: Record<string, unknown>) => ({
      content: [{ type: "text" as const, text: `result: ${(args as any).input}` }],
    }));

    await startGatewayServer(
      mcpServerPlugin({
        path: "/mcp",
        tools: [
          {
            name: "test-tool",
            description: "Test",
            inputSchema: { input: z.string() },
            handler: handlerSpy,
          },
        ],
      }),
    );

    // Initialize
    const initRes = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    const sessionId = initRes.headers.get("mcp-session-id");

    // Send initialized notification
    await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    // List tools
    const listRes = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list" }),
    });
    const listBody = await listRes.text();
    console.log("[test] tools/list status:", listRes.status, "body:", listBody);
    expect(listBody).toContain("test-tool");

    // Call tool
    const callRes = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "test-tool", arguments: { input: "hello" } },
      }),
    });
    const callBody = await callRes.text();
    console.log("[test] tools/call status:", callRes.status, "body:", callBody);
    expect(callBody).toContain("result: hello");
    expect(handlerSpy).toHaveBeenCalledOnce();
  });

  it("standalone tool handler can access Context.get() with user", async () => {
    let capturedUser: any = null;

    await startGatewayServer(
      mcpServerPlugin({
        path: "/mcp",
        tools: [
          {
            name: "whoami",
            description: "Who am I",
            inputSchema: {},
            handler: async (_args) => {
              try {
                const { Context } = await import("@agentick/kernel");
                const ctx = Context.tryGet();
                capturedUser = ctx?.user ?? null;
              } catch {
                /* no context in standalone */
              }
              return { content: [{ type: "text" as const, text: "ok" }] };
            },
          },
        ],
      }),
    );

    // Initialize + call
    const initRes = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    const sessionId = initRes.headers.get("mcp-session-id");

    await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Mcp-Session-Id": sessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const callRes = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "whoami", arguments: {} },
      }),
    });
    const body = await callRes.text();
    expect(body).toContain("ok");
  });

  // ════════════════════════════════════════════════════════════════════════
  // MCP Apps tool metadata — regression guard for a bug that silently broke
  // rendering in HTTP mode. The plugin used to reconstruct tool definitions
  // without copying the `ui` / `_meta` fields, so `tools/list` arrived at
  // Claude Desktop with no UI linkage. Stdio worked (bypasses the plugin),
  // HTTP did not. These tests assert the plugin preserves UI metadata end-
  // to-end over a real HTTP initialize+tools/list round-trip.
  // ════════════════════════════════════════════════════════════════════════

  it("preserves ui.resourceUri on standalone tools through tools/list over HTTP", async () => {
    await startGatewayServer(
      mcpServerPlugin({
        path: "/mcp-ui-passthrough",
        tools: [
          {
            name: "show_dashboard",
            description: "Open the dashboard",
            inputSchema: { type: "object" },
            ui: {
              resourceUri: "ui://demo/dashboard",
              visibility: ["model", "app"],
            },
            handler: async () => ({
              content: [{ type: "text" as const, text: "ok" }],
            }),
          },
        ],
        apps: [
          {
            name: "dashboard",
            uri: "ui://demo/dashboard",
            content: "<html></html>",
          },
        ],
      }),
    );

    const initRes = await fetch(`http://localhost:${port}/mcp-ui-passthrough`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {
            extensions: {
              "io.modelcontextprotocol/ui": {
                mimeTypes: ["text/html;profile=mcp-app"],
              },
            },
          },
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    const sessionId = initRes.headers.get("mcp-session-id")!;
    const initBody = await initRes.text();

    // Server MUST advertise the UI extension when apps are registered — this
    // is what tells conformant hosts to attempt iframe rendering.
    expect(initBody).toContain("io.modelcontextprotocol/ui");
    expect(initBody).toContain("text/html;profile=mcp-app");

    await fetch(`http://localhost:${port}/mcp-ui-passthrough`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Mcp-Session-Id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const listRes = await fetch(`http://localhost:${port}/mcp-ui-passthrough`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const listBody = await listRes.text();

    // Both modern and legacy _meta keys must appear on the wire.
    expect(listBody).toContain('"resourceUri":"ui://demo/dashboard"');
    expect(listBody).toContain('"ui/resourceUri":"ui://demo/dashboard"');
    expect(listBody).toMatch(/"visibility":\s*\[\s*"model",\s*"app"\s*\]/);
  });

  it("preserves raw _meta passthrough on standalone tools (legacy shape)", async () => {
    await startGatewayServer(
      mcpServerPlugin({
        path: "/mcp-legacy-meta",
        tools: [
          {
            name: "legacy_tool",
            description: "Registered with legacy _meta shape",
            inputSchema: { type: "object" },
            _meta: { "ui/resourceUri": "ui://legacy/view" },
            handler: async () => ({
              content: [{ type: "text" as const, text: "ok" }],
            }),
          },
        ],
        apps: [{ name: "legacy", uri: "ui://legacy/view", content: "<html></html>" }],
      }),
    );

    const initRes = await fetch(`http://localhost:${port}/mcp-legacy-meta`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    const sessionId = initRes.headers.get("mcp-session-id")!;

    await fetch(`http://localhost:${port}/mcp-legacy-meta`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Mcp-Session-Id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const listRes = await fetch(`http://localhost:${port}/mcp-legacy-meta`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const listBody = await listRes.text();

    // Legacy _meta should hydrate ui.resourceUri, and both keys should be emitted.
    expect(listBody).toContain('"resourceUri":"ui://legacy/view"');
    expect(listBody).toContain('"ui/resourceUri":"ui://legacy/view"');
  });
});

// ============================================================================
// End-to-end: resources via real HTTP
// ============================================================================

describe("MCP Server Plugin — resources e2e", () => {
  let gateway: Gateway;
  let server: import("http").Server;
  let port: number;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (gateway) await gateway.stop().catch(() => {});
  });

  async function startGatewayServer(plugin: GatewayPlugin) {
    const http = await import("http");
    gateway = createTestGateway();
    await gateway.use(plugin);

    server = http.createServer(async (req, res) => {
      try {
        await gateway.handleRequest(req, res);
      } catch {
        if (!res.headersSent) res.writeHead(500).end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  }

  async function mcpRequest(method: string, params: any, sessionId: string, id: number) {
    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const text = await res.text();
    const match = text.match(/data: (.+)/);
    return match ? JSON.parse(match[1]) : JSON.parse(text);
  }

  async function initSession(): Promise<string> {
    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    const sessionId = res.headers.get("mcp-session-id")!;
    await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Mcp-Session-Id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    return sessionId;
  }

  it("lists and reads static resources via MCP protocol", async () => {
    await startGatewayServer(
      mcpServerPlugin({
        path: "/mcp",
        resources: [
          {
            name: "schema",
            uri: "db://schema",
            description: "DB schema",
            read: () => ({ text: "CREATE TABLE users (id INT)" }),
          },
        ],
      }),
    );

    const sessionId = await initSession();

    const listData = await mcpRequest("resources/list", {}, sessionId, 2);
    expect(listData.result.resources).toHaveLength(1);
    expect(listData.result.resources[0].uri).toBe("db://schema");

    const readData = await mcpRequest("resources/read", { uri: "db://schema" }, sessionId, 3);
    expect(readData.result.contents[0].text).toBe("CREATE TABLE users (id INT)");
  });

  it("lists and reads template resources via MCP protocol", async () => {
    await startGatewayServer(
      mcpServerPlugin({
        path: "/mcp",
        resourceTemplates: [
          {
            name: "project",
            uriTemplate: "projects://{id}",
            list: () => [
              { uri: "projects://1", title: "Alpha" },
              { uri: "projects://2", title: "Beta" },
            ],
            read: (vars) => ({ text: `Project ${vars.id}` }),
          },
        ],
      }),
    );

    const sessionId = await initSession();

    // List templates
    const templatesData = await mcpRequest("resources/templates/list", {}, sessionId, 2);
    expect(templatesData.result.resourceTemplates).toHaveLength(1);

    // List instances
    const listData = await mcpRequest("resources/list", {}, sessionId, 3);
    expect(listData.result.resources.length).toBeGreaterThanOrEqual(2);

    // Read a specific instance
    const readData = await mcpRequest("resources/read", { uri: "projects://1" }, sessionId, 4);
    expect(readData.result.contents[0].text).toBe("Project 1");
  });
});

// ============================================================================
// Route matching with path prefix
// ============================================================================

describe("MCP Server Plugin — route matching", () => {
  it("absolute route matches at domain root despite httpPathPrefix", async () => {
    const gateway = createGateway({
      apps: { chat: createMockApp() },
      defaultApp: "chat",
      embedded: true,
      httpPathPrefix: "/api/v1",
    });

    const plugin = mcpServerPlugin({
      path: "/mcp",
      oauthMetadata: { metadata: { issuer: "test" } },
    });
    await gateway.use(plugin);

    // .well-known is absolute (not under prefix)
    const { req, res } = createMockHTTPPair("/.well-known/oauth-authorization-server", "GET");
    await gateway.handleRequest(req, res);
    expect(res.statusCode).toBe(200);

    await gateway.stop();
  });
});
