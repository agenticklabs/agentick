/**
 * MCPAppHost Integration Tests
 *
 * Tests the full server-side bridge lifecycle using a real session,
 * real MCP server, real AppBridge, and real channel routing.
 *
 * These tests verify the channel plumbing — the ext-apps protocol itself
 * (initialize handshake, tool calls, teardown) is tested at the RelayTransport
 * layer in @agentick/mcp. Here we verify:
 *
 *   1. <MCPAppHost> subscribes to mcp-app:mount when mounted in a session
 *   2. Mount events with valid serverName create a bridge
 *   3. Bridge messages flow through mcp-app:{appSessionId} channel
 *   4. Unmount events tear down bridges
 *   5. Invalid mount events are handled gracefully
 */

import { describe, it, expect, afterEach } from "vitest";
import { createApp } from "../../app.js";
import { System, User } from "../../jsx/components/messages.js";
import { Model } from "../../jsx/components/primitives.js";
import { Timeline } from "../../jsx/components/timeline.js";
import { MCPClient } from "../client.js";
import { MCPAppHost } from "../app-host.js";
import { createTestAdapter } from "../../testing/index.js";
import { MCPServer } from "@agentick/mcp/server";
import { InMemoryTransport } from "@agentick/mcp/transport";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Context } from "@agentick/kernel";
import type { ChannelEvent, ChannelServiceInterface, KernelContext } from "@agentick/kernel";

// ============================================================================
// Test harness — builds an agent with <MCPAppHost> and captures the session context
// ============================================================================

async function setupSessionWithAppHost(mcpClient: MCPClient) {
  const model = createTestAdapter();
  model.respondWith([{ text: "ok" }]);

  // Capture the session's context (channels + a context that's usable after render)
  let captured: { channels: ChannelServiceInterface; ctx: KernelContext } | undefined;

  const ContextCapture = () => {
    const ctx = Context.get();
    if (ctx.channels) {
      captured = { channels: ctx.channels, ctx };
    }
    return null;
  };

  const Agent = () => (
    <>
      <Model model={model} />
      <System>test</System>
      <MCPAppHost mcpClient={mcpClient} />
      <ContextCapture />
      <User>hi</User>
      <Timeline />
    </>
  );

  const app = createApp(Agent, { maxTicks: 1 });
  const session = await app.session();
  const handle = await session.render({} as any);
  for await (const _ of handle) {
    /* drain */
  }

  if (!captured) throw new Error("Failed to capture session context");
  return captured;
}

// ============================================================================
// Tests
// ============================================================================

