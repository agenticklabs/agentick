/**
 * `httpMiddlewareTransport` — the mount-door HTTP shape for hosts that own
 * their own server (express / Nest / Fastify). NO listening socket of its
 * own: a REAL `http.Server` here plays the host, driving every MCP request
 * through `mcp.handler(req, res, parsedBody?)` from inside its request
 * listener — exactly as an express middleware chain would. A REAL SDK
 * `Client` over `StreamableHTTPClientTransport` connects across the wire.
 *
 * Pins:
 *  - happy path: initialize → tools/list → tools/call through the door,
 *    with NO prior body parser (the transport reads the stream itself).
 *  - `parsedBody` passthrough: a host that already consumed + parsed the
 *    POST body (express.json-style) hands it in; the round-trip still works.
 *  - the RFC 9728 `401` pre-gate fires identically through the door.
 *  - RFC 9728 metadata is servable via `metadataHandler` (unauthenticated,
 *    outside any mount path), and `handler` also serves it when forwarded.
 *  - session lifecycle: `Mcp-Session-Id` routing + DELETE teardown drop the
 *    connection from the harness, same as the attached mode.
 *  - foreign paths are the host's — the door never claims them.
 */

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { ContentBlock, ToolDeclaration } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

import {
  allowAllAuth,
  bearerTokenAuth,
  httpMiddlewareTransport,
  McpServerHarness,
  type HttpMiddlewareTransportHandle,
  type McpServerAuthOptions,
  type ToolHandlerResolver,
} from "../../index.js";

const TOKEN = "secret-token";

const echoSchema = jsonSchema({
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
});

function echoTool(): ToolDeclaration {
  return {
    id: "echo",
    name: "echo",
    description: "echoes q",
    inputSchema: echoSchema,
    exposure: ["model"],
    handlerRef: "handler:echo",
  };
}

const echoHandlers: ToolHandlerResolver = (ref) => {
  if (ref !== "handler:echo") return null;
  return async (input) => ({
    kind: "inline",
    content: [{ type: "text", text: `echo: ${(input as { q: string }).q}` }] as ContentBlock[],
  });
};

const OAUTH_METADATA: OAuthProtectedResourceMetadata = {
  resource: "https://api.example.com/mcp",
  authorization_servers: ["https://auth.example.com"],
  bearer_methods_supported: ["header"],
  scopes_supported: ["mcp:read", "mcp:write"],
};

const WELL_KNOWN = "/.well-known/oauth-protected-resource";

/**
 * Stand up a host `http.Server` that drives the middleware transport. This
 * is the "express" in the test — MCP requests to `/mcp` go through
 * `mcp.handler`; the well-known path goes through `mcp.metadataHandler`;
 * `/host-route` is the host's OWN route (proving the door never claims it).
 *
 * `parseBody`: when true, the host reads + JSON-parses the POST body itself
 * (like `express.json()`) and passes it as `parsedBody` — proving the
 * passthrough. When false, the host hands the intact stream to the door.
 */
function makeHost(
  mcp: HttpMiddlewareTransportHandle,
  parseBody: boolean,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    // Root-level: RFC 9728 discovery (outside the mount path).
    if (mcp.metadataHandler(req, res)) return;

    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/host-route") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("host-handled");
      return;
    }
    if (url.pathname === "/mcp") {
      if (parseBody && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c as Buffer));
        req.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const body = raw.length > 0 ? JSON.parse(raw) : undefined;
          void mcp.handler(req, res, body);
        });
        return;
      }
      void mcp.handler(req, res);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  };
}

