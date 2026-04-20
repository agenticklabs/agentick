/**
 * MCP Component — Visibility Filtering Tests
 *
 * Tests that the MCP component correctly filters tools by visibility per
 * the MCP Apps spec when registering them with the agent. App-only tools
 * (visibility: ["app"]) must NOT appear in the model's tool list.
 *
 * The filtering happens at the @agentick/mcp/client layer via
 * `isToolVisibleToModel()`. This integration test verifies the full path:
 * MCPServer registers tool with `_meta.ui.visibility` → MCPClient discovers
 * it (preserves _meta) → component filters before agent registration.
 */

import { describe, it, expect } from "vitest";
import { MCPClient } from "../client.js";
import { MCPServer } from "@agentick/mcp/server";
import { InMemoryTransport } from "@agentick/mcp/transport";
import { isToolVisibleToModel } from "@agentick/mcp/client";
import { z } from "zod";

// ============================================================================
// Helpers
// ============================================================================

async function createPair(
  serverOptions: ConstructorParameters<typeof MCPServer>[0],
  serverName = "test-server",
) {
  const server = new MCPServer(serverOptions);
  const client = new MCPClient();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  await client.connect({
    serverName,
    transport: "in-process",
    connection: { transport: clientTransport },
  });

  return {
    server,
    client,
    serverName,
    cleanup: async () => {
      await client.disconnectAll();
      await server.close();
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("MCPClient — preserves _meta.ui from server", () => {
  it("propagates _meta from server through DiscoveredTool", async () => {
    const { client, serverName, cleanup } = await createPair({
      name: "test-server",
      version: "1.0.0",
      tools: [
        {
          name: "show_dashboard",
          description: "Show the dashboard",
          inputSchema: z.object({ projectId: z.number() }),
          // MCPServer auto-builds `_meta.ui` from the `ui` field on the definition
          ui: {
            resourceUri: "ui://test/dashboard",
            visibility: ["model", "app"],
          },
          handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
        },
      ],
      security: { authenticator: async () => ({ authenticated: true }) },
    });

    try {
      const tools = await client.listTools(serverName);
      expect(tools).toHaveLength(1);
      // The core adapter exposes _meta via MCPToolDefinition
      const meta = (tools[0] as any)._meta;
      expect(meta).toBeDefined();
      expect(meta.ui.resourceUri).toBe("ui://test/dashboard");
      expect(meta.ui.visibility).toEqual(["model", "app"]);
    } finally {
      await cleanup();
    }
  });
});

describe("Visibility filtering — agent registration", () => {
  it("model-visible tool passes filter", async () => {
    const tool = {
      name: "search",
      inputSchema: { type: "object" } as any,
      _meta: { ui: { visibility: ["model", "app"] as Array<"model" | "app"> } },
    };
    expect(isToolVisibleToModel(tool)).toBe(true);
  });

  it("app-only tool is filtered out", async () => {
    const tool = {
      name: "internal_app_action",
      inputSchema: { type: "object" } as any,
      _meta: { ui: { visibility: ["app"] as Array<"model" | "app"> } },
    };
    expect(isToolVisibleToModel(tool)).toBe(false);
  });

  it("tool without metadata is visible (default)", async () => {
    const tool = {
      name: "regular_tool",
      inputSchema: { type: "object" } as any,
    };
    expect(isToolVisibleToModel(tool)).toBe(true);
  });
});

describe("MCPTool — resolveContent for UI tools", () => {
  it("populates resolveContent that reads the resource", async () => {
    const { client, serverName, cleanup } = await createPair({
      name: "test-server",
      version: "1.0.0",
      tools: [
        {
          name: "dashboard",
          description: "Show dashboard",
          inputSchema: z.object({}),
          ui: { resourceUri: "ui://test/dash", visibility: ["model", "app"] },
          handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
        },
      ],
      resources: [
        {
          name: "dash-app",
          uri: "ui://test/dash",
          description: "Dashboard app",
          mimeType: "text/html;profile=mcp-app",
          read: async () => ({
            contents: [
              {
                uri: "ui://test/dash",
                text: "<!DOCTYPE html><html><body>Dashboard</body></html>",
                mimeType: "text/html;profile=mcp-app",
              },
            ],
          }),
        },
      ],
      security: { authenticator: async () => ({ authenticated: true }) },
    });

    try {
      // Build an MCPTool using the MCPService pattern
      const { MCPService } = await import("../service.js");
      const service = new MCPService(client);
      const tools = await service.listTools(serverName);
      const { MCPExecutableTool: MCPToolClass } = await import("../tool.js");
      const tool = new MCPToolClass(client, serverName, tools[0]);

      // Verify resolveContent was populated
      expect(tool.metadata.ui?.resolveContent).toBeDefined();

      // Call it — should return the HTML from the resource
      const content = await tool.metadata.ui!.resolveContent!();
      expect(content).toBe("<!DOCTYPE html><html><body>Dashboard</body></html>");
    } finally {
      await cleanup();
    }
  });
});

describe("End-to-end: MCPServer with mixed-visibility tools", () => {
  it("filters out app-only tools when listing for the model", async () => {
    const { client, serverName, cleanup } = await createPair({
      name: "mixed-tools",
      version: "1.0.0",
      tools: [
        {
          name: "model_tool",
          description: "Visible to model",
          inputSchema: z.object({}),
          handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
        },
        {
          name: "app_only_tool",
          description: "Hidden from model",
          inputSchema: z.object({}),
          ui: { visibility: ["app"] },
          handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
        },
        {
          name: "ui_tool",
          description: "Visible to both, has UI",
          inputSchema: z.object({}),
          ui: { resourceUri: "ui://test/widget", visibility: ["model", "app"] },
          handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
        },
      ],
      security: { authenticator: async () => ({ authenticated: true }) },
    });

    try {
      const allTools = await client.listTools(serverName);
      expect(allTools).toHaveLength(3); // server returns all tools

      // Apply the same filter the MCP component uses
      const modelVisibleTools = allTools.filter((t) => isToolVisibleToModel(t as any));
      const visibleNames = modelVisibleTools.map((t) => t.name);

      expect(visibleNames).toContain("model_tool");
      expect(visibleNames).toContain("ui_tool");
      expect(visibleNames).not.toContain("app_only_tool");
    } finally {
      await cleanup();
    }
  });
});