describe("MCPAppHost — bridge lifecycle via session channels", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
    cleanups.length = 0;
  });

  it("creates bridge on mount event and routes tool calls to MCPServer", async () => {
    // ── Real MCPServer with a tool ──
    const mcpServer = new MCPServer({
      name: "test-mcp",
      version: "1.0.0",
      tools: [
        {
          name: "greet",
          description: "Greet someone",
          inputSchema: z.object({ name: z.string() }),
          ui: { resourceUri: "ui://test/app", visibility: ["model", "app"] },
          handler: async (args) => ({
            content: [{ type: "text" as const, text: `Hello ${args.name}!` }],
          }),
        },
      ],
      security: { authenticator: async () => ({ authenticated: true }) },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    cleanups.push(() => mcpServer.close());

    // ── Connect MCPClient to the server ──
    const mcpClient = new MCPClient();
    await mcpClient.connect({
      serverName: "test-mcp",
      transport: "in-process",
      connection: { transport: clientTransport },
    });
    cleanups.push(() => mcpClient.disconnectAll());

    // ── Run session with MCPAppHost ──
    const { channels, ctx } = await setupSessionWithAppHost(mcpClient);

    // ── Publish mount event → bridge should be created ──
    const appSessionId = "app-1";

    channels.publish(ctx, "mcp-app:mount", {
      type: "mount",
      channel: "mcp-app:mount",
      payload: {
        appSessionId,
        resourceUri: "ui://test/app",
        serverName: "test-mcp",
      },
    });

    // Wait for bridge to mount (async)
    await new Promise((r) => setTimeout(r, 50));

    // ── Send a tools/call via the app channel → should reach MCPServer ──
    const channelName = `mcp-app:${appSessionId}`;

    // Capture "to-app" responses (from bridge → app)
    const received: JSONRPCMessage[] = [];
    const unsub = channels.subscribe(ctx, channelName, (e: ChannelEvent) => {
      if (e.type === "to-app") received.push(e.payload as JSONRPCMessage);
    });
    cleanups.push(unsub);

    // First: initialize handshake (required by AppBridge before it accepts requests)
    channels.publish(ctx, channelName, {
      type: "to-server",
      channel: channelName,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "ui/initialize",
        params: {
          protocolVersion: "2026-01-26",
          appInfo: { name: "test-iframe", version: "1.0.0" },
          appCapabilities: {},
        },
      },
    });

    // Wait for init response
    await new Promise((r) => setTimeout(r, 50));

    const initResponse = received.find((m: any) => m.id === 1);
    expect(initResponse).toBeDefined();
    expect((initResponse as any).result).toBeDefined();

    // Send the initialized notification
    channels.publish(ctx, channelName, {
      type: "to-server",
      channel: channelName,
      payload: {
        jsonrpc: "2.0",
        method: "ui/notifications/initialized",
        params: {},
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    // Now call the tool
    channels.publish(ctx, channelName, {
      type: "to-server",
      channel: channelName,
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "greet", arguments: { name: "World" } },
      },
    });

    // Wait for tool response
    await new Promise((r) => setTimeout(r, 50));

    const toolResponse = received.find((m: any) => m.id === 2);
    expect(toolResponse).toBeDefined();
    expect((toolResponse as any).result).toBeDefined();
    expect((toolResponse as any).result.content[0].text).toBe("Hello World!");
  });

  it("tears down bridge on unmount event", async () => {
    const mcpServer = new MCPServer({
      name: "test-mcp",
      version: "1.0.0",
      security: { authenticator: async () => ({ authenticated: true }) },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    cleanups.push(() => mcpServer.close());

    const mcpClient = new MCPClient();
    await mcpClient.connect({
      serverName: "test-mcp",
      transport: "in-process",
      connection: { transport: clientTransport },
    });
    cleanups.push(() => mcpClient.disconnectAll());

    const { channels, ctx } = await setupSessionWithAppHost(mcpClient);
    const appSessionId = "app-teardown-1";
    const channelName = `mcp-app:${appSessionId}`;

    // Mount
    channels.publish(ctx, "mcp-app:mount", {
      type: "mount",
      channel: "mcp-app:mount",
      payload: { appSessionId, resourceUri: "ui://test/app", serverName: "test-mcp" },
    });
    await new Promise((r) => setTimeout(r, 50));

    // Confirm bridge is active: send an init, expect a response
    let received: JSONRPCMessage[] = [];
    let unsub = channels.subscribe(ctx, channelName, (e: ChannelEvent) => {
      if (e.type === "to-app") received.push(e.payload as JSONRPCMessage);
    });

    channels.publish(ctx, channelName, {
      type: "to-server",
      channel: channelName,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "ui/initialize",
        params: {
          protocolVersion: "2026-01-26",
          appInfo: { name: "test", version: "1.0.0" },
          appCapabilities: {},
        },
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBeGreaterThan(0); // bridge responded
    unsub();

    // Unmount
    channels.publish(ctx, "mcp-app:unmount", {
      type: "unmount",
      channel: "mcp-app:unmount",
      payload: { appSessionId },
    });
    await new Promise((r) => setTimeout(r, 50));

    // After unmount: send another message. Bridge should NOT respond.
    received = [];
    unsub = channels.subscribe(ctx, channelName, (e: ChannelEvent) => {
      if (e.type === "to-app") received.push(e.payload as JSONRPCMessage);
    });

    channels.publish(ctx, channelName, {
      type: "to-server",
      channel: channelName,
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    unsub();

    expect(received).toHaveLength(0);
  });

  it("gracefully handles mount events for unknown servers", async () => {
    // MCPClient with no connections
    const mcpClient = new MCPClient();

    const { channels, ctx } = await setupSessionWithAppHost(mcpClient);

    // Mount a ghost server — should log warning, not crash, not create bridge
    channels.publish(ctx, "mcp-app:mount", {
      type: "mount",
      channel: "mcp-app:mount",
      payload: {
        appSessionId: "ghost-app",
        resourceUri: "ui://nowhere/app",
        serverName: "nonexistent-server",
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    // Confirm no bridge exists: send a message, expect no response
    const channelName = `mcp-app:ghost-app`;
    const received: JSONRPCMessage[] = [];
    const unsub = channels.subscribe(ctx, channelName, (e: ChannelEvent) => {
      if (e.type === "to-app") received.push(e.payload as JSONRPCMessage);
    });

    channels.publish(ctx, channelName, {
      type: "to-server",
      channel: channelName,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "ui/initialize",
        params: {
          protocolVersion: "2026-01-26",
          appInfo: { name: "test", version: "1.0.0" },
          appCapabilities: {},
        },
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    unsub();

    expect(received).toHaveLength(0);
  });

  it("ignores duplicate mount events (idempotent)", async () => {
    const mcpServer = new MCPServer({
      name: "test-mcp",
      version: "1.0.0",
      security: { authenticator: async () => ({ authenticated: true }) },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    cleanups.push(() => mcpServer.close());

    const mcpClient = new MCPClient();
    await mcpClient.connect({
      serverName: "test-mcp",
      transport: "in-process",
      connection: { transport: clientTransport },
    });
    cleanups.push(() => mcpClient.disconnectAll());

    const { channels, ctx } = await setupSessionWithAppHost(mcpClient);
    const appSessionId = "dup-app";

    // Send mount twice for the same appSessionId
    for (let i = 0; i < 2; i++) {
      channels.publish(ctx, "mcp-app:mount", {
        type: "mount",
        channel: "mcp-app:mount",
        payload: { appSessionId, resourceUri: "ui://test/app", serverName: "test-mcp" },
      });
      await new Promise((r) => setTimeout(r, 50));
    }

    // Confirm the bridge still works (not broken by dup mount)
    const channelName = `mcp-app:${appSessionId}`;
    const received: JSONRPCMessage[] = [];
    const unsub = channels.subscribe(ctx, channelName, (e: ChannelEvent) => {
      if (e.type === "to-app") received.push(e.payload as JSONRPCMessage);
    });

    channels.publish(ctx, channelName, {
      type: "to-server",
      channel: channelName,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "ui/initialize",
        params: {
          protocolVersion: "2026-01-26",
          appInfo: { name: "test", version: "1.0.0" },
          appCapabilities: {},
        },
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    unsub();

    // Exactly ONE response (from the single active bridge, not two)
    const responses = received.filter((m: any) => m.id === 1);
    expect(responses).toHaveLength(1);
  });
});
