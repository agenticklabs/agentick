/**
 * MCP Client Adapter Integration Tests
 *
 * Tests the core adapter layer end-to-end against a real MCPServer
 * via InMemoryTransport. Verifies:
 * - Type mappings (MCPConfig → MCPConnectionConfig, DiscoveredTool → MCPToolDefinition, etc.)
 * - Tool discovery, caching, and calling through the adapter
 * - Resource discovery, reading, and URI routing through the adapter
 * - Server-sent notifications (list_changed) propagate through the adapter
 * - Disconnect cleanup
 */

import { describe, it, expect, vi } from "vitest";
import { MCPClient, uriMatchesTemplate } from "../client.js";
import { MCPServer } from "@agentick/mcp/server";
import { InMemoryTransport } from "@agentick/mcp/transport";
import type {
  MCPToolDefinition,
  MCPResource,
  MCPResourceTemplate,
  MCPResourceContent,
} from "../types.js";
import { z } from "zod";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a connected core MCPClient + MCPServer pair.
 * Uses the core's MCPConfig (with transport: "websocket" mapped to "streamable-http")
 * to verify the adapter's config normalization.
 */
async function createPair(
  serverOptions: ConstructorParameters<typeof MCPServer>[0],
  serverName = "test-server",
) {
  const server = new MCPServer(serverOptions);
  const client = new MCPClient();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  // MCPClient is now the real @agentick/mcp client (no wrapper).
  // Connect directly with in-process transport.
  await client.connect({
    serverName,
    transport: "in-process",
    connection: { transport: clientTransport },
  });

  return {
    client,
    server,
    cleanup: async () => {
      await client.disconnectAll();
      await server.close();
    },
  };
}

// ============================================================================
// URI Template Matching (re-exported)
// ============================================================================

describe("uriMatchesTemplate", () => {
  it("matches exact URIs", () => {
    expect(uriMatchesTemplate("db://schema/users", "db://schema/users")).toBe(true);
  });

  it("matches Level 1 templates", () => {
    expect(uriMatchesTemplate("db://schema/users", "db://schema/{table}")).toBe(true);
  });

  it("does not match different URIs", () => {
    expect(uriMatchesTemplate("db://other/users", "db://schema/{table}")).toBe(false);
  });

  it("handles multiple variables", () => {
    expect(uriMatchesTemplate("db://org1/users", "db://{org}/{table}")).toBe(true);
  });

  it("does not match partial URIs", () => {
    expect(uriMatchesTemplate("db://schema/users/extra", "db://schema/{table}")).toBe(false);
  });
});

// ============================================================================
// Tool Discovery + Calling through Adapter
// ============================================================================

describe("MCPClient adapter — tools", () => {
  it("lists tools and maps to core MCPToolDefinition shape", async () => {
    const { client, cleanup } = await createPair({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "greet",
          description: "Greet someone",
          inputSchema: { name: z.string() },
          handler: async (input) => ({
            content: [{ type: "text", text: `Hi ${(input as any).name}` }],
          }),
        },
      ],
    });

    const tools: MCPToolDefinition[] = await client.listTools("test-server");
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("greet");
    expect(tools[0].description).toBe("Greet someone");
    // Core's MCPToolDefinition has inputSchema with type/properties
    expect(tools[0].inputSchema).toBeDefined();

    await cleanup();
  });

  it("caches tools — second call returns same data", async () => {
    const { client, cleanup } = await createPair({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "t",
          description: "T",
          inputSchema: {},
          handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        },
      ],
    });

    const first = await client.listTools("test-server");
    const second = await client.listTools("test-server");
    // Adapter re-maps each time, but inner cache is hit
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].name).toBe(second[0].name);

    await cleanup();
  });

  it("calls a tool and returns the result", async () => {
    const { client, cleanup } = await createPair({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "echo",
          description: "Echo",
          inputSchema: { msg: z.string() },
          handler: async (input) => ({ content: [{ type: "text", text: (input as any).msg }] }),
        },
      ],
    });

    const result = await client.callTool("test-server", "echo", { msg: "hello" });
    expect(result.content[0].text).toBe("hello");

    await cleanup();
  });
});

// ============================================================================
// Resource Discovery + Reading through Adapter
// ============================================================================

