/**
 * MCP Apps Client-Side Integration
 *
 * Wraps @modelcontextprotocol/ext-apps/app-bridge for the host side.
 * Provides convenience helpers for:
 * - Creating an AppBridge connected to an iframe + MCPClient
 * - Visibility enforcement (read _meta.ui.visibility, reject model-only calls from apps)
 * - Tool call proxying through MCPClient routing
 *
 * The host (e.g., Knowify Angular portal) creates the iframe, then calls
 * createMCPApp() to wire up the bridge.
 */

import {
  AppBridge,
  PostMessageTransport,
  getToolUiResourceUri,
  isToolVisibilityModelOnly,
  buildAllowAttribute,
} from "@modelcontextprotocol/ext-apps/app-bridge";

// NOTE: ext-apps 1.5.0 has a TypeScript bug — its app-bridge.d.ts imports
// type-only symbols (McpUiHostCapabilities, McpUiResourcePermissions, etc.)
// without the `type` keyword, then does `export * from "./types"`. Under
// `verbatimModuleSyntax: true`, importing these types directly fails with a
// misleading error. Upstream fix: ext-apps should use `import type { ... }`.
// Until then, we declare structural types that match the runtime shape.
export interface McpUiHostCapabilities {
  displayMode?: { supported: string[] };
  theme?: { supported: string[] };
  [key: string]: unknown;
}

export interface McpUiResourcePermissions {
  camera?: boolean;
  microphone?: boolean;
  geolocation?: boolean;
  clipboardWrite?: boolean;
}
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Logger } from "@agentick/kernel";
import type { MCPClient } from "./client.js";

const log = Logger.for("mcp:client:apps");

// ============================================================================
// Re-exports from ext-apps for consumer convenience
// ============================================================================

export {
  AppBridge,
  PostMessageTransport,
  getToolUiResourceUri,
  isToolVisibilityModelOnly,
  buildAllowAttribute,
};

// ============================================================================
// MCPApp — convenience wrapper around AppBridge + MCPClient
// ============================================================================

/**
 * Structural type for an iframe element. Avoids requiring DOM lib in tsconfig.
 * Consumers in browser environments will pass a real HTMLIFrameElement.
 */
export interface IframeLike {
  contentWindow: any;
}

export interface CreateMCPAppOptions {
  /** The MCPClient that owns the connection to the server hosting the ui:// resource. */
  mcpClient: MCPClient;
  /** The server name to route tool calls to. */
  serverName: string;
  /** The iframe element rendering the ui:// resource. */
  iframe: IframeLike;
  /** Host capabilities to advertise (display modes, themes, etc.). */
  hostCapabilities: McpUiHostCapabilities;
  /** Host implementation info. */
  hostInfo: { name: string; version: string };
  /**
   * Optional: enforce visibility rules. Default: true.
   * When enabled, tool calls from the iframe are rejected if the tool's
   * `_meta.ui.visibility` doesn't include "app".
   */
  enforceVisibility?: boolean;
}

export interface MCPAppHandle {
  /** The underlying AppBridge instance. */
  bridge: AppBridge;
  /** Close the app and clean up the bridge. */
  close: () => Promise<void>;
}

/**
 * Create an MCP App bridge for a sandboxed iframe.
 *
 * The host should:
 * 1. Create the iframe with appropriate `sandbox` and `allow` attributes
 *    (use `buildAllowAttribute(permissions)` for the `allow` attribute)
 * 2. Set the iframe's src to a URL serving the ui:// resource HTML
 * 3. Wait for the iframe to load
 * 4. Call `createMCPApp({ iframe, ... })` to wire up the bridge
 *
 * The bridge handles:
 * - postMessage JSON-RPC protocol via PostMessageTransport
 * - Tool call proxying from the iframe to the MCP server
 * - Visibility enforcement (model-only tools rejected)
 * - Standard MCP forwarding (resources/read, prompts/get, etc.)
 */
