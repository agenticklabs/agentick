/**
 * HTTP Lifecycle Integration Tests
 *
 * Tests the full handleHTTPRequest flow using a real HTTP server.
 * This is the critical path: initialize → tools/list → tools/call → resources/read → close.
 */

import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { MCPServer } from "../server/server.js";
import { z } from "zod";

// ============================================================================
// Helpers
// ============================================================================

let server: MCPServer | undefined;
let httpServer: http.Server | undefined;
let port: number;

async function startServer(options: ConstructorParameters<typeof MCPServer>[0]) {
  server = new MCPServer({
    ...options,
    security: {
      // Allow all for testing (HTTP default would reject non-localhost auth)
      authenticator: async () => ({ authenticated: true }),
      ...options.security,
    },
  });

  httpServer = http.createServer(async (req, res) => {
    await server!.handleHTTPRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    httpServer!.listen(0, () => {
      port = (httpServer!.address() as any).port;
      resolve();
    });
  });
}

afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  if (server) await server.close();
  server = undefined;
  httpServer = undefined;
});

async function mcpRequest(
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
  id: number = 1,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const body: any = { jsonrpc: "2.0", method };
  if (id !== -1) body.id = id;
  if (params) body.params = params;

  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id"),
    text,
    json: () => {
      // SSE responses have "event: message\ndata: {...}\n\n" format
      const match = text.match(/data: (.+)/);
      return match ? JSON.parse(match[1]) : JSON.parse(text);
    },
  };
}

async function initSession(): Promise<string> {
  const res = await mcpRequest("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  const sessionId = res.sessionId!;

  // Send initialized notification
  await mcpRequest("notifications/initialized", undefined, sessionId, -1);

  return sessionId;
}

// ============================================================================
// Full lifecycle
// ============================================================================

describe("handleHTTPRequest — full lifecycle", () => {
  it("initialize → tools/list → tools/call → result", async () => {
    await startServer({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "greet",
          description: "Greets someone",
          inputSchema: { name: z.string() },
          handler: async (input) => ({
            content: [{ type: "text", text: `Hello, ${(input as any).name}!` }],
          }),
        },
      ],
    });

    // Initialize
    const sessionId = await initSession();
    expect(sessionId).toBeTruthy();

    // List tools
    const listRes = await mcpRequest("tools/list", {}, sessionId, 2);
    const listData = listRes.json();
    expect(listData.result.tools).toHaveLength(1);
    expect(listData.result.tools[0].name).toBe("greet");

    // Call tool
    const callRes = await mcpRequest(
      "tools/call",
      {
        name: "greet",
        arguments: { name: "World" },
      },
      sessionId,
      3,
    );
    const callData = callRes.json();
    expect(callData.result.content[0].text).toBe("Hello, World!");
  });

  it("initialize → resources/list → resources/read", async () => {
    await startServer({
      name: "test",
      version: "1.0.0",
      resources: [
        {
          name: "schema",
          uri: "db://schema/users",
          description: "User table schema",
          read: async () => ({
            contents: [{ uri: "db://schema/users", text: "CREATE TABLE users (id INT)" }],
          }),
        },
      ],
    });

    const sessionId = await initSession();

    const listRes = await mcpRequest("resources/list", {}, sessionId, 2);
    const listData = listRes.json();
    expect(listData.result.resources).toHaveLength(1);
    expect(listData.result.resources[0].uri).toBe("db://schema/users");

    const readRes = await mcpRequest("resources/read", { uri: "db://schema/users" }, sessionId, 3);
    const readData = readRes.json();
    expect(readData.result.contents[0].text).toBe("CREATE TABLE users (id INT)");
  });

  it("initialize → prompts/list → prompts/get", async () => {
    await startServer({
      name: "test",
      version: "1.0.0",
      prompts: [
        {
          name: "summarize",
          description: "Summarize a topic",
          arguments: [{ name: "topic", required: true }],
          handler: async (args) => ({
            messages: [
              {
                role: "user" as const,
                content: { type: "text" as const, text: `Summarize: ${args.topic}` },
              },
            ],
          }),
        },
      ],
    });

    const sessionId = await initSession();

    const listRes = await mcpRequest("prompts/list", {}, sessionId, 2);
    const listData = listRes.json();
    expect(listData.result.prompts).toHaveLength(1);
    expect(listData.result.prompts[0].name).toBe("summarize");

    const getRes = await mcpRequest(
      "prompts/get",
      {
        name: "summarize",
        arguments: { topic: "AI" },
      },
      sessionId,
      3,
    );
    const getData = getRes.json();
    expect(getData.result.messages[0].content.text).toBe("Summarize: AI");
  });

  it("returns 404 for unknown session ID with non-initialize request", async () => {
    await startServer({ name: "test", version: "1.0.0" });

    const res = await mcpRequest("tools/list", {}, "nonexistent-session-id", 1);
    expect(res.status).toBe(404);
  });

  it("stale session ID + initialize → creates new session", async () => {
    await startServer({ name: "test", version: "1.0.0" });

    // Send initialize with a fake session ID
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": "stale-session-id",
    };

    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });

    // Should succeed with a new session, not 404
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("multiple concurrent clients get independent sessions", async () => {
    await startServer({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "echo",
          description: "Echo",
          inputSchema: { msg: z.string() },
          handler: async (input) => ({
            content: [{ type: "text", text: (input as any).msg }],
          }),
        },
      ],
    });

    const s1 = await initSession();
    const s2 = await initSession();
    expect(s1).not.toBe(s2);

    // Both can call tools independently
    const r1 = await mcpRequest(
      "tools/call",
      { name: "echo", arguments: { msg: "from-1" } },
      s1,
      2,
    );
    const r2 = await mcpRequest(
      "tools/call",
      { name: "echo", arguments: { msg: "from-2" } },
      s2,
      2,
    );

    expect(r1.json().result.content[0].text).toBe("from-1");
    expect(r2.json().result.content[0].text).toBe("from-2");
  });
});

