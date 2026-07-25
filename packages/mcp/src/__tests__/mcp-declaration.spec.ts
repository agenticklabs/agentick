/**
 * `mcpDeclaration` — provenance stamping (Pass B).
 *
 * Every MCP-discovered tool is dispatched THROUGH the MCP harness to its
 * `serverId`, so the declaration must carry `annotations.executedBy:
 * "mcp:<serverId>"`. The tool executor reads that at its server-handled stamp
 * site (`annotations.executedBy ?? "agentick"`), so the resulting
 * `ToolResultBlock` is attributed to the MCP server rather than the framework.
 * Stamped ONCE on the declaration, alongside (not clobbering) the existing
 * narrate / taskSupport annotations.
 */

import { describe, expect, it } from "vitest";

import type { McpToolDescriptor } from "../client/types.js";
import { mcpDeclaration } from "../integration/with-mcp.js";

const tool: McpToolDescriptor = {
  name: "search",
  description: "search the corpus",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};

describe("mcpDeclaration — executedBy provenance", () => {
  it("stamps executedBy: mcp:<serverId>", () => {
    const decl = mcpDeclaration("sess-1", "linear", tool, "linear__search", undefined);
    expect(decl.annotations?.executedBy).toBe("mcp:linear");
  });

  it("derives the stamp from the serverId argument", () => {
    const decl = mcpDeclaration("sess-1", "github:user-42", tool, "gh__search", undefined);
    expect(decl.annotations?.executedBy).toBe("mcp:github:user-42");
  });

  it("keeps executedBy alongside the narrate opt-out", () => {
    const decl = mcpDeclaration("sess-1", "linear", tool, "linear__search", false);
    expect(decl.annotations?.executedBy).toBe("mcp:linear");
    expect(decl.annotations?.narrate).toBe(false);
  });

  it("keeps executedBy alongside mapped taskSupport", () => {
    const taskTool: McpToolDescriptor = { ...tool, execution: { taskSupport: "required" } };
    const decl = mcpDeclaration("sess-1", "linear", taskTool, "linear__search", undefined);
    expect(decl.annotations?.executedBy).toBe("mcp:linear");
    expect(decl.annotations?.taskSupport).toBe("required");
  });

  it("is always present — every MCP tool carries provenance", () => {
    const decl = mcpDeclaration("sess-1", "srv", tool, "srv__search", undefined);
    expect(decl.annotations).toBeDefined();
    expect(decl.annotations?.executedBy).toBe("mcp:srv");
  });
});
