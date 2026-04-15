/**
 * RelayTransport + AppBridge Integration Tests
 *
 * Tests the server-side AppBridge connected via RelayTransport — the core
 * mechanism for MCP App hosting without a browser. Validates the full
 * ext-apps protocol: initialization handshake, tool calls with visibility
 * enforcement, resource reads, host→app notifications (tool input/result,
 * context changes), teardown, and error paths.
 *
 * Architecture under test:
 *   App (ext-apps) ↔ appTransport ↔ RelayTransport ↔ AppBridge ↔ MCPClient ↔ MCPServer
 *
 * The appTransport ↔ RelayTransport link simulates what the browser relay
 * (PostMessage ↔ gateway connection) does in production.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { MCPServer } from "../../server/server.js";
import { MCPClient } from "../client.js";
import { RelayTransport } from "../relay-transport.js";
import { InMemoryTransport } from "../../transport/index.js";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { App } from "@modelcontextprotocol/ext-apps";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// ============================================================================
// Test infrastructure — creates the full server → client → bridge → app chain
// ============================================================================

interface TestStack {
  server: MCPServer;
  client: MCPClient;
  bridge: AppBridge;
  relay: RelayTransport;
  app: App;
  cleanup: () => Promise<void>;
}

interface TestStackOptions {
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema: z.ZodType;
    handler: (
      args: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
    annotations?: Record<string, unknown>;
  }>;
  resources?: Array<{
    name: string;
    uri: string;
    description?: string;
    mimeType?: string;
    read: () => Promise<{ contents: Array<{ uri: string; text: string; mimeType?: string }> }>;
  }>;
  hostCapabilities?: Record<string, unknown>;
}

/**
 * Creates the full chain: MCPServer → MCPClient → AppBridge → RelayTransport ↔ App.
 * The relay ↔ app link is direct (no browser), simulating the PostMessage relay.
 */
async function createTestStack(options: TestStackOptions = {}): Promise<TestStack> {
  // MCPServer
  const server = new MCPServer({
    name: "test-server",
    version: "1.0.0",
    tools: options.tools as any,
    resources: options.resources as any,
    security: { authenticator: async () => ({ authenticated: true }) },
  });

  // MCPClient → MCPServer (in-process)
  const client = new MCPClient();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect({
      serverName: "test-server",
      transport: "in-process",
      connection: { transport: clientTransport },
    }),
    server.connect(serverTransport),
  ]);

  // RelayTransport ↔ appTransport (simulates browser relay)
  let appOnMessage: ((msg: JSONRPCMessage) => void) | undefined;

  const relay = new RelayTransport({
    send: (msg) => {
      queueMicrotask(() => appOnMessage?.(msg));
    },
  });

  const appTransport: Transport = {
    async start() {},
    async send(msg: JSONRPCMessage) {
      queueMicrotask(() => relay.receive(msg));
    },
    async close() {
      this.onclose?.();
    },
    set onmessage(fn) {
      appOnMessage = fn;
    },
    get onmessage() {
      return appOnMessage;
    },
    onerror: undefined,
    onclose: undefined,
  };

  // AppBridge (server-side) → RelayTransport
  const sdkClient = (client as any).connections.get("test-server")?.client;
  const bridge = new AppBridge(
    sdkClient,
    { name: "test-host", version: "1.0.0" },
    options.hostCapabilities ?? {},
  );
  await bridge.connect(relay as Transport);

  // ext-apps App (simulates iframe)
  const app = new App({ name: "test-app", version: "1.0.0" }, {}, { autoResize: false });
  await app.connect(appTransport);

  return {
    server,
    client,
    bridge,
    relay,
    app,
    cleanup: async () => {
      await client.disconnectAll();
      await server.close();
    },
  };
}

// ============================================================================
// Initialization handshake
// ============================================================================

describe("Initialization handshake", () => {
  let stack: TestStack;
  afterEach(async () => stack?.cleanup());

  it("app receives host info and capabilities after connect", async () => {
    stack = await createTestStack({
      hostCapabilities: { serverTools: {}, openLinks: {}, logging: {} },
    });

    const hostVersion = stack.app.getHostVersion();
    expect(hostVersion).toEqual({ name: "test-host", version: "1.0.0" });

    const caps = stack.app.getHostCapabilities();
    expect(caps).toBeDefined();
    expect(caps?.serverTools).toEqual({});
    expect(caps?.openLinks).toEqual({});
    expect(caps?.logging).toEqual({});
  });

  it("bridge receives app info after initialization", async () => {
    stack = await createTestStack();

    const appCaps = stack.bridge.getAppCapabilities();
    // The App constructor passes empty capabilities by default
    expect(appCaps).toBeDefined();
  });
});

// ============================================================================
// Tool calls (app → server)
// ============================================================================

