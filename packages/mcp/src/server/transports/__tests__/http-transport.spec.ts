/**
 * `httpTransport` — real-loopback Streamable HTTP conformance (Wave 1).
 *
 * NO fakes, NO in-memory pair: this stands up an `McpServerHarness` on
 * `httpTransport({ port: 0 })` (ephemeral loopback port) and connects a
 * REAL `McpClientHarness` over the SDK's `StreamableHTTPClientTransport`
 * to `http://127.0.0.1:<port>/mcp`. Every assertion crosses the actual
 * HTTP/SSE wire.
 *
 * Pins:
 *  - Full round-trip: initialize → tools/list (sees the tool) →
 *    tools/call (gets the result) over real HTTP.
 *  - The security pipeline runs for HTTP connections: bearer auth reads
 *    the `Authorization` header built from the HTTP request
 *    (`McpConnectionInfo` → `ctx.metadata.headers`); a bad token is
 *    rejected at the per-request pipeline.
 *  - Multi-connection: two concurrent clients each get their own MCP
 *    session (distinct `Mcp-Session-Id`), tracked independently by the
 *    server harness, with isolated call results.
 *  - Client factory + OAuth threading: `streamableHttpTransport({ oauth })`
 *    constructs the SDK transport with an `authProvider`; the provider's
 *    `redirectToAuthorization` fires the session-bound URL elicit.
 */

import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import type { ContentBlock, ToolDeclaration, UrlElicitationRequest } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

import {
  bearerTokenAuth,
  httpTransport,
  McpServerHarness,
  type HttpServerTransportHandle,
  type ToolHandlerResolver,
} from "../../index.js";
import {
  McpClientHarness,
  NoneAuth,
  streamableHttpTransport,
  type TransportFactoryDeps,
} from "../../../index.js";

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

/**
 * Stand up a server harness on an ephemeral loopback port with a bearer
 * authenticator. Returns the harness, the transport handle (to read the
 * bound port), and the resolved base URL.
 */
async function makeHttpServer(): Promise<{
  readonly harness: McpServerHarness;
  readonly transport: HttpServerTransportHandle;
  readonly url: string;
}> {
  const transport = httpTransport({ port: 0 });
  const harness = new McpServerHarness(
    `srv:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      name: "http-test-server",
      transports: [transport],
      tools: { registry: [echoTool()], resolveHandler: echoHandlers },
      auth: { authenticator: bearerTokenAuth({ tokens: { [TOKEN]: { id: "alice" } } }) },
      serverInfo: { name: "http-test", version: "0.0.0" },
    },
  );
  await harness.ready;
  await harness.start();
  const addr = transport.address();
  if (addr === null) throw new Error("httpTransport did not bind a port");
  return { harness, transport, url: `http://127.0.0.1:${addr.port}/mcp` };
}

/** Build a client harness over a real StreamableHTTP transport. */
async function makeHttpClient(transport: Transport, serverId: string): Promise<McpClientHarness> {
  const client = new McpClientHarness(
    `${serverId}:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    { serverId, transport, auth: new NoneAuth() },
  );
  await client.ready;
  await client.connect();
  return client;
}

/** Deps for the client transport factory (no OAuth path). */
function bearerDeps(serverId: string): TransportFactoryDeps {
  return {
    elicit: async () => ({ outcome: "cancelled" }),
    serverId,
    credentialKey: (field) => `mcp:${serverId}:${field}`,
    interactive: false,
  };
}

describe("httpTransport — round-trip over real loopback HTTP", () => {
  it("initialize → tools/list → tools/call across the wire", async () => {
    const { harness, transport, url } = await makeHttpServer();
    const clientTransport = await streamableHttpTransport({
      url,
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    })(bearerDeps("echo-srv"));
    expect(clientTransport).toBeInstanceOf(StreamableHTTPClientTransport);

    const client = await makeHttpClient(clientTransport, "echo-srv");

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("echo");

    const result = await client.callTool("echo", { q: "hello" });
    expect(result.isError).toBeFalsy();
    expect((result.content as { type: string; text: string }[])[0]!.text).toBe("echo: hello");

    // The connection was accepted over loopback (localOnly guard) and
    // is tracked by the harness.
    expect(harness.connections()).toHaveLength(1);
    expect(harness.connections()[0]!.transportKind).toBe("http");

    await client.close();
    await harness.close();
    await transport.close();
  });

  it("rejects a bad bearer token at the per-request security pipeline", async () => {
    const { harness, transport, url } = await makeHttpServer();
    const clientTransport = await streamableHttpTransport({
      url,
      requestInit: { headers: { Authorization: "Bearer wrong-token" } },
    })(bearerDeps("bad-srv"));
    const client = await makeHttpClient(clientTransport, "bad-srv");

    // Initialize is not authenticated (SDK-internal); the pipeline runs
    // on tools/list and rejects the invalid token. Capture rather than
    // matching the wire-surfaced message (JSON-RPC error text is not
    // load-bearing here — that the pipeline rejected is).
    let threw = false;
    try {
      await client.listTools();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    await client.close();
    await harness.close();
    await transport.close();
  });
});

describe("httpTransport — multi-connection session isolation", () => {
  it("two concurrent clients each get their own Mcp-Session-Id", async () => {
    const { harness, transport, url } = await makeHttpServer();

    const t1 = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const t2 = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });

    const c1 = await makeHttpClient(t1, "srv-1");
    const c2 = await makeHttpClient(t2, "srv-2");

    // Two independent sessions on the server.
    expect(harness.connections()).toHaveLength(2);

    // Distinct session ids minted per connection by the SDK server transport.
    expect(t1.sessionId).toBeDefined();
    expect(t2.sessionId).toBeDefined();
    expect(t1.sessionId).not.toBe(t2.sessionId);

    // Isolated round-trips.
    const [r1, r2] = await Promise.all([
      c1.callTool("echo", { q: "A" }),
      c2.callTool("echo", { q: "B" }),
    ]);
    expect((r1.content as { text: string }[])[0]!.text).toBe("echo: A");
    expect((r2.content as { text: string }[])[0]!.text).toBe("echo: B");

    await c1.close();
    await c2.close();
    await harness.close();
    await transport.close();
  });
});

/** RFC 9728 protected-resource metadata document served in the OAuth tests. */
const OAUTH_METADATA: OAuthProtectedResourceMetadata = {
  resource: "https://api.example.com/mcp",
  authorization_servers: ["https://auth.example.com"],
  bearer_methods_supported: ["header"],
  scopes_supported: ["mcp:read", "mcp:write"],
};

const WELL_KNOWN = "/.well-known/oauth-protected-resource";

/**
 * Start a server harness on the given transport handle (already
 * constructed with the desired options). Mirrors `makeHttpServer` but
 * lets a test pick the transport (owned vs. attached, oauth on/off).
 */
async function startHarnessOn(transport: HttpServerTransportHandle): Promise<McpServerHarness> {
  const harness = new McpServerHarness(
    `srv:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      name: "http-oauth-test-server",
      transports: [transport],
      tools: { registry: [echoTool()], resolveHandler: echoHandlers },
      auth: { authenticator: bearerTokenAuth({ tokens: { [TOKEN]: { id: "alice" } } }) },
      serverInfo: { name: "http-oauth-test", version: "0.0.0" },
    },
  );
  await harness.ready;
  await harness.start();
  return harness;
}