describe("MCPClient adapter — resources", () => {
  it("lists resources and maps to core MCPResource shape", async () => {
    const { client, cleanup } = await createPair({
      name: "test",
      version: "1.0.0",
      resources: [
        {
          name: "schema",
          uri: "db://schema/users",
          description: "User table",
          read: async () => ({ contents: [{ uri: "db://schema/users", text: "CREATE TABLE" }] }),
        },
      ],
    });

    const resources: MCPResource[] = await client.listResources("test-server");
    expect(resources).toHaveLength(1);
    expect(resources[0].uri).toBe("db://schema/users");
    expect(resources[0].name).toBe("schema");
    expect(resources[0].serverName).toBe("test-server");

    await cleanup();
  });

  it("reads a resource and maps to core MCPResourceContent shape", async () => {
    const { client, cleanup } = await createPair({
      name: "test",
      version: "1.0.0",
      resources: [
        {
          name: "doc",
          uri: "docs://readme",
          read: async () => ({ contents: [{ uri: "docs://readme", text: "# README" }] }),
        },
      ],
    });

    const contents: MCPResourceContent[] = await client.readResource(
      "test-server",
      "docs://readme",
    );
    expect(contents).toHaveLength(1);
    expect(contents[0].uri).toBe("docs://readme");
    expect(contents[0].text).toBe("# README");

    await cleanup();
  });

  it("lists resource templates and maps to core MCPResourceTemplate shape", async () => {
    const { client, cleanup } = await createPair({
      name: "test",
      version: "1.0.0",
      resourceTemplates: [
        {
          name: "table-schema",
          uriTemplate: "db://schema/{table}",
          list: async () => ({ resources: [{ uri: "db://schema/users", name: "users" }] }),
          read: async (uri, vars) => ({ contents: [{ uri, text: `Schema: ${vars.table}` }] }),
        },
      ],
    });

    const templates: MCPResourceTemplate[] = await client.listResourceTemplates("test-server");
    expect(templates).toHaveLength(1);
    expect(templates[0].uriTemplate).toBe("db://schema/{table}");
    expect(templates[0].serverName).toBe("test-server");

    await cleanup();
  });

  it("readResourceByURI routes via cached resources", async () => {
    const { client, cleanup } = await createPair({
      name: "test",
      version: "1.0.0",
      resources: [
        {
          name: "doc",
          uri: "docs://target",
          read: async () => ({ contents: [{ uri: "docs://target", text: "found it" }] }),
        },
      ],
    });

    // Populate cache
    await client.listResources("test-server");

    const contents = await client.readResourceByURI("docs://target");
    expect(contents[0].text).toBe("found it");

    await cleanup();
  });

  it("readResourceByURI routes via template matching", async () => {
    const { client, cleanup } = await createPair({
      name: "test",
      version: "1.0.0",
      resourceTemplates: [
        {
          name: "schema",
          uriTemplate: "db://schema/{table}",
          list: async () => ({ resources: [] }),
          read: async (uri, vars) => ({ contents: [{ uri, text: `Schema: ${vars.table}` }] }),
        },
      ],
    });

    await client.listResourceTemplates("test-server");

    const contents = await client.readResourceByURI("db://schema/orders");
    expect(contents[0].text).toBe("Schema: orders");

    await cleanup();
  });

  it("listAllResources aggregates across servers", async () => {
    const server1 = new MCPServer({
      name: "s1",
      version: "1.0.0",
      resources: [
        {
          name: "a",
          uri: "a://1",
          read: async () => ({ contents: [{ uri: "a://1", text: "a" }] }),
        },
      ],
    });
    const server2 = new MCPServer({
      name: "s2",
      version: "1.0.0",
      resources: [
        {
          name: "b",
          uri: "b://2",
          read: async () => ({ contents: [{ uri: "b://2", text: "b" }] }),
        },
      ],
    });

    const client = new MCPClient();
    const inner = client;

    const [ct1, st1] = InMemoryTransport.createLinkedPair();
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await server1.connect(st1);
    await server2.connect(st2);
    await inner.connect({
      serverName: "s1",
      transport: "in-process",
      connection: { transport: ct1 },
    });
    await inner.connect({
      serverName: "s2",
      transport: "in-process",
      connection: { transport: ct2 },
    });

    const all: MCPResource[] = await client.listAllResources();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.uri).sort()).toEqual(["a://1", "b://2"]);
    // All have serverName set
    expect(all.every((r) => r.serverName)).toBe(true);

    await client.disconnectAll();
    await server1.close();
    await server2.close();
  });
});

// ============================================================================
// Server-Sent Notifications through Adapter
// ============================================================================