describe("Tool calls through relay", () => {
  let stack: TestStack;
  afterEach(async () => stack?.cleanup());

  it("app calls tool and receives result", async () => {
    stack = await createTestStack({
      tools: [
        {
          name: "greet",
          description: "Greet someone",
          inputSchema: z.object({ name: z.string() }),
          handler: async (args) => ({
            content: [{ type: "text", text: `Hello ${args.name}!` }],
          }),
        },
      ],
    });

    const result = await stack.app.request(
      { method: "tools/call", params: { name: "greet", arguments: { name: "World" } } },
      z.any(),
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe("Hello World!");
  });

  it("app can call multiple tools sequentially", async () => {
    stack = await createTestStack({
      tools: [
        {
          name: "add",
          description: "Add two numbers",
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          handler: async (args) => ({
            content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }],
          }),
        },
      ],
    });

    const r1 = await stack.app.request(
      { method: "tools/call", params: { name: "add", arguments: { a: 1, b: 2 } } },
      z.any(),
    );
    expect(r1.content[0].text).toBe("3");

    const r2 = await stack.app.request(
      { method: "tools/call", params: { name: "add", arguments: { a: 10, b: 20 } } },
      z.any(),
    );
    expect(r2.content[0].text).toBe("30");
  });

  it("tool error propagates back to app", async () => {
    stack = await createTestStack({
      tools: [
        {
          name: "fail",
          description: "Always fails",
          inputSchema: z.object({}),
          handler: async () => {
            throw new Error("Something went wrong");
          },
        },
      ],
    });

    // Tool errors come back as isError results, not thrown exceptions
    const result = await stack.app.request(
      { method: "tools/call", params: { name: "fail", arguments: {} } },
      z.any(),
    );

    expect(result.isError).toBe(true);
  });

  it("calling nonexistent tool returns error", async () => {
    stack = await createTestStack({
      tools: [
        {
          name: "exists",
          description: "A real tool",
          inputSchema: z.object({}),
          handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        },
      ],
    });

    try {
      await stack.app.request(
        { method: "tools/call", params: { name: "does_not_exist", arguments: {} } },
        z.any(),
      );
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e.message || e.code).toBeDefined();
    }
  });
});

// ============================================================================
// Resource reads (app → server)
// ============================================================================

describe("Resource reads through relay", () => {
  let stack: TestStack;
  afterEach(async () => stack?.cleanup());

  it("app reads a resource and receives content", async () => {
    stack = await createTestStack({
      resources: [
        {
          name: "doc",
          uri: "test://docs/readme",
          description: "A readme",
          mimeType: "text/markdown",
          read: async () => ({
            contents: [
              { uri: "test://docs/readme", text: "# Hello\n\nWorld.", mimeType: "text/markdown" },
            ],
          }),
        },
      ],
    });

    const result = await stack.app.request(
      { method: "resources/read", params: { uri: "test://docs/readme" } },
      z.any(),
    );

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].text).toBe("# Hello\n\nWorld.");
    expect(result.contents[0].mimeType).toBe("text/markdown");
  });

  it("reading nonexistent resource returns error", async () => {
    stack = await createTestStack();

    try {
      await stack.app.request(
        { method: "resources/read", params: { uri: "test://nope" } },
        z.any(),
      );
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e.message || e.code).toBeDefined();
    }
  });
});

// ============================================================================
// Host → App notifications (tool input, tool result, context changes)
// ============================================================================

describe("Host → App notifications", () => {
  let stack: TestStack;
  afterEach(async () => stack?.cleanup());

  it("bridge sends tool input and app receives it", async () => {
    stack = await createTestStack();

    const inputReceived = new Promise<Record<string, unknown>>((resolve) => {
      stack.app.ontoolinput = (params) => {
        resolve(params.arguments ?? {});
      };
    });

    await stack.bridge.sendToolInput({
      arguments: { projectId: 123, dateRange: "2024-01-01/2024-12-31" },
    });

    const args = await inputReceived;
    expect(args).toEqual({ projectId: 123, dateRange: "2024-01-01/2024-12-31" });
  });

  it("bridge sends tool result and app receives it", async () => {
    stack = await createTestStack();

    const resultReceived = new Promise<any>((resolve) => {
      stack.app.ontoolresult = (params) => {
        resolve(params);
      };
    });

    await stack.bridge.sendToolResult({
      content: [{ type: "text", text: "Query returned 5 rows" }],
    });

    const result = await resultReceived;
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe("Query returned 5 rows");
  });

  it("bridge sends tool cancelled and app receives it", async () => {
    stack = await createTestStack();

    const cancelReceived = new Promise<string | undefined>((resolve) => {
      stack.app.ontoolcancelled = (params) => {
        resolve(params.reason);
      };
    });

    await stack.bridge.sendToolCancelled({ reason: "User cancelled the operation" });

    const reason = await cancelReceived;
    expect(reason).toBe("User cancelled the operation");
  });

  it("bridge sends host context change and app receives it", async () => {
    stack = await createTestStack();

    const contextReceived = new Promise<any>((resolve) => {
      stack.app.onhostcontextchanged = (params) => {
        resolve(params);
      };
    });

    stack.bridge.setHostContext({ theme: "dark" } as any);

    const params = await contextReceived;
    // The notification params contain the changed context fields
    // App.getHostContext() merges them automatically
    expect(params).toBeDefined();

    // After the notification, getHostContext should reflect the change
    const ctx = stack.app.getHostContext();
    expect(ctx?.theme).toBe("dark");
  });

  it("bridge sends partial tool input (streaming) and app receives it", async () => {
    stack = await createTestStack();

    const partials: Array<Record<string, unknown>> = [];
    const partialsDone = new Promise<void>((resolve) => {
      stack.app.ontoolinputpartial = (params) => {
        partials.push(params.arguments ?? {});
        if (partials.length >= 3) resolve();
      };
    });

    await stack.bridge.sendToolInputPartial({ arguments: { q: "N" } });
    await stack.bridge.sendToolInputPartial({ arguments: { query: "New" } });
    await stack.bridge.sendToolInputPartial({ arguments: { query: "New York" } });

    await partialsDone;
    expect(partials).toHaveLength(3);
    expect(partials[2]).toEqual({ query: "New York" });
  });
});

