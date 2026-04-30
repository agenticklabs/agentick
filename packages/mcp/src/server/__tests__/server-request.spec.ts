/**
 * Phase 1 — Server-to-client request primitive
 *
 * Tests `MCPServer.request(sessionId, method, params, opts?)` — the
 * load-bearing primitive every bidirectional feature builds on.
 *
 * Adversarial: covers session lookup failures, closed-server errors,
 * timeouts, aborts, schema validation, concurrency, and post-disconnect
 * behavior.
 */

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ListRootsRequestSchema,
  CreateMessageRequestSchema,
  EmptyResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { InMemoryTransport } from "../../transport/index.js";
import { MCPServer } from "../server.js";
import { SessionNotFoundError } from "../server.js";

// ============================================================================
// Helpers
// ============================================================================

async function setupServerWithClient(opts?: {
  capabilities?: Record<string, unknown>;
  configureClient?: (client: Client) => void;
}): Promise<{
  server: MCPServer;
  client: Client;
  sessionId: string;
  cleanup: () => Promise<void>;
}> {
  const server = new MCPServer({
    name: "test-server",
    version: "1.0.0",
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: opts?.capabilities ?? {} },
  );

  if (opts?.configureClient) opts.configureClient(client);

  await client.connect(clientTransport);

  // The session was created on initialize; capture its id
  const sessions = server.getActiveSessions();
  if (sessions.length !== 1) {
    throw new Error(`Expected 1 session, got ${sessions.length}`);
  }
  const sessionId = sessions[0]!.sessionId;

  return {
    server,
    client,
    sessionId,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("MCPServer.request — server-to-client request primitive", () => {
  // ── Happy path ───────────────────────────────────────────────────────

  it("returns the client's response for a registered method", async () => {
    const { server, sessionId, cleanup } = await setupServerWithClient({
      capabilities: { roots: {} },
      configureClient: (client) => {
        client.setRequestHandler(ListRootsRequestSchema, async () => ({
          roots: [{ uri: "file:///workspace", name: "workspace" }],
        }));
      },
    });

    const result = await server.request(
      sessionId,
      "roots/list",
      {},
      {
        resultSchema: z.object({
          roots: z.array(z.object({ uri: z.string(), name: z.string().optional() })),
        }),
      },
    );

    expect(result.roots).toHaveLength(1);
    expect(result.roots[0]!.uri).toBe("file:///workspace");
    expect(result.roots[0]!.name).toBe("workspace");

    await cleanup();
  });

  it("supports built-in ping method round-trip", async () => {
    const { server, sessionId, cleanup } = await setupServerWithClient();

    // ping resolves with EmptyResultSchema — confirms basic request/response works.
    const result = await server.request(
      sessionId,
      "ping",
      {},
      {
        resultSchema: EmptyResultSchema,
      },
    );

    expect(result).toBeDefined();
    await cleanup();
  });

  // ── Session lookup failures ──────────────────────────────────────────

  it("throws SessionNotFoundError for unknown sessionId", async () => {
    const { server, cleanup } = await setupServerWithClient();

    await expect(
      server.request("does-not-exist", "ping", {}, { resultSchema: EmptyResultSchema }),
    ).rejects.toThrow(SessionNotFoundError);

    await cleanup();
  });

  it("SessionNotFoundError carries the requested sessionId", async () => {
    const { server, cleanup } = await setupServerWithClient();

    try {
      await server.request("missing-id", "ping", {}, { resultSchema: EmptyResultSchema });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionNotFoundError);
      expect((err as SessionNotFoundError).sessionId).toBe("missing-id");
    }

    await cleanup();
  });

  // ── Server-closed behavior ───────────────────────────────────────────

  it("throws clearly when the server is closed", async () => {
    const { server, sessionId, cleanup } = await setupServerWithClient();
    await cleanup();

    await expect(
      server.request(sessionId, "ping", {}, { resultSchema: EmptyResultSchema }),
    ).rejects.toThrow(/closed|not active|not connected/i);
  });

  // ── Timeout ──────────────────────────────────────────────────────────

  it("times out when the client never responds", async () => {
    const { server, sessionId, cleanup } = await setupServerWithClient({
      capabilities: { roots: {} },
      configureClient: (client) => {
        client.setRequestHandler(ListRootsRequestSchema, () => {
          // Hang forever
          return new Promise(() => {
            /* never resolves */
          });
        });
      },
    });

    const start = Date.now();
    await expect(
      server.request(
        sessionId,
        "roots/list",
        {},
        {
          resultSchema: z.object({ roots: z.array(z.unknown()) }),
          timeoutMs: 50,
        },
      ),
    ).rejects.toThrow(/timed out|timeout/i);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);

    await cleanup();
  });

  // ── AbortSignal ──────────────────────────────────────────────────────

  it("aborts when the signal is triggered", async () => {
    const { server, sessionId, cleanup } = await setupServerWithClient({
      capabilities: { roots: {} },
      configureClient: (client) => {
        client.setRequestHandler(ListRootsRequestSchema, () => {
          return new Promise(() => {
            /* never resolves */
          });
        });
      },
    });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);

    await expect(
      server.request(
        sessionId,
        "roots/list",
        {},
        {
          resultSchema: z.object({ roots: z.array(z.unknown()) }),
          signal: ac.signal,
        },
      ),
    ).rejects.toThrow(/abort/i);

    await cleanup();
  });

  it("does not abort other requests when one is signal-aborted", async () => {
    let resolveSecond!: (val: unknown) => void;
    const secondPromise = new Promise((res) => {
      resolveSecond = res;
    });

    let callCount = 0;
    const { server, sessionId, cleanup } = await setupServerWithClient({
      capabilities: { roots: {} },
      configureClient: (client) => {
        client.setRequestHandler(ListRootsRequestSchema, async () => {
          callCount++;
          if (callCount === 1) {
            // First call hangs — will be aborted
            return new Promise(() => {});
          }
          // Second call awaits the test's signal
          await secondPromise;
          return { roots: [{ uri: "file:///b", name: "b" }] };
        });
      },
    });

    const ac = new AbortController();
    const first = server
      .request(
        sessionId,
        "roots/list",
        {},
        {
          resultSchema: z.object({ roots: z.array(z.unknown()) }),
          signal: ac.signal,
        },
      )
      .catch((err) => ({ aborted: true, err }));

    const second = server.request(
      sessionId,
      "roots/list",
      {},
      {
        resultSchema: z.object({ roots: z.array(z.object({ uri: z.string() })) }),
      },
    );

    // Abort the first
    setTimeout(() => ac.abort(), 20);

    // Let second proceed
    setTimeout(() => resolveSecond(undefined), 40);

    const firstResult = await first;
    const secondResult = await second;

    expect((firstResult as { aborted: boolean }).aborted).toBe(true);
    expect(secondResult.roots[0]!.uri).toBe("file:///b");

    await cleanup();
  });

  // ── Result schema validation ─────────────────────────────────────────

  it("validates results with the provided Zod schema", async () => {
    const { server, sessionId, cleanup } = await setupServerWithClient({
      capabilities: { roots: {} },
      configureClient: (client) => {
        client.setRequestHandler(ListRootsRequestSchema, async () => ({
          // Intentionally malformed: missing the `roots` array entirely
          notRoots: "wrong shape",
        }));
      },
    });

    await expect(
      server.request(
        sessionId,
        "roots/list",
        {},
        {
          resultSchema: z.object({
            roots: z.array(z.object({ uri: z.string() })),
          }),
        },
      ),
    ).rejects.toThrow(/invalid|expected|required|parse/i);

    await cleanup();
  });

  it("returns parsed result typed by the schema", async () => {
    const { server, sessionId, cleanup } = await setupServerWithClient({
      capabilities: { roots: {} },
      configureClient: (client) => {
        client.setRequestHandler(ListRootsRequestSchema, async () => ({
          roots: [{ uri: "file:///x" }],
        }));
      },
    });

    const result = await server.request(
      sessionId,
      "roots/list",
      {},
      {
        resultSchema: z.object({
          roots: z.array(z.object({ uri: z.string() })),
        }),
      },
    );

    // TypeScript should infer result.roots[0].uri as string
    const uri: string = result.roots[0]!.uri;
    expect(uri).toBe("file:///x");

    await cleanup();
  });

  // ── Concurrency ──────────────────────────────────────────────────────

  it("handles many concurrent requests on a single session", async () => {
    const { server, sessionId, cleanup } = await setupServerWithClient({
      capabilities: { roots: {} },
      configureClient: (client) => {
        let count = 0;
        client.setRequestHandler(ListRootsRequestSchema, async () => {
          const id = count++;
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          return { roots: [{ uri: `file:///r${id}`, name: `r${id}` }] };
        });
      },
    });

    const requests = Array.from({ length: 20 }, () =>
      server.request(
        sessionId,
        "roots/list",
        {},
        {
          resultSchema: z.object({
            roots: z.array(z.object({ uri: z.string(), name: z.string().optional() })),
          }),
        },
      ),
    );

    const results = await Promise.all(requests);
    expect(results).toHaveLength(20);
    // Each call should have produced a unique identifier
    const uris = new Set(results.map((r) => r.roots[0]!.uri));
    expect(uris.size).toBe(20);

    await cleanup();
  });

  it("handles concurrent requests across different sessions", async () => {
    // Open two clients connected to the same server.
    const server = new MCPServer({ name: "multi-session", version: "1.0.0" });

    const [c1t, s1t] = InMemoryTransport.createLinkedPair();
    const [c2t, s2t] = InMemoryTransport.createLinkedPair();
    await server.connect(s1t);
    await server.connect(s2t);

    const client1 = new Client({ name: "c1", version: "1.0.0" }, { capabilities: { roots: {} } });
    client1.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: "file:///c1", name: "c1" }],
    }));

    const client2 = new Client({ name: "c2", version: "1.0.0" }, { capabilities: { roots: {} } });
    client2.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: "file:///c2", name: "c2" }],
    }));

    await client1.connect(c1t);
    await client2.connect(c2t);

    const sessions = server.getActiveSessions();
    expect(sessions).toHaveLength(2);

    const schema = z.object({
      roots: z.array(z.object({ uri: z.string(), name: z.string().optional() })),
    });

    const [r1, r2] = await Promise.all([
      server.request(sessions[0]!.sessionId, "roots/list", {}, { resultSchema: schema }),
      server.request(sessions[1]!.sessionId, "roots/list", {}, { resultSchema: schema }),
    ]);

    // Each session should resolve to its own client's response
    const uris = new Set([r1.roots[0]!.uri, r2.roots[0]!.uri]);
    expect(uris.has("file:///c1")).toBe(true);
    expect(uris.has("file:///c2")).toBe(true);

    await client1.close();
    await client2.close();
    await server.close();
  });

  // ── Cross-session isolation ──────────────────────────────────────────

  it("a request to session A does not invoke session B's handler", async () => {
    const server = new MCPServer({ name: "iso-test", version: "1.0.0" });

    const [c1t, s1t] = InMemoryTransport.createLinkedPair();
    const [c2t, s2t] = InMemoryTransport.createLinkedPair();
    await server.connect(s1t);
    await server.connect(s2t);

    let c1Called = 0;
    let c2Called = 0;

    const client1 = new Client({ name: "c1", version: "1.0.0" }, { capabilities: { roots: {} } });
    client1.setRequestHandler(ListRootsRequestSchema, async () => {
      c1Called++;
      return { roots: [{ uri: "file:///c1" }] };
    });
    const client2 = new Client({ name: "c2", version: "1.0.0" }, { capabilities: { roots: {} } });
    client2.setRequestHandler(ListRootsRequestSchema, async () => {
      c2Called++;
      return { roots: [{ uri: "file:///c2" }] };
    });

    await client1.connect(c1t);
    await client2.connect(c2t);

    const [s1, s2] = server.getActiveSessions();
    const schema = z.object({ roots: z.array(z.object({ uri: z.string() })) });

    await server.request(s1!.sessionId, "roots/list", {}, { resultSchema: schema });

    expect(c1Called).toBe(1);
    expect(c2Called).toBe(0);

    await server.request(s2!.sessionId, "roots/list", {}, { resultSchema: schema });

    expect(c1Called).toBe(1);
    expect(c2Called).toBe(1);

    await client1.close();
    await client2.close();
    await server.close();
  });

  // ── Error propagation ────────────────────────────────────────────────

  it("propagates errors thrown by the client's handler", async () => {
    const { server, sessionId, cleanup } = await setupServerWithClient({
      capabilities: { roots: {} },
      configureClient: (client) => {
        client.setRequestHandler(ListRootsRequestSchema, async () => {
          throw new Error("client handler exploded");
        });
      },
    });

    await expect(
      server.request(
        sessionId,
        "roots/list",
        {},
        {
          resultSchema: z.object({ roots: z.array(z.unknown()) }),
        },
      ),
    ).rejects.toThrow(/exploded|internal/i);

    await cleanup();
  });

  it("propagates protocol errors with code from client response", async () => {
    const { server, sessionId, cleanup } = await setupServerWithClient({
      capabilities: { roots: {} },
      configureClient: (client) => {
        client.setRequestHandler(ListRootsRequestSchema, async () => {
          // Throw a plain error — SDK serializes as JSON-RPC error.
          const err = new Error("Specific failure detail");
          (err as Error & { code: number }).code = -32099;
          throw err;
        });
      },
    });

    try {
      await server.request(
        sessionId,
        "roots/list",
        {},
        {
          resultSchema: z.object({ roots: z.array(z.unknown()) }),
        },
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("Specific failure detail");
    }

    await cleanup();
  });

  // ── Pre-aborted signal ───────────────────────────────────────────────

  it("rejects immediately when given an already-aborted signal", async () => {
    const { server, sessionId, cleanup } = await setupServerWithClient();

    const ac = new AbortController();
    ac.abort();

    const start = Date.now();
    await expect(
      server.request(sessionId, "ping", {}, { resultSchema: EmptyResultSchema, signal: ac.signal }),
    ).rejects.toThrow(/abort/i);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);

    await cleanup();
  });

  // ── Default schema ───────────────────────────────────────────────────

  it("works without a resultSchema (returns unknown)", async () => {
    const { server, sessionId, cleanup } = await setupServerWithClient({
      capabilities: { roots: {} },
      configureClient: (client) => {
        client.setRequestHandler(ListRootsRequestSchema, async () => ({
          roots: [{ uri: "file:///anything" }],
        }));
      },
    });

    const result = await server.request(sessionId, "roots/list", {});
    // No schema — returns unknown. Cast to inspect.
    const r = result as { roots: Array<{ uri: string }> };
    expect(r.roots[0]!.uri).toBe("file:///anything");

    await cleanup();
  });

  // ── Method dispatch boundary ─────────────────────────────────────────

  it("returns method-not-found error when client has no handler for method", async () => {
    const { server, sessionId, cleanup } = await setupServerWithClient({
      // No `roots` capability — client won't have a handler
    });

    await expect(
      server.request(
        sessionId,
        "roots/list",
        {},
        {
          resultSchema: z.object({ roots: z.array(z.unknown()) }),
        },
      ),
    ).rejects.toThrow(/method not found|not supported|-32601/i);

    await cleanup();
  });

  // ── Sampling smoke (forward-compat for Phase 4) ──────────────────────

  it("can issue sampling/createMessage when client supports it", async () => {
    const { server, sessionId, cleanup } = await setupServerWithClient({
      capabilities: { sampling: {} },
      configureClient: (client) => {
        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
          model: "test-model",
          role: "assistant",
          content: { type: "text", text: "echo back" },
          stopReason: "endTurn",
        }));
      },
    });

    const result = await server.request(
      sessionId,
      "sampling/createMessage",
      {
        messages: [{ role: "user", content: { type: "text", text: "hi" } }],
        maxTokens: 10,
      },
      {
        resultSchema: z.object({
          model: z.string(),
          role: z.literal("assistant"),
          content: z.union([
            z.object({ type: z.literal("text"), text: z.string() }),
            z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
          ]),
          stopReason: z.string().optional(),
        }),
      },
    );

    expect(result.model).toBe("test-model");
    expect(result.content.type).toBe("text");
    if (result.content.type === "text") {
      expect(result.content.text).toBe("echo back");
    }

    await cleanup();
  });
});
