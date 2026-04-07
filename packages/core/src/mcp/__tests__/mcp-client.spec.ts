/**
 * MCPClient Tests
 *
 * Tests for the MCPClient resource methods: listResources, readResource,
 * listResourceTemplates, readResourceByURI, and cache invalidation.
 *
 * Uses a mock MCP SDK Client to avoid real server connections.
 */

import { describe, it, expect, vi } from "vitest";
import { MCPClient, uriMatchesTemplate } from "../client.js";
import { Client } from "@modelcontextprotocol/sdk/client";

// ============================================================================
// Mock Setup
// ============================================================================

/**
 * Create an MCPClient with a pre-injected mock SDK Client.
 * Bypasses connect() transport logic entirely.
 */
function createClientWithMock(serverName: string, mock: Partial<Client>): MCPClient {
  const client = new MCPClient();

  // Inject mock directly into the private clients map
  const clientsMap = (client as any).clients as Map<string, Client>;
  clientsMap.set(serverName, mock as Client);

  return client;
}

function mockSDKClient(overrides: {
  resources?: Array<{
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
  }>;
  resourceTemplates?: Array<{
    uriTemplate: string;
    name: string;
    description?: string;
    mimeType?: string;
  }>;
  resourceContents?: Record<
    string,
    Array<{ uri: string; text?: string; blob?: string; mimeType?: string }>
  >;
  tools?: Array<{ name: string; description: string; inputSchema: any }>;
}): Partial<Client> {
  return {
    listResources: vi.fn().mockResolvedValue({
      resources: overrides.resources ?? [],
    }),
    listResourceTemplates: vi.fn().mockResolvedValue({
      resourceTemplates: overrides.resourceTemplates ?? [],
    }),
    readResource: vi.fn().mockImplementation(async (params: { uri: string }) => {
      const contents = overrides.resourceContents?.[params.uri];
      if (!contents) {
        throw new Error(`Resource not found: ${params.uri}`);
      }
      return { contents };
    }),
    listTools: vi.fn().mockResolvedValue({
      tools: overrides.tools ?? [],
    }),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  };
}

// ============================================================================
// listResources
// ============================================================================

