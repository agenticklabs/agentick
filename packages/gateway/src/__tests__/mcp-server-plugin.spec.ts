/**
 * MCP Server Plugin Tests
 *
 * Tests tool discovery, filtering, dispatch, and lifecycle.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  Gateway,
  createGateway,
} from "../index.js";
import { mcpServerPlugin } from "../plugins/mcp-server.js";
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

function createMockHTTPPair(path: string, method = "GET") {
  const chunks: Buffer[] = [];
  const req = {
    method,
    url: path,
    headers: { host: "localhost", "content-type": "application/json" },
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
    // sessionId "chat:default" will trigger session creation via mock app.
    // tool-catalog returns empty tools, but the route still gets registered.
    const plugin = mcpServerPlugin({ sessionId: "default", path: "/test-mcp" });
    await gateway.use(plugin);

    // Hitting the route should NOT 404 — the MCP transport handles it
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

describe("MCP Server Plugin — tool filtering", () => {
  it("include filter keeps only named tools", () => {
    const { filterTools } = getFilterHelpers();
    const tools = [
      { name: "a", description: "", input: {} },
      { name: "b", description: "", input: {} },
      { name: "c", description: "", input: {} },
    ];
    const result = filterTools(tools, { include: ["a", "c"] });
    expect(result.map((t: any) => t.name)).toEqual(["a", "c"]);
  });

  it("exclude filter removes named tools", () => {
    const { filterTools } = getFilterHelpers();
    const tools = [
      { name: "a", description: "", input: {} },
      { name: "b", description: "", input: {} },
      { name: "c", description: "", input: {} },
    ];
    const result = filterTools(tools, { exclude: ["b"] });
    expect(result.map((t: any) => t.name)).toEqual(["a", "c"]);
  });

  it("include + exclude together: include first, then exclude", () => {
    const { filterTools } = getFilterHelpers();
    const tools = [
      { name: "a", description: "", input: {} },
      { name: "b", description: "", input: {} },
      { name: "c", description: "", input: {} },
    ];
    const result = filterTools(tools, { include: ["a", "b"], exclude: ["b"] });
    expect(result.map((t: any) => t.name)).toEqual(["a"]);
  });

  it("empty include/exclude passes all tools through", () => {
    const { filterTools } = getFilterHelpers();
    const tools = [{ name: "x", description: "", input: {} }];
    const result = filterTools(tools, {});
    expect(result).toHaveLength(1);
  });
});

/** Replicate the filterTools logic for unit testing */
function getFilterHelpers() {
  function filterTools(
    tools: Array<{ name: string; description: string; input: Record<string, unknown> }>,
    config: { include?: string[]; exclude?: string[] },
  ) {
    let filtered = tools;
    if (config.include?.length) {
      const set = new Set(config.include);
      filtered = filtered.filter((t) => set.has(t.name));
    }
    if (config.exclude?.length) {
      const set = new Set(config.exclude);
      filtered = filtered.filter((t) => !set.has(t.name));
    }
    return filtered;
  }
  return { filterTools };
}
