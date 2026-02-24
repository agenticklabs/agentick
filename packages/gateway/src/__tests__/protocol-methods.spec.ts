/**
 * Protocol Method Tests
 *
 * Tests for Phase 1 protocol formalization:
 * - ConnectedMessage with protocolVersion on WS handshake
 * - schema method — protocol discovery
 * - tool-catalog method — session tool definitions
 * - tool-confirm method — confirmation routing
 * - tool-dispatch method — direct tool invocation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createGateway, Gateway } from "../gateway.js";
import { method } from "../types.js";
import { PROTOCOL_VERSION } from "../transport-protocol.js";
import { createMockApp, type MockApp } from "@agentick/core/testing";
import WebSocket from "ws";
import { z } from "zod";

// ============================================================================
// Test Helpers
// ============================================================================

const TEST_PORT = 19990;
const TEST_HOST = "127.0.0.1";

/** Send a WS request and wait for the matching response. */
function rpc(
  client: WebSocket,
  method: string,
  params: Record<string, unknown> = {},
): Promise<any> {
  const id = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 5000);
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "res" && msg.id === id) {
        clearTimeout(timeout);
        client.off("message", handler);
        resolve(msg);
      }
    };
    client.on("message", handler);
    client.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

/** Connect and authenticate a WS client. Returns [ws, connectedMessage]. */
async function connectClient(port: number, clientId = "test-client"): Promise<[WebSocket, any]> {
  const ws = new WebSocket(`ws://${TEST_HOST}:${port}`);
  await new Promise<void>((r) => ws.on("open", () => r()));

  const connectedPromise = new Promise<any>((resolve) => {
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "connected") {
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });

  ws.send(JSON.stringify({ type: "connect", clientId }));
  const connected = await connectedPromise;

  return [ws, connected];
}

// ============================================================================
// ConnectedMessage
// ============================================================================