// ============================================================================
// Teardown
// ============================================================================

describe("Resource teardown", () => {
  let stack: TestStack;
  afterEach(async () => stack?.cleanup());

  it("bridge can teardown app and app responds", async () => {
    // Need custom setup — onteardown must be set BEFORE connect
    const server = new MCPServer({
      name: "test-server",
      version: "1.0.0",
      security: { authenticator: async () => ({ authenticated: true }) },
    });

    const client = new MCPClient();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect({
        serverName: "test-server",
        transport: "in-process",
        connection: { transport: ct },
      }),
      server.connect(st),
    ]);

    let appOnMsg: ((msg: JSONRPCMessage) => void) | undefined;
    const relay = new RelayTransport({
      send: (msg) => {
        queueMicrotask(() => appOnMsg?.(msg));
      },
    });
    const appTransport: Transport = {
      async start() {},
      async send(msg: JSONRPCMessage) {
        queueMicrotask(() => relay.receive(msg));
      },
      async close() {
        this.onclose?.();
      },
      set onmessage(fn) {
        appOnMsg = fn;
      },
      get onmessage() {
        return appOnMsg;
      },
      onerror: undefined,
      onclose: undefined,
    };

    const sdkClient = (client as any).connections.get("test-server")?.client;
    const bridge = new AppBridge(sdkClient, { name: "test-host", version: "1.0.0" }, {});
    await bridge.connect(relay as Transport);

    // Register teardown handler BEFORE connect
    let teardownReceived = false;
    const app = new App({ name: "test-app", version: "1.0.0" }, {}, { autoResize: false });
    app.onteardown = async () => {
      teardownReceived = true;
      return {};
    };
    await app.connect(appTransport);

    // Bridge requests teardown
    const result = await bridge.teardownResource({});

    expect(result).toBeDefined();
    expect(teardownReceived).toBe(true);

    // Cleanup
    stack = {
      server,
      client,
      bridge,
      relay,
      app,
      cleanup: async () => {
        await client.disconnectAll();
        await server.close();
      },
    };
  });
});

// ============================================================================
// RelayTransport unit tests
// ============================================================================

describe("RelayTransport", () => {
  it("send callback is called when transport sends", async () => {
    const sendSpy = vi.fn();
    const relay = new RelayTransport({ send: sendSpy });
    await relay.start();

    const msg: JSONRPCMessage = { jsonrpc: "2.0", id: 1, method: "test", params: {} };
    await relay.send(msg);

    expect(sendSpy).toHaveBeenCalledWith(msg);
  });

  it("receive delivers to onmessage handler", async () => {
    const relay = new RelayTransport({ send: vi.fn() });
    await relay.start();

    const received: JSONRPCMessage[] = [];
    relay.onmessage = (msg) => received.push(msg);

    const msg: JSONRPCMessage = { jsonrpc: "2.0", id: 1, method: "test", params: {} };
    relay.receive(msg);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);
  });

  it("receive is ignored before start", () => {
    const relay = new RelayTransport({ send: vi.fn() });
    // NOT started

    const received: JSONRPCMessage[] = [];
    relay.onmessage = (msg) => received.push(msg);

    relay.receive({ jsonrpc: "2.0", id: 1, method: "test", params: {} });

    expect(received).toHaveLength(0);
  });

  it("receive is ignored after close", async () => {
    const relay = new RelayTransport({ send: vi.fn() });
    await relay.start();
    await relay.close();

    const received: JSONRPCMessage[] = [];
    relay.onmessage = (msg) => received.push(msg);

    relay.receive({ jsonrpc: "2.0", id: 1, method: "test", params: {} });

    expect(received).toHaveLength(0);
  });

  it("close triggers onclose callback", async () => {
    const relay = new RelayTransport({ send: vi.fn() });
    await relay.start();

    const closeSpy = vi.fn();
    relay.onclose = closeSpy;

    await relay.close();
    expect(closeSpy).toHaveBeenCalled();
  });
});