// ============================================================================
// Security pipeline — end-to-end through HTTP
// ============================================================================

describe("handleHTTPRequest — security pipeline", () => {
  it("authenticator rejects → client gets error result", async () => {
    await startServer({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "secret",
          description: "Secret tool",
          inputSchema: {},
          handler: async () => ({ content: [{ type: "text", text: "should not reach" }] }),
        },
      ],
      security: {
        authenticator: async () => ({ authenticated: false, reason: "Invalid token" }),
      },
    });

    const sessionId = await initSession();
    const res = await mcpRequest("tools/call", { name: "secret", arguments: {} }, sessionId, 2);
    const data = res.json();
    // Tool call returns isError result (safeToolHandler catches SecurityError)
    expect(data.result.isError).toBe(true);
  });

  it("authorizer rejects → client gets error for specific tool", async () => {
    await startServer({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "allowed",
          description: "OK",
          inputSchema: {},
          handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        },
        {
          name: "forbidden",
          description: "Nope",
          inputSchema: {},
          handler: async () => ({ content: [{ type: "text", text: "should not reach" }] }),
        },
      ],
      security: {
        authenticator: async () => ({ authenticated: true }),
        authorizer: async (_ctx, op) => {
          if (op.name === "forbidden") return { allowed: false, reason: "Insufficient role" };
          return { allowed: true };
        },
      },
    });

    const sessionId = await initSession();

    const okRes = await mcpRequest("tools/call", { name: "allowed", arguments: {} }, sessionId, 2);
    expect(okRes.json().result.content[0].text).toBe("ok");

    const forbiddenRes = await mcpRequest(
      "tools/call",
      { name: "forbidden", arguments: {} },
      sessionId,
      3,
    );
    expect(forbiddenRes.json().result.isError).toBe(true);
  });

  it("inputSanitizer modifies input before handler receives it", async () => {
    let receivedInput: any = null;

    await startServer({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "echo",
          description: "Echo",
          inputSchema: { msg: z.string() },
          handler: async (input) => {
            receivedInput = input;
            return { content: [{ type: "text", text: JSON.stringify(input) }] };
          },
        },
      ],
      security: {
        authenticator: async () => ({ authenticated: true }),
        inputSanitizer: async (_ctx, _tool, input) => ({
          ...input,
          sanitized: true,
        }),
      },
    });

    const sessionId = await initSession();
    await mcpRequest("tools/call", { name: "echo", arguments: { msg: "hello" } }, sessionId, 2);

    expect(receivedInput).toEqual({ msg: "hello", sanitized: true });
  });
});

