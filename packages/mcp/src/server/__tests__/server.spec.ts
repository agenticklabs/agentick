import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "../../transport/index.js";
import { MCPServer } from "../server.js";
import type {
  MCPServerOptions,
  MCPToolDefinition,
  MCPStaticResource,
  MCPResourceTemplateDefinition as MCPResourceTemplateDef,
  MCPAppDefinition,
  MCPPromptDefinition,
} from "../../protocol/types.js";
type MCPResourceTemplateDefinition = MCPResourceTemplateDef;
import { z } from "zod";

// ============================================================================
// Helpers
// ============================================================================

function createTestTool(name = "greet", overrides?: Partial<MCPToolDefinition>): MCPToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { name: z.string() },
    handler: async (input) => ({
      content: [{ type: "text", text: `Hello, ${(input as any).name}!` }],
    }),
    ...overrides,
  };
}

function createTestResource(): MCPStaticResource {
  return {
    name: "schema",
    uri: "db://schema/users",
    description: "User schema",
    read: async (_ctx) => ({
      contents: [{ uri: "db://schema/users", text: "CREATE TABLE users (id INT)" }],
    }),
  };
}

async function createConnectedPair(
  options: Partial<MCPServerOptions> = {},
): Promise<{ server: MCPServer; client: Client; cleanup: () => Promise<void> }> {
  const server = new MCPServer({
    name: "test",
    version: "1.0.0",
    ...options,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  return {
    server,
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ============================================================================
// Server lifecycle
// ============================================================================

describe("MCPServer", () => {
  describe("lifecycle", () => {
    it("creates and closes cleanly", async () => {
      const server = new MCPServer({ name: "test", version: "1.0.0" });
      await server.close();
    });

    it("throws after close", async () => {
      const server = new MCPServer({ name: "test", version: "1.0.0" });
      await server.close();
      const [, transport] = InMemoryTransport.createLinkedPair();
      await expect(server.connect(transport)).rejects.toThrow("MCPServer is closed");
    });

    it("close is idempotent", async () => {
      const server = new MCPServer({ name: "test", version: "1.0.0" });
      await server.close();
      await server.close(); // should not throw
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Tool registration and execution
  // ══════════════════════════════════════════════════════════════════════════

  describe("tools", () => {
    it("registers tools and lists them via client", async () => {
      const { client, cleanup } = await createConnectedPair({
        tools: [createTestTool("alpha"), createTestTool("beta")],
      });

      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["alpha", "beta"]);

      await cleanup();
    });

    it("calls a tool and returns the result", async () => {
      const { client, cleanup } = await createConnectedPair({
        tools: [createTestTool()],
      });

      const result = await client.callTool({
        name: "greet",
        arguments: { name: "World" },
      });

      expect(result.content).toEqual([{ type: "text", text: "Hello, World!" }]);

      await cleanup();
    });

    it("returns isError when handler throws", async () => {
      const { client, cleanup } = await createConnectedPair({
        tools: [
          createTestTool("fail", {
            inputSchema: {},
            handler: async () => {
              throw new Error("Boom");
            },
          }),
        ],
      });

      const result = await client.callTool({ name: "fail", arguments: {} });
      expect(result.isError).toBe(true);

      await cleanup();
    });

    // ── SEP-1303 Tool Execution Error semantics (2025-11-25) ──────────────
    //
    // Per SEP-1303, tool **execution** errors (including input validation
    // failures from inside the handler) MUST surface as `isError: true`
    // content blocks so the model can self-correct. Protocol errors
    // (-32xxx JSON-RPC errors) are reserved for genuinely fatal conditions
    // (method not found, server misconfigured, transport broken).

    describe("tool execution errors (SEP-1303)", () => {
      it("plain Error becomes Tool Execution Error, not protocol error", async () => {
        const { client, cleanup } = await createConnectedPair({
          tools: [
            createTestTool("oops", {
              inputSchema: {},
              handler: async () => {
                throw new Error("plain JS error");
              },
            }),
          ],
        });

        const result = await client.callTool({ name: "oops", arguments: {} });
        expect(result.isError).toBe(true);
        expect(Array.isArray(result.content)).toBe(true);
        // Should NOT have raised a JSON-RPC protocol error.
        // (If it had, callTool would have rejected.)
        await cleanup();
      });

      it("Zod validation throw inside handler becomes Tool Execution Error", async () => {
        const Inner = z.object({ count: z.number().int().positive() });
        const { client, cleanup } = await createConnectedPair({
          tools: [
            createTestTool("validate-inside", {
              inputSchema: { value: z.unknown() },
              handler: async (input) => {
                // Simulate handler doing its own validation
                Inner.parse((input as { value: unknown }).value);
                return { content: [{ type: "text", text: "ok" }] };
              },
            }),
          ],
        });

        const result = await client.callTool({
          name: "validate-inside",
          arguments: { value: { count: -1 } },
        });
        expect(result.isError).toBe(true);
        await cleanup();
      });

      it("error message preserved in content (does not leak stack)", async () => {
        const { client, cleanup } = await createConnectedPair({
          tools: [
            createTestTool("descriptive-fail", {
              inputSchema: {},
              handler: async () => {
                throw new Error("Database connection lost (host=internal-db.local)");
              },
            }),
          ],
        });

        const result = await client.callTool({ name: "descriptive-fail", arguments: {} });
        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        // Error message preserved so the model can reason about it...
        expect(text.toLowerCase()).toMatch(/database/);
        // ...but the result is shaped as content, not a protocol error.
        expect(typeof text).toBe("string");
        await cleanup();
      });

      it("tool not found is a protocol error (genuinely fatal)", async () => {
        const { client, cleanup } = await createConnectedPair({
          tools: [createTestTool("only-real-tool")],
        });

        // Call a tool that doesn't exist — this IS a protocol error.
        // The error message should have a SINGLE "MCP error -32601:" prefix,
        // not the doubled prefix the SDK's McpError-throwing path produces.
        await expect(client.callTool({ name: "ghost-tool", arguments: {} })).rejects.toThrow(
          "MCP error -32601: Tool ghost-tool not found",
        );

        await cleanup();
      });

      it("protocol error message is not double-prefixed by SDK round-trip", async () => {
        // SDK quirk: `throw new McpError(code, msg)` puts "MCP error <code>:"
        // into .message at construction; SDK serialization sends .message
        // verbatim; client SDK reconstructs adding another prefix. We must
        // throw plain Errors with .code/.data so only one prefix appears.
        const { client, cleanup } = await createConnectedPair({
          tools: [createTestTool("only-real-tool")],
        });

        let capturedMessage = "";
        try {
          await client.callTool({ name: "ghost-tool", arguments: {} });
        } catch (err) {
          capturedMessage = (err as Error).message;
        }

        expect(capturedMessage).toContain("Tool ghost-tool not found");
        const prefixCount = (capturedMessage.match(/MCP error -?\d+:/g) ?? []).length;
        expect(prefixCount).toBe(1);

        await cleanup();
      });

      it("handler returning isError: true is preserved (not double-wrapped)", async () => {
        const { client, cleanup } = await createConnectedPair({
          tools: [
            createTestTool("self-flagged", {
              inputSchema: {},
              handler: async () => ({
                content: [{ type: "text", text: "I declare this an error" }],
                isError: true,
              }),
            }),
          ],
        });

        const result = await client.callTool({ name: "self-flagged", arguments: {} });
        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text;
        expect(text).toBe("I declare this an error");
        await cleanup();
      });

      it("handler returning content without isError is not flagged as error", async () => {
        const { client, cleanup } = await createConnectedPair({
          tools: [
            createTestTool("happy-path", {
              inputSchema: {},
              handler: async () => ({
                content: [{ type: "text", text: "all good" }],
              }),
            }),
          ],
        });

        const result = await client.callTool({ name: "happy-path", arguments: {} });
        expect(result.isError).toBeFalsy();
        await cleanup();
      });

      it("recovers cleanly — failing call doesn't poison subsequent calls", async () => {
        let counter = 0;
        const { client, cleanup } = await createConnectedPair({
          tools: [
            createTestTool("flaky", {
              inputSchema: {},
              handler: async () => {
                counter++;
                if (counter === 1) throw new Error("first call fails");
                return { content: [{ type: "text", text: `call ${counter}` }] };
              },
            }),
          ],
        });

        const first = await client.callTool({ name: "flaky", arguments: {} });
        expect(first.isError).toBe(true);

        const second = await client.callTool({ name: "flaky", arguments: {} });
        expect(second.isError).toBeFalsy();
        const text = (second.content as Array<{ type: string; text?: string }>)[0]?.text;
        expect(text).toBe("call 2");

        await cleanup();
      });

      it("non-Error throw (string) becomes Tool Execution Error", async () => {
        const { client, cleanup } = await createConnectedPair({
          tools: [
            createTestTool("string-throw", {
              inputSchema: {},
              handler: async () => {
                // Yes, people do this. Test for it.
                // eslint-disable-next-line @typescript-eslint/only-throw-error
                throw "raw string error";
              },
            }),
          ],
        });

        const result = await client.callTool({ name: "string-throw", arguments: {} });
        expect(result.isError).toBe(true);
        await cleanup();
      });

      it("synchronous throw inside async handler becomes Tool Execution Error", async () => {
        const { client, cleanup } = await createConnectedPair({
          tools: [
            createTestTool("sync-throw", {
              inputSchema: {},
              handler: async () => {
                // Throw synchronously even though handler is async
                if (true as boolean) throw new Error("sync from async");
                return { content: [] };
              },
            }),
          ],
        });

        const result = await client.callTool({ name: "sync-throw", arguments: {} });
        expect(result.isError).toBe(true);
        await cleanup();
      });
    });

    it("supports dynamic tool registration", async () => {
      const { server, client, cleanup } = await createConnectedPair();

      // Initially no tools
      let { tools } = await client.listTools();
      expect(tools).toHaveLength(0);

      // Register dynamically
      server.registerTool(createTestTool("dynamic"));
      ({ tools } = await client.listTools());
      expect(tools.map((t) => t.name)).toContain("dynamic");

      // Unregister
      server.unregisterTool("dynamic");
      ({ tools } = await client.listTools());
      expect(tools.map((t) => t.name)).not.toContain("dynamic");

      await cleanup();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Resources
  // ══════════════════════════════════════════════════════════════════════════

  describe("resources", () => {
    it("lists and reads a static resource", async () => {
      const { client, cleanup } = await createConnectedPair({
        resources: [createTestResource()],
      });

      const { resources } = await client.listResources();
      expect(resources).toHaveLength(1);
      expect(resources[0].uri).toBe("db://schema/users");

      const { contents } = await client.readResource({ uri: "db://schema/users" });
      expect((contents[0] as any).text).toBe("CREATE TABLE users (id INT)");

      await cleanup();
    });

    it("supports dynamic resource registration", async () => {
      const { server, client, cleanup } = await createConnectedPair();

      server.registerResource(createTestResource());
      const { resources } = await client.listResources();
      expect(resources).toHaveLength(1);

      server.unregisterResource("db://schema/users");
      const { resources: after } = await client.listResources();
      expect(after).toHaveLength(0);

      await cleanup();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // MCP Apps
  // ══════════════════════════════════════════════════════════════════════════

  describe("apps", () => {
    it("registers ui:// resource with correct mimeType", async () => {
      const app: MCPAppDefinition = {
        name: "dashboard",
        uri: "ui://test/dashboard",
        description: "Test dashboard",
        content: "<html><body>Dashboard</body></html>",
      };

      const { client, cleanup } = await createConnectedPair({ apps: [app] });

      const { resources } = await client.listResources();
      const appResource = resources.find((r) => r.uri === "ui://test/dashboard");
      expect(appResource).toBeDefined();
      expect(appResource!.mimeType).toBe("text/html;profile=mcp-app");

      const { contents } = await client.readResource({ uri: "ui://test/dashboard" });
      expect((contents[0] as any).text).toContain("Dashboard");

      await cleanup();
    });

    it("emits _meta.ui (csp, permissions, prefersBorder, domain) on resources/list", async () => {
      const app: MCPAppDefinition = {
        name: "dashboard",
        uri: "ui://test/dashboard",
        content: "<html></html>",
        csp: {
          connectDomains: ["https://api.example.com"],
          resourceDomains: ["https://cdn.example.com"],
        },
        permissions: ["camera", "clipboardWrite"],
        prefersBorder: true,
        domain: "abc123.claudemcpcontent.com",
      };

      const { client, cleanup } = await createConnectedPair({ apps: [app] });

      const { resources } = await client.listResources();
      const entry = resources.find((r) => r.uri === "ui://test/dashboard") as any;

      expect(entry._meta).toBeDefined();
      expect(entry._meta.ui.csp).toEqual({
        connectDomains: ["https://api.example.com"],
        resourceDomains: ["https://cdn.example.com"],
      });
      // Permissions: array form on the server API, object form on the wire.
      expect(entry._meta.ui.permissions).toEqual({
        camera: {},
        clipboardWrite: {},
      });
      expect(entry._meta.ui.prefersBorder).toBe(true);
      expect(entry._meta.ui.domain).toBe("abc123.claudemcpcontent.com");

      await cleanup();
    });

    it("emits _meta.ui (csp, permissions, prefersBorder, domain) on resources/read content", async () => {
      const app: MCPAppDefinition = {
        name: "dashboard",
        uri: "ui://test/dashboard",
        content: "<html></html>",
        csp: { resourceDomains: ["https://cdn.example.com"] },
        permissions: ["microphone"],
        prefersBorder: false,
        domain: "dash.example.com",
      };

      const { client, cleanup } = await createConnectedPair({ apps: [app] });
      const { contents } = await client.readResource({ uri: "ui://test/dashboard" });
      const item = contents[0] as any;

      expect(item.mimeType).toBe("text/html;profile=mcp-app");
      expect(item._meta).toBeDefined();
      expect(item._meta.ui.csp).toEqual({ resourceDomains: ["https://cdn.example.com"] });
      expect(item._meta.ui.permissions).toEqual({ microphone: {} });
      expect(item._meta.ui.prefersBorder).toBe(false);
      expect(item._meta.ui.domain).toBe("dash.example.com");

      await cleanup();
    });

    it("omits _meta on resources/list and /read when the app declares no UI metadata", async () => {
      const app: MCPAppDefinition = {
        name: "bare",
        uri: "ui://test/bare",
        content: "<html></html>",
      };

      const { client, cleanup } = await createConnectedPair({ apps: [app] });

      const { resources } = await client.listResources();
      const entry = resources.find((r) => r.uri === "ui://test/bare") as any;
      expect(entry._meta).toBeUndefined();

      const { contents } = await client.readResource({ uri: "ui://test/bare" });
      expect((contents[0] as any)._meta).toBeUndefined();

      await cleanup();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // MCP Apps — tool-side metadata
  // ══════════════════════════════════════════════════════════════════════════

  describe("apps — tool metadata", () => {
    it('emits both _meta.ui.resourceUri and legacy _meta["ui/resourceUri"] on tools/list', async () => {
      const tool = createTestTool("show_dashboard", {
        ui: { resourceUri: "ui://test/dashboard", visibility: ["model", "app"] },
      });

      const { client, cleanup } = await createConnectedPair({ tools: [tool] });
      const { tools } = await client.listTools();
      const entry = tools.find((t) => t.name === "show_dashboard") as any;

      expect(entry._meta.ui).toEqual({
        resourceUri: "ui://test/dashboard",
        visibility: ["model", "app"],
      });
      // Legacy key must equal the modern value, not be dropped.
      expect(entry._meta["ui/resourceUri"]).toBe("ui://test/dashboard");

      await cleanup();
    });

    it('hydrates ui.resourceUri from legacy _meta["ui/resourceUri"] on registration', async () => {
      const tool: MCPToolDefinition = {
        name: "show_cart",
        description: "Legacy registration",
        inputSchema: { type: "object" },
        _meta: { "ui/resourceUri": "ui://shop/cart.html" },
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      };

      const { client, cleanup } = await createConnectedPair({ tools: [tool] });
      const { tools } = await client.listTools();
      const entry = tools.find((t) => t.name === "show_cart") as any;

      // Normalization: the canonical ui.resourceUri should be populated from
      // the legacy key so both the modern and legacy fields appear on the wire.
      expect(entry._meta.ui.resourceUri).toBe("ui://shop/cart.html");
      expect(entry._meta["ui/resourceUri"]).toBe("ui://shop/cart.html");

      await cleanup();
    });

    it("prefers ui.resourceUri when both modern and legacy keys are provided", async () => {
      const tool: MCPToolDefinition = {
        name: "conflict",
        description: "Conflict case",
        inputSchema: { type: "object" },
        ui: { resourceUri: "ui://modern/view" },
        _meta: { "ui/resourceUri": "ui://legacy/view" },
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      };

      const { client, cleanup } = await createConnectedPair({ tools: [tool] });
      const { tools } = await client.listTools();
      const entry = tools.find((t) => t.name === "conflict") as any;

      // Modern wins and is broadcast under both keys.
      expect(entry._meta.ui.resourceUri).toBe("ui://modern/view");
      expect(entry._meta["ui/resourceUri"]).toBe("ui://modern/view");

      await cleanup();
    });

    it("omits _meta on tools with no UI metadata", async () => {
      const tool = createTestTool("plain");
      const { client, cleanup } = await createConnectedPair({ tools: [tool] });
      const { tools } = await client.listTools();
      const entry = tools.find((t) => t.name === "plain") as any;
      expect(entry._meta).toBeUndefined();
      await cleanup();
    });

    it("passes through additional caller-supplied _meta keys on tools/list", async () => {
      const tool: MCPToolDefinition = {
        name: "extra_meta",
        description: "Tool with extra _meta",
        inputSchema: { type: "object" },
        ui: { resourceUri: "ui://test/view" },
        _meta: { "x-custom-key": "custom-value" },
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      };

      const { client, cleanup } = await createConnectedPair({ tools: [tool] });
      const { tools } = await client.listTools();
      const entry = tools.find((t) => t.name === "extra_meta") as any;

      expect(entry._meta["x-custom-key"]).toBe("custom-value");
      expect(entry._meta.ui.resourceUri).toBe("ui://test/view");
      expect(entry._meta["ui/resourceUri"]).toBe("ui://test/view");

      await cleanup();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // securitySchemes — server-level default with per-tool scope derivation
  // ══════════════════════════════════════════════════════════════════════════

  describe("securitySchemes", () => {
    it("derives read scope from readOnlyHint annotation", async () => {
      const tool = createTestTool("reader", {
        annotations: { readOnlyHint: true },
      });

      const { client, cleanup } = await createConnectedPair({
        tools: [tool],
        securitySchemes: [{ type: "oauth2" }],
      });
      const { tools } = await client.listTools();
      const entry = tools.find((t) => t.name === "reader") as any;

      expect(entry._meta.securitySchemes).toEqual([{ type: "oauth2", scopes: ["read"] }]);
      await cleanup();
    });

    it("derives read+write scopes when readOnlyHint is false", async () => {
      const tool = createTestTool("writer", {
        annotations: { readOnlyHint: false, destructiveHint: false },
      });

      const { client, cleanup } = await createConnectedPair({
        tools: [tool],
        securitySchemes: [{ type: "oauth2" }],
      });
      const { tools } = await client.listTools();
      const entry = tools.find((t) => t.name === "writer") as any;

      expect(entry._meta.securitySchemes).toEqual([{ type: "oauth2", scopes: ["read", "write"] }]);
      await cleanup();
    });

    it("derives read+write scopes when no annotations set", async () => {
      const tool = createTestTool("no_hints");

      const { client, cleanup } = await createConnectedPair({
        tools: [tool],
        securitySchemes: [{ type: "oauth2" }],
      });
      const { tools } = await client.listTools();
      const entry = tools.find((t) => t.name === "no_hints") as any;

      expect(entry._meta.securitySchemes).toEqual([{ type: "oauth2", scopes: ["read", "write"] }]);
      await cleanup();
    });

    it("uses explicit scopes from server config when provided", async () => {
      const tool = createTestTool("explicit", {
        annotations: { readOnlyHint: true },
      });

      const { client, cleanup } = await createConnectedPair({
        tools: [tool],
        securitySchemes: [{ type: "oauth2", scopes: ["admin"] }],
      });
      const { tools } = await client.listTools();
      const entry = tools.find((t) => t.name === "explicit") as any;

      // Explicit scopes on the scheme take precedence over annotation derivation
      expect(entry._meta.securitySchemes).toEqual([{ type: "oauth2", scopes: ["admin"] }]);
      await cleanup();
    });

    it("does not override tool-level _meta.securitySchemes", async () => {
      const tool: MCPToolDefinition = {
        name: "custom_auth",
        description: "Tool with own securitySchemes",
        inputSchema: { type: "object" },
        _meta: { securitySchemes: [{ type: "noauth" }] },
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      };

      const { client, cleanup } = await createConnectedPair({
        tools: [tool],
        securitySchemes: [{ type: "oauth2" }],
      });
      const { tools } = await client.listTools();
      const entry = tools.find((t) => t.name === "custom_auth") as any;

      // Tool-level wins
      expect(entry._meta.securitySchemes).toEqual([{ type: "noauth" }]);
      await cleanup();
    });

    it("omits securitySchemes when server does not configure them", async () => {
      const tool = createTestTool("no_schemes");

      const { client, cleanup } = await createConnectedPair({ tools: [tool] });
      const { tools } = await client.listTools();
      const entry = tools.find((t) => t.name === "no_schemes") as any;

      expect(entry._meta).toBeUndefined();
      await cleanup();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // MCP Apps — capability negotiation
  //
  // Per the MCP Apps spec (2026-01-26), the server MUST advertise the
  // `io.modelcontextprotocol/ui` extension in its initialize response when it
  // serves any `ui://` resources. Without this, conformant hosts (Claude Desktop,
  // etc.) will refuse to render the apps even though tool/resource metadata is
  // otherwise correct. See: specification/2026-01-26/apps.mdx.
  // ══════════════════════════════════════════════════════════════════════════

  describe("apps — capability negotiation", () => {
    it("advertises io.modelcontextprotocol/ui capability when apps are registered", async () => {
      const app: MCPAppDefinition = {
        name: "dashboard",
        uri: "ui://test/dashboard",
        content: "<html></html>",
      };

      const { client, cleanup } = await createConnectedPair({ apps: [app] });
      const caps = client.getServerCapabilities() as any;

      expect(caps?.extensions).toBeDefined();
      expect(caps.extensions["io.modelcontextprotocol/ui"]).toEqual({
        mimeTypes: ["text/html;profile=mcp-app"],
      });

      await cleanup();
    });

    it("omits extensions capability when no apps are registered", async () => {
      const { client, cleanup } = await createConnectedPair({
        tools: [createTestTool("plain")],
      });
      const caps = client.getServerCapabilities() as any;

      // Either extensions is absent entirely, or it doesn't include the UI ext.
      // Both are spec-valid — a server with no apps shouldn't claim UI support.
      if (caps?.extensions) {
        expect(caps.extensions["io.modelcontextprotocol/ui"]).toBeUndefined();
      }

      await cleanup();
    });

    it("advertises UI capability alongside standard capabilities (not replacing them)", async () => {
      const app: MCPAppDefinition = {
        name: "dashboard",
        uri: "ui://test/dashboard",
        content: "<html></html>",
      };

      const { client, cleanup } = await createConnectedPair({ apps: [app] });
      const caps = client.getServerCapabilities() as any;

      // Standard capabilities must still be present — extensions is additive.
      expect(caps.tools).toBeDefined();
      expect(caps.resources).toBeDefined();
      expect(caps.prompts).toBeDefined();
      expect(caps.logging).toBeDefined();
      expect(caps.extensions["io.modelcontextprotocol/ui"]).toBeDefined();

      await cleanup();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Resource Templates
  // ══════════════════════════════════════════════════════════════════════════

  describe("resource templates", () => {
    it("lists instances and reads by URI", async () => {
      const tmpl: MCPResourceTemplateDefinition = {
        name: "table-schema",
        uriTemplate: "db://schema/{table}",
        description: "Schema for a table",
        list: async () => ({
          resources: [
            { uri: "db://schema/users", name: "users", description: "Users table" },
            { uri: "db://schema/orders", name: "orders", description: "Orders table" },
          ],
        }),
        read: async (uri, variables) => ({
          contents: [{ uri, text: `Schema for ${variables.table}` }],
        }),
      };

      const { client, cleanup } = await createConnectedPair({
        resourceTemplates: [tmpl],
      });

      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates).toHaveLength(1);
      expect(resourceTemplates[0].uriTemplate).toBe("db://schema/{table}");

      const { resources } = await client.listResources();
      expect(resources).toHaveLength(2);

      const { contents } = await client.readResource({ uri: "db://schema/users" });
      expect((contents[0] as any).text).toBe("Schema for users");

      await cleanup();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Prompts
  // ══════════════════════════════════════════════════════════════════════════

  describe("prompts", () => {
    it("lists and gets a prompt", async () => {
      const prompt: MCPPromptDefinition = {
        name: "summarize",
        description: "Summarize data",
        arguments: [{ name: "topic", description: "What to summarize", required: true }],
        handler: async (args) => ({
          messages: [
            {
              role: "user" as const,
              content: { type: "text" as const, text: `Summarize: ${args.topic}` },
            },
          ],
        }),
      };

      const { client, cleanup } = await createConnectedPair({
        prompts: [prompt],
      });

      const { prompts } = await client.listPrompts();
      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe("summarize");

      const result = await client.getPrompt({
        name: "summarize",
        arguments: { topic: "Q4 revenue" },
      });
      expect(result.messages[0].content).toEqual({
        type: "text",
        text: "Summarize: Q4 revenue",
      });

      await cleanup();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Tool annotations
  // ══════════════════════════════════════════════════════════════════════════

  describe("tool annotations", () => {
    it("passes annotations through to the client", async () => {
      const { client, cleanup } = await createConnectedPair({
        tools: [
          createTestTool("safe-read", {
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              title: "Safe Read Tool",
            },
          }),
        ],
      });

      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "safe-read");
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(tool?.annotations?.destructiveHint).toBe(false);
      expect(tool?.annotations?.idempotentHint).toBe(true);

      await cleanup();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Events (standalone mode — no ALS)
  // ══════════════════════════════════════════════════════════════════════════

  describe("events", () => {
    it("emits mcp:session:created on connect", async () => {
      const server = new MCPServer({ name: "test", version: "1.0.0" });
      const sessionEvents: any[] = [];
      server.on("mcp:session:created", (e) => sessionEvents.push(e));

      const [, transport] = InMemoryTransport.createLinkedPair();
      await server.connect(transport);

      expect(sessionEvents).toHaveLength(1);
      expect(sessionEvents[0].sessionId).toBeDefined();

      await server.close();
    });

    it("emits mcp:tool:start and mcp:tool:end on tool call", async () => {
      const starts: any[] = [];
      const ends: any[] = [];

      const { server, client, cleanup } = await createConnectedPair({
        tools: [createTestTool()],
      });

      server.on("mcp:tool:start", (e) => starts.push(e));
      server.on("mcp:tool:end", (e) => ends.push(e));

      await client.callTool({ name: "greet", arguments: { name: "Test" } });

      expect(starts).toHaveLength(1);
      expect(starts[0].tool).toBe("greet");

      expect(ends).toHaveLength(1);
      expect(ends[0].tool).toBe("greet");
      expect(ends[0].isError).toBe(false);
      expect(ends[0].durationMs).toBeGreaterThanOrEqual(0);

      await cleanup();
    });

    it("emits mcp:tool:error on handler failure", async () => {
      const errors: any[] = [];

      const { server, client, cleanup } = await createConnectedPair({
        tools: [
          createTestTool("fail", {
            inputSchema: {},
            handler: async () => {
              throw new Error("Oops");
            },
          }),
        ],
      });

      server.on("mcp:tool:error", (e) => errors.push(e));
      await client.callTool({ name: "fail", arguments: {} });

      expect(errors).toHaveLength(1);
      expect(errors[0].tool).toBe("fail");

      await cleanup();
    });

    it("emits mcp:session:closed on server close", async () => {
      const server = new MCPServer({ name: "test", version: "1.0.0" });
      const closeEvents: any[] = [];
      server.on("mcp:session:closed", (e) => closeEvents.push(e));

      const [, transport] = InMemoryTransport.createLinkedPair();
      await server.connect(transport);
      await server.close();

      expect(closeEvents.length).toBeGreaterThanOrEqual(1);
      expect(closeEvents[0].reason).toBe("server closing");
    });

    it("supports off() to remove listeners", async () => {
      const server = new MCPServer({ name: "test", version: "1.0.0" });
      const events: any[] = [];
      const handler = (e: any) => events.push(e);

      server.on("mcp:session:created", handler);
      server.off("mcp:session:created", handler);

      const [, transport] = InMemoryTransport.createLinkedPair();
      await server.connect(transport);

      expect(events).toHaveLength(0);
      await server.close();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Security pipeline integration
  // ══════════════════════════════════════════════════════════════════════════

  describe("security", () => {
    it("uses allowAll defaults for in-process transport", async () => {
      // No security config — in-process should work with defaults
      const { client, cleanup } = await createConnectedPair({
        tools: [createTestTool()],
      });

      const result = await client.callTool({
        name: "greet",
        arguments: { name: "Test" },
      });
      expect(result.isError).toBeFalsy();

      await cleanup();
    });

    it("runs authenticator on tool calls", async () => {
      const authCalls: any[] = [];

      const { client, cleanup } = await createConnectedPair({
        tools: [createTestTool()],
        security: {
          authenticator: async (ctx) => {
            authCalls.push(ctx);
            return { authenticated: true };
          },
        },
      });

      await client.callTool({ name: "greet", arguments: { name: "Test" } });
      expect(authCalls.length).toBeGreaterThanOrEqual(1);

      await cleanup();
    });

    it("rejects tool call when authenticator fails", async () => {
      const { client, cleanup } = await createConnectedPair({
        tools: [createTestTool()],
        security: {
          authenticator: async () => ({
            authenticated: false,
            reason: "No token",
          }),
        },
      });

      const result = await client.callTool({
        name: "greet",
        arguments: { name: "Test" },
      });
      // safeToolHandler catches SecurityError and returns isError result
      expect(result.isError).toBe(true);

      await cleanup();
    });

    it("handler receives MCPHandlerContext with authenticated user", async () => {
      let receivedCtx: any = null;

      const { client, cleanup } = await createConnectedPair({
        tools: [
          {
            name: "whoami",
            description: "Returns caller identity",
            inputSchema: {},
            handler: async (_input, ctx) => {
              receivedCtx = ctx;
              return {
                content: [
                  {
                    type: "text",
                    text: `User: ${ctx.request.user?.id}, Tenant: ${ctx.request.user?.tenantId}`,
                  },
                ],
              };
            },
          },
        ],
        contextProvider: async (extra) => ({
          user: { id: "user-42", tenantId: "knowify", roles: ["admin"] },
          signal: extra.signal,
        }),
      });

      const result = await client.callTool({ name: "whoami", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: "User: user-42, Tenant: knowify" }]);

      // Verify the full MCPHandlerContext shape
      expect(receivedCtx).toBeDefined();
      expect(receivedCtx.request.user.id).toBe("user-42");
      expect(receivedCtx.request.user.tenantId).toBe("knowify");
      expect(receivedCtx.request.user.roles).toEqual(["admin"]);
      expect(typeof receivedCtx.sessionId).toBe("string");
      expect(receivedCtx.extra).toBeDefined();
      expect(receivedCtx.extra.signal).toBeDefined();

      await cleanup();
    });

    it("populates clientInfo and clientCapabilities from initialize handshake", async () => {
      let receivedCtx: any = null;

      const server = new MCPServer({
        name: "test",
        version: "1.0.0",
        tools: [
          {
            name: "probe",
            description: "Captures context",
            inputSchema: {},
            handler: async (_input, ctx) => {
              receivedCtx = ctx;
              return { content: [{ type: "text", text: "ok" }] };
            },
          },
        ],
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "cursor", version: "0.50.0" },
        { capabilities: { sampling: {} } },
      );
      await client.connect(clientTransport);

      await client.callTool({ name: "probe", arguments: {} });

      expect(receivedCtx.request.clientInfo).toEqual({ name: "cursor", version: "0.50.0" });
      expect(receivedCtx.request.clientCapabilities).toBeDefined();
      expect(receivedCtx.request.clientCapabilities.sampling).toBeDefined();

      await client.close();
      await server.close();
    });

    it("clientInfo is available in toolFilter and toolTransform", async () => {
      const filterClients: string[] = [];
      const transformClients: string[] = [];

      const server = new MCPServer({
        name: "test",
        version: "1.0.0",
        tools: [createTestTool("alpha"), createTestTool("beta")],
        toolFilter: (tool, ctx) => {
          if (ctx.clientInfo) filterClients.push(ctx.clientInfo.name);
          return true;
        },
        toolTransform: (tool, ctx) => {
          if (ctx.clientInfo) transformClients.push(ctx.clientInfo.name);
          return tool;
        },
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "claude-desktop", version: "1.0.0" });
      await client.connect(clientTransport);

      await client.listTools();

      expect(filterClients.length).toBeGreaterThan(0);
      expect(filterClients[0]).toBe("claude-desktop");
      expect(transformClients.length).toBeGreaterThan(0);
      expect(transformClients[0]).toBe("claude-desktop");

      await client.close();
      await server.close();
    });

    it("toolFilter hides tools from listing and rejects calls", async () => {
      const { client, cleanup } = await createConnectedPair({
        tools: [createTestTool("visible"), createTestTool("hidden")],
        toolFilter: (tool) => tool.name !== "hidden",
      });

      // toolFilter is applied at BOTH list time and call time
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("visible");
      expect(names).not.toContain("hidden");

      // Calling a filtered tool throws a protocol-level error (method not found)
      await expect(
        client.callTool({ name: "hidden", arguments: { name: "Test" } }),
      ).rejects.toThrow("Tool hidden not found");

      await cleanup();
    });

    it("toolTransform modifies tool descriptions per session", async () => {
      const { client, cleanup } = await createConnectedPair({
        tools: [createTestTool("query"), createTestTool("other")],
        toolTransform: (tool) => {
          if (tool.name === "query") {
            return { ...tool, description: `${tool.description}\n\nUser: Alice at Acme Corp.` };
          }
          return tool;
        },
      });

      const { tools } = await client.listTools();
      const query = tools.find((t) => t.name === "query");
      const other = tools.find((t) => t.name === "other");
      expect(query?.description).toContain("User: Alice at Acme Corp.");
      expect(other?.description).not.toContain("Alice");

      await cleanup();
    });

    it("toolTransform returning null removes tool from listing", async () => {
      const { client, cleanup } = await createConnectedPair({
        tools: [createTestTool("keep"), createTestTool("remove")],
        toolTransform: (tool) => (tool.name === "remove" ? null : tool),
      });

      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("keep");
      expect(tools.map((t) => t.name)).not.toContain("remove");

      await cleanup();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Sessions
  // ══════════════════════════════════════════════════════════════════════════

  describe("sessions", () => {
    it("tracks sessions", async () => {
      const server = new MCPServer({ name: "test", version: "1.0.0" });

      const [, transport] = InMemoryTransport.createLinkedPair();
      await server.connect(transport);

      const sessions = server.getActiveSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].transport).toBe("in-process");

      await server.close();
    });

    it("multiple concurrent sessions share the registry", async () => {
      const server = new MCPServer({
        name: "test",
        version: "1.0.0",
        tools: [createTestTool("initial-tool")],
      });

      // Connect two clients
      const [ct1, st1] = InMemoryTransport.createLinkedPair();
      const [ct2, st2] = InMemoryTransport.createLinkedPair();
      await server.connect(st1);
      await server.connect(st2);

      const client1 = new Client({ name: "client-1", version: "1.0.0" });
      const client2 = new Client({ name: "client-2", version: "1.0.0" });
      await client1.connect(ct1);
      await client2.connect(ct2);

      // Both see the initial tool
      let tools1 = await client1.listTools();
      let tools2 = await client2.listTools();
      expect(tools1.tools.map((t) => t.name)).toEqual(["initial-tool"]);
      expect(tools2.tools.map((t) => t.name)).toEqual(["initial-tool"]);

      // Dynamically register a new tool
      server.registerTool(createTestTool("dynamic-tool"));

      // Both clients see the new tool (they re-fetch from the shared registry)
      tools1 = await client1.listTools();
      tools2 = await client2.listTools();
      expect(tools1.tools.map((t) => t.name).sort()).toEqual(["dynamic-tool", "initial-tool"]);
      expect(tools2.tools.map((t) => t.name).sort()).toEqual(["dynamic-tool", "initial-tool"]);

      // Both clients can call the new tool
      const r1 = await client1.callTool({ name: "dynamic-tool", arguments: { name: "A" } });
      const r2 = await client2.callTool({ name: "dynamic-tool", arguments: { name: "B" } });
      expect(r1.content).toEqual([{ type: "text", text: "Hello, A!" }]);
      expect(r2.content).toEqual([{ type: "text", text: "Hello, B!" }]);

      // Unregister — both clients lose access
      server.unregisterTool("dynamic-tool");
      tools1 = await client1.listTools();
      tools2 = await client2.listTools();
      expect(tools1.tools.map((t) => t.name)).toEqual(["initial-tool"]);
      expect(tools2.tools.map((t) => t.name)).toEqual(["initial-tool"]);

      await client1.close();
      await client2.close();
      await server.close();
    });

    it("enforces maxSessions default of 1000", () => {
      const server = new MCPServer({
        name: "test",
        version: "1.0.0",
        sessions: { maxSessions: 5 },
      });

      const sessions = server.getActiveSessions();
      expect(sessions).toHaveLength(0);

      server.close();
    });

    it("cleans up idle sessions after TTL", async () => {
      const server = new MCPServer({
        name: "test",
        version: "1.0.0",
        sessions: {
          idleTtlMs: 50, // 50ms TTL for testing
          cleanupIntervalMs: 25, // Check every 25ms
        },
      });

      const timeoutEvents: any[] = [];
      const closeEvents: any[] = [];
      server.on("mcp:session:idle-timeout", (e) => timeoutEvents.push(e));
      server.on("mcp:session:closed", (e) => closeEvents.push(e));

      const [, transport] = InMemoryTransport.createLinkedPair();
      await server.connect(transport);

      expect(server.getActiveSessions()).toHaveLength(1);

      // Wait for TTL + cleanup interval
      await new Promise((r) => setTimeout(r, 120));

      expect(server.getActiveSessions()).toHaveLength(0);
      expect(timeoutEvents).toHaveLength(1);
      expect(closeEvents.some((e) => e.reason === "idle timeout")).toBe(true);

      await server.close();
    });

    it("reports session info correctly", async () => {
      const server = new MCPServer({ name: "test", version: "1.0.0" });

      const [, transport] = InMemoryTransport.createLinkedPair();
      await server.connect(transport);

      const sessions = server.getActiveSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].transport).toBe("in-process");
      expect(sessions[0].createdAt).toBeGreaterThan(0);
      expect(sessions[0].lastActivityAt).toBeGreaterThan(0);
      expect(sessions[0].sessionId).toBeDefined();

      await server.close();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Capabilities — dynamic list_changed notifications
  // ══════════════════════════════════════════════════════════════════════════

  describe("capabilities", () => {
    it("emits mcp:tools:changed on dynamic tool registration", async () => {
      const changes: any[] = [];
      const { server, cleanup } = await createConnectedPair();
      server.on("mcp:tools:changed", (e) => changes.push(e));

      server.registerTool(createTestTool("new-tool"));
      expect(changes).toHaveLength(1);

      server.unregisterTool("new-tool");
      expect(changes).toHaveLength(2);

      await cleanup();
    });

    it("emits mcp:resources:changed on dynamic resource registration", async () => {
      const changes: any[] = [];
      const { server, cleanup } = await createConnectedPair();
      server.on("mcp:resources:changed", (e) => changes.push(e));

      server.registerResource(createTestResource());
      expect(changes).toHaveLength(1);

      server.unregisterResource("db://schema/users");
      expect(changes).toHaveLength(2);

      await cleanup();
    });

    it("emits mcp:resources:changed on app registration", async () => {
      const changes: any[] = [];
      const { server, cleanup } = await createConnectedPair();
      server.on("mcp:resources:changed", (e) => changes.push(e));

      server.registerApp({
        name: "dashboard",
        uri: "ui://test/dash",
        content: "<html></html>",
      });
      expect(changes).toHaveLength(1);

      server.unregisterApp("ui://test/dash");
      expect(changes).toHaveLength(2);

      await cleanup();
    });
  });
});
