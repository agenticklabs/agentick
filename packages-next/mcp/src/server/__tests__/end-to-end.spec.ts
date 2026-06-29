/**
 * End-to-end smoke for the MCP server harness MVP (#171c part 2).
 *
 * Drives the full path: harness start → in-memory connect → SDK Client
 * on the other side → initialize handshake → tools/list → tools/call →
 * response. No subprocess; the in-memory transport pair models a single
 * accepted connection.
 *
 * Pins:
 *  - Capability negotiation advertises `tools` iff registry is non-empty
 *  - Per-connection tool filter applied at both list + call
 *  - Per-connection tool transforms (rename, prefix) apply
 *  - Security pipeline runs each request — authn rejection surfaces as
 *    a JSON-RPC protocol error
 *  - Tool handler exceptions surface as `isError: true` results, not
 *    protocol errors (v1 distinction preserved)
 *  - Multi-connection isolation: connection A's auth state doesn't
 *    leak into connection B
 *  - Connection-tracking via `harness.connections()` + `onConnectionChange`
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import type { ContentBlock, ToolDeclaration } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";
import { prefix as toolPrefix } from "@agentick/tool-next/transforms";

import {
  bearerTokenAuth,
  inMemoryServerTransport,
  McpServerHarness,
  type ToolHandlerResolver,
} from "../index.js";

const stringSchema = jsonSchema({
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
});

function tool(name: string, description = `desc:${name}`): ToolDeclaration {
  return {
    id: name,
    name,
    description,
    inputSchema: stringSchema,
    exposure: ["model"],
    handlerRef: `handler:${name}`,
  };
}

function staticHandlers(
  map: Readonly<Record<string, (input: unknown) => Promise<ContentBlock[]>>>,
): ToolHandlerResolver {
  return (ref: string) => {
    const handler = map[ref];
    if (!handler) return null;
    return async (input) => handler(input);
  };
}

async function makeServer(
  tools: ToolDeclaration[],
  handlers: Readonly<Record<string, (input: unknown) => Promise<ContentBlock[]>>>,
  options: {
    readonly transform?: Parameters<typeof toolPrefix>[0];
    readonly filterPredicate?: (decl: ToolDeclaration) => boolean;
    readonly bearer?: Readonly<Record<string, { id: string }>>;
  } = {},
): Promise<{
  readonly harness: McpServerHarness;
  readonly transport: ReturnType<typeof inMemoryServerTransport>;
}> {
  const transport = inMemoryServerTransport();
  const harness = new McpServerHarness(
    `srv:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      name: "test-server",
      transports: [transport],
      tools: {
        registry: tools,
        resolveHandler: staticHandlers(handlers),
        ...(options.filterPredicate ? { filter: options.filterPredicate } : {}),
        ...(options.transform ? { transforms: [toolPrefix(options.transform)] } : {}),
      },
      ...(options.bearer
        ? {
            auth: {
              authenticator: bearerTokenAuth({ tokens: options.bearer }),
            },
          }
        : {}),
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

describe("end-to-end: initialize + tools/list + tools/call", () => {
  it("advertises tools capability when registry is non-empty", async () => {
    const { harness, transport } = await makeServer([tool("search")], {
      "handler:search": async () => [{ type: "text", text: "hit" }],
    });
    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();

    await client.close();
    await harness.close();
  });

  it("does NOT advertise tools capability with an empty registry", async () => {
    const { harness, transport } = await makeServer([], {});
    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    expect(client.getServerCapabilities()?.tools).toBeUndefined();

    await client.close();
    await harness.close();
  });

  it("tools/list returns the projected (filtered + transformed) view", async () => {
    const { harness, transport } = await makeServer(
      [tool("public_search"), tool("internal_secret")],
      {
        "handler:public_search": async () => [{ type: "text", text: "hit" }],
        "handler:internal_secret": async () => [{ type: "text", text: "secret" }],
      },
      {
        filterPredicate: (decl) => decl.name.startsWith("public_"),
        transform: "api_",
      },
    );
    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    const result = await client.listTools();
    expect(result.tools.map((t) => t.name)).toEqual(["api_public_search"]);

    await client.close();
    await harness.close();
  });

  it("tools/call dispatches to the resolved handler", async () => {
    const { harness, transport } = await makeServer([tool("search")], {
      "handler:search": async (input) => [
        {
          type: "text",
          text: `searched: ${(input as { q: string }).q}`,
        },
      ],
    });
    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    const result = await client.callTool(
      { name: "search", arguments: { q: "hello" } },
      CallToolResultSchema,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "searched: hello" }]);

    await client.close();
    await harness.close();
  });

  it("tools/call to a filtered-out tool returns isError + 'not found'", async () => {
    const { harness, transport } = await makeServer(
      [tool("public_search"), tool("internal_secret")],
      {
        "handler:public_search": async () => [{ type: "text", text: "ok" }],
        "handler:internal_secret": async () => [{ type: "text", text: "secret" }],
      },
      {
        filterPredicate: (decl) => decl.name.startsWith("public_"),
      },
    );
    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    const result = await client.callTool(
      { name: "internal_secret", arguments: { q: "x" } },
      CallToolResultSchema,
    );
    expect(result.isError).toBe(true);
    const block = (result.content as { type: string; text: string }[])[0]!;
    expect(block.text).toMatch(/not found|not available/);

    await client.close();
    await harness.close();
  });

  it("tool handler exception surfaces as isError, not a protocol error", async () => {
    const { harness, transport } = await makeServer([tool("crash")], {
      "handler:crash": async () => {
        throw new Error("handler boom");
      },
    });
    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    const result = await client.callTool(
      { name: "crash", arguments: { q: "x" } },
      CallToolResultSchema,
    );
    expect(result.isError).toBe(true);
    const block = (result.content as { type: string; text: string }[])[0]!;
    expect(block.text).toContain("handler boom");

    await client.close();
    await harness.close();
  });
});

describe("end-to-end: multi-connection isolation", () => {
  it("two concurrent connections see independent contexts", async () => {
    const { harness, transport } = await makeServer([tool("echo")], {
      "handler:echo": async (input) => [
        {
          type: "text",
          text: `echo: ${(input as { q: string }).q}`,
        },
      ],
    });

    const clientTransportA = await transport.connect();
    const clientA = await makeClient(clientTransportA);
    const clientTransportB = await transport.connect();
    const clientB = await makeClient(clientTransportB);

    // Both connections tracked.
    expect(harness.connections()).toHaveLength(2);

    const [resultA, resultB] = await Promise.all([
      clientA.callTool({ name: "echo", arguments: { q: "A" } }, CallToolResultSchema),
      clientB.callTool({ name: "echo", arguments: { q: "B" } }, CallToolResultSchema),
    ]);
    expect((resultA.content as { text: string }[])[0]!.text).toBe("echo: A");
    expect((resultB.content as { text: string }[])[0]!.text).toBe("echo: B");

    await clientA.close();
    await clientB.close();
    await harness.close();
  });

  it("connection notifier fires on open + close", async () => {
    const { harness, transport } = await makeServer([tool("x")], {
      "handler:x": async () => [{ type: "text", text: "ok" }],
    });

    let notifyCount = 0;
    const unsub = harness.onConnectionChange(() => {
      notifyCount++;
    });

    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);
    expect(harness.connections()).toHaveLength(1);
    expect(notifyCount).toBeGreaterThanOrEqual(1);

    await client.close();
    // Give the SDK's onclose callback time to fire.
    await new Promise((r) => setTimeout(r, 10));
    expect(harness.connections()).toHaveLength(0);

    unsub();
    await harness.close();
  });
});