// ============================================================================
// MCPHandlerContext — verified in all handler types
// ============================================================================

describe("handleHTTPRequest — MCPHandlerContext flow", () => {
  it("tool handler receives user context from contextProvider", async () => {
    let capturedCtx: any = null;

    await startServer({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "whoami",
          description: "Who am I",
          inputSchema: {},
          handler: async (_input, ctx) => {
            capturedCtx = ctx;
            return { content: [{ type: "text", text: `${ctx.request.user?.id}` }] };
          },
        },
      ],
      contextProvider: async () => ({
        user: { id: "user-42", tenantId: "knowify", roles: ["admin"] },
      }),
    });

    const sessionId = await initSession();
    const res = await mcpRequest("tools/call", { name: "whoami", arguments: {} }, sessionId, 2);
    expect(res.json().result.content[0].text).toBe("user-42");
    expect(capturedCtx.request.user.tenantId).toBe("knowify");
    expect(capturedCtx.sessionId).toBeTruthy();
  });

  it("resource handler receives user context", async () => {
    let capturedCtx: any = null;

    await startServer({
      name: "test",
      version: "1.0.0",
      resources: [
        {
          name: "tenant-data",
          uri: "data://tenant",
          read: async (ctx) => {
            capturedCtx = ctx;
            return {
              contents: [{ uri: "data://tenant", text: `tenant: ${ctx.request.user?.tenantId}` }],
            };
          },
        },
      ],
      contextProvider: async () => ({
        user: { id: "u1", tenantId: "acme" },
      }),
    });

    const sessionId = await initSession();
    const res = await mcpRequest("resources/read", { uri: "data://tenant" }, sessionId, 2);
    expect(res.json().result.contents[0].text).toBe("tenant: acme");
    expect(capturedCtx.request.user.id).toBe("u1");
  });

  it("prompt handler receives user context", async () => {
    let capturedCtx: any = null;

    await startServer({
      name: "test",
      version: "1.0.0",
      prompts: [
        {
          name: "greet",
          description: "Greet user",
          handler: async (_args, ctx) => {
            capturedCtx = ctx;
            return {
              messages: [
                {
                  role: "user" as const,
                  content: { type: "text" as const, text: `Hi ${ctx.request.user?.id}` },
                },
              ],
            };
          },
        },
      ],
      contextProvider: async () => ({
        user: { id: "u99" },
      }),
    });

    const sessionId = await initSession();
    const res = await mcpRequest("prompts/get", { name: "greet" }, sessionId, 2);
    expect(res.json().result.messages[0].content.text).toBe("Hi u99");
    expect(capturedCtx.request.user.id).toBe("u99");
  });
});

// ============================================================================
// Dynamic registration via HTTP
// ============================================================================