async function standUp(opts: {
  readonly parseBody?: boolean;
  readonly oauth?: boolean;
  readonly auth?: McpServerAuthOptions;
  readonly idleTtlMs?: number;
  readonly maxSessions?: number;
  readonly cleanupIntervalMs?: number;
}): Promise<{
  readonly harness: McpServerHarness;
  readonly mcp: HttpMiddlewareTransportHandle;
  readonly host: HttpServer;
  readonly base: string;
  readonly cleanup: () => Promise<void>;
}> {
  const mcp = httpMiddlewareTransport({
    ...(opts.oauth ? { oauth: { metadata: OAUTH_METADATA } } : {}),
    ...(opts.idleTtlMs !== undefined ? { idleTtlMs: opts.idleTtlMs } : {}),
    ...(opts.maxSessions !== undefined ? { maxSessions: opts.maxSessions } : {}),
    ...(opts.cleanupIntervalMs !== undefined ? { cleanupIntervalMs: opts.cleanupIntervalMs } : {}),
  });
  const harness = new McpServerHarness(
    `srv:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      name: "mw-test",
      transports: [mcp],
      tools: { registry: [echoTool()], resolveHandler: echoHandlers },
      serverInfo: { name: "mw-test", version: "0.0.0" },
      auth: opts.auth ?? { authenticator: allowAllAuth },
    },
  );
  await harness.ready;
  await harness.start();

  const host = createServer(makeHost(mcp, opts.parseBody ?? false));
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  const port = (host.address() as AddressInfo).port;

  return {
    harness,
    mcp,
    host,
    base: `http://127.0.0.1:${port}`,
    cleanup: async () => {
      await harness.close();
      await mcp.close();
      await new Promise<void>((resolve) => host.close(() => resolve()));
    },
  };
}

