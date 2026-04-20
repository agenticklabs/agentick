/**
 * MCP Tool Tick Survival Tests
 *
 * Verifies that MCP tools discovered via MCPToolComponent persist across
 * compilation ticks. The COM clears all tools on each tick via clear(),
 * so tools must be re-collected from the component tree every tick.
 *
 * The fix: MCPToolComponent renders <tool> elements (collected by the
 * compiler each tick) instead of using ctx.addTool() in useEffect (which
 * only runs once and gets wiped by clear()).
 */

import { describe, it, expect } from "vitest";
import { FiberCompiler } from "../../compiler/fiber-compiler.js";
import { createMockCom, createMockTickState } from "../../testing/index.js";
import { MCPToolComponent } from "../component.js";
import { MCPClient } from "../client.js";
import { MCPServer } from "@agentick/mcp/server";
import { InMemoryTransport } from "@agentick/mcp/transport";
import { z } from "zod";

// ============================================================================
// Helpers
// ============================================================================

async function createConnectedPair(
  tools: Array<{ name: string; description: string; inputSchema: any; handler: any }>,
) {
  const server = new MCPServer({
    name: "test-server",
    version: "1.0.0",
    tools,
  });
  const client = new MCPClient();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect({
    serverName: "test",
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
// Tests
// ============================================================================

describe("MCPToolComponent — tool tick survival", () => {
  it("should render <tool> elements that the compiler collects", async () => {
    const { client, cleanup } = await createConnectedPair([
      {
        name: "ping",
        description: "Ping tool",
        inputSchema: z.object({}),
        handler: async () => ({ content: [{ type: "text" as const, text: "pong" }] }),
      },
    ]);

    const ctx = createMockCom();
    const compiler = new FiberCompiler(ctx);
    const tickState = createMockTickState();

    const App = () => (
      <MCPToolComponent
        server="test"
        config={{ serverName: "test", transport: "in-process" as any, connection: {} }}
        mcpClient={client}
      />
    );

    // First compile — useEffect fires, tools are discovered and rendered
    const _compiled1 = await compiler.compile(<App />, tickState);

    // useEffect is async — the first compile may not have tools yet
    // because discovery happens in useEffect. Wait for the state update
    // to trigger a re-render.
    await new Promise((r) => setTimeout(r, 100));

    // Second compile — tools should now be in the rendered output
    const compiled2 = await compiler.compile(<App />, { ...tickState, tick: 2 });
    expect(compiled2.tools.length).toBeGreaterThanOrEqual(1);
    expect(compiled2.tools.some((t) => t.metadata.name === "ping")).toBe(true);

    // Third compile — tools should STILL be present (tick survival)
    const compiled3 = await compiler.compile(<App />, { ...tickState, tick: 3 });
    expect(compiled3.tools.length).toBeGreaterThanOrEqual(1);
    expect(compiled3.tools.some((t) => t.metadata.name === "ping")).toBe(true);

    await cleanup();
  });

  it("should include multiple tools from the same server", async () => {
    const { client, cleanup } = await createConnectedPair([
      {
        name: "read",
        description: "Read data",
        inputSchema: z.object({ id: z.string() }),
        handler: async () => ({ content: [{ type: "text" as const, text: "data" }] }),
      },
      {
        name: "write",
        description: "Write data",
        inputSchema: z.object({ id: z.string(), value: z.string() }),
        handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      },
    ]);

    const ctx = createMockCom();
    const compiler = new FiberCompiler(ctx);
    const tickState = createMockTickState();

    const App = () => (
      <MCPToolComponent
        server="test"
        config={{ serverName: "test", transport: "in-process" as any, connection: {} }}
        mcpClient={client}
      />
    );

    await compiler.compile(<App />, tickState);
    await new Promise((r) => setTimeout(r, 100));

    const compiled = await compiler.compile(<App />, { ...tickState, tick: 2 });
    expect(compiled.tools.length).toBe(2);

    const names = compiled.tools.map((t) => t.metadata.name).sort();
    expect(names).toEqual(["read", "write"]);

    await cleanup();
  });

  it("should apply tool prefix", async () => {
    const { client, cleanup } = await createConnectedPair([
      {
        name: "query",
        description: "Query",
        inputSchema: z.object({}),
        handler: async () => ({ content: [{ type: "text" as const, text: "result" }] }),
      },
    ]);

    const ctx = createMockCom();
    const compiler = new FiberCompiler(ctx);
    const tickState = createMockTickState();

    const App = () => (
      <MCPToolComponent
        server="test"
        config={{ serverName: "test", transport: "in-process" as any, connection: {} }}
        mcpClient={client}
        toolPrefix="knowify_"
      />
    );

    await compiler.compile(<App />, tickState);
    await new Promise((r) => setTimeout(r, 100));

    const compiled = await compiler.compile(<App />, { ...tickState, tick: 2 });
    expect(compiled.tools.some((t) => t.metadata.name === "knowify_query")).toBe(true);

    await cleanup();
  });

  it("should respect include filter", async () => {
    const { client, cleanup } = await createConnectedPair([
      {
        name: "allowed",
        description: "Allowed tool",
        inputSchema: z.object({}),
        handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      },
      {
        name: "blocked",
        description: "Blocked tool",
        inputSchema: z.object({}),
        handler: async () => ({ content: [{ type: "text" as const, text: "nope" }] }),
      },
    ]);

    const ctx = createMockCom();
    const compiler = new FiberCompiler(ctx);
    const tickState = createMockTickState();

    const App = () => (
      <MCPToolComponent
        server="test"
        config={{ serverName: "test", transport: "in-process" as any, connection: {} }}
        mcpClient={client}
        include={["allowed"]}
      />
    );

    await compiler.compile(<App />, tickState);
    await new Promise((r) => setTimeout(r, 100));

    const compiled = await compiler.compile(<App />, { ...tickState, tick: 2 });
    expect(compiled.tools.length).toBe(1);
    expect(compiled.tools[0].metadata.name).toBe("allowed");

    await cleanup();
  });
});