describe("handleHTTPRequest — dynamic registration", () => {
  it("dynamically registered tool is visible to existing clients", async () => {
    await startServer({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "initial",
          description: "Initial tool",
          inputSchema: {},
          handler: async () => ({ content: [{ type: "text", text: "initial" }] }),
        },
      ],
    });

    const sessionId = await initSession();

    // Initially one tool
    const list1 = await mcpRequest("tools/list", {}, sessionId, 2);
    expect(list1.json().result.tools.map((t: any) => t.name)).toEqual(["initial"]);

    // Register new tool dynamically
    server!.registerTool({
      name: "dynamic",
      description: "Added later",
      inputSchema: {},
      handler: async () => ({ content: [{ type: "text", text: "dynamic" }] }),
    });

    // Client sees the new tool
    const list2 = await mcpRequest("tools/list", {}, sessionId, 3);
    const names = list2
      .json()
      .result.tools.map((t: any) => t.name)
      .sort();
    expect(names).toEqual(["dynamic", "initial"]);

    // Client can call the new tool
    const callRes = await mcpRequest(
      "tools/call",
      { name: "dynamic", arguments: {} },
      sessionId,
      4,
    );
    expect(callRes.json().result.content[0].text).toBe("dynamic");
  });

  it("dynamically registered resource is visible to existing clients", async () => {
    await startServer({ name: "test", version: "1.0.0" });

    const sessionId = await initSession();

    // Initially no resources
    const list1 = await mcpRequest("resources/list", {}, sessionId, 2);
    expect(list1.json().result.resources).toHaveLength(0);

    // Register resource dynamically
    server!.registerResource({
      name: "new-doc",
      uri: "docs://new",
      read: async () => ({ contents: [{ uri: "docs://new", text: "new content" }] }),
    });

    // Client sees it
    const list2 = await mcpRequest("resources/list", {}, sessionId, 3);
    expect(list2.json().result.resources).toHaveLength(1);
    expect(list2.json().result.resources[0].uri).toBe("docs://new");

    // Client can read it
    const readRes = await mcpRequest("resources/read", { uri: "docs://new" }, sessionId, 4);
    expect(readRes.json().result.contents[0].text).toBe("new content");
  });
});

// ============================================================================
// Dynamic unregistration
// ============================================================================

describe("handleHTTPRequest — dynamic unregistration", () => {
  it("unregistered tool disappears from listing and rejects calls", async () => {
    await startServer({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "keep",
          description: "Keep",
          inputSchema: {},
          handler: async () => ({ content: [{ type: "text", text: "kept" }] }),
        },
        {
          name: "remove-me",
          description: "Remove",
          inputSchema: {},
          handler: async () => ({ content: [{ type: "text", text: "removed" }] }),
        },
      ],
    });

    const sessionId = await initSession();

    // Both visible initially
    const list1 = await mcpRequest("tools/list", {}, sessionId, 2);
    expect(
      list1
        .json()
        .result.tools.map((t: any) => t.name)
        .sort(),
    ).toEqual(["keep", "remove-me"]);

    // Unregister
    server!.unregisterTool("remove-me");

    // Gone from listing
    const list2 = await mcpRequest("tools/list", {}, sessionId, 3);
    expect(list2.json().result.tools.map((t: any) => t.name)).toEqual(["keep"]);

    // Call rejects
    const callRes = await mcpRequest(
      "tools/call",
      { name: "remove-me", arguments: {} },
      sessionId,
      4,
    );
    const callData = callRes.json();
    expect(callData.error || callData.result?.isError).toBeTruthy();
  });

  it("unregistered resource disappears from listing", async () => {
    await startServer({
      name: "test",
      version: "1.0.0",
      resources: [
        {
          name: "doc-a",
          uri: "docs://a",
          read: async () => ({ contents: [{ uri: "docs://a", text: "A" }] }),
        },
        {
          name: "doc-b",
          uri: "docs://b",
          read: async () => ({ contents: [{ uri: "docs://b", text: "B" }] }),
        },
      ],
    });

    const sessionId = await initSession();

    const list1 = await mcpRequest("resources/list", {}, sessionId, 2);
    expect(list1.json().result.resources).toHaveLength(2);

    server!.unregisterResource("docs://b");

    const list2 = await mcpRequest("resources/list", {}, sessionId, 3);
    expect(list2.json().result.resources).toHaveLength(1);
    expect(list2.json().result.resources[0].uri).toBe("docs://a");
  });

  it("dynamically registered app (ui://) is visible and readable", async () => {
    await startServer({ name: "test", version: "1.0.0" });

    const sessionId = await initSession();

    // No resources initially
    const list1 = await mcpRequest("resources/list", {}, sessionId, 2);
    expect(list1.json().result.resources).toHaveLength(0);

    // Register app dynamically
    server!.registerApp({
      name: "live-dashboard",
      uri: "ui://test/live",
      description: "Live dashboard",
      content: "<html><body>Live!</body></html>",
    });

    // Visible in listing with correct mimeType
    const list2 = await mcpRequest("resources/list", {}, sessionId, 3);
    const app = list2.json().result.resources.find((r: any) => r.uri === "ui://test/live");
    expect(app).toBeDefined();
    expect(app.mimeType).toBe("text/html;profile=mcp-app");

    // Readable
    const readRes = await mcpRequest("resources/read", { uri: "ui://test/live" }, sessionId, 4);
    expect(readRes.json().result.contents[0].text).toContain("Live!");

    // Unregister
    server!.unregisterApp("ui://test/live");
    const list3 = await mcpRequest("resources/list", {}, sessionId, 5);
    expect(list3.json().result.resources).toHaveLength(0);
  });
});