describe("MCPClient", () => {
  describe("listResources", () => {
    it("returns resources from a connected server", async () => {
      const client = createClientWithMock(
        "db",
        mockSDKClient({
          resources: [
            { uri: "db://schema/users", name: "users", description: "Users table schema" },
            { uri: "db://schema/orders", name: "orders", mimeType: "application/json" },
          ],
        }),
      );

      const resources = await client.listResources("db");

      expect(resources).toEqual([
        {
          uri: "db://schema/users",
          name: "users",
          description: "Users table schema",
          mimeType: undefined,
          serverName: "db",
        },
        {
          uri: "db://schema/orders",
          name: "orders",
          description: undefined,
          mimeType: "application/json",
          serverName: "db",
        },
      ]);
    });

    it("caches results — second call does not hit SDK", async () => {
      const mock = mockSDKClient({
        resources: [{ uri: "file:///readme", name: "readme" }],
      });
      const client = createClientWithMock("fs", mock);

      await client.listResources("fs");
      await client.listResources("fs");

      expect(mock.listResources).toHaveBeenCalledTimes(1);
    });

    it("throws when server is not connected", async () => {
      const client = new MCPClient();

      await expect(client.listResources("nonexistent")).rejects.toThrow(
        'MCP server "nonexistent" is not connected',
      );
    });

    it("returns empty array when server has no resources", async () => {
      const client = createClientWithMock("empty", mockSDKClient({}));

      const resources = await client.listResources("empty");

      expect(resources).toEqual([]);
    });
  });

  // ============================================================================
  // listResourceTemplates
  // ============================================================================

  describe("listResourceTemplates", () => {
    it("returns templates from a connected server", async () => {
      const client = createClientWithMock(
        "db",
        mockSDKClient({
          resourceTemplates: [
            {
              uriTemplate: "db://schema/{table}",
              name: "table_schema",
              description: "Schema for a database table",
            },
          ],
        }),
      );

      const templates = await client.listResourceTemplates("db");

      expect(templates).toEqual([
        {
          uriTemplate: "db://schema/{table}",
          name: "table_schema",
          description: "Schema for a database table",
          mimeType: undefined,
          serverName: "db",
        },
      ]);
    });

    it("caches template results", async () => {
      const mock = mockSDKClient({
        resourceTemplates: [{ uriTemplate: "x://{id}", name: "x" }],
      });
      const client = createClientWithMock("svc", mock);

      await client.listResourceTemplates("svc");
      await client.listResourceTemplates("svc");

      expect(mock.listResourceTemplates).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // readResource
  // ============================================================================

  describe("readResource", () => {
    it("reads text content from a resource", async () => {
      const client = createClientWithMock(
        "db",
        mockSDKClient({
          resourceContents: {
            "db://schema/users": [
              {
                uri: "db://schema/users",
                text: "CREATE TABLE users (id INT)",
                mimeType: "text/plain",
              },
            ],
          },
        }),
      );

      const contents = await client.readResource("db", "db://schema/users");

      expect(contents).toEqual([
        {
          uri: "db://schema/users",
          text: "CREATE TABLE users (id INT)",
          blob: undefined,
          mimeType: "text/plain",
        },
      ]);
    });

    it("reads binary content from a resource", async () => {
      const client = createClientWithMock(
        "fs",
        mockSDKClient({
          resourceContents: {
            "file:///image.png": [
              { uri: "file:///image.png", blob: "iVBORw0KGgo=", mimeType: "image/png" },
            ],
          },
        }),
      );

      const contents = await client.readResource("fs", "file:///image.png");

      expect(contents).toEqual([
        { uri: "file:///image.png", text: undefined, blob: "iVBORw0KGgo=", mimeType: "image/png" },
      ]);
    });

    it("throws when resource URI is not found on server", async () => {
      const client = createClientWithMock("db", mockSDKClient({ resourceContents: {} }));

      await expect(client.readResource("db", "db://nope")).rejects.toThrow("Resource not found");
    });

    it("returns multiple content items for multi-part resources", async () => {
      const client = createClientWithMock(
        "db",
        mockSDKClient({
          resourceContents: {
            "db://schema/all": [
              { uri: "db://schema/all", text: "-- Part 1" },
              { uri: "db://schema/all", text: "-- Part 2" },
            ],
          },
        }),
      );

      const contents = await client.readResource("db", "db://schema/all");

      expect(contents).toHaveLength(2);
    });
  });

  // ============================================================================
  // readResourceByURI (routing)
  // ============================================================================

  describe("readResourceByURI", () => {
    it("routes to the correct server based on cached resources", async () => {
      const dbMock = mockSDKClient({
        resources: [{ uri: "db://schema/users", name: "users" }],
        resourceContents: {
          "db://schema/users": [{ uri: "db://schema/users", text: "CREATE TABLE users..." }],
        },
      });
      const fsMock = mockSDKClient({
        resources: [{ uri: "file:///readme", name: "readme" }],
        resourceContents: {
          "file:///readme": [{ uri: "file:///readme", text: "# README" }],
        },
      });

      const client = new MCPClient();
      (client as any).clients.set("db", dbMock);
      (client as any).clients.set("fs", fsMock);

      // Prime the cache
      await client.listResources("db");
      await client.listResources("fs");

      const contents = await client.readResourceByURI("file:///readme");

      expect(contents[0].text).toBe("# README");
      expect(fsMock.readResource).toHaveBeenCalledWith({ uri: "file:///readme" });
      expect(dbMock.readResource).not.toHaveBeenCalled();
    });

    it("routes via template matching when no exact URI match", async () => {
      const mock = mockSDKClient({
        resources: [],
        resourceTemplates: [{ uriTemplate: "db://schema/{table}", name: "table_schema" }],
        resourceContents: {
          "db://schema/invoices": [
            { uri: "db://schema/invoices", text: "CREATE TABLE invoices..." },
          ],
        },
      });

      const client = createClientWithMock("db", mock);

      // Prime caches
      await client.listResources("db");
      await client.listResourceTemplates("db");

      const contents = await client.readResourceByURI("db://schema/invoices");

      expect(contents[0].text).toBe("CREATE TABLE invoices...");
    });

    it("throws when URI matches no server", async () => {
      const client = createClientWithMock(
        "db",
        mockSDKClient({ resources: [{ uri: "db://schema/users", name: "users" }] }),
      );

      await client.listResources("db");

      await expect(client.readResourceByURI("unknown://foo")).rejects.toThrow(
        "No MCP server found for resource URI",
      );
    });

    it("prefers exact URI match over template match", async () => {
      const mock = mockSDKClient({
        resources: [{ uri: "db://schema/users", name: "users" }],
        resourceTemplates: [{ uriTemplate: "db://schema/{table}", name: "table_schema" }],
        resourceContents: {
          "db://schema/users": [{ uri: "db://schema/users", text: "exact match" }],
        },
      });

      const client = createClientWithMock("db", mock);
      await client.listResources("db");
      await client.listResourceTemplates("db");

      const contents = await client.readResourceByURI("db://schema/users");

      expect(contents[0].text).toBe("exact match");
      // Should only have been called once (from the exact match path)
      expect(mock.readResource).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // Cache Invalidation
  // ============================================================================

  describe("invalidateResources", () => {
    it("clears cache for a specific server", async () => {
      const mock = mockSDKClient({
        resources: [{ uri: "db://x", name: "x" }],
      });
      const client = createClientWithMock("db", mock);

      await client.listResources("db");
      expect(mock.listResources).toHaveBeenCalledTimes(1);

      client.invalidateResources("db");

      await client.listResources("db");
      expect(mock.listResources).toHaveBeenCalledTimes(2);
    });

    it("clears cache for all servers", async () => {
      const mock1 = mockSDKClient({ resources: [{ uri: "a://1", name: "1" }] });
      const mock2 = mockSDKClient({ resources: [{ uri: "b://2", name: "2" }] });

      const client = new MCPClient();
      (client as any).clients.set("a", mock1);
      (client as any).clients.set("b", mock2);

      await client.listResources("a");
      await client.listResources("b");

      client.invalidateResources();

      await client.listResources("a");
      await client.listResources("b");

      expect(mock1.listResources).toHaveBeenCalledTimes(2);
      expect(mock2.listResources).toHaveBeenCalledTimes(2);
    });

    it("also clears template cache", async () => {
      const mock = mockSDKClient({
        resourceTemplates: [{ uriTemplate: "x://{id}", name: "x" }],
      });
      const client = createClientWithMock("svc", mock);

      await client.listResourceTemplates("svc");
      client.invalidateResources("svc");
      await client.listResourceTemplates("svc");

      expect(mock.listResourceTemplates).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================================
  // listAllResources / listAllResourceTemplates
  // ============================================================================

  describe("listAllResources", () => {
    it("aggregates resources from all connected servers", async () => {
      const client = new MCPClient();
      (client as any).clients.set(
        "db",
        mockSDKClient({ resources: [{ uri: "db://users", name: "users" }] }),
      );
      (client as any).clients.set(
        "fs",
        mockSDKClient({ resources: [{ uri: "file:///readme", name: "readme" }] }),
      );

      const all = await client.listAllResources();

      expect(all).toHaveLength(2);
      expect(all.map((r) => r.uri)).toContain("db://users");
      expect(all.map((r) => r.uri)).toContain("file:///readme");
    });

    it("returns empty array when no servers are connected", async () => {
      const client = new MCPClient();
      const all = await client.listAllResources();
      expect(all).toEqual([]);
    });
  });

  describe("listAllResourceTemplates", () => {
    it("aggregates templates from all connected servers", async () => {
      const client = new MCPClient();
      (client as any).clients.set(
        "db",
        mockSDKClient({ resourceTemplates: [{ uriTemplate: "db://{table}", name: "table" }] }),
      );
      (client as any).clients.set(
        "api",
        mockSDKClient({
          resourceTemplates: [{ uriTemplate: "api://{endpoint}", name: "endpoint" }],
        }),
      );

      const all = await client.listAllResourceTemplates();

      expect(all).toHaveLength(2);
    });
  });

  // ============================================================================
  // disconnect
  // ============================================================================

  describe("disconnect", () => {
    it("clears all caches for the disconnected server", async () => {
      const mock = mockSDKClient({
        resources: [{ uri: "db://x", name: "x" }],
        resourceTemplates: [{ uriTemplate: "db://{t}", name: "t" }],
      });
      const client = createClientWithMock("db", mock);

      await client.listResources("db");
      await client.listResourceTemplates("db");

      await client.disconnect("db");

      // Client should be gone
      expect(client.getClient("db")).toBeUndefined();

      // Caches should be cleared — next call should throw (no client)
      await expect(client.listResources("db")).rejects.toThrow("not connected");
    });
  });
});

// ============================================================================
// uriMatchesTemplate
// ============================================================================

describe("uriMatchesTemplate", () => {
  it("matches simple single-variable templates", () => {
    expect(uriMatchesTemplate("db://schema/users", "db://schema/{table}")).toBe(true);
    expect(uriMatchesTemplate("db://schema/orders", "db://schema/{table}")).toBe(true);
  });

  it("rejects URIs that don't match the template structure", () => {
    expect(uriMatchesTemplate("db://schema/users/columns", "db://schema/{table}")).toBe(false);
    expect(uriMatchesTemplate("file://readme", "db://schema/{table}")).toBe(false);
  });

  it("matches multi-variable templates", () => {
    expect(uriMatchesTemplate("db://mydb/users", "db://{database}/{table}")).toBe(true);
  });

  it("handles special regex characters in the URI scheme", () => {
    expect(uriMatchesTemplate("file+ssh://host/path", "file+ssh://host/{path}")).toBe(true);
  });

  it("requires exact match — no partial matches", () => {
    expect(uriMatchesTemplate("db://schema/users/extra", "db://schema/{table}")).toBe(false);
    expect(uriMatchesTemplate("db://schema/", "db://schema/{table}")).toBe(false);
  });

  it("handles empty template variables (no match)", () => {
    // The variable segment must be non-empty ([^/]+)
    expect(uriMatchesTemplate("db://schema/", "db://schema/{table}")).toBe(false);
  });
});
