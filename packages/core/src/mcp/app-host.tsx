/**
 * MCP App Host
 *
 * Server-side AppBridge lifecycle manager for MCP Apps. Subscribes to the
 * session's `mcp-app:mount` channel, creates AppBridge instances on demand
 * using the shared MCPClient, and routes bidirectional messages via per-app
 * session channels.
 *
 * Mounted automatically by the `<MCP>` component — users don't need to
 * instantiate this directly.
 *
 * ## Flow
 *
 * 1. UI tool fires → session emits `tool_result_start.ui` with `{ resourceUri, appSessionId }`
 * 2. Host (browser) renders iframe, publishes to channel `mcp-app:mount`:
 *    `{ appSessionId, resourceUri, serverName }`
 * 3. This component receives the mount event, looks up the SDK Client for
 *    `serverName`, creates an AppBridge + RelayTransport
 * 4. RelayTransport routes AppBridge messages via session channel
 *    `mcp-app:{appSessionId}`:
 *    - `type: "to-app"` → messages from bridge to browser/iframe
 *    - `type: "to-server"` → messages from browser/iframe to bridge
 * 5. On `mcp-app:unmount`, bridge is torn down
 * 6. Component unmount cleans up all remaining bridges
 */

import React, { useRef } from "react";
import type { MCPClient } from "./client.js";
import { useOnMount, useOnUnmount } from "../hooks/index.js";
import { Context } from "@agentick/kernel";
import type { ChannelEvent } from "@agentick/kernel";
import { AppBridge, RelayTransport } from "@agentick/mcp/client";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSX } from "../jsx/jsx-runtime.js";

// ============================================================================
// Types
// ============================================================================

export interface MCPAppHostProps {
  /** Shared MCPClient instance from the parent <MCP> component */
  mcpClient: MCPClient;
}

interface AppInstance {
  appSessionId: string;
  serverName: string;
  bridge: AppBridge;
  relay: RelayTransport;
  unsubChannel: () => void;
}

// ============================================================================
// Component
// ============================================================================

export function MCPAppHost(props: MCPAppHostProps): JSX.Element | null {
  // Map<appSessionId, AppInstance> — persists across renders
  const bridgesRef = useRef<Map<string, AppInstance>>(new Map());
  // Channel unsubscribes — set in useOnMount, called in useOnUnmount
  const unsubsRef = useRef<Array<() => void>>([]);

  useOnMount(() => {
    const ctx = Context.tryGet();
    if (!ctx?.channels) {
      // No channel service — app hosting is disabled (e.g., standalone app.run without session)
      return;
    }

    const channels = ctx.channels;
    const bridges = bridgesRef.current;

    // ── Mount handler ────────────────────────────────────────────────────

    const handleMount = async (event: ChannelEvent) => {
      if (event.type !== "mount") return;
      const payload = event.payload as {
        appSessionId?: string;
        resourceUri?: string;
        serverName?: string;
      };
      const { appSessionId, serverName } = payload;

      if (!appSessionId || !serverName) {
        console.warn("[mcp-app-host] mount event missing appSessionId or serverName");
        return;
      }

      if (bridges.has(appSessionId)) {
        // Already mounted — idempotent
        return;
      }

      // Get the SDK Client for this server from the connections map
      const sdkClient = (props.mcpClient as any).connections?.get(serverName)?.client;
      if (!sdkClient) {
        console.warn(
          `[mcp-app-host] No MCP client connection for server "${serverName}" — cannot mount app ${appSessionId}`,
        );
        return;
      }

      // Create per-app channel for bidirectional relay
      const appChannelName = `mcp-app:${appSessionId}`;

      // RelayTransport: bridge's send → publish to channel as "to-app".
      // Note: ChannelServiceInterface.publish takes channel name as a
      // separate arg and excludes it from the event object.
      const relay = new RelayTransport({
        send: (msg) => {
          channels.publish(ctx, appChannelName, {
            type: "to-app",
            payload: msg,
          });
        },
      });

      // Subscribe to "to-server" messages on the app channel → relay.receive
      const unsubChannel = channels.subscribe(ctx, appChannelName, (e) => {
        if (e.type === "to-server") {
          relay.receive(e.payload);
        }
      });

      // Create AppBridge with the SDK Client
      const bridge = new AppBridge(sdkClient, { name: "agentick-app-host", version: "1.0.0" }, {});

      try {
        await bridge.connect(relay as Transport);
        bridges.set(appSessionId, {
          appSessionId,
          serverName,
          bridge,
          relay,
          unsubChannel,
        });
      } catch (err) {
        console.error(`[mcp-app-host] Failed to connect bridge for ${appSessionId}:`, err);
        unsubChannel();
        await relay.close().catch(() => {});
      }
    };

    // ── Unmount handler ──────────────────────────────────────────────────

    const handleUnmount = async (event: ChannelEvent) => {
      if (event.type !== "unmount") return;
      const { appSessionId } = (event.payload as { appSessionId?: string }) ?? {};
      if (!appSessionId) return;

      const instance = bridges.get(appSessionId);
      if (!instance) return;

      instance.unsubChannel();
      try {
        await instance.relay.close();
      } catch {
        // best-effort cleanup
      }
      bridges.delete(appSessionId);
    };

    // ── Subscribe to mount/unmount channels ──────────────────────────────

    const unsubMount = channels.subscribe(ctx, "mcp-app:mount", handleMount);
    const unsubUnmount = channels.subscribe(ctx, "mcp-app:unmount", handleUnmount);

    // Store unsubs for the unmount callback
    unsubsRef.current = [unsubMount, unsubUnmount];
  });

  // ── Cleanup on component unmount ───────────────────────────────────────

  useOnUnmount(() => {
    for (const unsub of unsubsRef.current) unsub();
    unsubsRef.current = [];
    // Close all remaining bridges
    for (const instance of bridgesRef.current.values()) {
      instance.unsubChannel();
      instance.relay.close().catch(() => {});
    }
    bridgesRef.current.clear();
  });

  return null;
}