// ============================================================================
// MCP Apps metadata
// ============================================================================

describe("handleHTTPRequest — MCP Apps", () => {
  it("ui:// resource appears in resources/list with correct mimeType", async () => {
    await startServer({
      name: "test",
      version: "1.0.0",
      apps: [
        {
          name: "dashboard",
          uri: "ui://test/dashboard",
          description: "Test dashboard",
          content: "<html><body>Dashboard</body></html>",
        },
      ],
    });

    const sessionId = await initSession();

    const listRes = await mcpRequest("resources/list", {}, sessionId, 2);
    const resources = listRes.json().result.resources;
    const app = resources.find((r: any) => r.uri === "ui://test/dashboard");
    expect(app).toBeDefined();
    expect(app.mimeType).toBe("text/html;profile=mcp-app");
  });

  it("ui:// resource content is readable", async () => {
    await startServer({
      name: "test",
      version: "1.0.0",
      apps: [
        {
          name: "dashboard",
          uri: "ui://test/dashboard",
          content: "<html><body>Dashboard Content</body></html>",
        },
      ],
    });

    const sessionId = await initSession();
    const readRes = await mcpRequest(
      "resources/read",
      { uri: "ui://test/dashboard" },
      sessionId,
      2,
    );
    const contents = readRes.json().result.contents;
    expect(contents[0].text).toContain("Dashboard Content");
    expect(contents[0].mimeType).toBe("text/html;profile=mcp-app");
  });
});

// ============================================================================
// Push notifications via SSE
// ============================================================================

describe("handleHTTPRequest — push notifications", () => {
  it("sends notifications/tools/list_changed when tools are registered dynamically", async () => {
    await startServer({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "initial",
          description: "Initial",
          inputSchema: {},
          handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        },
      ],
    });

    const sessionId = await initSession();

    // Open SSE stream (GET request with session ID)
    const sseRes = await fetch(`http://localhost:${port}/mcp`, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Mcp-Session-Id": sessionId,
      },
    });

    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

    // Get the readable stream
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();

    // Register a new tool — should trigger notification
    server!.registerTool({
      name: "new-tool",
      description: "New",
      inputSchema: {},
      handler: async () => ({ content: [{ type: "text", text: "new" }] }),
    });

    // Read from SSE stream — should get notifications/tools/list_changed
    let sseData = "";
    const readWithTimeout = async (timeoutMs: number): Promise<string> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((r) =>
            setTimeout(() => r({ value: undefined, done: true }), timeoutMs - (Date.now() - start)),
          ),
        ]);
        if (done) break;
        if (value) sseData += decoder.decode(value);
        if (sseData.includes("notifications/tools/list_changed")) break;
      }
      return sseData;
    };

    const received = await readWithTimeout(2000);
    reader.cancel();

    expect(received).toContain("notifications/tools/list_changed");
  });
});