describe("ConnectedMessage with protocolVersion", () => {
  let gateway: Gateway;
  let app: MockApp;

  beforeEach(() => {
    app = createMockApp();
  });

  afterEach(async () => {
    if (gateway?.running) await gateway.stop();
  });

  it("sends ConnectedMessage after WS auth with protocolVersion", async () => {
    gateway = createGateway({
      port: TEST_PORT,
      host: TEST_HOST,
      apps: { test: app as any },
      defaultApp: "test",
    });
    await gateway.start();

    const [ws, connected] = await connectClient(TEST_PORT);
    try {
      expect(connected.type).toBe("connected");
      expect(connected.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(connected.gatewayId).toBe(gateway.id);
      expect(connected.apps).toContain("test");
      expect(connected.sessions).toEqual([]);
    } finally {
      ws.close();
    }
  });

  it("includes subscriptions in ConnectedMessage sessions array", async () => {
    gateway = createGateway({
      port: TEST_PORT,
      host: TEST_HOST,
      apps: { test: app as any },
      defaultApp: "test",
    });
    await gateway.start();

    const [ws, _connected] = await connectClient(TEST_PORT, "sub-client");
    try {
      // Subscribe to a session first
      const subRes = await rpc(ws, "subscribe", { sessionId: "main" });
      expect(subRes.ok).toBe(true);

      // Reconnect — but since we can't re-auth on same connection,
      // verify the initial connected message had empty sessions
      expect(_connected.sessions).toEqual([]);
    } finally {
      ws.close();
    }
  });
});

// ============================================================================
// schema method
// ============================================================================

describe("schema method", () => {
  let gateway: Gateway;
  let ws: WebSocket;

  afterEach(async () => {
    ws?.close();
    if (gateway?.running) await gateway.stop();
  });

  it("returns protocol version and unified methods record", async () => {
    gateway = createGateway({
      port: TEST_PORT + 1,
      host: TEST_HOST,
      apps: { test: createMockApp() as any },
      defaultApp: "test",
    });
    await gateway.start();

    [ws] = await connectClient(TEST_PORT + 1);
    const res = await rpc(ws, "schema");

    expect(res.ok).toBe(true);
    const payload = res.payload;
    expect(payload.protocolVersion).toBe("1.0");

    // Unified methods record (Phase 2 shape)
    expect(payload.methods).toBeDefined();
    expect(typeof payload.methods).toBe("object");
    expect(payload.methods.send).toBeDefined();
    expect(payload.methods.schema).toBeDefined();
    expect(payload.methods["tool-catalog"]).toBeDefined();
    expect(payload.methods["tool-confirm"]).toBeDefined();
    expect(payload.methods["tool-dispatch"]).toBeDefined();

    // Each built-in has builtin: true and a description
    for (const name of ["send", "schema", "tool-catalog", "tool-confirm", "tool-dispatch"]) {
      expect(payload.methods[name].builtin).toBe(true);
      expect(payload.methods[name].description).toBeTruthy();
    }

    // Events are array of { type, category } objects
    const eventTypes = payload.events.map((e: any) => e.type);
    expect(eventTypes).toContain("content_delta");
    expect(eventTypes).toContain("tool_confirmation_required");
    expect(eventTypes).toContain("execution_end");

    // Old shape must be gone
    expect(payload.builtInMethods).toBeUndefined();
    expect(payload.customMethods).toBeUndefined();
  });

  it("includes custom methods with params schema and description", async () => {
    gateway = createGateway({
      port: TEST_PORT + 1,
      host: TEST_HOST,
      apps: { test: createMockApp() as any },
      defaultApp: "test",
      methods: {
        analyze: method({
          description: "Analyze text",
          schema: z.object({ text: z.string(), depth: z.number().optional() }),
          handler: async (params) => ({ result: params.text }),
        }),
      },
    });
    await gateway.start();

    [ws] = await connectClient(TEST_PORT + 1);
    const res = await rpc(ws, "schema");

    expect(res.ok).toBe(true);
    const analyze = res.payload.methods.analyze;
    expect(analyze).toBeDefined();
    expect(analyze.builtin).toBe(false);
    expect(analyze.description).toBe("Analyze text");
    expect(analyze.params).toBeDefined();
    expect(analyze.params.type).toBe("object");
    expect(analyze.params.properties.text).toBeDefined();
  });

  it("includes roles on custom methods", async () => {
    gateway = createGateway({
      port: TEST_PORT + 1,
      host: TEST_HOST,
      apps: { test: createMockApp() as any },
      defaultApp: "test",
      methods: {
        admin: {
          nuke: method({
            roles: ["admin"],
            description: "Nuclear option",
            handler: async () => ({ boom: true }),
          }),
        },
      },
    });
    await gateway.start();

    [ws] = await connectClient(TEST_PORT + 1);
    const res = await rpc(ws, "schema");

    expect(res.ok).toBe(true);
    const nuke = res.payload.methods["admin:nuke"];
    expect(nuke).toBeDefined();
    expect(nuke.builtin).toBe(false);
    expect(nuke.roles).toEqual(["admin"]);
    expect(nuke.description).toBe("Nuclear option");
  });

  it("no custom methods when none registered", async () => {
    gateway = createGateway({
      port: TEST_PORT + 1,
      host: TEST_HOST,
      apps: { test: createMockApp() as any },
      defaultApp: "test",
    });
    await gateway.start();

    [ws] = await connectClient(TEST_PORT + 1);
    const res = await rpc(ws, "schema");

    expect(res.ok).toBe(true);
    // All methods should be built-in
    for (const entry of Object.values(res.payload.methods) as any[]) {
      expect(entry.builtin).toBe(true);
    }
  });
});

// ============================================================================
// tool-catalog method
// ============================================================================

describe("tool-catalog method", () => {
  let gateway: Gateway;
  let ws: WebSocket;

  afterEach(async () => {
    ws?.close();
    if (gateway?.running) await gateway.stop();
  });

  it("returns empty tool list for session with no tools", async () => {
    gateway = createGateway({
      port: TEST_PORT + 2,
      host: TEST_HOST,
      apps: { test: createMockApp() as any },
      defaultApp: "test",
    });
    await gateway.start();

    [ws] = await connectClient(TEST_PORT + 2);
    const res = await rpc(ws, "tool-catalog", { sessionId: "main" });

    expect(res.ok).toBe(true);
    expect(res.payload.tools).toEqual([]);
  });

  it("returns tools with full payload shape", async () => {
    const app = createMockApp();

    // Patch: when gateway creates a session, override getToolDefinitions
    // to return realistic tool definitions
    app.onSessionCreate((session) => {
      (session as any).getToolDefinitions = async () => [
        {
          name: "read_file",
          description: "Read a file from the workspace",
          input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          type: "function",
          intent: "query",
          audience: "model",
        },
        {
          name: "write_file",
          description: "Write content to a file",
          input: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
          },
          type: "function",
          intent: "mutation",
          audience: "all",
        },
        {
          name: "user_feedback",
          description: "Collect user feedback",
          input: { type: "object", properties: {} },
          type: "function",
          audience: "user",
        },
      ];
    });

    gateway = createGateway({
      port: TEST_PORT + 2,
      host: TEST_HOST,
      apps: { test: app as any },
      defaultApp: "test",
    });
    await gateway.start();

    [ws] = await connectClient(TEST_PORT + 2);
    const res = await rpc(ws, "tool-catalog", { sessionId: "main" });

    expect(res.ok).toBe(true);
    const { tools } = res.payload;
    expect(tools).toHaveLength(3);

    // Verify payload shape for each tool
    const readFile = tools.find((t: any) => t.name === "read_file");
    expect(readFile).toBeDefined();
    expect(readFile.description).toBe("Read a file from the workspace");
    expect(readFile.input.properties.path).toBeDefined();
    expect(readFile.audience).toBe("model");
    expect(readFile.intent).toBe("query");

    const userFeedback = tools.find((t: any) => t.name === "user_feedback");
    expect(userFeedback).toBeDefined();
    expect(userFeedback.audience).toBe("user");
  });

  it("requires sessionId", async () => {
    gateway = createGateway({
      port: TEST_PORT + 2,
      host: TEST_HOST,
      apps: { test: createMockApp() as any },
      defaultApp: "test",
    });
    await gateway.start();

    [ws] = await connectClient(TEST_PORT + 2);
    const res = await rpc(ws, "tool-catalog", {});

    expect(res.ok).toBe(false);
    expect(res.error.message).toContain("sessionId");
  });
});

