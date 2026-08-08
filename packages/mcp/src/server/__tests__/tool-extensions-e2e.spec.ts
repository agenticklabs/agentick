/**
 * MCP tool wire extensions (3b-0b-B) — end-to-end through a real SDK
 * client over the in-memory transport pair, exercising the CreatedTool
 * authoring path (config.ts wrapper → `normalizeToolResult` → projection).
 *
 * Pins:
 *  - Result-side step-up: a tool returning
 *    `metadata: mcpResultExtensions({ meta: wwwAuthenticateMeta(...) })`
 *    lands as `_meta["mcp/www_authenticate"]` on the client's
 *    `CallToolResult` — the previously-INERT `wwwAuthenticateMeta` helper
 *    now reaches the wire.
 *  - Declaration-side: `mcpToolExtensions({ meta, annotations })` on a
 *    `createTool` surfaces as `_meta` + `annotations` in the client's
 *    `tools/list`.
 *  - Regression: a tool carrying no extensions produces a
 *    `CallToolResult` with no `_meta` (byte-identical result-side).
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import { createTool, type CreatedTool } from "@agentick/tool";

import {
  inMemoryServerTransport,
  McpServerHarness,
  mcpResultExtensions,
  mcpToolExtensions,
  WWW_AUTHENTICATE_META_KEY,
  wwwAuthenticateMeta,
} from "../index.js";

async function makeServer(tools: readonly CreatedTool[]): Promise<{
  readonly harness: McpServerHarness;
  readonly transport: ReturnType<typeof inMemoryServerTransport>;
}> {
  const transport = inMemoryServerTransport();
  const harness = new McpServerHarness(
    `srv:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      name: "test-server",
      transports: [transport],
      tools: tools as CreatedTool[],
      serverInfo: { name: "test", version: "0.0.0" },
    },
  );
  await harness.ready;
  await harness.start();
  return { harness, transport };
}

async function connect(transport: ReturnType<typeof inMemoryServerTransport>): Promise<McpClient> {
  const clientTransport = await transport.connect();
  const client = new McpClient({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("3b-0b-B — result-side _meta (step-up auth) reaches the wire", () => {
  it("a tool returning wwwAuthenticateMeta surfaces _meta on the client CallToolResult", async () => {
    const stepUp = createTool({
      name: "pay_invoice",
      description: "Pay an invoice (needs write scope).",
      handler: async () => ({
        content: [{ type: "text", text: "Re-authentication required." }],
        isError: true,
        metadata: mcpResultExtensions({
          meta: wwwAuthenticateMeta({
            resourceMetadataUrl: "https://api.example.com/.well-known/oauth-protected-resource",
            scope: "invoices:write",
            error: "insufficient_scope",
          }),
        }),
      }),
    });
    const { harness, transport } = await makeServer([stepUp]);
    const client = await connect(transport);

    const result = await client.callTool(
      { name: "pay_invoice", arguments: { q: "inv-1" } },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    expect(result._meta).toBeDefined();
    expect((result._meta as Record<string, unknown>)[WWW_AUTHENTICATE_META_KEY]).toBe(
      'Bearer error="insufficient_scope", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource", scope="invoices:write"',
    );

    await client.close();
    await harness.close();
  });

  it("REGRESSION: a tool carrying no extensions produces a result with no _meta", async () => {
    const plain = createTool({
      name: "echo",
      description: "echo",
      handler: async (input) => [{ type: "text", text: `echo: ${(input as { q: string }).q}` }],
    });
    const { harness, transport } = await makeServer([plain]);
    const client = await connect(transport);

    const result = await client.callTool(
      { name: "echo", arguments: { q: "hi" } },
      CallToolResultSchema,
    );
    expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);
    expect(result._meta).toBeUndefined();

    await client.close();
    await harness.close();
  });
});

describe("3b-0b-B — declaration-side _meta + annotations reach tools/list", () => {
  it("mcpToolExtensions surfaces _meta and advisory annotation hints", async () => {
    const search = createTool({
      name: "search_invoices",
      description: "Search invoices (read-only).",
      handler: async () => [{ type: "text", text: "ok" }],
      metadata: mcpToolExtensions({
        annotations: { readOnlyHint: true, openWorldHint: false },
        meta: { "openai/outputTemplate": "ui://widget/invoice-list" },
      }),
    });
    const { harness, transport } = await makeServer([search]);
    const client = await connect(transport);

    const list = await client.listTools();
    const tool = list.tools.find((t) => t.name === "search_invoices");
    expect(tool).toBeDefined();
    expect(tool!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tool!._meta).toEqual({ "openai/outputTemplate": "ui://widget/invoice-list" });

    await client.close();
    await harness.close();
  });

  it("REGRESSION: a plain tool has no annotations/_meta in tools/list", async () => {
    const plain = createTool({
      name: "plain",
      description: "plain",
      handler: async () => [{ type: "text", text: "ok" }],
    });
    const { harness, transport } = await makeServer([plain]);
    const client = await connect(transport);

    const list = await client.listTools();
    const tool = list.tools.find((t) => t.name === "plain");
    expect(tool).toBeDefined();
    expect(tool!.annotations).toBeUndefined();
    expect(tool!._meta).toBeUndefined();

    await client.close();
    await harness.close();
  });
});
