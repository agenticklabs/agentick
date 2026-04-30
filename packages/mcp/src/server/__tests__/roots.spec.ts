/**
 * Phase 3 — Roots
 *
 * Tests `MCPServer.listRoots()` outbound primitive, per-session caching,
 * cache invalidation on `notifications/roots/list_changed`, file:// scheme
 * enforcement, and the `RootsAPI` sugar surface (`ctx.roots.*`).
 *
 * Adversarial: unknown session, no-capability client, empty roots list,
 * non-file URIs (rejected), path traversal, path normalization, named
 * root resolution, missing-named-root error, subscribe fan-out, cache
 * survives session close (no leaks).
 */

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "../../transport/index.js";
import { MCPServer, SessionNotFoundError } from "../server.js";
import type { MCPToolDefinition, Root } from "../../protocol/types.js";
import { z } from "zod";

// ============================================================================
// Helpers
// ============================================================================

interface SetupOpts {
  rootsCapability?: boolean;
  rootsResponse?: () => Root[] | Promise<Root[]>;
  tools?: MCPToolDefinition[];
}

async function setup(opts: SetupOpts = {}): Promise<{
  server: MCPServer;
  client: Client;
  sessionId: string;
  cleanup: () => Promise<void>;
}> {
  const server = new MCPServer({
    name: "roots-test",
    version: "1.0.0",
    tools: opts.tools,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    {
      capabilities: opts.rootsCapability ? { roots: { listChanged: true } } : {},
    },
  );

  if (opts.rootsCapability !== false && opts.rootsResponse) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: await opts.rootsResponse!(),
    }));
  }

  await client.connect(clientTransport);

  const sessions = server.getActiveSessions();
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
// MCPServer.listRoots — outbound primitive
// ============================================================================

describe("MCPServer.listRoots — outbound primitive", () => {
  it("fetches roots from a client that advertised the capability", async () => {
    const { server, sessionId, cleanup } = await setup({
      rootsCapability: true,
      rootsResponse: () => [
        { uri: "file:///workspace/a", name: "a" },
        { uri: "file:///workspace/b", name: "b" },
      ],
    });

    const roots = await server.listRoots(sessionId);
    expect(roots).toHaveLength(2);
    expect(roots[0]!.uri).toBe("file:///workspace/a");
    expect(roots[1]!.name).toBe("b");

    await cleanup();
  });

  it("returns empty array when client did not advertise roots capability", async () => {
    const { server, sessionId, cleanup } = await setup({
      rootsCapability: false,
    });

    const roots = await server.listRoots(sessionId);
    expect(roots).toEqual([]);

    await cleanup();
  });

  it("returns empty array when client supports capability but list is empty", async () => {
    const { server, sessionId, cleanup } = await setup({
      rootsCapability: true,
      rootsResponse: () => [],
    });

    const roots = await server.listRoots(sessionId);
    expect(roots).toEqual([]);

    await cleanup();
  });

  it("throws SessionNotFoundError for unknown sessionId", async () => {
    const { server, cleanup } = await setup({ rootsCapability: true });

    await expect(server.listRoots("ghost-session")).rejects.toThrow(SessionNotFoundError);
    await cleanup();
  });

  it("rejects when client returns a non-file:// URI (SDK-level enforcement)", async () => {
    // Spec: roots URIs MUST be file:// in 2025-11-25. The SDK's
    // ListRootsResultSchema enforces this at parse time — a misbehaving
    // client trying to ship `https://...` causes the entire response to
    // be rejected, surfacing as a thrown error from listRoots(). This is
    // strictly better than silent filtering.
    const { server, sessionId, cleanup } = await setup({
      rootsCapability: true,
      rootsResponse: () => [
        { uri: "file:///valid", name: "ok" },
        { uri: "https://example.com/bad" } as Root,
      ],
    });

    await expect(server.listRoots(sessionId)).rejects.toThrow(/.+/);
    await cleanup();
  });
});

// ============================================================================
// listRoots — caching
// ============================================================================

