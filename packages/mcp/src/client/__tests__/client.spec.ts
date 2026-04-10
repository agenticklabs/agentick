/**
 * MCPClient Tests
 *
 * Tests connection management, tool/resource discovery, caching,
 * automatic cache invalidation on list_changed notifications,
 * URI routing, disconnect cleanup, and health tracking.
 *
 * Uses MCPServer + InMemoryTransport for end-to-end verification.
 */

import { describe, it, expect } from "vitest";
import { MCPClient, uriMatchesTemplate } from "../client.js";
import { MCPServer } from "../../server/server.js";
import { InMemoryTransport } from "../../transport/index.js";
import { z } from "zod";

// ============================================================================
// Helpers
// ============================================================================

async function createClientServerPair(
  serverOptions: ConstructorParameters<typeof MCPServer>[0],
  clientServerName = "test-server",
): Promise<{
  client: MCPClient;
  server: MCPServer;
  cleanup: () => Promise<void>;
}> {
  const server = new MCPServer(serverOptions);
  const client = new MCPClient();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect({
    serverName: clientServerName,
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
// URI Template Matching
// ============================================================================

describe("uriMatchesTemplate", () => {
  it("matches exact URIs", () => {
    expect(uriMatchesTemplate("db://schema/users", "db://schema/users")).toBe(true);
  });

  it("matches Level 1 templates", () => {
    expect(uriMatchesTemplate("db://schema/users", "db://schema/{table}")).toBe(true);
    expect(uriMatchesTemplate("db://schema/orders", "db://schema/{table}")).toBe(true);
  });

  it("does not match different URIs", () => {
    expect(uriMatchesTemplate("db://other/users", "db://schema/{table}")).toBe(false);
  });

  it("does not match partial URIs", () => {
    expect(uriMatchesTemplate("db://schema/users/extra", "db://schema/{table}")).toBe(false);
  });

  it("handles multiple template variables", () => {
    expect(uriMatchesTemplate("db://org1/users", "db://{org}/{table}")).toBe(true);
  });
});

// ============================================================================
// Connection
// ============================================================================

describe("MCPClient — connection", () => {
  it("connects to a server via InMemoryTransport", async () => {
    const { client, cleanup } = await createClientServerPair({
      name: "test",
      version: "1.0.0",
    });

    const health = client.getHealth("test-server");
    expect(health?.state).toBe("connected");

    await cleanup();
  });

  it("tracks health across multiple servers", async () => {
    const server1 = new MCPServer({ name: "s1", version: "1.0.0" });
    const server2 = new MCPServer({ name: "s2", version: "1.0.0" });

    const client = new MCPClient();

    const [ct1, st1] = InMemoryTransport.createLinkedPair();
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await server1.connect(st1);
    await server2.connect(st2);

    await client.connect({
      serverName: "s1",
      transport: "in-process",
      connection: { transport: ct1 },
    });
    await client.connect({
      serverName: "s2",
      transport: "in-process",
      connection: { transport: ct2 },
    });

    const health = client.getAllHealth();
    expect(health).toHaveLength(2);
    expect(health.every((h) => h.state === "connected")).toBe(true);

    await client.disconnectAll();
    await server1.close();
    await server2.close();
  });

  it("disconnect properly closes SDK client", async () => {
    const { client, server } = await createClientServerPair({
      name: "test",
      version: "1.0.0",
    });

    await client.disconnect("test-server");

    // Health should be gone
    expect(client.getHealth("test-server")).toBeUndefined();

    // Trying to list tools should throw
    await expect(client.listTools("test-server")).rejects.toThrow("not connected");

    await server.close();
  });

  it("throws for unknown server name", async () => {
    const client = new MCPClient();
    await expect(client.listTools("nonexistent")).rejects.toThrow("not connected");
  });
});

// ============================================================================
// Tool Discovery + Caching
// ============================================================================

describe("MCPClient — tools", () => {
  it("discovers tools from server", async () => {
    const { client, cleanup } = await createClientServerPair({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "greet",
          description: "Greet",
          inputSchema: { name: z.string() },
          handler: async (input) => ({
            content: [{ type: "text", text: `Hi ${(input as any).name}` }],
          }),
        },
        {
          name: "calc",
          description: "Calculate",
          inputSchema: { x: z.number() },
          handler: async () => ({ content: [{ type: "text", text: "42" }] }),
        },
      ],
    });

    const tools = await client.listTools("test-server");
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["calc", "greet"]);
    expect(tools[0].serverName).toBe("test-server");

    await cleanup();
  });

  it("caches tool list — second call returns same data without server round-trip", async () => {
    const { client, cleanup } = await createClientServerPair({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "tool-a",
          description: "A",
          inputSchema: {},
          handler: async () => ({ content: [{ type: "text", text: "a" }] }),
        },
      ],
    });

    const first = await client.listTools("test-server");
    const second = await client.listTools("test-server");
    // Same reference — cached
    expect(first).toBe(second);

    await cleanup();
  });

  it("calls a tool and returns the result", async () => {
    const { client, cleanup } = await createClientServerPair({
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

  it("invalidates tool cache when server sends list_changed notification", async () => {
    const { client, server, cleanup } = await createClientServerPair({
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

    // Register new tool on server — sends list_changed notification
    server.registerTool({
      name: "added",
      description: "Added",
      inputSchema: {},
      handler: async () => ({ content: [{ type: "text", text: "added" }] }),
    });

    // Give notification a tick to propagate
    await new Promise((r) => setTimeout(r, 10));

    // Cache should be invalidated — next fetch gets fresh data
    const second = await client.listTools("test-server");
    expect(second).toHaveLength(2);
    expect(second).not.toBe(first); // Different reference — re-fetched

    await cleanup();
  });

  it("manual invalidateTools clears cache", async () => {
    const { client, cleanup } = await createClientServerPair({
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
    client.invalidateTools("test-server");
    const second = await client.listTools("test-server");
    expect(second).not.toBe(first);

    await cleanup();
  });
});

// ============================================================================
// Resource Discovery + Caching + URI Routing
// ============================================================================

describe("MCPClient — resources", () => {
  it("discovers resources from server", async () => {
    const { client, cleanup } = await createClientServerPair({
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

    const resources = await client.listResources("test-server");
    expect(resources).toHaveLength(1);
    expect(resources[0].uri).toBe("db://schema/users");
    expect(resources[0].serverName).toBe("test-server");

    await cleanup();
  });

  it("reads a resource by URI", async () => {
    const { client, cleanup } = await createClientServerPair({
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

    const contents = await client.readResource("test-server", "docs://readme");
    expect(contents[0].text).toBe("# README");

    await cleanup();
  });

  it("discovers resource templates", async () => {
    const { client, cleanup } = await createClientServerPair({
      name: "test",
      version: "1.0.0",
      resourceTemplates: [
        {
          name: "table-schema",
          uriTemplate: "db://schema/{table}",
          list: async () => ({ resources: [{ uri: "db://schema/users", name: "users" }] }),
          read: async (uri, vars) => ({ contents: [{ uri, text: `Schema for ${vars.table}` }] }),
        },
      ],
    });

    const templates = await client.listResourceTemplates("test-server");
    expect(templates).toHaveLength(1);
    expect(templates[0].uriTemplate).toBe("db://schema/{table}");

    await cleanup();
  });

  it("routes readResourceByURI to the correct server via cached resources", async () => {
    const server1 = new MCPServer({
      name: "s1",
      version: "1.0.0",
      resources: [
        {
          name: "doc-a",
          uri: "docs://a",
          read: async () => ({ contents: [{ uri: "docs://a", text: "from server 1" }] }),
        },
      ],
    });
    const server2 = new MCPServer({
      name: "s2",
      version: "1.0.0",
      resources: [
        {
          name: "doc-b",
          uri: "docs://b",
          read: async () => ({ contents: [{ uri: "docs://b", text: "from server 2" }] }),
        },
      ],
    });

    const client = new MCPClient();
    const [ct1, st1] = InMemoryTransport.createLinkedPair();
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await server1.connect(st1);
    await server2.connect(st2);
    await client.connect({
      serverName: "s1",
      transport: "in-process",
      connection: { transport: ct1 },
    });
    await client.connect({
      serverName: "s2",
      transport: "in-process",
      connection: { transport: ct2 },
    });

    // Populate caches
    await client.listResources("s1");
    await client.listResources("s2");

    // Route by URI
    const contentA = await client.readResourceByURI("docs://a");
    expect(contentA[0].text).toBe("from server 1");

    const contentB = await client.readResourceByURI("docs://b");
    expect(contentB[0].text).toBe("from server 2");

    await client.disconnectAll();
    await server1.close();
    await server2.close();
  });

  it("routes readResourceByURI via template matching", async () => {
    const { client, cleanup } = await createClientServerPair({
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

    // Populate template cache
    await client.listResourceTemplates("test-server");

    const contents = await client.readResourceByURI("db://schema/orders");
    expect(contents[0].text).toBe("Schema: orders");

    await cleanup();
  });

  it("throws for unknown URI in readResourceByURI", async () => {
    const { client, cleanup } = await createClientServerPair({
      name: "test",
      version: "1.0.0",
    });

    await expect(client.readResourceByURI("unknown://uri")).rejects.toThrow("No MCP server found");

    await cleanup();
  });

  it("invalidates resource cache when server sends list_changed notification", async () => {
    const { client, server, cleanup } = await createClientServerPair({
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

    // Register new resource — sends list_changed
    server.registerResource({
      name: "doc2",
      uri: "docs://new",
      read: async () => ({ contents: [{ uri: "docs://new", text: "new" }] }),
    });

    await new Promise((r) => setTimeout(r, 10));

    const second = await client.listResources("test-server");
    expect(second).toHaveLength(2);
    expect(second).not.toBe(first);

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
    const [ct1, st1] = InMemoryTransport.createLinkedPair();
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await server1.connect(st1);
    await server2.connect(st2);
    await client.connect({
      serverName: "s1",
      transport: "in-process",
      connection: { transport: ct1 },
    });
    await client.connect({
      serverName: "s2",
      transport: "in-process",
      connection: { transport: ct2 },
    });

    const all = await client.listAllResources();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.uri).sort()).toEqual(["a://1", "b://2"]);

    await client.disconnectAll();
    await server1.close();
    await server2.close();
  });

  it("listAllResources handles per-server errors gracefully", async () => {
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

    const client = new MCPClient();
    const [ct1, st1] = InMemoryTransport.createLinkedPair();
    await server1.connect(st1);
    await client.connect({
      serverName: "s1",
      transport: "in-process",
      connection: { transport: ct1 },
    });

    // Disconnect s1 to make it fail
    await server1.close();

    // Should not throw — returns what it can
    const all = await client.listAllResources();
    // May return 0 or cached results depending on timing
    expect(Array.isArray(all)).toBe(true);

    await client.disconnectAll();
  });
});

// ============================================================================
// Events
// ============================================================================

describe("MCPClient — events", () => {
  it("emits tools:changed when server sends list_changed", async () => {
    const { client, server, cleanup } = await createClientServerPair({
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

    const events: any[] = [];
    client.on("tools:changed", (e) => events.push(e));

    // Trigger list_changed
    server.registerTool({
      name: "new",
      description: "New",
      inputSchema: {},
      handler: async () => ({ content: [{ type: "text", text: "new" }] }),
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(1);
    expect(events[0].serverName).toBe("test-server");

    await cleanup();
  });

  it("emits resources:changed when server sends list_changed", async () => {
    const { client, server, cleanup } = await createClientServerPair({
      name: "test",
      version: "1.0.0",
    });

    const events: any[] = [];
    client.on("resources:changed", (e) => events.push(e));

    server.registerResource({
      name: "doc",
      uri: "docs://new",
      read: async () => ({ contents: [{ uri: "docs://new", text: "new" }] }),
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(1);
    expect(events[0].serverName).toBe("test-server");

    await cleanup();
  });
});
