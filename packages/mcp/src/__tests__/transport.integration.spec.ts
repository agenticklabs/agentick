import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "../transport/index.js";
import { z } from "zod";

describe("InMemoryTransport integration", () => {
  it("completes a tool-call round-trip: client → server → handler → result → client", async () => {
    // Server: register a simple tool
    const server = new McpServer({ name: "test", version: "1.0.0" });
    server.tool("greet", { name: z.string() }, async ({ name }) => ({
      content: [{ type: "text", text: `Hello, ${name}!` }],
    }));

    // Transport: linked pair
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // Wire up
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    // Call the tool
    const result = await client.callTool({
      name: "greet",
      arguments: { name: "World" },
    });

    expect(result.content).toEqual([{ type: "text", text: "Hello, World!" }]);
    expect(result.isError).toBeFalsy();

    // Cleanup
    await client.close();
    await server.close();
  });

  it("returns isError: true when tool handler throws", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    server.tool("fail", {}, async () => {
      throw new Error("Something went wrong");
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "fail", arguments: {} });

    expect(result.isError).toBe(true);

    await client.close();
    await server.close();
  });

  it("lists tools from the server", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    server.tool("alpha", { x: z.number() }, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    server.tool("beta", {}, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["alpha", "beta"]);

    await client.close();
    await server.close();
  });

  it("lists and reads resources", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    server.resource("schema", "db://schema/users", async () => ({
      contents: [{ uri: "db://schema/users", text: "CREATE TABLE users ..." }],
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const { resources } = await client.listResources();
    expect(resources).toHaveLength(1);
    expect(resources[0].uri).toBe("db://schema/users");

    const { contents } = await client.readResource({ uri: "db://schema/users" });
    expect(contents[0].text).toBe("CREATE TABLE users ...");

    await client.close();
    await server.close();
  });

  it("propagates close from either side", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    // Close client side — should propagate
    await client.close();

    // Server transport should be closed
    // (InMemoryTransport.close() sets _otherTransport to undefined)
    expect((serverTransport as any)._otherTransport).toBeUndefined();
  });
});
