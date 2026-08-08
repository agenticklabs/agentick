/**
 * Inbound client-roots per-connection isolation (ADR 65 — server ← client).
 *
 * TWO clients (A and B) advertise the `roots` capability with DIFFERENT
 * `file://` roots and connect to ONE `McpServerHarness`. A tool invoked
 * over connection A must see A's roots on `ctx.mcp.clientRoots` and NEVER
 * B's; over B, the mirror. A `notifications/roots/list_changed` on A
 * re-pulls A's roots ONLY — B is untouched.
 *
 * DIFFERENTIAL by construction: every assertion pins both the positive
 * presence (A's ctx contains A's root) AND the negative absence (A's ctx
 * does NOT contain B's root). The isolation is structural — each
 * connection's `installClientRootsIngest` holder is scoped to its own SDK
 * `Server`, so there is no shared store to leak across.
 *
 * @see docs/proposals/v2/blueprint/65-roots-as-projection.md
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { ContentBlock, McpRoot, ToolDeclaration } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

import { inMemoryServerTransport, McpServerHarness, type ToolHandlerResolver } from "../index.js";

function readRootsToolDeclaration(): ToolDeclaration {
  return {
    id: "read_roots",
    name: "read_roots",
    description: "returns ctx.mcp.clientRoots as JSON",
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
    exposure: ["model"],
    handlerRef: "handler:read_roots",
  };
}

const readRootsResolver: ToolHandlerResolver = (ref) => {
  if (ref !== "handler:read_roots") return null;
  return async (_input, ctx) => {
    const roots = ctx.mcp?.clientRoots ?? null;
    const content: ContentBlock[] = [{ type: "text", text: JSON.stringify(roots) }];
    return { kind: "inline", content };
  };
};

/** A raw SDK client advertising `roots` with a MUTABLE roots list. */
function rootsClient(name: string, initial: readonly McpRoot[]) {
  let roots: readonly McpRoot[] = initial;
  const client = new McpClient(
    { name, version: "0.0.0" },
    { capabilities: { roots: { listChanged: true } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [...roots] }));
  return {
    client,
    async setRoots(next: readonly McpRoot[]): Promise<void> {
      roots = next;
      await client.sendRootsListChanged();
    },
  };
}

/** Call `read_roots` until the server has pulled a non-empty list (or give up). */
async function readRootsEventually(client: McpClient): Promise<readonly McpRoot[]> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const res = await client.callTool({ name: "read_roots", arguments: {} });
    const first = (res.content as readonly { text?: string }[])[0];
    const parsed = first?.text ? (JSON.parse(first.text) as McpRoot[] | null) : null;
    if (parsed && parsed.length > 0) return parsed;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("server never pulled client roots");
}

/** Poll `read_roots` until it satisfies `pred` (used for list_changed re-pull). */
async function readRootsUntil(
  client: McpClient,
  pred: (roots: readonly McpRoot[] | null) => boolean,
): Promise<readonly McpRoot[] | null> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const res = await client.callTool({ name: "read_roots", arguments: {} });
    const first = (res.content as readonly { text?: string }[])[0];
    const parsed = first?.text ? (JSON.parse(first.text) as McpRoot[] | null) : null;
    if (pred(parsed)) return parsed;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition never met");
}

describe("inbound client-roots isolation (ADR 65 — per-connection)", () => {
  it("connection A sees only A's roots, connection B only B's — differential", async () => {
    const rootA: McpRoot = { uri: "file:///a-workspace", name: "A" };
    const rootB: McpRoot = { uri: "file:///b-workspace", name: "B" };

    const transport = inMemoryServerTransport();
    const harness = new McpServerHarness(
      `srv:${generateId()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      {
        transports: [transport],
        serverInfo: { name: "test", version: "0.0.0" },
        name: "roots-isolation",
        tools: { registry: [readRootsToolDeclaration()], resolveHandler: readRootsResolver },
      },
    );
    await harness.ready;
    await harness.start();

    const a = rootsClient("client-A", [rootA]);
    const b = rootsClient("client-B", [rootB]);
    await a.client.connect(await transport.connect());
    await b.client.connect(await transport.connect());

    const seenByA = await readRootsEventually(a.client);
    const seenByB = await readRootsEventually(b.client);

    // Positive presence …
    expect(seenByA).toContainEqual(rootA);
    expect(seenByB).toContainEqual(rootB);
    // … AND negative absence (the isolation guarantee).
    expect(seenByA).not.toContainEqual(rootB);
    expect(seenByB).not.toContainEqual(rootA);

    // list_changed on A re-pulls A ONLY.
    const rootA2: McpRoot = { uri: "file:///a-workspace-2", name: "A2" };
    await a.setRoots([rootA2]);
    const seenByAAfter = await readRootsUntil(
      a.client,
      (r) => r !== null && r.some((x) => x.uri === rootA2.uri),
    );
    expect(seenByAAfter).toContainEqual(rootA2);
    expect(seenByAAfter).not.toContainEqual(rootA); // A's old root is gone
    // B is untouched by A's change — still exactly B's root, never A's.
    const seenByBAfter = await readRootsEventually(b.client);
    expect(seenByBAfter).toEqual([rootB]);
    expect(seenByBAfter).not.toContainEqual(rootA2);

    await a.client.close();
    await b.client.close();
    await harness.close();
  });

  it("a client that does NOT advertise roots leaves clientRoots undefined", async () => {
    const transport = inMemoryServerTransport();
    const harness = new McpServerHarness(
      `srv:${generateId()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      {
        transports: [transport],
        serverInfo: { name: "test", version: "0.0.0" },
        name: "roots-absent",
        tools: { registry: [readRootsToolDeclaration()], resolveHandler: readRootsResolver },
      },
    );
    await harness.ready;
    await harness.start();

    const client = new McpClient({ name: "no-roots", version: "0.0.0" }, { capabilities: {} });
    await client.connect(await transport.connect());

    // No pull ever happens (capability absent) → clientRoots stays undefined
    // → the tool serializes `null`. Settle to prove it never populates.
    await new Promise((r) => setTimeout(r, 40));
    const res = await client.callTool({ name: "read_roots", arguments: {} });
    const first = (res.content as readonly { text?: string }[])[0];
    expect(first?.text).toBe("null");

    await client.close();
    await harness.close();
  });
});