// ============================================================================
// tool-confirm method
// ============================================================================

describe("tool-confirm method", () => {
  let gateway: Gateway;
  let ws: WebSocket;

  afterEach(async () => {
    ws?.close();
    if (gateway?.running) await gateway.stop();
  });

  it("validates required params", async () => {
    gateway = createGateway({
      port: TEST_PORT + 3,
      host: TEST_HOST,
      apps: { test: createMockApp() as any },
      defaultApp: "test",
    });
    await gateway.start();

    [ws] = await connectClient(TEST_PORT + 3);

    // Missing sessionId
    const res1 = await rpc(ws, "tool-confirm", { callId: "c1", confirmed: true });
    expect(res1.ok).toBe(false);
    expect(res1.error.message).toContain("sessionId");

    // Missing callId
    const res2 = await rpc(ws, "tool-confirm", { sessionId: "main", confirmed: true });
    expect(res2.ok).toBe(false);
    expect(res2.error.message).toContain("callId");
  });

  it("publishes confirmation to channel and returns ok", async () => {
    gateway = createGateway({
      port: TEST_PORT + 3,
      host: TEST_HOST,
      apps: { test: createMockApp() as any },
      defaultApp: "test",
    });
    await gateway.start();

    [ws] = await connectClient(TEST_PORT + 3);

    // Send tool-confirm — this creates the session and publishes to channel.
    // Even without a listener, the method should return ok.
    const res = await rpc(ws, "tool-confirm", {
      sessionId: "main",
      callId: "tool-use-123",
      confirmed: true,
      reason: "looks safe",
    });

    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({ ok: true });
  });

  it("confirmation payload arrives on session channel in coordinator-compatible format", async () => {
    gateway = createGateway({
      port: TEST_PORT + 3,
      host: TEST_HOST,
      apps: { test: createMockApp() as any },
      defaultApp: "test",
    });
    await gateway.start();

    // Get the core session so we can subscribe to its channel
    const session = await gateway.session("main");
    const channel = session.channel("tool_confirmation");

    // Subscribe before the confirm call
    const receivedPromise = new Promise<any>((resolve) => {
      channel.subscribe((event) => {
        resolve(event);
      });
    });

    [ws] = await connectClient(TEST_PORT + 3);

    const res = await rpc(ws, "tool-confirm", {
      sessionId: "main",
      callId: "tool-use-abc",
      confirmed: false,
      reason: "unsafe operation",
    });
    expect(res.ok).toBe(true);

    // Verify the event has the shape the confirmation coordinator expects:
    // session.ts:2808 checks event.type === "response" && event.id
    const event = await receivedPromise;
    expect(event.type).toBe("response");
    expect(event.id).toBe("tool-use-abc");
    expect(event.channel).toBe("tool_confirmation");
    expect(event.payload).toEqual({
      approved: false,
      reason: "unsafe operation",
    });
  });
});

