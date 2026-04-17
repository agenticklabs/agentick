/**
 * Integration test: verifies the in-process MCP connection pattern
 * that ernesto uses — InMemoryTransport with deferred delivery,
 * server connected first, client connected after.
 *
 * This is the exact scenario that triggered "unknown message ID" errors
 * with the SDK's synchronous InMemoryTransport.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "../transport/index.js";
import { MCPServer } from "../server/server.js";
import { z } from "zod";

describe("In-process MCP connection (ernesto pattern)", () => {
  it("completes initialize + tools/list without 'unknown message ID' errors", async () => {
    // 1. Create server with tools (same as createKnowifyMcpServer)
    const server = new MCPServer({
      name: "test",
      version: "1.0.0",
      instructions: "Test server for in-process integration",
      tools: [
        {
          name: "query",
          description: "Query tool",
          inputSchema: z.object({ table: z.string() }),
          handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        },
        {
          name: "platform_knowledge",
          description: "Knowledge tool",
          inputSchema: z.object({ search: z.string().optional() }),
          handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        },
      ],
      apps: [
        {
          name: "hello",
          uri: "ui://test/hello",
          content: "<html>hello</html>",
        },
      ],
    });

    // 2. Create transport pair
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // 3. Connect server side FIRST (same as useData in useMcpServers)
    await server.connect(serverTransport);

    // 4. Create client and connect AFTER (same as MCPToolComponent)
    const client = new Client({ name: "test-client", version: "1.0.0" });

    // This is the line that previously threw "unknown message ID"
    await client.connect(clientTransport);

    // 5. Verify tools/list works
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["platform_knowledge", "query"]);

    // 6. Verify resources/list includes the app
    const { resources } = await client.listResources();
    const appResource = resources.find((r) => r.uri === "ui://test/hello");
    expect(appResource).toBeDefined();
    expect(appResource!.mimeType).toBe("text/html;profile=mcp-app");

    // 7. Verify server capabilities include UI extension
    const caps = client.getServerCapabilities() as any;
    expect(caps?.extensions?.["io.modelcontextprotocol/ui"]).toBeDefined();

    // 8. Verify instructions are received
    const instructions = (client as any).getInstructions?.();
    expect(instructions).toContain("Test server");

    // 9. Call a tool
    const result = await client.callTool({ name: "query", arguments: { table: "Projects" } });
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);

    await client.close();
    await server.close();
  });

  it("handles multiple sequential connects to the same server (per-session pattern)", async () => {
    const server = new MCPServer({
      name: "multi",
      version: "1.0.0",
      tools: [
        {
          name: "ping",
          description: "Ping",
          inputSchema: { type: "object" },
          handler: async () => ({ content: [{ type: "text", text: "pong" }] }),
        },
      ],
    });

    // Session 1
    const [c1, s1] = InMemoryTransport.createLinkedPair();
    await server.connect(s1);
    const client1 = new Client({ name: "session-1", version: "1.0.0" });
    await client1.connect(c1);
    const r1 = await client1.callTool({ name: "ping", arguments: {} });
    expect(r1.content).toEqual([{ type: "text", text: "pong" }]);

    // Session 2 (concurrent with session 1)
    const [c2, s2] = InMemoryTransport.createLinkedPair();
    await server.connect(s2);
    const client2 = new Client({ name: "session-2", version: "1.0.0" });
    await client2.connect(c2);
    const r2 = await client2.callTool({ name: "ping", arguments: {} });
    expect(r2.content).toEqual([{ type: "text", text: "pong" }]);

    // Both still work
    const r1b = await client1.callTool({ name: "ping", arguments: {} });
    expect(r1b.content).toEqual([{ type: "text", text: "pong" }]);

    await client1.close();
    await client2.close();
    await server.close();
  });
});
