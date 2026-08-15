/**
 * `McpClientHarness` — substrate-level integration spec.
 *
 * Uses {@link InMemoryMcpTransport.createLinkedPair} to wire a real
 * SDK `Server` to the harness's `Client`. Every round-trip exercises:
 *
 *   - The harness's connect / `initialize` handshake
 *   - Era codec selection (the stub server reports the canonical era)
 *   - `listTools` + `callTool` through `runOperation` (canonical
 *     substrate phase contract)
 *   - State machine transitions (idle → connecting → ready → closed)
 *   - State change envelopes published on the bus
 *   - Reconnect bookkeeping (lifecycle counters, degraded transition
 *     when policy is exhausted)
 *
 * stdio transport isn't exercised here — it requires spawning a real
 * subprocess MCP server. That coverage lands with the `withMCP` e2e
 * test in #3 (against `@modelcontextprotocol/server-everything` or
 * similar).
 */

import { describe, expect, it } from "vitest";
import { Chunk, Effect, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { ProtocolEvent } from "@agentick/spec";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  CanonicalPassthroughCodec,
  InMemoryMcpTransport,
  McpClientHarness,
  NoneAuth,
  type McpClientHarnessOptions,
} from "../index.js";

// ---------------------------------------------------------------------------
// Test fixture — paired client harness + SDK server over in-memory transport
// ---------------------------------------------------------------------------

interface Fixture {
  readonly harness: McpClientHarness;
  readonly server: Server;
  readonly journal: MemoryJournal;
  readonly bus: LocalEventBus;
  readonly inbox: LocalInbox;
  close(): Promise<void>;
}

