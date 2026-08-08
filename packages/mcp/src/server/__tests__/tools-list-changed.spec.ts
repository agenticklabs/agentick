/**
 * `notifications/tools/list_changed` emission — the MCP server harness
 * fans catalog mutations out to connected clients when the adopter's
 * tools source is a live {@link ToolCatalog} (ticket #310).
 *
 * Covers:
 *  - Adopter passes a `ToolCatalog` via `tools.registry` — server subscribes
 *    at connection accept, emits `sendToolListChanged()` on catalog changes
 *  - Post-notification `tools/list` returns the updated set
 *  - Multiple connected clients each receive their own notification
 *  - Connection close unsubscribes — subsequent catalog mutations do NOT
 *    fan out to closed connections
 *  - Static-array shorthand (no catalog) — server still installs, no
 *    notifications ever fire (subscribeAll is a no-op)
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { ContentBlock, ToolDeclaration } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";
import { createToolCatalog } from "@agentick/tool";

import { inMemoryServerTransport, McpServerHarness, type ToolHandlerResolver } from "../index.js";

const stringSchema = jsonSchema({
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
});

function tool(name: string): ToolDeclaration {
  return {
    id: name,
    name,
    description: `desc:${name}`,
    inputSchema: stringSchema,
    exposure: ["model"],
    handlerRef: `handler:${name}`,
  };
}

function trivialResolver(): ToolHandlerResolver {
  return () => async (): Promise<{ kind: "inline"; content: ContentBlock[] }> => ({
    kind: "inline",
    content: [{ type: "text", text: "ok" }],
  });
}

async function makeServer(
  registry: Parameters<typeof createToolCatalog>[0] | ReturnType<typeof createToolCatalog>,
  { catalog = false }: { catalog?: boolean } = {},
): Promise<{
  readonly harness: McpServerHarness;
  readonly transport: ReturnType<typeof inMemoryServerTransport>;
}> {
  const transport = inMemoryServerTransport();
  const registryValue = catalog
    ? (registry as ReturnType<typeof createToolCatalog>)
    : (registry as readonly ToolDeclaration[]);
  const harness = new McpServerHarness(
    `srv:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      name: "test-server",
      transports: [transport],
      tools: {
        registry: registryValue,
        resolveHandler: trivialResolver(),
      },
      serverInfo: { name: "test", version: "0.0.0" },
    },
  );
  await harness.ready;
  await harness.start();
  return { harness, transport };
}

async function makeClient(
  transport: Awaited<ReturnType<ReturnType<typeof inMemoryServerTransport>["connect"]>>,
): Promise<McpClient> {
  const client = new McpClient({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

describe("notifications/tools/list_changed emission (#310)", () => {
  it("fires on catalog mutation when adopter supplies a ToolCatalog", async () => {
    const catalog = createToolCatalog([tool("initial")]);
    const { harness, transport } = await makeServer(catalog, { catalog: true });
    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    let notified = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      notified += 1;
    });

    // Baseline — initial catalog visible.
    let listing = await client.listTools();
    expect(listing.tools.map((t) => t.name)).toEqual(["initial"]);

    // Mutate → notification fires → refetch sees the new set.
    catalog.register(tool("added"));
    await new Promise((r) => setTimeout(r, 5));
    expect(notified).toBeGreaterThanOrEqual(1);
    listing = await client.listTools();
    expect(listing.tools.map((t) => t.name).sort()).toEqual(["added", "initial"]);

    const before = notified;
    catalog.remove("initial");
    await new Promise((r) => setTimeout(r, 5));
    expect(notified).toBeGreaterThan(before);
    listing = await client.listTools();
    expect(listing.tools.map((t) => t.name)).toEqual(["added"]);

    await client.close();
    await harness.close();
  });

  it("fans notifications to every connected client independently", async () => {
    const catalog = createToolCatalog([tool("a")]);
    const { harness, transport } = await makeServer(catalog, { catalog: true });

    const t1 = await transport.connect();
    const c1 = await makeClient(t1);
    let n1 = 0;
    c1.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      n1 += 1;
    });

    const t2 = await transport.connect();
    const c2 = await makeClient(t2);
    let n2 = 0;
    c2.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      n2 += 1;
    });

    catalog.register(tool("b"));
    await new Promise((r) => setTimeout(r, 5));
    expect(n1).toBeGreaterThanOrEqual(1);
    expect(n2).toBeGreaterThanOrEqual(1);

    await c1.close();
    await c2.close();
    await harness.close();
  });

  it("connection close unsubscribes — closed client sees no further notifications", async () => {
    const catalog = createToolCatalog([tool("x")]);
    const { harness, transport } = await makeServer(catalog, { catalog: true });
    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    let notified = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      notified += 1;
    });

    catalog.register(tool("y"));
    await new Promise((r) => setTimeout(r, 5));
    const beforeClose = notified;
    expect(beforeClose).toBeGreaterThanOrEqual(1);

    await client.close();

    // Post-close mutation — harness still notifies its own subscribers,
    // but this connection's unsubscribe ran, so the client's counter
    // stays put.
    catalog.register(tool("z"));
    await new Promise((r) => setTimeout(r, 5));
    expect(notified).toBe(beforeClose);

    await harness.close();
  });

  it("static-array registry still works — no notifications fired", async () => {
    // Adopters passing a plain array wrap internally as a static
    // catalog; subscribeAll is a no-op. Regression coverage that the
    // catalog refactor didn't break the static path.
    const { harness, transport } = await makeServer([tool("only")]);
    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    let notified = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      notified += 1;
    });

    const listing = await client.listTools();
    expect(listing.tools.map((t) => t.name)).toEqual(["only"]);

    // Wait a beat — no notification should arrive.
    await new Promise((r) => setTimeout(r, 10));
    expect(notified).toBe(0);

    await client.close();
    await harness.close();
  });
});