async function connectClient(
  base: string,
  token?: string,
): Promise<{ client: McpClient; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${base}/mcp`),
    token !== undefined ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {},
  );
  const client = new McpClient({ name: "c", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

describe("httpMiddlewareTransport — round-trip through the host's middleware", () => {
  it("initialize → tools/list → tools/call with NO prior body parser", async () => {
    const ctx = await standUp({ parseBody: false });
    const { client } = await connectClient(ctx.base);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("echo");
    const result = await client.callTool({ name: "echo", arguments: { q: "hello" } });
    expect((result.content as { text: string }[])[0]!.text).toBe("echo: hello");
    expect(ctx.harness.connections()).toHaveLength(1);
    expect(ctx.harness.connections()[0]!.transportKind).toBe("http");

    await client.close();
    await ctx.cleanup();
  });

  it("works when the host already parsed the body (parsedBody passthrough)", async () => {
    const ctx = await standUp({ parseBody: true });
    const { client } = await connectClient(ctx.base);

    // Every POST (initialize + tools/call) was drained + JSON-parsed by the
    // host before reaching the door — the SDK used the passed body, not the
    // (already-consumed) stream.
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("echo");
    const result = await client.callTool({ name: "echo", arguments: { q: "parsed" } });
    expect((result.content as { text: string }[])[0]!.text).toBe("echo: parsed");

    await client.close();
    await ctx.cleanup();
  });

  it("leaves the host's own routes untouched — the door never claims foreign paths", async () => {
    const ctx = await standUp({ parseBody: false });
    const foreign = await fetch(`${ctx.base}/host-route`);
    expect(foreign.status).toBe(200);
    expect(await foreign.text()).toBe("host-handled");
    await ctx.cleanup();
  });
});

describe("httpMiddlewareTransport — session lifecycle", () => {
  it("routes by Mcp-Session-Id and drops the session on DELETE teardown", async () => {
    const ctx = await standUp({ parseBody: false });
    const { client, transport } = await connectClient(ctx.base);

    // A second call reuses the same Mcp-Session-Id — proves the session map
    // routes returning requests to the right SDK transport.
    await client.callTool({ name: "echo", arguments: { q: "one" } });
    await client.callTool({ name: "echo", arguments: { q: "two" } });
    expect(ctx.harness.connections()).toHaveLength(1);
    const sessionId = transport.sessionId;
    expect(sessionId).toBeDefined();

    // DELETE teardown: the SDK transport's `terminateSession()` sends the
    // DELETE with the session id through the door; the core drops it from
    // the `Mcp-Session-Id` map. Proven by a raw follow-up POST carrying the
    // now-stale id getting a 404 "Unknown session" — identical to the
    // attached mode's routing.
    await transport.terminateSession();
    const stale = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }),
    });
    expect(stale.status).toBe(404);
    await stale.body?.cancel();

    await client.close();
    await ctx.cleanup();
  });
});

describe("httpMiddlewareTransport — RFC 9728 pre-gate through the door", () => {
  it("challenges an absent credential with 401 + WWW-Authenticate", async () => {
    const ctx = await standUp({
      oauth: true,
      auth: { authenticator: bearerTokenAuth({ tokens: { [TOKEN]: { id: "alice" } } }) },
    });

    const res = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    await res.body?.cancel();

    // The crossing was rejected before the SDK saw it — no session opened.
    expect(ctx.harness.connections()).toHaveLength(0);
    await ctx.cleanup();
  });

  it("lets a valid token pass through the door to normal handling", async () => {
    const ctx = await standUp({
      oauth: true,
      auth: { authenticator: bearerTokenAuth({ tokens: { [TOKEN]: { id: "alice" } } }) },
    });
    const { client } = await connectClient(ctx.base, TOKEN);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("echo");
    expect(ctx.harness.connections()).toHaveLength(1);
    await client.close();
    await ctx.cleanup();
  });
});

describe("httpMiddlewareTransport — RFC 9728 metadata serving", () => {
  it("metadataHandler serves the document unauthenticated at the well-known path(s)", async () => {
    const ctx = await standUp({
      oauth: true,
      auth: { authenticator: bearerTokenAuth({ tokens: { [TOKEN]: { id: "alice" } } }) },
    });

    // No Authorization header — discovery MUST work (pre-gate never touches it).
    const bare = await fetch(`${ctx.base}${WELL_KNOWN}`);
    expect(bare.status).toBe(200);
    expect(await bare.json()).toEqual(OAUTH_METADATA);

    const suffixed = await fetch(`${ctx.base}${WELL_KNOWN}/mcp`);
    expect(suffixed.status).toBe(200);
    expect(await suffixed.json()).toEqual(OAUTH_METADATA);

    await ctx.cleanup();
  });

  it("metadataHandler returns false (host continues) for a non-metadata path", async () => {
    const ctx = await standUp({ oauth: true, auth: { authenticator: allowAllAuth } });
    // /host-route is NOT a metadata path → metadataHandler returns false →
    // the host's own route answers.
    const foreign = await fetch(`${ctx.base}/host-route`);
    expect(foreign.status).toBe(200);
    expect(await foreign.text()).toBe("host-handled");
    await ctx.cleanup();
  });

  it("handler also serves metadata when the host forwards the well-known path to it", async () => {
    // Direct-drive the door with a fabricated GET at the well-known path —
    // proves `handler` serves metadata (and does NOT 401 it) even when the
    // host routes discovery through the same entry point.
    const mcp = httpMiddlewareTransport({ oauth: { metadata: OAUTH_METADATA } });
    const harness = new McpServerHarness(
      `srv:${generateId()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      {
        name: "mw-fwd",
        transports: [mcp],
        serverInfo: { name: "mw-fwd", version: "0.0.0" },
        auth: { authenticator: bearerTokenAuth({ tokens: { [TOKEN]: { id: "alice" } } }) },
      },
    );
    await harness.ready;
    await harness.start();

    const captured: { status?: number; body?: string; headers: Record<string, string> } = {
      headers: {},
    };
    const res = {
      headersSent: false,
      writeHead(status: number, headers?: Record<string, string>): unknown {
        captured.status = status;
        Object.assign(captured.headers, headers ?? {});
        (res as { headersSent: boolean }).headersSent = true;
        return res;
      },
      end(chunk?: string): void {
        captured.body = chunk;
      },
    } as unknown as ServerResponse;
    const req = {
      method: "GET",
      url: WELL_KNOWN,
      headers: {},
      socket: {},
    } as unknown as IncomingMessage;

    await mcp.handler(req, res);
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body ?? "{}")).toEqual(OAUTH_METADATA);

    await harness.close();
    await mcp.close();
  });
});

