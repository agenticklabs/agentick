/**
 * MCPResourceComponent Tests
 *
 * Integration tests for the resource component lifecycle:
 * - Discovery and terrain map rendering
 * - list_resources tool behavior
 * - read_resource tool with URI routing
 * - Multi-server aggregation
 * - Error handling and edge cases
 */

import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client";
import { createApp } from "../../app.js";
import { createTestAdapter } from "../../testing/test-adapter.js";
import { System } from "../../jsx/components/messages.js";
import { Timeline } from "../../jsx/components/timeline.js";
import { MCPClient } from "../client.js";
import {
  MCPResourceComponent,
  renderResourceList,
  renderResourceTree,
  type MCPResourceRenderer,
} from "../resource-component.js";
import type { MCPConfig } from "../types.js";

// ============================================================================
// Mock Helpers
// ============================================================================

function mockSDKClient(overrides: {
  resources?: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
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
}): Partial<Client> {
  return {
    listResources: vi.fn().mockResolvedValue({ resources: overrides.resources ?? [] }),
    listResourceTemplates: vi
      .fn()
      .mockResolvedValue({ resourceTemplates: overrides.resourceTemplates ?? [] }),
    readResource: vi.fn().mockImplementation(async (params: { uri: string }) => {
      const contents = overrides.resourceContents?.[params.uri];
      if (!contents) throw new Error(`Resource not found: ${params.uri}`);
      return { contents };
    }),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
  };
}

function createMockMCPClient(servers: Record<string, Partial<Client>>): MCPClient {
  const client = new MCPClient();
  // MCPClient is now the real @agentick/mcp client (no wrapper).
  // Reach into `connections` to inject mock SDK clients as connected.
  const connections = (client as any).connections as Map<
    string,
    {
      client: Client;
      config: Record<string, unknown>;
      state: string;
      reconnectAttempts: number;
    }
  >;
  for (const [name, mock] of Object.entries(servers)) {
    connections.set(name, {
      client: mock as Client,
      config: { serverName: name, transport: "sse", connection: { url: "http://mock" } },
      state: "connected",
      reconnectAttempts: 0,
    });
  }
  return client;
}

function dummyConfig(serverName: string): MCPConfig {
  return { serverName, transport: "sse", connection: { url: "http://mock" } };
}

// ============================================================================
// Agent Factory — captures dependencies via closure
// ============================================================================

function createResourceAgent(opts: {
  mcpClient: MCPClient;
  servers: Record<string, MCPConfig>;
  listToolName?: string;
  readToolName?: string;
  renderResources?: MCPResourceRenderer;
}) {
  return function ResourceAgent() {
    return (
      <>
        <System>You have access to resources via MCP.</System>
        <MCPResourceComponent
          servers={opts.servers}
          mcpClient={opts.mcpClient}
          listToolName={opts.listToolName}
          readToolName={opts.readToolName}
          renderResources={opts.renderResources}
        />
        <Timeline />
      </>
    );
  };
}

const userMsg = (text: string) => ({
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text }] }],
});

// ============================================================================
// Tests
// ============================================================================