describe("MCPServer.listRoots — caching", () => {
  it("caches per session — repeated calls hit the cache", async () => {
    let callCount = 0;
    const { server, sessionId, cleanup } = await setup({
      rootsCapability: true,
      rootsResponse: () => {
        callCount++;
        return [{ uri: "file:///x", name: "x" }];
      },
    });

    await server.listRoots(sessionId);
    await server.listRoots(sessionId);
    await server.listRoots(sessionId);

    expect(callCount).toBe(1);
    await cleanup();
  });

  it("force option bypasses the cache", async () => {
    let callCount = 0;
    const { server, sessionId, cleanup } = await setup({
      rootsCapability: true,
      rootsResponse: () => {
        callCount++;
        return [{ uri: "file:///x" }];
      },
    });

    await server.listRoots(sessionId);
    await server.listRoots(sessionId, { force: true });
    await server.listRoots(sessionId, { force: true });

    expect(callCount).toBe(3);
    await cleanup();
  });

  it("cache invalidated when client sends notifications/roots/list_changed", async () => {
    let callCount = 0;
    let currentRoots: Root[] = [{ uri: "file:///before", name: "before" }];

    const { server, client, sessionId, cleanup } = await setup({
      rootsCapability: true,
      rootsResponse: () => {
        callCount++;
        return currentRoots;
      },
    });

    const first = await server.listRoots(sessionId);
    expect(first[0]!.uri).toBe("file:///before");
    expect(callCount).toBe(1);

    // Client updates its roots and notifies the server
    currentRoots = [{ uri: "file:///after", name: "after" }];
    await client.sendRootsListChanged();

    // Wait for the notification to round-trip
    await new Promise((r) => setTimeout(r, 30));

    const second = await server.listRoots(sessionId);
    expect(second[0]!.uri).toBe("file:///after");
    expect(callCount).toBe(2);

    await cleanup();
  });
});

// ============================================================================
// ctx.roots — sugar API
// ============================================================================