describe("httpMiddlewareTransport — stale-session recovery (restart survivability)", () => {
  const INIT = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "raw", version: "0" },
    },
  });
  const post = (base: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body,
    });

  it("a POST carrying a STALE session id + initialize opens a FRESH session (does not 404)", async () => {
    const ctx = await standUp({ parseBody: false });
    try {
      // A session id the server has never heard of (the pre-restart one).
      const res = await post(ctx.base, INIT, {
        "mcp-session-id": "stale-00000000-0000-0000-0000-000000000000",
      });
      // Recovered: a brand-new session, NOT a hard 404.
      expect(res.status).toBe(200);
      expect(res.headers.get("mcp-session-id")).toBeTruthy();
      expect(res.headers.get("mcp-session-id")).not.toBe(
        "stale-00000000-0000-0000-0000-000000000000",
      );
    } finally {
      await ctx.cleanup();
    }
  });

  it("a non-initialize POST with a stale session id 404s with a re-initialize hint", async () => {
    const ctx = await standUp({ parseBody: false });
    try {
      const res = await post(
        ctx.base,
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        { "mcp-session-id": "stale-11111111-1111-1111-1111-111111111111" },
      );
      expect(res.status).toBe(404);
      const json = (await res.json()) as { error?: { message?: string } };
      expect(json.error?.message ?? "").toMatch(/re-initialize/i);
    } finally {
      await ctx.cleanup();
    }
  });

  it("a sessionless initialize still opens a session (unchanged happy path)", async () => {
    const ctx = await standUp({ parseBody: false });
    try {
      const res = await post(ctx.base, INIT);
      expect(res.status).toBe(200);
      expect(res.headers.get("mcp-session-id")).toBeTruthy();
    } finally {
      await ctx.cleanup();
    }
  });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("httpMiddlewareTransport — session reaper", () => {
  it("idle sweep closes a session that goes quiet past the TTL", async () => {
    const ctx = await standUp({ parseBody: false, idleTtlMs: 60, cleanupIntervalMs: 20 });
    const { client } = await connectClient(ctx.base);
    expect(ctx.harness.connections()).toHaveLength(1);

    await sleep(220); // no activity — the sweep closes it
    expect(ctx.harness.connections()).toHaveLength(0);

    try {
      await client.close();
    } catch {
      /* session already reaped */
    }
    await ctx.cleanup();
  });

  it("activity resets idleness — a busy session is NOT reaped", async () => {
    const ctx = await standUp({ parseBody: false, idleTtlMs: 120, cleanupIntervalMs: 20 });
    const { client } = await connectClient(ctx.base);

    // Calls spaced under the TTL keep it alive well past one TTL window.
    for (let i = 0; i < 6; i++) {
      await client.callTool({ name: "echo", arguments: { q: `${i}` } });
      await sleep(40);
    }
    expect(ctx.harness.connections()).toHaveLength(1);

    // Now go quiet — it gets reaped.
    await sleep(260);
    expect(ctx.harness.connections()).toHaveLength(0);

    try {
      await client.close();
    } catch {
      /* already reaped */
    }
    await ctx.cleanup();
  });

  it("maxSessions evicts the least-recently-active session", async () => {
    // Sweep disabled (idleTtlMs: 0) so eviction is the only thing closing sessions.
    const ctx = await standUp({ parseBody: false, idleTtlMs: 0, maxSessions: 2 });
    const a = await connectClient(ctx.base);
    const b = await connectClient(ctx.base);
    expect(ctx.harness.connections()).toHaveLength(2);

    // Touch A so B is the least-recently-active of the two. Space it so A's
    // activity timestamp is strictly newer than B's (LRU ties break by
    // insertion order, which would otherwise evict A).
    await sleep(10);
    await a.client.callTool({ name: "echo", arguments: { q: "keepalive" } });

    // Opening C exceeds the cap → the stalest (B) is evicted, A survives.
    const c = await connectClient(ctx.base);
    await sleep(50); // let B's close propagate to the harness registry
    expect(ctx.harness.connections()).toHaveLength(2);

    // A was most-recently-active, so it's still live and serving.
    const still = await a.client.callTool({ name: "echo", arguments: { q: "alive" } });
    expect((still.content as { text: string }[])[0]!.text).toBe("echo: alive");

    for (const conn of [a, b, c]) {
      try {
        await conn.client.close();
      } catch {
        /* evicted session's client may already be dead */
      }
    }
    await ctx.cleanup();
  });
});