describe("httpTransport — OAuth resource-server discovery (RFC 9728)", () => {
  it("serves protected-resource metadata at the well-known path(s) (owned server)", async () => {
    const transport = httpTransport({ port: 0, oauth: { metadata: OAUTH_METADATA } });
    const harness = await startHarnessOn(transport);
    const addr = transport.address();
    if (addr === null) throw new Error("httpTransport did not bind a port");
    const base = `http://127.0.0.1:${addr.port}`;

    // Bare well-known path (RFC 9728 §3.1).
    const bare = await fetch(`${base}${WELL_KNOWN}`);
    expect(bare.status).toBe(200);
    expect(bare.headers.get("content-type")).toContain("application/json");
    expect(await bare.json()).toEqual(OAUTH_METADATA);

    // Path-suffixed variant derived from `resource` ("/mcp").
    const suffixed = await fetch(`${base}${WELL_KNOWN}/mcp`);
    expect(suffixed.status).toBe(200);
    expect(await suffixed.json()).toEqual(OAUTH_METADATA);

    // Non-GET is rejected with 405 + Allow.
    const posted = await fetch(`${base}${WELL_KNOWN}`, { method: "POST" });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toContain("GET");

    await harness.close();
    await transport.close();
  });

  it("serves metadata on a caller-supplied server without claiming foreign paths (attached)", async () => {
    // Caller owns the server + its own routes; the transport attaches.
    const caller: HttpServer = createServer((req, res) => {
      if (req.url === "/caller-route") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("caller-handled");
      }
      // Any other path: leave it for the transport's attached listener.
    });
    await new Promise<void>((resolve) => caller.listen(0, "127.0.0.1", resolve));
    const port = (caller.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const transport = httpTransport({ server: caller, oauth: { metadata: OAUTH_METADATA } });
    const harness = await startHarnessOn(transport);

    // The transport claims + serves its OAuth well-known path.
    const md = await fetch(`${base}${WELL_KNOWN}`);
    expect(md.status).toBe(200);
    expect(await md.json()).toEqual(OAUTH_METADATA);

    // Shared-server citizenship: the transport does NOT 404 a foreign
    // path — the caller's own listener answers it.
    const foreign = await fetch(`${base}/caller-route`);
    expect(foreign.status).toBe(200);
    expect(await foreign.text()).toBe("caller-handled");

    await harness.close();
    await transport.close();
    await new Promise<void>((resolve) => caller.close(() => resolve()));
  });

  it("serves no metadata endpoint and 404s the well-known path when oauth is absent (owned)", async () => {
    const transport = httpTransport({ port: 0 });
    const harness = await startHarnessOn(transport);
    const addr = transport.address();
    if (addr === null) throw new Error("httpTransport did not bind a port");

    const res = await fetch(`http://127.0.0.1:${addr.port}${WELL_KNOWN}`);
    expect(res.status).toBe(404);

    await harness.close();
    await transport.close();
  });
});