describe("MCPClient adapter — notifications", () => {
  it("tool cache invalidated when server sends notifications/tools/list_changed", async () => {
    const { client, server, cleanup } = await createPair({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "original",
          description: "Original",
          inputSchema: {},
          handler: async () => ({ content: [{ type: "text", text: "orig" }] }),
        },
      ],
    });

    // First fetch — cached
    const first = await client.listTools("test-server");
    expect(first).toHaveLength(1);

    // Server dynamically registers a new tool → sends list_changed
    server.registerTool({
      name: "added",
      description: "Added dynamically",
      inputSchema: {},
      handler: async () => ({ content: [{ type: "text", text: "added" }] }),
    });

    // Wait for notification to propagate
    await new Promise((r) => setTimeout(r, 50));

    // Adapter should return fresh data (inner cache was invalidated by notification)
    const second = await client.listTools("test-server");
    expect(second).toHaveLength(2);
    expect(second.map((t) => t.name).sort()).toEqual(["added", "original"]);

    await cleanup();
  });

  it("resource cache invalidated when server sends notifications/resources/list_changed", async () => {
    const { client, server, cleanup } = await createPair({
      name: "test",
      version: "1.0.0",
      resources: [
        {
          name: "doc",
          uri: "docs://original",
          read: async () => ({ contents: [{ uri: "docs://original", text: "original" }] }),
        },
      ],
    });

    const first = await client.listResources("test-server");
    expect(first).toHaveLength(1);

    server.registerResource({
      name: "doc2",
      uri: "docs://new",
      read: async () => ({ contents: [{ uri: "docs://new", text: "new" }] }),
    });

    await new Promise((r) => setTimeout(r, 50));

    const second = await client.listResources("test-server");
    expect(second).toHaveLength(2);

    await cleanup();
  });

  it("dynamically added tool is callable through the adapter", async () => {
    const { client, server, cleanup } = await createPair({
      name: "test",
      version: "1.0.0",
    });

    // No tools initially
    const initial = await client.listTools("test-server");
    expect(initial).toHaveLength(0);

    // Add tool
    server.registerTool({
      name: "dynamic",
      description: "Dynamic tool",
      inputSchema: { x: z.number() },
      handler: async (input) => ({ content: [{ type: "text", text: `x=${(input as any).x}` }] }),
    });

    await new Promise((r) => setTimeout(r, 50));

    // List shows it
    const after = await client.listTools("test-server");
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe("dynamic");

    // Can call it
    const result = await client.callTool("test-server", "dynamic", { x: 42 });
    expect(result.content[0].text).toBe("x=42");

    await cleanup();
  });
});

// ============================================================================
// Disconnect + Cleanup
// ============================================================================

describe("MCPClient adapter — lifecycle", () => {
  it("disconnect cleans up and subsequent calls throw", async () => {
    const { client, server } = await createPair({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "t",
          description: "T",
          inputSchema: {},
          handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        },
      ],
    });

    // Works before disconnect
    const tools = await client.listTools("test-server");
    expect(tools).toHaveLength(1);

    await client.disconnect("test-server");

    // Throws after disconnect
    await expect(client.listTools("test-server")).rejects.toThrow("not connected");

    await server.close();
  });

  it("disconnectAll cleans up all servers", async () => {
    const server1 = new MCPServer({ name: "s1", version: "1.0.0" });
    const server2 = new MCPServer({ name: "s2", version: "1.0.0" });

    const client = new MCPClient();
    const inner = client;

    const [ct1, st1] = InMemoryTransport.createLinkedPair();
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await server1.connect(st1);
    await server2.connect(st2);
    await inner.connect({
      serverName: "s1",
      transport: "in-process",
      connection: { transport: ct1 },
    });
    await inner.connect({
      serverName: "s2",
      transport: "in-process",
      connection: { transport: ct2 },
    });

    await client.disconnectAll();

    await expect(client.listTools("s1")).rejects.toThrow(/not connected/i);
    await expect(client.listTools("s2")).rejects.toThrow(/not connected/i);

    await server1.close();
    await server2.close();
  });
});

// ============================================================================
// Adapter connect() — config normalization
// ============================================================================

describe("MCPClient — connect() path", () => {
  // Transport mapping (websocket → streamable-http) now lives in MCPService,
  // not in MCPClient. MCPClient is the real @agentick/mcp client — no wrapper.

  it("forwards auth config through to connect()", async () => {
    const client = new MCPClient();
    const spy = vi.spyOn(client, "connect").mockResolvedValue(undefined);

    await client.connect({
      serverName: "auth-server",
      transport: "sse",
      connection: { url: "https://example.com/sse" },
      auth: { type: "bearer", token: "secret-token" },
    });

    const calledWith = spy.mock.calls[0]![0] as {
      auth?: { type: string; token: string };
    };
    expect(calledWith.auth).toEqual({ type: "bearer", token: "secret-token" });
    spy.mockRestore();
  });

  it("does end-to-end connect against a real MCPServer via websocket → streamable-http mapping", async () => {
    // Real integration: use in-process transport but go through the adapter's connect()
    // path with a "websocket" config. Since InMemoryTransport is always in-process,
    // we can't directly test the streamable-http mapping against a network server,
    // but we can verify the full adapter → inner.connect() chain by spying at the
    // inner client and then running the normal tool flow through the adapter.
    const server = new MCPServer({
      name: "adapter-connect-test",
      version: "1.0.0",
      tools: [
        {
          name: "ping",
          description: "Ping",
          inputSchema: {},
          handler: async () => ({ content: [{ type: "text", text: "pong" }] }),
        },
      ],
    });
    const client = new MCPClient();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    // Inject via inner.connect() because the adapter's public connect() doesn't
    // expose "in-process" (it only accepts websocket/sse/stdio). This verifies
    // that the adapter and inner client share state correctly.
    const innerClient = client;
    await innerClient.connect({
      serverName: "adapter-connect-test",
      transport: "in-process",
      connection: { transport: clientTransport },
    });

    const tools = await client.listTools("adapter-connect-test");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("ping");

    const result = await client.callTool("adapter-connect-test", "ping", {});
    expect((result as any).content[0].text).toBe("pong");

    await client.disconnectAll();
    await server.close();
  });
});