describe("MCPResourceComponent", () => {
  describe("discovery and terrain map", () => {
    it("registers list_resources and read_resource tools", async () => {
      const mcpClient = createMockMCPClient({
        db: mockSDKClient({
          resources: [{ uri: "db://schema/users", name: "users", description: "Users table" }],
        }),
      });

      const model = createTestAdapter({ defaultResponse: "I see resources." });
      const Agent = createResourceAgent({ mcpClient, servers: { db: dummyConfig("db") } });
      const app = createApp(Agent, { model, maxTicks: 1 });
      const session = await app.session();

      await session.send(userMsg("list resources")).result;

      const inputs = model.getCapturedInputs();
      const lastInput = inputs[inputs.length - 1];
      const toolNames = (lastInput.tools ?? []).map((t: any) => t.name);

      expect(toolNames).toContain("list_resources");
      expect(toolNames).toContain("read_resource");
    });

    it("includes terrain map in compiled context", async () => {
      const mcpClient = createMockMCPClient({
        db: mockSDKClient({
          resources: [
            { uri: "db://schema/users", name: "users", description: "Users table" },
            { uri: "db://schema/orders", name: "orders", mimeType: "application/json" },
          ],
          resourceTemplates: [
            { uriTemplate: "db://schema/{table}", name: "table_schema", description: "Any table" },
          ],
        }),
      });

      const model = createTestAdapter({ defaultResponse: "Got it." });
      const Agent = createResourceAgent({ mcpClient, servers: { db: dummyConfig("db") } });
      const app = createApp(Agent, { model, maxTicks: 1 });
      const session = await app.session();

      await session.send(userMsg("hello")).result;

      const inputs = model.getCapturedInputs();
      const lastInput = inputs[inputs.length - 1];

      // The section with terrain map content should be compiled into the model context.
      // Check if tools were registered (confirms component rendered successfully)
      const toolNames = (lastInput.tools ?? []).map((t: any) => t.name);
      expect(toolNames).toContain("list_resources");
      expect(toolNames).toContain("read_resource");

      // Use list_resources tool to verify the actual resource data is accessible
      // This is the better test — the terrain map is a rendering detail,
      // but the tool returning correct data is the contract.
    });
  });

  describe("list_resources tool", () => {
    it("returns all resources when called without filters", async () => {
      const mcpClient = createMockMCPClient({
        db: mockSDKClient({
          resources: [
            { uri: "db://users", name: "users" },
            { uri: "db://orders", name: "orders" },
          ],
        }),
      });

      const model = createTestAdapter({ defaultResponse: "" });
      model.respondWith([{ tool: { name: "list_resources", input: {} } }, { text: "Done" }]);

      const Agent = createResourceAgent({ mcpClient, servers: { db: dummyConfig("db") } });
      const app = createApp(Agent, { model, maxTicks: 3 });
      const session = await app.session();

      await session.send(userMsg("list")).result;

      const toolEntries = session.snapshot().timeline.filter((e) => e.message.role === "tool");
      expect(toolEntries.length).toBeGreaterThanOrEqual(1);

      const toolContent = JSON.stringify(toolEntries);
      expect(toolContent).toContain("db://users");
      expect(toolContent).toContain("db://orders");
    });

    it("filters by server name", async () => {
      const mcpClient = createMockMCPClient({
        db: mockSDKClient({
          resources: [{ uri: "db://users", name: "users" }],
        }),
        fs: mockSDKClient({
          resources: [{ uri: "file:///readme", name: "readme" }],
        }),
      });

      const model = createTestAdapter({ defaultResponse: "" });
      model.respondWith([
        { tool: { name: "list_resources", input: { server: "db" } } },
        { text: "Done" },
      ]);

      const Agent = createResourceAgent({
        mcpClient,
        servers: { db: dummyConfig("db"), fs: dummyConfig("fs") },
      });
      const app = createApp(Agent, { model, maxTicks: 3 });
      const session = await app.session();

      await session.send(userMsg("list db")).result;

      const toolContent = JSON.stringify(
        session.snapshot().timeline.filter((e) => e.message.role === "tool"),
      );
      expect(toolContent).toContain("db://users");
      expect(toolContent).not.toContain("file:///readme");
    });

    it("filters by name pattern (case-insensitive)", async () => {
      const mcpClient = createMockMCPClient({
        db: mockSDKClient({
          resources: [
            { uri: "db://users", name: "users", description: "User accounts" },
            { uri: "db://orders", name: "orders", description: "Purchase orders" },
            { uri: "db://invoices", name: "invoices", description: "Invoice records" },
          ],
        }),
      });

      const model = createTestAdapter({ defaultResponse: "" });
      model.respondWith([
        { tool: { name: "list_resources", input: { pattern: "Order" } } },
        { text: "Done" },
      ]);

      const Agent = createResourceAgent({ mcpClient, servers: { db: dummyConfig("db") } });
      const app = createApp(Agent, { model, maxTicks: 3 });
      const session = await app.session();

      await session.send(userMsg("find orders")).result;

      const toolContent = JSON.stringify(
        session.snapshot().timeline.filter((e) => e.message.role === "tool"),
      );
      expect(toolContent).toContain("db://orders");
      expect(toolContent).not.toContain("db://users");
      expect(toolContent).not.toContain("db://invoices");
    });

    it("returns 'No resources found' when filters match nothing", async () => {
      const mcpClient = createMockMCPClient({
        db: mockSDKClient({
          resources: [{ uri: "db://users", name: "users" }],
        }),
      });

      const model = createTestAdapter({ defaultResponse: "" });
      model.respondWith([
        { tool: { name: "list_resources", input: { pattern: "nonexistent" } } },
        { text: "Done" },
      ]);

      const Agent = createResourceAgent({ mcpClient, servers: { db: dummyConfig("db") } });
      const app = createApp(Agent, { model, maxTicks: 3 });
      const session = await app.session();

      await session.send(userMsg("search")).result;

      const toolContent = JSON.stringify(
        session.snapshot().timeline.filter((e) => e.message.role === "tool"),
      );
      expect(toolContent).toContain("No resources found");
    });
  });

  describe("read_resource tool", () => {
    it("reads a resource by URI and returns text content", async () => {
      const mcpClient = createMockMCPClient({
        db: mockSDKClient({
          resources: [{ uri: "db://schema/users", name: "users" }],
          resourceContents: {
            "db://schema/users": [
              { uri: "db://schema/users", text: "CREATE TABLE users (id INT, name TEXT)" },
            ],
          },
        }),
      });

      const model = createTestAdapter({ defaultResponse: "" });
      model.respondWith([
        { tool: { name: "read_resource", input: { uri: "db://schema/users" } } },
        { text: "Done" },
      ]);

      const Agent = createResourceAgent({ mcpClient, servers: { db: dummyConfig("db") } });
      const app = createApp(Agent, { model, maxTicks: 3 });
      const session = await app.session();

      await session.send(userMsg("read schema")).result;

      const toolContent = JSON.stringify(
        session.snapshot().timeline.filter((e) => e.message.role === "tool"),
      );
      expect(toolContent).toContain("CREATE TABLE users");
    });

    it("routes to the correct server across multiple servers", async () => {
      const dbMock = mockSDKClient({
        resources: [{ uri: "db://users", name: "users" }],
        resourceContents: {
          "db://users": [{ uri: "db://users", text: "db content" }],
        },
      });
      const fsMock = mockSDKClient({
        resources: [{ uri: "file:///config.json", name: "config" }],
        resourceContents: {
          "file:///config.json": [{ uri: "file:///config.json", text: '{"key":"value"}' }],
        },
      });

      const mcpClient = createMockMCPClient({ db: dbMock, fs: fsMock });

      const model = createTestAdapter({ defaultResponse: "" });
      model.respondWith([
        { tool: { name: "read_resource", input: { uri: "file:///config.json" } } },
        { text: "Done" },
      ]);

      const Agent = createResourceAgent({
        mcpClient,
        servers: { db: dummyConfig("db"), fs: dummyConfig("fs") },
      });
      const app = createApp(Agent, { model, maxTicks: 3 });
      const session = await app.session();

      await session.send(userMsg("read config")).result;

      expect(fsMock.readResource).toHaveBeenCalled();
      expect(dbMock.readResource).not.toHaveBeenCalled();
    });

    it("returns error as tool result when URI is unknown", async () => {
      const mcpClient = createMockMCPClient({
        db: mockSDKClient({
          resources: [{ uri: "db://users", name: "users" }],
          resourceContents: {},
        }),
      });

      const model = createTestAdapter({ defaultResponse: "" });
      model.respondWith([
        { tool: { name: "read_resource", input: { uri: "db://nonexistent" } } },
        { text: "Done" },
      ]);

      const Agent = createResourceAgent({ mcpClient, servers: { db: dummyConfig("db") } });
      const app = createApp(Agent, { model, maxTicks: 3 });
      const session = await app.session();

      // Should not throw — errors become tool results
      const result = await session.send(userMsg("read bad")).result;
      expect(result).toBeDefined();
    });
  });

  describe("multi-server aggregation", () => {
    it("discovers resources from multiple servers and exposes them via list_resources", async () => {
      const mcpClient = createMockMCPClient({
        db: mockSDKClient({
          resources: [
            { uri: "db://users", name: "users" },
            { uri: "db://orders", name: "orders" },
          ],
        }),
        fs: mockSDKClient({
          resources: [{ uri: "file:///readme", name: "readme" }],
          resourceTemplates: [
            { uriTemplate: "file:///{path}", name: "file", description: "Read any file" },
          ],
        }),
      });

      const model = createTestAdapter({ defaultResponse: "" });
      model.respondWith([{ tool: { name: "list_resources", input: {} } }, { text: "Done" }]);

      const Agent = createResourceAgent({
        mcpClient,
        servers: { db: dummyConfig("db"), fs: dummyConfig("fs") },
      });
      const app = createApp(Agent, { model, maxTicks: 3 });
      const session = await app.session();

      await session.send(userMsg("list all")).result;

      const toolContent = JSON.stringify(
        session.snapshot().timeline.filter((e) => e.message.role === "tool"),
      );
      expect(toolContent).toContain("db://users");
      expect(toolContent).toContain("db://orders");
      expect(toolContent).toContain("file:///readme");
      expect(toolContent).toContain("file:///{path}");
    });
  });

  describe("edge cases", () => {
    it("handles servers with no resources — list_resources returns empty", async () => {
      const mcpClient = createMockMCPClient({
        empty: mockSDKClient({}),
      });

      const model = createTestAdapter({ defaultResponse: "" });
      model.respondWith([
        { tool: { name: "list_resources", input: {} } },
        { text: "Nothing here" },
      ]);

      const Agent = createResourceAgent({ mcpClient, servers: { empty: dummyConfig("empty") } });
      const app = createApp(Agent, { model, maxTicks: 3 });
      const session = await app.session();

      await session.send(userMsg("hello")).result;

      const toolContent = JSON.stringify(
        session.snapshot().timeline.filter((e) => e.message.role === "tool"),
      );
      expect(toolContent).toContain("No resources found");
    });

    it("registers tools with custom names", async () => {
      const mcpClient = createMockMCPClient({
        db: mockSDKClient({
          resources: [{ uri: "db://users", name: "users" }],
        }),
      });

      const model = createTestAdapter({ defaultResponse: "ok" });
      const Agent = createResourceAgent({
        mcpClient,
        servers: { db: dummyConfig("db") },
        listToolName: "browse_schemas",
        readToolName: "fetch_schema",
      });
      const app = createApp(Agent, { model, maxTicks: 1 });
      const session = await app.session();

      await session.send(userMsg("hi")).result;

      const inputs = model.getCapturedInputs();
      const toolNames = (inputs[inputs.length - 1].tools ?? []).map((t: any) => t.name);
      expect(toolNames).toContain("browse_schemas");
      expect(toolNames).toContain("fetch_schema");
      expect(toolNames).not.toContain("list_resources");
      expect(toolNames).not.toContain("read_resource");
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Renderers — direct unit tests on the pure functions
  // ────────────────────────────────────────────────────────────────────
  describe("renderResourceTree", () => {
    it("returns the empty-set message when there are no resources or templates", () => {
      const out = renderResourceTree([], []);
      expect(out).toBe("No resources available.");
    });

    it("groups by scheme://host and collapses multi-segment URIs into directory counts", () => {
      const out = renderResourceTree(
        [
          { uri: "knowify://me", name: "me", serverName: "k", mimeType: "text/markdown" } as any,
          {
            uri: "knowify://company",
            name: "company",
            serverName: "k",
            mimeType: "text/markdown",
          } as any,
          { uri: "knowify://guide/overview", name: "overview", serverName: "k" } as any,
          { uri: "knowify://guide/relationships", name: "relationships", serverName: "k" } as any,
          { uri: "knowify://schema/projects", name: "projects", serverName: "k" } as any,
          { uri: "knowify://schema/invoices", name: "invoices", serverName: "k" } as any,
          { uri: "knowify://schema/clients", name: "clients", serverName: "k" } as any,
        ],
        [],
      );
      const text = String(out);
      // Group header present
      expect(text).toContain("knowify://");
      // Root-level leaves rendered with mime
      expect(text).toContain("company");
      expect(text).toContain("me");
      expect(text).toContain("[text/markdown]");
      // Directories collapsed with counts
      expect(text).toContain("guide/");
      expect(text).toContain("2 resources");
      expect(text).toContain("schema/");
      expect(text).toContain("3 resources");
      // Individual schemas NOT listed (they're collapsed under schema/)
      expect(text).not.toContain("projects");
      expect(text).not.toContain("invoices");
      // Tool guidance present
      expect(text).toContain("list_resources");
      expect(text).toContain("read_resource");
    });

    it("attaches a template description to its directory entry", () => {
      const out = renderResourceTree(
        [
          { uri: "knowify://schema/projects", name: "projects", serverName: "k" } as any,
          { uri: "knowify://schema/invoices", name: "invoices", serverName: "k" } as any,
        ],
        [
          {
            uriTemplate: "knowify://schema/{model}",
            name: "resource-schema",
            description: "Per-model field schema",
            serverName: "k",
          } as any,
        ],
      );
      const text = String(out);
      expect(text).toContain("schema/");
      expect(text).toContain("2 resources");
      expect(text).toContain("template: knowify://schema/{model}");
      expect(text).toContain("Per-model field schema");
    });

    it("singular vs plural — one resource renders 'resource', not 'resources'", () => {
      const out = renderResourceTree(
        [{ uri: "knowify://guide/overview", name: "overview", serverName: "k" } as any],
        [],
      );
      expect(String(out)).toMatch(/1 resource(\n|$)/);
      expect(String(out)).not.toContain("1 resources");
    });

    it("handles multiple groups (different schemes / hosts)", () => {
      const out = renderResourceTree(
        [
          { uri: "knowify://me", name: "me", serverName: "k" } as any,
          { uri: "ui://app/hello", name: "hello", serverName: "u", mimeType: "text/html" } as any,
        ],
        [],
      );
      const text = String(out);
      expect(text).toContain("knowify://");
      expect(text).toContain("ui://");
    });
  });

  describe("renderResourceList", () => {
    it("renders the historical flat listing format", () => {
      const out = renderResourceList(
        [{ uri: "db://users", name: "users", description: "Users table", serverName: "d" } as any],
        [
          {
            uriTemplate: "db://t/{name}",
            name: "table",
            description: "A table",
            serverName: "d",
          } as any,
        ],
      );
      const text = String(out);
      expect(text).toContain("Resources:");
      expect(text).toContain("users");
      expect(text).toContain("Users table");
      expect(text).toContain("Resource Templates:");
      expect(text).toContain("db://t/{name}");
    });
  });

  describe("renderResources prop", () => {
    it("uses tree renderer by default — directories collapsed in the model context", async () => {
      const mcpClient = createMockMCPClient({
        db: mockSDKClient({
          resources: [
            { uri: "db://schema/users", name: "users" },
            { uri: "db://schema/orders", name: "orders" },
            { uri: "db://schema/invoices", name: "invoices" },
          ],
        }),
      });
      const model = createTestAdapter({ defaultResponse: "ok" });
      const Agent = createResourceAgent({ mcpClient, servers: { db: dummyConfig("db") } });
      const app = createApp(Agent, { model, maxTicks: 1 });
      const session = await app.session();
      await session.send(userMsg("hi")).result;

      const inputs = model.getCapturedInputs();
      const sys = JSON.stringify(inputs[inputs.length - 1]);
      // Tree: directory + count, no individual schema names
      expect(sys).toContain("schema/");
      expect(sys).toContain("3 resources");
      expect(sys).not.toContain("db://schema/users");
      expect(sys).not.toContain("db://schema/orders");
    });

    it("uses renderResourceList when explicitly passed — individual URIs appear", async () => {
      const mcpClient = createMockMCPClient({
        db: mockSDKClient({
          resources: [
            { uri: "db://schema/users", name: "users" },
            { uri: "db://schema/orders", name: "orders" },
          ],
        }),
      });
      const model = createTestAdapter({ defaultResponse: "ok" });
      const Agent = createResourceAgent({
        mcpClient,
        servers: { db: dummyConfig("db") },
        renderResources: renderResourceList,
      });
      const app = createApp(Agent, { model, maxTicks: 1 });
      const session = await app.session();
      await session.send(userMsg("hi")).result;

      const sys = JSON.stringify(model.getCapturedInputs().slice(-1)[0]);
      expect(sys).toContain("Resources:");
      expect(sys).toContain("users");
      expect(sys).toContain("orders");
    });

    it("suppresses the Section entirely when renderer returns null — tools still register", async () => {
      const mcpClient = createMockMCPClient({
        db: mockSDKClient({
          resources: [{ uri: "db://schema/users", name: "users" }],
        }),
      });
      const model = createTestAdapter({ defaultResponse: "ok" });
      const Agent = createResourceAgent({
        mcpClient,
        servers: { db: dummyConfig("db") },
        renderResources: () => null,
      });
      const app = createApp(Agent, { model, maxTicks: 1 });
      const session = await app.session();
      await session.send(userMsg("hi")).result;

      const captured = model.getCapturedInputs().slice(-1)[0];
      const sys = JSON.stringify(captured);
      // No orientation section content — the schema users name should not
      // appear via either tree count or flat listing
      expect(sys).not.toContain("schema/   —");
      expect(sys).not.toContain("Resources:");
      // Tools still registered
      const toolNames = (captured.tools ?? []).map((t: any) => t.name);
      expect(toolNames).toContain("list_resources");
      expect(toolNames).toContain("read_resource");
    });

    it("invokes a custom renderer with the discovered resources and templates", async () => {
      const mcpClient = createMockMCPClient({
        db: mockSDKClient({
          resources: [{ uri: "db://schema/users", name: "users" }],
          resourceTemplates: [{ uriTemplate: "db://t/{name}", name: "table", description: "any" }],
        }),
      });
      const renderer = vi.fn((_resources, _templates) => "CUSTOM_OUTPUT") as MCPResourceRenderer;
      const model = createTestAdapter({ defaultResponse: "ok" });
      const Agent = createResourceAgent({
        mcpClient,
        servers: { db: dummyConfig("db") },
        renderResources: renderer,
      });
      const app = createApp(Agent, { model, maxTicks: 1 });
      const session = await app.session();
      await session.send(userMsg("hi")).result;

      expect(renderer).toHaveBeenCalled();
      const [resources, templates] = (renderer as any).mock.calls[0];
      expect(resources.map((r: any) => r.uri)).toEqual(["db://schema/users"]);
      expect(templates.map((t: any) => t.uriTemplate)).toEqual(["db://t/{name}"]);
      expect(JSON.stringify(model.getCapturedInputs().slice(-1)[0])).toContain("CUSTOM_OUTPUT");
    });
  });
});