describe("ctx.roots — sugar API", () => {
  async function runWithRoots<T>(
    roots: Root[] | undefined,
    handler: (rootsAPI: import("../../protocol/types.js").RootsAPI) => Promise<T>,
  ): Promise<T> {
    let captured!: T;
    let handlerError: unknown = null;
    const tool: MCPToolDefinition = {
      name: "probe",
      inputSchema: {},
      handler: async (_input, ctx) => {
        try {
          captured = await handler(ctx.roots);
        } catch (err) {
          handlerError = err;
          throw err;
        }
        return { content: [{ type: "text", text: "ok" }] };
      },
    };

    const { client, cleanup } = await setup({
      rootsCapability: roots !== undefined,
      rootsResponse: roots ? () => roots : undefined,
      tools: [tool],
    });

    const result = await client.callTool({ name: "probe", arguments: {} });
    await cleanup();
    if (handlerError) throw handlerError;
    if (result.isError) {
      const text = (result.content as Array<{ text?: string }>)[0]?.text;
      throw new Error(`tool error: ${text}`);
    }
    return captured;
  }

  it("ctx.roots is always present (non-null) on the handler context", async () => {
    const out = await runWithRoots(undefined, async (roots) => roots);
    expect(out).toBeDefined();
    expect(typeof out.list).toBe("function");
  });

  it("list() returns the connected client's roots", async () => {
    const out = await runWithRoots([{ uri: "file:///a" }, { uri: "file:///b" }], async (roots) =>
      roots.list(),
    );
    expect(out.map((r) => r.uri).sort()).toEqual(["file:///a", "file:///b"]);
  });

  it("list() returns [] when client did not advertise roots capability", async () => {
    const out = await runWithRoots(undefined, async (roots) => roots.list());
    expect(out).toEqual([]);
  });

  // ── isWithin / assertWithin ───────────────────────────────────────────

  it("isWithin returns true for path inside a declared root", async () => {
    const out = await runWithRoots([{ uri: "file:///workspace" }], async (roots) =>
      roots.isWithin("/workspace/src/index.ts"),
    );
    expect(out).toBe(true);
  });

  it("isWithin returns false for path outside all declared roots", async () => {
    const out = await runWithRoots([{ uri: "file:///workspace" }], async (roots) =>
      roots.isWithin("/etc/passwd"),
    );
    expect(out).toBe(false);
  });

  it("isWithin permissive when no roots declared (no constraints)", async () => {
    const out = await runWithRoots(undefined, async (roots) => roots.isWithin("/anywhere"));
    expect(out).toBe(true);
  });

  it("isWithin accepts file:// URIs as the path argument", async () => {
    const out = await runWithRoots([{ uri: "file:///workspace" }], async (roots) =>
      roots.isWithin("file:///workspace/sub/file.ts"),
    );
    expect(out).toBe(true);
  });

  it("assertWithin passes for paths inside a root", async () => {
    await expect(
      runWithRoots([{ uri: "file:///workspace" }], async (roots) => {
        await roots.assertWithin("/workspace/file.ts");
        return "ok";
      }),
    ).resolves.toBe("ok");
  });

  it("assertWithin throws for paths outside all roots", async () => {
    await expect(
      runWithRoots([{ uri: "file:///workspace" }], async (roots) => {
        await roots.assertWithin("/elsewhere/file.ts");
        return "ok";
      }),
    ).rejects.toThrow(/outside.*root/i);
  });

  it("assertWithin no-ops (permissive) when no roots declared", async () => {
    await expect(
      runWithRoots(undefined, async (roots) => {
        await roots.assertWithin("/anywhere");
        return "ok";
      }),
    ).resolves.toBe("ok");
  });

  // ── rootContaining ────────────────────────────────────────────────────

  it("rootContaining returns the matching root for an inside path", async () => {
    const out = await runWithRoots(
      [
        { uri: "file:///workspace/a", name: "a" },
        { uri: "file:///workspace/b", name: "b" },
      ],
      async (roots) => roots.rootContaining("/workspace/b/file.ts"),
    );
    expect(out?.name).toBe("b");
  });

  it("rootContaining returns null for outside path", async () => {
    const out = await runWithRoots([{ uri: "file:///workspace" }], async (roots) =>
      roots.rootContaining("/etc/passwd"),
    );
    expect(out).toBeNull();
  });

  it("rootContaining returns null when list is empty even if path exists", async () => {
    const out = await runWithRoots(undefined, async (roots) => roots.rootContaining("/anywhere"));
    expect(out).toBeNull();
  });

  it("rootContaining picks the most specific match (longer prefix wins)", async () => {
    const out = await runWithRoots(
      [
        { uri: "file:///a", name: "outer" },
        { uri: "file:///a/b/c", name: "inner" },
      ],
      async (roots) => roots.rootContaining("/a/b/c/d/file.ts"),
    );
    expect(out?.name).toBe("inner");
  });

  // ── resolveRelative ───────────────────────────────────────────────────

  it("resolveRelative joins against the first root by default", async () => {
    const out = await runWithRoots(
      [
        { uri: "file:///first", name: "first" },
        { uri: "file:///second", name: "second" },
      ],
      async (roots) => roots.resolveRelative("src/index.ts"),
    );
    expect(out).toBe("/first/src/index.ts");
  });

  it("resolveRelative joins against a named root when requested", async () => {
    const out = await runWithRoots(
      [
        { uri: "file:///first", name: "first" },
        { uri: "file:///second", name: "second" },
      ],
      async (roots) => roots.resolveRelative("src/index.ts", { name: "second" }),
    );
    expect(out).toBe("/second/src/index.ts");
  });

  it("resolveRelative throws when named root is not found", async () => {
    await expect(
      runWithRoots([{ uri: "file:///x", name: "x" }], async (roots) =>
        roots.resolveRelative("a", { name: "missing" }),
      ),
    ).rejects.toThrow(/no root.*missing/i);
  });

  it("resolveRelative throws when no roots are declared", async () => {
    await expect(
      runWithRoots(undefined, async (roots) => roots.resolveRelative("a")),
    ).rejects.toThrow(/no roots/i);
  });

  // ── Path normalization (adversarial) ──────────────────────────────────

  it("isWithin treats trailing-slash root and bare path equivalently", async () => {
    // Workspace root supplied with no trailing slash; path is exactly the
    // root; should be considered within.
    const out = await runWithRoots([{ uri: "file:///workspace" }], async (roots) =>
      roots.isWithin("/workspace"),
    );
    expect(out).toBe(true);
  });

  it("isWithin rejects a sibling whose name shares a prefix (no false match)", async () => {
    // Root: /workspace ; candidate: /workspace-other/x.txt
    // Naive startsWith check would falsely match — must use boundary.
    const out = await runWithRoots([{ uri: "file:///workspace" }], async (roots) =>
      roots.isWithin("/workspace-other/x.txt"),
    );
    expect(out).toBe(false);
  });

  it("isWithin handles URI-encoded paths in roots", async () => {
    // file:///path%20with%20space  → /path with space
    const out = await runWithRoots([{ uri: "file:///path%20with%20space" }], async (roots) =>
      roots.isWithin("/path with space/file.ts"),
    );
    expect(out).toBe(true);
  });

  // ── subscribe ─────────────────────────────────────────────────────────

  it("subscribe fires when client sends roots/list_changed", async () => {
    let received: Root[] | null = null;

    let currentRoots: Root[] = [{ uri: "file:///old" }];
    const tool: MCPToolDefinition = {
      name: "subscribe",
      inputSchema: {},
      handler: async (_input, ctx) => {
        ctx.roots.subscribe((roots) => {
          received = roots;
        });
        return { content: [{ type: "text", text: "subscribed" }] };
      },
    };

    const { client, cleanup } = await setup({
      rootsCapability: true,
      rootsResponse: () => currentRoots,
      tools: [tool],
    });

    await client.callTool({ name: "subscribe", arguments: {} });

    currentRoots = [{ uri: "file:///new", name: "new" }];
    await client.sendRootsListChanged();

    // Allow notification + cache refresh round trip
    await new Promise((r) => setTimeout(r, 50));

    expect(received).not.toBeNull();
    expect(received![0]!.uri).toBe("file:///new");

    await cleanup();
  });

  it("subscribe returns an unsubscribe function", async () => {
    let count = 0;

    const tool: MCPToolDefinition = {
      name: "sub",
      inputSchema: {},
      handler: async (_input, ctx) => {
        const unsub = ctx.roots.subscribe(() => {
          count++;
        });
        unsub();
        return { content: [{ type: "text", text: "x" }] };
      },
    };

    const { client, cleanup } = await setup({
      rootsCapability: true,
      rootsResponse: () => [{ uri: "file:///x" }],
      tools: [tool],
    });

    await client.callTool({ name: "sub", arguments: {} });
    await client.sendRootsListChanged();
    await new Promise((r) => setTimeout(r, 30));

    expect(count).toBe(0);
    await cleanup();
  });
});

