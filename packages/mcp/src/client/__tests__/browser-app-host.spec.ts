/**
 * @vitest-environment happy-dom
 *
 * BrowserMCPAppHost Tests
 *
 * Tests the browser-side app host class using happy-dom for iframe + window
 * simulation. Exercises mount/unmount lifecycle, PostMessage ↔ channel relay,
 * and the full round-trip by wiring the browser host to a real server-side
 * AppBridge via an in-memory channel transport.
 */

import { describe, it, expect, afterEach } from "vitest";
import { BrowserMCPAppHost } from "../browser-app-host.js";
import type { AppHostTransport, AppHostChannelEvent } from "../browser-app-host.js";
import { MCPServer } from "../../server/server.js";
import { MCPClient } from "../client.js";
import { RelayTransport } from "../relay-transport.js";
import { InMemoryTransport } from "../../transport/index.js";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// ============================================================================
// In-memory channel transport — simulates session channels for the test
// ============================================================================

function createInMemoryTransport(): AppHostTransport & {
  // Test helpers: let test code also publish/subscribe as "the server side"
  serverSubscribe(channel: string, handler: (event: AppHostChannelEvent) => void): () => void;
  serverPublish(channel: string, event: AppHostChannelEvent): void;
} {
  const subscribers = new Map<string, Set<(event: AppHostChannelEvent) => void>>();

  function getSubs(channel: string) {
    let set = subscribers.get(channel);
    if (!set) {
      set = new Set();
      subscribers.set(channel, set);
    }
    return set;
  }

  return {
    publish(channel, event) {
      // Deliver to all subscribers (both browser and server simulated here)
      queueMicrotask(() => {
        const subs = subscribers.get(channel);
        if (subs) for (const h of subs) h(event);
      });
    },
    subscribe(channel, handler) {
      const subs = getSubs(channel);
      subs.add(handler);
      return () => subs.delete(handler);
    },
    // Same underlying bus — "server" is just another subscriber
    serverSubscribe(channel, handler) {
      const subs = getSubs(channel);
      subs.add(handler);
      return () => subs.delete(handler);
    },
    serverPublish(channel, event) {
      queueMicrotask(() => {
        const subs = subscribers.get(channel);
        if (subs) for (const h of subs) h(event);
      });
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("BrowserMCPAppHost — iframe lifecycle and relay", () => {
  let host: BrowserMCPAppHost | undefined;

  afterEach(async () => {
    await host?.close();
    host = undefined;
    // Clean up any leftover containers
    document.body.innerHTML = "";
  });

  it("mounts an app — creates iframe, sets srcdoc, publishes mount event", async () => {
    const transport = createInMemoryTransport();
    host = new BrowserMCPAppHost({ transport });

    // Capture mount publish
    const mountEvents: AppHostChannelEvent[] = [];
    transport.serverSubscribe("mcp-app:mount", (e) => {
      mountEvents.push(e);
    });

    const container = document.createElement("div");
    document.body.appendChild(container);

    const handle = await host.mount(container, {
      appSessionId: "app-1",
      resourceUri: "ui://test/widget",
      serverName: "test-server",
      content: "<!DOCTYPE html><html><body>Hello</body></html>",
    });

    expect(handle.appSessionId).toBe("app-1");
    expect(handle.iframe).toBeInstanceOf(HTMLIFrameElement);
    expect(container.contains(handle.iframe)).toBe(true);
    expect(handle.iframe.srcdoc).toContain("Hello");
    expect(handle.iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");

    // Wait for microtask queue to flush
    await new Promise((r) => setTimeout(r, 10));

    expect(mountEvents).toHaveLength(1);
    expect(mountEvents[0].type).toBe("mount");
    expect((mountEvents[0].payload as any).appSessionId).toBe("app-1");
    expect((mountEvents[0].payload as any).serverName).toBe("test-server");
    expect((mountEvents[0].payload as any).resourceUri).toBe("ui://test/widget");
  });

  it("rejects duplicate mount for the same appSessionId", async () => {
    const transport = createInMemoryTransport();
    host = new BrowserMCPAppHost({ transport });

    const container = document.createElement("div");
    document.body.appendChild(container);

    await host.mount(container, {
      appSessionId: "dup",
      resourceUri: "ui://test/x",
      serverName: "test",
      content: "<html></html>",
    });

    await expect(
      host.mount(container, {
        appSessionId: "dup",
        resourceUri: "ui://test/y",
        serverName: "test",
        content: "<html></html>",
      }),
    ).rejects.toThrow("already mounted");
  });

  it("unmount removes iframe, unsubscribes, publishes unmount event", async () => {
    const transport = createInMemoryTransport();
    host = new BrowserMCPAppHost({ transport });

    const unmountEvents: AppHostChannelEvent[] = [];
    transport.serverSubscribe("mcp-app:unmount", (e) => {
      unmountEvents.push(e);
    });

    const container = document.createElement("div");
    document.body.appendChild(container);

    const handle = await host.mount(container, {
      appSessionId: "tear-1",
      resourceUri: "ui://test",
      serverName: "test",
      content: "<html></html>",
    });

    expect(container.contains(handle.iframe)).toBe(true);
    await handle.close();

    expect(container.contains(handle.iframe)).toBe(false);
    await new Promise((r) => setTimeout(r, 10));

    expect(unmountEvents).toHaveLength(1);
    expect((unmountEvents[0].payload as any).appSessionId).toBe("tear-1");

    // Handle is no longer in the list
    expect(host.list()).not.toContain("tear-1");
    expect(host.get("tear-1")).toBeUndefined();
  });

  it("close() tears down all mounted apps", async () => {
    const transport = createInMemoryTransport();
    host = new BrowserMCPAppHost({ transport });

    const container = document.createElement("div");
    document.body.appendChild(container);

    for (const id of ["a", "b", "c"]) {
      await host.mount(container, {
        appSessionId: id,
        resourceUri: "ui://test",
        serverName: "test",
        content: "<html></html>",
      });
    }

    expect(host.list()).toHaveLength(3);

    await host.close();

    expect(host.list()).toHaveLength(0);
    expect(container.children.length).toBe(0);
  });
});

// ============================================================================
// End-to-end: browser host ↔ server AppBridge ↔ MCPServer
// ============================================================================

describe("BrowserMCPAppHost — full round-trip to MCPServer", () => {
  it("iframe tool call flows through browser host → channel → AppBridge → MCPServer", async () => {
    // ── MCPServer with a tool ──
    const server = new MCPServer({
      name: "test-mcp",
      version: "1.0.0",
      tools: [
        {
          name: "echo",
          description: "Echo the input",
          inputSchema: z.object({ msg: z.string() }),
          handler: async (args) => ({
            content: [{ type: "text" as const, text: `Echo: ${args.msg}` }],
          }),
        },
      ],
      security: { authenticator: async () => ({ authenticated: true }) },
    });

    const client = new MCPClient();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect({
        serverName: "test-mcp",
        transport: "in-process",
        connection: { transport: ct },
      }),
      server.connect(st),
    ]);

    // ── In-memory transport shared between browser and server ──
    const transport = createInMemoryTransport();

    // ── Server-side: on mount event, create AppBridge + RelayTransport ──
    const bridges = new Map<string, { bridge: AppBridge; unsubChannel: () => void }>();

    transport.serverSubscribe("mcp-app:mount", async (event) => {
      const { appSessionId, serverName } = event.payload as any;
      const sdkClient = (client as any).connections.get(serverName)?.client;
      if (!sdkClient) return;

      const channelName = `mcp-app:${appSessionId}`;

      const relay = new RelayTransport({
        send: (msg) => {
          transport.serverPublish(channelName, {
            type: "to-app",
            channel: channelName,
            payload: msg,
          });
        },
      });

      const unsubChannel = transport.serverSubscribe(channelName, (e) => {
        if (e.type === "to-server") {
          relay.receive(e.payload as JSONRPCMessage);
        }
      });

      const bridge = new AppBridge(sdkClient, { name: "test-host", version: "1.0.0" }, {});
      await bridge.connect(relay as Transport);
      bridges.set(appSessionId, { bridge, unsubChannel });
    });

    transport.serverSubscribe("mcp-app:unmount", async (event) => {
      const { appSessionId } = event.payload as any;
      const b = bridges.get(appSessionId);
      if (b) {
        b.unsubChannel();
        bridges.delete(appSessionId);
      }
    });

    // ── Browser side: mount an app ──
    const host = new BrowserMCPAppHost({ transport });
    const container = document.createElement("div");
    document.body.appendChild(container);

    await host.mount(container, {
      appSessionId: "e2e-1",
      resourceUri: "ui://test/widget",
      serverName: "test-mcp",
      content: "<!DOCTYPE html><html><body></body></html>",
    });

    // Wait for mount → bridge setup to complete
    await new Promise((r) => setTimeout(r, 30));

    expect(bridges.has("e2e-1")).toBe(true);

    // ── Simulate the iframe sending a tools/call via PostMessage ──
    // We capture responses flowing back to the iframe (via PostMessage from the host)
    const iframe = host.get("e2e-1")!.iframe;
    const responses: JSONRPCMessage[] = [];

    // Listen on iframe.contentWindow for messages the host posts to it
    const origPostMessage = iframe.contentWindow!.postMessage.bind(iframe.contentWindow);
    iframe.contentWindow!.postMessage = ((msg: any) => {
      responses.push(msg);
      return origPostMessage(msg, "*");
    }) as any;

    // Now dispatch a message event FROM the iframe's window (simulating
    // the iframe sending to window.parent via PostMessage)
    const initMsg: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        appInfo: { name: "test-iframe", version: "1.0.0" },
        appCapabilities: {},
      },
    };

    // Dispatch as if from iframe's contentWindow
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow!,
        data: initMsg,
      }),
    );

    // Wait for round-trip
    await new Promise((r) => setTimeout(r, 50));

    // Should have received an init response
    const initResponse = responses.find((m: any) => m.id === 1);
    expect(initResponse).toBeDefined();
    expect((initResponse as any).result).toBeDefined();

    // ── Send initialized notification, then tools/call ──
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow!,
        data: {
          jsonrpc: "2.0",
          method: "ui/notifications/initialized",
          params: {},
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow!,
        data: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "echo", arguments: { msg: "hello" } },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    const toolResponse = responses.find((m: any) => m.id === 2);
    expect(toolResponse).toBeDefined();
    expect((toolResponse as any).result).toBeDefined();
    expect((toolResponse as any).result.content[0].text).toBe("Echo: hello");

    // Cleanup
    await host.close();
    await client.disconnectAll();
    await server.close();
  });
});