export async function createMCPApp(options: CreateMCPAppOptions): Promise<MCPAppHandle> {
  const {
    mcpClient,
    serverName,
    iframe,
    hostCapabilities,
    hostInfo,
    enforceVisibility = true,
  } = options;

  if (!iframe.contentWindow) {
    throw new Error("Iframe contentWindow is not available — ensure the iframe is loaded");
  }

  // Get the underlying SDK Client from the MCPClient (for ext-apps's auto-forwarding)
  const sdkClient = (mcpClient as any).connections.get(serverName)?.client as Client | undefined;
  if (!sdkClient) {
    throw new Error(`MCPClient is not connected to server "${serverName}"`);
  }

  // Create the bridge with the SDK client — ext-apps auto-forwards MCP requests
  const bridge = new AppBridge(sdkClient, hostInfo, hostCapabilities);

  // Wire up visibility enforcement if enabled
  if (enforceVisibility) {
    // Cache the tool list to check visibility on tool calls
    let toolsCache: Tool[] | null = null;

    const refreshTools = async () => {
      const discovered = await mcpClient.listTools(serverName);
      // Convert DiscoveredTool back to SDK Tool shape for visibility helpers
      toolsCache = discovered.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as any,
        annotations: t.annotations as any,
      }));
    };

    await refreshTools();

    // Re-fetch tools when the server sends list_changed
    mcpClient.on("tools:changed", (e: { serverName: string }) => {
      if (e.serverName === serverName) {
        refreshTools().catch((err) => log.warn({ err }, "Failed to refresh tools after change"));
      }
    });

    // Hook the bridge's tool-call handler to enforce visibility
    bridge.oncalltool = async (params) => {
      const toolName = params.name;
      const tool = toolsCache?.find((t) => t.name === toolName);

      if (tool && isToolVisibilityModelOnly(tool)) {
        log.warn({ serverName, toolName }, "App attempted to call model-only tool — rejected");
        throw new Error(`Tool "${toolName}" is model-only and cannot be called from an app`);
      }

      // Allowed — forward to MCPClient with progress relay
      return mcpClient.callTool(
        serverName,
        toolName,
        (params.arguments ?? {}) as Record<string, unknown>,
        {
          onProgress: (info) => {
            // Relay progress back to the app via the bridge's transport
            try {
              (bridge as any)._server?.notification({
                method: "notifications/progress",
                params: {
                  progressToken: (params as any)._meta?.progressToken ?? toolName,
                  progress: info.progress,
                  total: info.total,
                  message: info.message,
                },
              });
            } catch {
              // Best-effort — bridge may not support raw notifications
            }
          },
        },
      );
    };
  }

  // Set up the postMessage transport (host side)
  const transport = new PostMessageTransport(
    iframe.contentWindow,
    iframe.contentWindow,
  ) as Transport;
  await bridge.connect(transport);

  return {
    bridge,
    async close() {
      try {
        // Close the underlying transport — AppBridge doesn't expose its own close()
        await transport.close?.();
      } catch {
        // Best-effort cleanup
      }
    },
  };
}

// ============================================================================
// Visibility Helpers
// ============================================================================

/**
 * Check if a discovered tool is visible to apps (i.e., can be called from a ui:// iframe).
 * Returns true if the tool's _meta.ui.visibility includes "app", or if visibility is unset
 * (default visibility is ["model", "app"], which means apps can call it).
 */
export function isToolVisibleToApps(
  tool: { annotations?: Record<string, unknown> } & Partial<Tool>,
): boolean {
  return !isToolVisibilityModelOnly(tool as Partial<Tool>);
}

/**
 * Check if a discovered tool is visible to the model (i.e., should appear in tools/list to the LLM).
 * Returns true if the tool's _meta.ui.visibility includes "model", or if visibility is unset
 * (default visibility is ["model", "app"], which means the model can call it).
 *
 * Hosts MUST filter app-only tools (visibility: ["app"]) from the model's tool list.
 */
export function isToolVisibleToModel(
  tool: { _meta?: Record<string, unknown> } & Partial<Tool>,
): boolean {
  const meta = tool._meta as { ui?: { visibility?: Array<"model" | "app"> } } | undefined;
  const visibility = meta?.ui?.visibility;
  if (!visibility || visibility.length === 0) return true; // default: visible to model
  return visibility.includes("model");
}

/**
 * Get the ui:// resource URI linked to a tool, if any.
 * Returns the URI from _meta.ui.resourceUri or undefined.
 */
export function getToolAppUri(tool: Partial<Tool>): string | undefined {
  return getToolUiResourceUri(tool);
}