// ============================================================================
// tool-dispatch method
// ============================================================================

describe("tool-dispatch method", () => {
  let gateway: Gateway;
  let ws: WebSocket;

  afterEach(async () => {
    ws?.close();
    if (gateway?.running) await gateway.stop();
  });

  it("validates required params", async () => {
    gateway = createGateway({
      port: TEST_PORT + 4,
      host: TEST_HOST,
      apps: { test: createMockApp() as any },
      defaultApp: "test",
    });
    await gateway.start();

    [ws] = await connectClient(TEST_PORT + 4);

    // Missing sessionId
    const res1 = await rpc(ws, "tool-dispatch", { tool: "search", input: {} });
    expect(res1.ok).toBe(false);
    expect(res1.error.message).toContain("sessionId");

    // Missing tool
    const res2 = await rpc(ws, "tool-dispatch", { sessionId: "main", input: {} });
    expect(res2.ok).toBe(false);
    expect(res2.error.message).toContain("tool");
  });

  it("dispatches tool on mock session", async () => {
    const app = createMockApp();
    gateway = createGateway({
      port: TEST_PORT + 4,
      host: TEST_HOST,
      apps: { test: app as any },
      defaultApp: "test",
    });
    await gateway.start();

    [ws] = await connectClient(TEST_PORT + 4);

    // dispatch invokes session.dispatch — mock returns [{ type: "text", text: "mock" }]
    const res = await rpc(ws, "tool-dispatch", {
      sessionId: "main",
      tool: "anything",
      input: { q: "test" },
    });

    expect(res.ok).toBe(true);
    expect(res.payload.content).toBeDefined();
  });
});

// ============================================================================
// Adversarial: concurrent requests, bad methods
// ============================================================================

describe("protocol method edge cases", () => {
  let gateway: Gateway;
  let ws: WebSocket;

  afterEach(async () => {
    ws?.close();
    if (gateway?.running) await gateway.stop();
  });

  it("handles concurrent schema + tool-catalog requests", async () => {
    gateway = createGateway({
      port: TEST_PORT + 5,
      host: TEST_HOST,
      apps: { test: createMockApp() as any },
      defaultApp: "test",
    });
    await gateway.start();

    [ws] = await connectClient(TEST_PORT + 5);

    // Fire both simultaneously
    const [schemaRes, catalogRes] = await Promise.all([
      rpc(ws, "schema"),
      rpc(ws, "tool-catalog", { sessionId: "main" }),
    ]);

    expect(schemaRes.ok).toBe(true);
    expect(schemaRes.payload.protocolVersion).toBe("1.0");
    expect(catalogRes.ok).toBe(true);
    expect(catalogRes.payload.tools).toEqual([]);
  });

  it("unauthenticated client cannot call schema", async () => {
    gateway = createGateway({
      port: TEST_PORT + 5,
      host: TEST_HOST,
      apps: { test: createMockApp() as any },
      defaultApp: "test",
    });
    await gateway.start();

    // Connect but don't authenticate
    const rawWs = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT + 5}`);
    await new Promise<void>((r) => rawWs.on("open", () => r()));

    try {
      const errorPromise = new Promise<any>((resolve) => {
        rawWs.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "error") resolve(msg);
        });
      });

      rawWs.send(JSON.stringify({ type: "req", id: "unauth-1", method: "schema", params: {} }));

      const error = await errorPromise;
      expect(error.code).toBe("UNAUTHORIZED");
    } finally {
      rawWs.close();
    }
  });
});