// ============================================================================
// Cache hygiene on session close
// ============================================================================

describe("MCPServer.listRoots — cache hygiene", () => {
  it("listRoots after session close throws SessionNotFoundError (no stale cache hit)", async () => {
    const { server, sessionId, cleanup } = await setup({
      rootsCapability: true,
      rootsResponse: () => [{ uri: "file:///x" }],
    });

    await server.listRoots(sessionId); // populate cache
    await cleanup();

    await expect(server.listRoots(sessionId)).rejects.toThrow(/.+/);
  });
});

// ============================================================================
// Path utilities — unit tests
// ============================================================================

describe("path utilities", () => {
  it("isValidRootUri accepts file:// URIs", async () => {
    const { isValidRootUri } = await import("../roots.js");
    expect(isValidRootUri("file:///workspace")).toBe(true);
    expect(isValidRootUri("file://localhost/path")).toBe(true);
  });

  it("isValidRootUri rejects everything else", async () => {
    const { isValidRootUri } = await import("../roots.js");
    expect(isValidRootUri("https://example.com")).toBe(false);
    expect(isValidRootUri("ssh://server")).toBe(false);
    expect(isValidRootUri("/no-scheme")).toBe(false);
    expect(isValidRootUri("")).toBe(false);
    expect(isValidRootUri(undefined)).toBe(false);
    expect(isValidRootUri(null)).toBe(false);
    expect(isValidRootUri(42)).toBe(false);
  });

  it("fileUriToPath decodes percent-escapes", async () => {
    const { fileUriToPath } = await import("../roots.js");
    expect(fileUriToPath("file:///path%20with%20space")).toBe("/path with space");
    expect(fileUriToPath("file:///%C3%BCnicode")).toBe("/ünicode");
  });

  it("fileUriToPath returns input unchanged for non-file URIs", async () => {
    const { fileUriToPath } = await import("../roots.js");
    expect(fileUriToPath("/already/abs")).toBe("/already/abs");
  });

  it("pathIsWithin rejects sibling-name false matches", async () => {
    const { pathIsWithin } = await import("../roots.js");
    expect(pathIsWithin("/workspace-other/x", "/workspace")).toBe(false);
    expect(pathIsWithin("/workspaceX", "/workspace")).toBe(false);
  });

  it("pathIsWithin treats exact-match path as within", async () => {
    const { pathIsWithin } = await import("../roots.js");
    expect(pathIsWithin("/workspace", "/workspace")).toBe(true);
    expect(pathIsWithin("/workspace/", "/workspace")).toBe(true);
  });

  it("pathIsWithin handles nested children", async () => {
    const { pathIsWithin } = await import("../roots.js");
    expect(pathIsWithin("/workspace/src/index.ts", "/workspace")).toBe(true);
  });
});

// ── unused import guard ──────────────────────────────────────────────────
void z;