// ============================================================================
// Error paths
// ============================================================================

describe("handleHTTPRequest — error paths", () => {
  it("resource read handler that throws returns error to client", async () => {
    await startServer({
      name: "test",
      version: "1.0.0",
      resources: [
        {
          name: "broken",
          uri: "broken://resource",
          read: async () => {
            throw new Error("Database connection failed at /internal/path:42");
          },
        },
      ],
    });

    const sessionId = await initSession();
    const res = await mcpRequest("resources/read", { uri: "broken://resource" }, sessionId, 2);
    const data = res.json();

    // Should get an error, not crash
    expect(data.error).toBeDefined();
    // Error message should NOT contain internal path
    expect(JSON.stringify(data)).not.toContain("/internal/path");
  });

  it("resource template read that throws returns error", async () => {
    await startServer({
      name: "test",
      version: "1.0.0",
      resourceTemplates: [
        {
          name: "failing",
          uriTemplate: "fail://{id}",
          list: async () => ({ resources: [{ uri: "fail://1", name: "fail-1" }] }),
          read: async () => {
            throw new Error("Template read failed");
          },
        },
      ],
    });

    const sessionId = await initSession();
    const res = await mcpRequest("resources/read", { uri: "fail://1" }, sessionId, 2);
    const data = res.json();
    expect(data.error).toBeDefined();
  });

  it("prompt handler that throws returns error", async () => {
    await startServer({
      name: "test",
      version: "1.0.0",
      prompts: [
        {
          name: "broken-prompt",
          description: "Broken",
          handler: async () => {
            throw new Error("Prompt generation failed");
          },
        },
      ],
    });

    const sessionId = await initSession();
    const res = await mcpRequest("prompts/get", { name: "broken-prompt" }, sessionId, 2);
    const data = res.json();
    expect(data.error).toBeDefined();
  });

  it("reading nonexistent resource returns error", async () => {
    await startServer({ name: "test", version: "1.0.0" });

    const sessionId = await initSession();
    const res = await mcpRequest("resources/read", { uri: "does://not/exist" }, sessionId, 2);
    const data = res.json();
    expect(data.error).toBeDefined();
    expect(data.error.message).toContain("not found");
  });

  it("getting nonexistent prompt returns error", async () => {
    await startServer({ name: "test", version: "1.0.0" });

    const sessionId = await initSession();
    const res = await mcpRequest("prompts/get", { name: "ghost" }, sessionId, 2);
    const data = res.json();
    expect(data.error).toBeDefined();
    expect(data.error.message).toContain("not found");
  });
});

// ============================================================================
// toolFilter via HTTP
// ============================================================================

describe("handleHTTPRequest — toolFilter", () => {
  it("toolFilter controls which tools each session sees", async () => {
    await startServer({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "public",
          description: "Public",
          inputSchema: {},
          handler: async () => ({ content: [{ type: "text", text: "public" }] }),
        },
        {
          name: "admin-only",
          description: "Admin",
          inputSchema: {},
          handler: async () => ({ content: [{ type: "text", text: "admin" }] }),
        },
      ],
      toolFilter: (tool, ctx) => {
        // Simulate: only admin users see admin tools
        if (tool.name === "admin-only") {
          return ctx.user?.roles?.includes("admin") ?? false;
        }
        return true;
      },
      contextProvider: async () => ({
        // Non-admin user
        user: { id: "regular-user", roles: ["viewer"] },
      }),
    });

    const sessionId = await initSession();

    // Non-admin sees only "public"
    const listRes = await mcpRequest("tools/list", {}, sessionId, 2);
    const tools = listRes.json().result.tools;
    expect(tools.map((t: any) => t.name)).toEqual(["public"]);
    expect(tools.map((t: any) => t.name)).not.toContain("admin-only");
  });
});