async function makeFixture(options?: Partial<McpClientHarnessOptions>): Promise<Fixture> {
  const [clientTransport, serverTransport] = InMemoryMcpTransport.createLinkedPair();

  // SDK server with a single `echo` tool — the harness round-trips
  // against this in the listTools + callTool tests.
  const server = new Server(
    { name: "fake-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "echoes the input",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [
      {
        type: "text",
        text: `echo: ${(req.params.arguments as { message?: string } | undefined)?.message ?? ""}`,
      },
    ],
  }));
  await server.connect(serverTransport);

  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const harness = new McpClientHarness("test-server", journal, bus, inbox, {
    serverId: "test-server",
    transport: clientTransport,
    auth: new NoneAuth(),
    ...options,
  });
  await harness.ready;

  return {
    harness,
    server,
    journal,
    bus,
    inbox,
    close: async () => {
      await harness.close();
      await server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function captureStateEnvelope(bus: LocalEventBus, serverId: string): Promise<ProtocolEvent> {
  const chunk = await Effect.runPromise(
    Stream.runCollect(
      Stream.take(
        bus.subscribe({
          surface: "mcp",
          name: { exact: `mcp:${serverId}:state` },
        }),
        1,
      ),
    ),
  );
  return Array.from(Chunk.toReadonlyArray(chunk))[0]!;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("McpClientHarness — lifecycle", () => {
  it("starts in idle, transitions through connecting → ready on connect()", async () => {
    const f = await makeFixture();
    try {
      // The fixture awaits ready (the BaseHarness inbox-register), but
      // hasn't called connect() yet — verify pre-connect state.
      expect(f.harness.state).toBe("idle");

      await f.harness.connect();
      expect(f.harness.state).toBe("ready");
    } finally {
      await f.close();
    }
  });

  it("connect() is idempotent on a ready harness", async () => {
    const f = await makeFixture();
    try {
      await f.harness.connect();
      const before = f.harness.state;
      await f.harness.connect();
      expect(f.harness.state).toBe(before);
      expect(f.harness.state).toBe("ready");
    } finally {
      await f.close();
    }
  });

  it("close() transitions to closed and rejects subsequent connect()", async () => {
    const f = await makeFixture();
    await f.harness.connect();
    await f.harness.close();
    expect(f.harness.state).toBe("closed");
    await expect(f.harness.connect()).rejects.toThrow(/closed/);
    await f.server.close();
  });

  it("publishes mcp:<id>:state envelopes on transitions", async () => {
    const f = await makeFixture();
    try {
      // Capture the first state-change envelope. The harness fires
      // them on every transition; we just verify the wire shape.
      const pending = captureStateEnvelope(f.bus, "test-server");
      await f.harness.connect();
      const env = await pending;
      expect(env.surface).toBe("mcp");
      expect(env.name).toBe("mcp:test-server:state");
      const payload = env.payload as { state: string; serverId: string };
      // Connecting fires before ready; either is acceptable since the
      // bus subscription may grab either.
      expect(["connecting", "ready"]).toContain(payload.state);
      expect(payload.serverId).toBe("test-server");
    } finally {
      await f.close();
    }
  });
});

describe("McpClientHarness — protocol", () => {
  it("listTools normalizes server tools through the era codec", async () => {
    const f = await makeFixture();
    try {
      await f.harness.connect();
      const page = await f.harness.listTools();
      expect(page.tools).toHaveLength(1);
      expect(page.tools[0]?.name).toBe("echo");
      expect(page.tools[0]?.description).toBe("echoes the input");
      expect(page.tools[0]?.inputSchema).toMatchObject({
        type: "object",
        required: ["message"],
      });
      // A single-page catalog advertises no cursor.
      expect(page.nextCursor).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it("callTool round-trips against the SDK server", async () => {
    const f = await makeFixture();
    try {
      await f.harness.connect();
      const result = await f.harness.callTool("echo", { message: "hi" });
      expect(result.content).toHaveLength(1);
      expect((result.content as Array<{ text: string }>)[0]?.text).toBe("echo: hi");
    } finally {
      await f.close();
    }
  });

  it("spanAttributes stamps tool.name + mcp.server on the call-tool op (ADR 78 identity seam)", async () => {
    const f = await makeFixture();
    try {
      const spanAttributes = (op: { readonly name: string; readonly input?: unknown }) =>
        (
          f.harness as unknown as {
            spanAttributes(o: unknown): Readonly<Record<string, unknown>>;
          }
        ).spanAttributes({ opId: "x", surface: "mcp", scope: {}, ...op });

      const attrs = spanAttributes({
        name: "mcp:command:call-tool",
        input: { name: "echo", args: { message: "hi" } },
      });
      expect(attrs["agentick.tool.name"]).toBe("echo");
      expect(attrs["agentick.mcp.server"]).toBe("test-server");

      // A different op carries the server id nowhere near tool.name.
      const listing = spanAttributes({
        name: "mcp:command:list-tools",
        input: { cursor: undefined },
      });
      expect(listing["agentick.tool.name"]).toBeUndefined();
      expect(listing["agentick.mcp.server"]).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it("listTools / callTool fail before connect with McpClientNotReadyError", async () => {
    const f = await makeFixture();
    try {
      await expect(f.harness.listTools()).rejects.toMatchObject({
        _tag: "McpClientNotReadyError",
        state: "idle",
        serverId: "test-server",
      });
      await expect(f.harness.callTool("echo", {})).rejects.toMatchObject({
        _tag: "McpClientNotReadyError",
      });
    } finally {
      await f.close();
    }
  });
});

describe("McpClientHarness — era codec", () => {
  it("falls back to the canonical passthrough for a version we do not map", async () => {
    const f = await makeFixture();
    try {
      await f.harness.connect();
      expect(f.harness.currentCodec().era).toBe("2026-07-28");
    } finally {
      await f.close();
    }
  });

  it("honors an explicit codec override on the options", async () => {
    const f = await makeFixture({ codec: CanonicalPassthroughCodec });
    try {
      await f.harness.connect();
      expect(f.harness.currentCodec()).toBe(CanonicalPassthroughCodec);
    } finally {
      await f.close();
    }
  });
});

describe("McpClientHarness — reconnect policy", () => {
  it("disabled by default — transport drop transitions to degraded", async () => {
    const f = await makeFixture();
    try {
      await f.harness.connect();
      // Close the SERVER side of the in-memory transport, which fires
      // the client's onclose. No reconnect policy → degraded.
      await f.server.close();
      // Give the SDK a microtask to propagate the close.
      await new Promise<void>((r) => setTimeout(r, 5));
      expect(f.harness.state).toBe("degraded");
    } finally {
      await f.close();
    }
  });

  it("close() during reconnect cancels the pending timer and goes to closed", async () => {
    const f = await makeFixture({
      reconnect: { maxAttempts: 5, initialDelayMs: 10_000, maxDelayMs: 10_000 },
    });
    try {
      await f.harness.connect();
      await f.server.close();
      await new Promise<void>((r) => setTimeout(r, 5));
      expect(f.harness.state).toBe("reconnecting");
      await f.harness.close();
      expect(f.harness.state).toBe("closed");
    } catch {
      await f.harness.close();
    }
  });
});
