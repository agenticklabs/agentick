/**
 * Per-connection `instructions` — projected into the MCP
 * `InitializeResult.instructions` field (read client-side via
 * `client.getInstructions()`).
 *
 * Pins:
 *  - static string → surfaced verbatim.
 *  - function form → evaluated per connection; its return reaches the wire.
 *  - identity-visible: over an authenticated HTTP crossing, the function
 *    sees the resolved `ctx.mcp.user` (v1 injects live user context here).
 *  - absent slot → no instructions on the wire.
 *  - not cached across connections: two connections re-evaluate the fn.
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { McpRequestContext } from "@agentick/spec";

import {
  bearerTokenAuth,
  httpTransport,
  inMemoryServerTransport,
  McpServerHarness,
  type HttpServerTransportHandle,
  type McpServerInstructions,
  type McpServerOptions,
} from "../index.js";

// ────────────────────────── in-memory helper ──────────────────────────

async function connectInMemory(
  instructions: McpServerInstructions | undefined,
  rest: Partial<Omit<McpServerOptions, "transports" | "instructions">> = {},
): Promise<{ client: McpClient; cleanup: () => Promise<void> }> {
  const transport = inMemoryServerTransport();
  const harness = new McpServerHarness(
    `srv:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      name: "instr",
      transports: [transport],
      serverInfo: { name: "test", version: "0.0.0" },
      ...(instructions !== undefined ? { instructions } : {}),
      ...rest,
    },
  );
  await harness.ready;
  await harness.start();
  const client = new McpClient({ name: "c", version: "0.0.0" }, { capabilities: {} });
  await client.connect(await transport.connect());
  return {
    client,
    cleanup: async () => {
      await client.close();
      await harness.close();
    },
  };
}

describe("instructions — static + function forms", () => {
  it("projects a static string into InitializeResult.instructions", async () => {
    const { client, cleanup } = await connectInMemory("Use the echo tool for testing.");
    expect(client.getInstructions()).toBe("Use the echo tool for testing.");
    await cleanup();
  });

  it("omits instructions when the slot is absent", async () => {
    const { client, cleanup } = await connectInMemory(undefined);
    expect(client.getInstructions()).toBeUndefined();
    await cleanup();
  });

  it("evaluates the function form per connection and projects its return", async () => {
    let calls = 0;
    const fn: McpServerInstructions = () => {
      calls += 1;
      return `Instructions #${calls}`;
    };
    const first = await connectInMemory(fn);
    expect(first.client.getInstructions()).toBe("Instructions #1");
    await first.cleanup();

    // A fresh connection re-evaluates — not cached across connections.
    const second = await connectInMemory(fn);
    expect(second.client.getInstructions()).toBe("Instructions #2");
    await second.cleanup();
  });

  it("supports an async function form", async () => {
    const fn: McpServerInstructions = async () => {
      await Promise.resolve();
      return "async instructions";
    };
    const { client, cleanup } = await connectInMemory(fn);
    expect(client.getInstructions()).toBe("async instructions");
    await cleanup();
  });

  it("receives the request context (transport discriminator visible)", async () => {
    let seen: McpRequestContext | undefined;
    const fn: McpServerInstructions = (ctx) => {
      seen = ctx;
      return `transport=${ctx.transport}`;
    };
    const { client, cleanup } = await connectInMemory(fn);
    expect(client.getInstructions()).toBe("transport=mcp");
    expect(seen?.mcp.serverId).toBeDefined();
    await cleanup();
  });
});

// ────────────────────────── identity over HTTP ──────────────────────────

const TOKEN = "secret-token";

describe("instructions — identity-visible over an authenticated HTTP crossing", () => {
  it("the function sees the authenticated user resolved into ctx.mcp.user", async () => {
    const transport: HttpServerTransportHandle = httpTransport({ port: 0 });
    const fn: McpServerInstructions = (ctx) => {
      const userId = ctx.mcp.user?.id ?? "anonymous";
      return `Hello ${userId} — server ready.`;
    };
    const harness = new McpServerHarness(
      `srv:${generateId()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      {
        name: "instr-http",
        transports: [transport],
        serverInfo: { name: "test", version: "0.0.0" },
        instructions: fn,
        auth: { authenticator: bearerTokenAuth({ tokens: { [TOKEN]: { id: "alice" } } }) },
      },
    );
    await harness.ready;
    await harness.start();
    const addr = transport.address();
    if (addr === null) throw new Error("httpTransport did not bind a port");
    const url = `http://127.0.0.1:${addr.port}/mcp`;

    const clientTransport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const client = new McpClient({ name: "c", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    // The instructions fn resolved identity by running the authenticator
    // against the crossing headers — `alice`, not `anonymous`.
    expect(client.getInstructions()).toBe("Hello alice — server ready.");

    await client.close();
    await harness.close();
    await transport.close();
  });

  it("runs the authenticator EXACTLY ONCE for an initialize (ADR 91 §2 forward-derivation)", async () => {
    // Pre-ADR-91: the HTTP pre-gate authenticated the crossing, then
    // buildInstructionsContext re-ran the authenticator to populate
    // ctx.mcp.user — TWO runs per initialize. ADR 91 §Phase-2 forward-derives
    // the pre-gate's identity onto the accept-path McpConnectionInfo, so
    // instructions resolution reuses it: exactly ONE run.
    let authCalls = 0;
    const base = bearerTokenAuth({ tokens: { [TOKEN]: { id: "alice" } } });
    const countingAuth = async (
      ctx: McpRequestContext,
    ): Promise<Awaited<ReturnType<typeof base>>> => {
      authCalls += 1;
      return base(ctx);
    };

    const transport: HttpServerTransportHandle = httpTransport({ port: 0 });
    const fn: McpServerInstructions = (ctx) =>
      `Hello ${ctx.mcp.user?.id ?? "anonymous"} — server ready.`;
    const harness = new McpServerHarness(
      `srv:${generateId()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      {
        name: "instr-http-once",
        transports: [transport],
        serverInfo: { name: "test", version: "0.0.0" },
        instructions: fn,
        auth: { authenticator: countingAuth },
      },
    );
    await harness.ready;
    await harness.start();
    const addr = transport.address();
    if (addr === null) throw new Error("httpTransport did not bind a port");
    const url = `http://127.0.0.1:${addr.port}/mcp`;

    const clientTransport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const client = new McpClient({ name: "c", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    // Identity still reaches the instructions fn — via the forwarded pre-gate
    // identity, NOT a second authenticator run.
    expect(client.getInstructions()).toBe("Hello alice — server ready.");
    expect(authCalls).toBe(1);

    await client.close();
    await harness.close();
    await transport.close();
  });
});