// ============================================================================
// Stale session recovery
// ============================================================================

describe("handleHTTPRequest — stale session handling", () => {
  it("returns 404 (not 400) for tool call with stale session ID", async () => {
    await startServer({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "greet",
          description: "Greets someone",
          inputSchema: { name: z.string() },
          handler: async (input) => ({
            content: [{ type: "text", text: `Hello, ${(input as any).name}!` }],
          }),
        },
      ],
    });

    // Tool call with a made-up session ID → should be 404
    const res = await mcpRequest(
      "tools/call",
      { name: "greet", arguments: { name: "World" } },
      "stale-session-id-that-does-not-exist",
      1,
    );
    expect(res.status).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain("Session not found");
  });

  it("returns 404 for tools/list with stale session ID", async () => {
    await startServer({ name: "test", version: "1.0.0" });

    const res = await mcpRequest("tools/list", {}, "dead-session", 1);
    expect(res.status).toBe(404);
    expect(res.json().error.message).toContain("Session not found");
  });

  it("allows re-initialize with a stale session ID", async () => {
    await startServer({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "greet",
          description: "Greets someone",
          inputSchema: { name: z.string() },
          handler: async (input) => ({
            content: [{ type: "text", text: `Hello, ${(input as any).name}!` }],
          }),
        },
      ],
    });

    // Initialize normally
    const sessionId = await initSession();
    expect(sessionId).toBeTruthy();

    // Simulate server restart: close and recreate (sessions lost)
    await server!.close();
    server = new MCPServer({
      name: "test",
      version: "1.0.0",
      security: {
        authenticator: async () => ({ authenticated: true }),
      },
      tools: [
        {
          name: "greet",
          description: "Greets someone",
          inputSchema: { name: z.string() },
          handler: async (input) => ({
            content: [{ type: "text", text: `Hello, ${(input as any).name}!` }],
          }),
        },
      ],
    });

    // Rewire the HTTP server to the new MCPServer
    httpServer!.removeAllListeners("request");
    httpServer!.on("request", async (req, res) => {
      await server!.handleHTTPRequest(req, res);
    });

    // Old session ID should get 404
    const staleRes = await mcpRequest("tools/list", {}, sessionId, 2);
    expect(staleRes.status).toBe(404);

    // Re-initialize WITH the stale session ID should succeed (creates new session)
    const reinitRes = await mcpRequest(
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
      sessionId, // sending stale session ID
      3,
    );
    expect(reinitRes.status).toBe(200);
    const newSessionId = reinitRes.sessionId;
    expect(newSessionId).toBeTruthy();
    expect(newSessionId).not.toBe(sessionId);

    // New session should work
    await mcpRequest("notifications/initialized", undefined, newSessionId!, -1);
    const listRes = await mcpRequest("tools/list", {}, newSessionId!, 4);
    expect(listRes.status).toBe(200);
    expect(listRes.json().result.tools).toHaveLength(1);
  });

  it("returns 404 for GET (SSE) with stale session ID", async () => {
    await startServer({ name: "test", version: "1.0.0" });

    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Mcp-Session-Id": "nonexistent-session",
      },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.message).toContain("Session not found");
  });

  it("emits mcp:session:stale event for stale requests", async () => {
    await startServer({ name: "test", version: "1.0.0" });

    const staleEvents: Array<{ sessionId: string | null; method?: string }> = [];
    server!.on("mcp:session:stale", (e) => staleEvents.push(e));

    await mcpRequest("tools/list", {}, "ghost-session", 1);

    expect(staleEvents).toHaveLength(1);
    expect(staleEvents[0].sessionId).toBe("ghost-session");
  });
});