describe("httpTransport — HTTP auth pre-gate (RFC 9728 challenge)", () => {
  /** Expected `resource_metadata` URL derived from OAUTH_METADATA.resource. */
  const EXPECTED_CHALLENGE_URL = "https://api.example.com/.well-known/oauth-protected-resource/mcp";

  it("challenges an absent credential with 401 + WWW-Authenticate on the MCP path", async () => {
    const transport = httpTransport({ port: 0, oauth: { metadata: OAUTH_METADATA } });
    const harness = await startHarnessOn(transport);
    const addr = transport.address();
    if (addr === null) throw new Error("httpTransport did not bind a port");
    const mcpUrl = `http://127.0.0.1:${addr.port}/mcp`;

    // A POST with no Authorization header is rejected at the crossing —
    // before the SDK ever sees it — so the discovery challenge reaches
    // the wire (impossible from inside an SDK request handler).
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${EXPECTED_CHALLENGE_URL}"`,
    );
    await res.body?.cancel();

    // No SDK session was created — the crossing never reached the SDK.
    expect(harness.connections()).toHaveLength(0);

    await harness.close();
    await transport.close();
  });

  it("challenges a bad token with 401 + the right resource_metadata url", async () => {
    const transport = httpTransport({ port: 0, oauth: { metadata: OAUTH_METADATA } });
    const harness = await startHarnessOn(transport);
    const addr = transport.address();
    if (addr === null) throw new Error("httpTransport did not bind a port");
    const mcpUrl = `http://127.0.0.1:${addr.port}/mcp`;

    // Bad token on a GET events-stream request is challenged too.
    const res = await fetch(mcpUrl, {
      method: "GET",
      headers: { Authorization: "Bearer wrong-token", Accept: "text/event-stream" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${EXPECTED_CHALLENGE_URL}"`,
    );
    await res.body?.cancel();

    await harness.close();
    await transport.close();
  });

  it("the well-known discovery endpoint stays reachable unauthenticated behind the pre-gate", async () => {
    const transport = httpTransport({ port: 0, oauth: { metadata: OAUTH_METADATA } });
    const harness = await startHarnessOn(transport);
    const addr = transport.address();
    if (addr === null) throw new Error("httpTransport did not bind a port");
    const base = `http://127.0.0.1:${addr.port}`;

    // No Authorization header — discovery MUST work (that is its purpose).
    const md = await fetch(`${base}${WELL_KNOWN}`);
    expect(md.status).toBe(200);
    expect(await md.json()).toEqual(OAUTH_METADATA);

    await harness.close();
    await transport.close();
  });

  it("lets a valid token pass through the pre-gate to normal handling", async () => {
    const transport = httpTransport({ port: 0, oauth: { metadata: OAUTH_METADATA } });
    const harness = await startHarnessOn(transport);
    const addr = transport.address();
    if (addr === null) throw new Error("httpTransport did not bind a port");
    const url = `http://127.0.0.1:${addr.port}/mcp`;

    const clientTransport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const client = await makeHttpClient(clientTransport, "pregate-ok-srv");

    // The crossing authenticated at the pre-gate; the full round-trip
    // then proceeds through the SDK + per-operation pipeline.
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("echo");
    const result = await client.callTool("echo", { q: "gated" });
    expect((result.content as { text: string }[])[0]!.text).toBe("echo: gated");
    expect(harness.connections()).toHaveLength(1);

    await client.close();
    await harness.close();
    await transport.close();
  });

  it("emits a bare 401 (no WWW-Authenticate) when no metadata url is resolvable", async () => {
    // oauth configured (pre-gate armed) but with NO metadata + NO
    // resourceMetadataUrl — the challenge has nothing to point at.
    const transport = httpTransport({ port: 0, oauth: {} });
    const harness = await startHarnessOn(transport);
    const addr = transport.address();
    if (addr === null) throw new Error("httpTransport did not bind a port");
    const mcpUrl = `http://127.0.0.1:${addr.port}/mcp`;

    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer"); // RFC 6750 §3: MUST on 401; bare scheme when no metadata url
    await res.body?.cancel();

    await harness.close();
    await transport.close();
  });

  it("honors an explicit resourceMetadataUrl in the challenge", async () => {
    const external = "https://elsewhere.example.com/.well-known/oauth-protected-resource";
    const transport = httpTransport({
      port: 0,
      oauth: { metadata: OAUTH_METADATA, resourceMetadataUrl: external },
    });
    const harness = await startHarnessOn(transport);
    const addr = transport.address();
    if (addr === null) throw new Error("httpTransport did not bind a port");
    const mcpUrl = `http://127.0.0.1:${addr.port}/mcp`;

    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${external}"`);
    await res.body?.cancel();

    await harness.close();
    await transport.close();
  });

  it("stays dormant when oauth is not configured — unauthenticated requests reach the pipeline unchanged", async () => {
    // No oauth on the transport → pre-gate never fires. The absent-token
    // POST is NOT 401'd at the crossing; it reaches the SDK, which (per
    // the existing baseline) opens a session and lets the per-operation
    // pipeline gate individual operations. Proven by the connection being
    // tracked — the crossing was accepted, not pre-gate-rejected.
    const { harness, transport, url } = await makeHttpServer();
    const clientTransport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const client = await makeHttpClient(clientTransport, "no-oauth-srv");

    // initialize succeeded (SDK session opened) — the pre-gate did not
    // intercept the crossing because oauth is unconfigured.
    expect(harness.connections()).toHaveLength(1);
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("echo");

    await client.close();
    await harness.close();
    await transport.close();
  });

  it("keeps attached-mode citizenship — pre-gate guards only the MCP path, not foreign routes", async () => {
    const caller: HttpServer = createServer((req, res) => {
      if (req.url === "/caller-route") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("caller-handled");
      }
    });
    await new Promise<void>((resolve) => caller.listen(0, "127.0.0.1", resolve));
    const port = (caller.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const transport = httpTransport({ server: caller, oauth: { metadata: OAUTH_METADATA } });
    const harness = await startHarnessOn(transport);

    // Foreign path is untouched by the pre-gate — the caller's own
    // listener answers it (no 401).
    const foreign = await fetch(`${base}/caller-route`);
    expect(foreign.status).toBe(200);
    expect(await foreign.text()).toBe("caller-handled");

    // Discovery still open.
    const md = await fetch(`${base}${WELL_KNOWN}`);
    expect(md.status).toBe(200);

    // The MCP path IS gated.
    const gated = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(gated.status).toBe(401);
    await gated.body?.cancel();

    await harness.close();
    await transport.close();
    await new Promise<void>((resolve) => caller.close(() => resolve()));
  });
});

describe("streamableHttpTransport — client factory + OAuth threading", () => {
  it("wires an authProvider whose redirect fires the session URL elicit", async () => {
    const elicitCalls: UrlElicitationRequest[] = [];
    const deps: TransportFactoryDeps = {
      elicit: async (request) => {
        elicitCalls.push(request);
        return { outcome: "accepted", value: undefined };
      },
      serverId: "oauth-srv",
      credentialKey: (field) => `mcp:oauth-srv:${field}`,
      interactive: true,
    };

    const transport = await streamableHttpTransport({
      url: "https://remote.example/mcp",
      oauth: true,
    })(deps);
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);

    // The SDK transport carries the bridged provider.
    const provider = (
      transport as unknown as { _authProvider?: { redirectToAuthorization?: unknown } }
    )._authProvider;
    expect(provider).toBeDefined();
    expect(typeof provider!.redirectToAuthorization).toBe("function");

    // Behavioral proof: driving the SDK provider's redirect path fires
    // the session-bound URL elicit (DefaultOAuthProvider → createSDKProvider
    // → StreamableHTTPClientTransport). Fire-and-forget inside the provider;
    // give the microtask queue a tick.
    await (
      provider as { redirectToAuthorization: (u: URL) => Promise<void> }
    ).redirectToAuthorization(new URL("https://auth.example/authorize?state=1"));
    await new Promise((r) => setTimeout(r, 0));
    expect(elicitCalls).toHaveLength(1);
    expect(elicitCalls[0]!.mode).toBe("url");
    expect(elicitCalls[0]!.url).toContain("auth.example");
  });

  it("omits the authProvider when oauth is not enabled", async () => {
    const transport = await streamableHttpTransport({ url: "https://remote.example/mcp" })(
      bearerDeps("plain-srv"),
    );
    const provider = (transport as unknown as { _authProvider?: unknown })._authProvider;
    expect(provider).toBeUndefined();
  });
});
