/**
 * MCP Apps Client-Side Tests
 *
 * Tests visibility helpers and structural integration with the AppBridge.
 * The full bidirectional postMessage flow requires a browser context (or jsdom)
 * and is verified by ext-apps's own tests — we test our wrapper layer.
 */

import { describe, it, expect } from "vitest";
import {
  isToolVisibleToApps,
  getToolAppUri,
  isToolVisibilityModelOnly,
  buildAllowAttribute,
  createMCPApp,
} from "../apps.js";
import { MCPClient } from "../client.js";
import { MCPServer } from "../../server/server.js";
import { InMemoryTransport } from "../../transport/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// ============================================================================
// Visibility Helpers
// ============================================================================

describe("Visibility helpers", () => {
  // Per the ext-apps implementation, isToolVisibilityModelOnly returns true ONLY when
  // visibility is literally ["model"]. A tool with no _meta.ui.visibility is treated
  // as visible to any caller (not "model-only"). This matches the MCP Apps spec semantics.

  it("isToolVisibilityModelOnly: tool with no _meta is NOT marked as model-only", () => {
    const tool: Partial<Tool> = { name: "t" };
    expect(isToolVisibilityModelOnly(tool)).toBe(false);
  });

  it("isToolVisibilityModelOnly: tool with visibility ['model'] is model-only", () => {
    const tool: Partial<Tool> = {
      name: "t",
      _meta: { ui: { visibility: ["model"] } },
    };
    expect(isToolVisibilityModelOnly(tool)).toBe(true);
  });

  it("isToolVisibilityModelOnly: tool with visibility ['app'] is NOT model-only", () => {
    const tool: Partial<Tool> = {
      name: "t",
      _meta: { ui: { visibility: ["app"] } },
    };
    expect(isToolVisibilityModelOnly(tool)).toBe(false);
  });

  it("isToolVisibilityModelOnly: tool with visibility ['model', 'app'] is NOT model-only", () => {
    const tool: Partial<Tool> = {
      name: "t",
      _meta: { ui: { visibility: ["model", "app"] } },
    };
    expect(isToolVisibilityModelOnly(tool)).toBe(false);
  });

  it("isToolVisibleToApps: tool with no _meta is visible to apps", () => {
    expect(isToolVisibleToApps({ name: "t" })).toBe(true);
  });

  it("isToolVisibleToApps: tool with visibility ['model'] is NOT visible to apps", () => {
    expect(
      isToolVisibleToApps({
        name: "t",
        _meta: { ui: { visibility: ["model"] } },
      }),
    ).toBe(false);
  });

  it("isToolVisibleToApps: tool with visibility ['app'] is visible to apps", () => {
    expect(
      isToolVisibleToApps({
        name: "t",
        _meta: { ui: { visibility: ["app"] } },
      }),
    ).toBe(true);
  });

  it("isToolVisibleToApps: tool with visibility ['model','app'] is visible to apps", () => {
    expect(
      isToolVisibleToApps({
        name: "t",
        _meta: { ui: { visibility: ["model", "app"] } },
      }),
    ).toBe(true);
  });

  it("getToolAppUri: returns ui:// URI from _meta.ui.resourceUri", () => {
    const tool: Partial<Tool> = {
      name: "t",
      _meta: { ui: { resourceUri: "ui://test/dashboard" } },
    };
    expect(getToolAppUri(tool)).toBe("ui://test/dashboard");
  });

  it("getToolAppUri: returns undefined when no ui resource", () => {
    expect(getToolAppUri({ name: "t" })).toBeUndefined();
  });
});

// ============================================================================
// buildAllowAttribute (re-exported from ext-apps)
// ============================================================================

describe("buildAllowAttribute", () => {
  it("returns empty string for no permissions", () => {
    expect(buildAllowAttribute(undefined)).toBe("");
  });

  it("includes camera when requested", () => {
    const allow = buildAllowAttribute({ camera: true });
    expect(allow).toContain("camera");
  });

  it("combines multiple permissions", () => {
    const allow = buildAllowAttribute({
      camera: true,
      microphone: true,
      geolocation: true,
    });
    expect(allow).toContain("camera");
    expect(allow).toContain("microphone");
    expect(allow).toContain("geolocation");
  });
});

// ============================================================================
// createMCPApp — structural test
// ============================================================================

describe("createMCPApp", () => {
  it("throws when iframe.contentWindow is not available", async () => {
    const server = new MCPServer({ name: "test", version: "1.0.0" });
    const client = new MCPClient();

    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect({
      serverName: "test-server",
      transport: "in-process",
      connection: { transport: ct },
    });

    const fakeIframe = { contentWindow: null } as any;
    await expect(
      createMCPApp({
        mcpClient: client,
        serverName: "test-server",
        iframe: fakeIframe,
        hostCapabilities: {},
        hostInfo: { name: "test-host", version: "1.0.0" },
      }),
    ).rejects.toThrow("Iframe contentWindow is not available");

    await client.disconnectAll();
    await server.close();
  });

  it("throws when MCPClient is not connected to the named server", async () => {
    const client = new MCPClient();
    const fakeIframe = {
      contentWindow: {
        addEventListener: () => {},
        removeEventListener: () => {},
        postMessage: () => {},
      },
    } as any;

    await expect(
      createMCPApp({
        mcpClient: client,
        serverName: "nonexistent",
        iframe: fakeIframe,
        hostCapabilities: {},
        hostInfo: { name: "test-host", version: "1.0.0" },
      }),
    ).rejects.toThrow("not connected to server");
  });
});
