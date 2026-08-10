/**
 * `mcpDeclaration` — annotation mapping: the server's advertised hints plus
 * provenance stamping (Pass B).
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

describe("mcpDeclaration — advertised annotations", () => {
  it("lands the four advisory hints, typed, on the declaration", () => {
    const hinted: McpToolDescriptor = {
      ...tool,
      annotations: {
        title: "Search",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    };
    const decl = mcpDeclaration("sess-1", "linear", hinted, "linear__search", undefined);
    const readOnly: boolean | undefined = decl.annotations?.readOnlyHint;
    expect(readOnly).toBe(true);
    expect(decl.annotations?.destructiveHint).toBe(false);
    expect(decl.annotations?.idempotentHint).toBe(true);
    expect(decl.annotations?.openWorldHint).toBe(false);
    expect(decl.annotations?.title).toBe("Search");
    expect(decl.annotations?.executedBy).toBe("mcp:linear");
  });

  it("fills a hint the server never advertised with the MCP spec's default", () => {
    const hinted: McpToolDescriptor = { ...tool, annotations: { readOnlyHint: true } };
    const decl = mcpDeclaration("sess-1", "linear", hinted, "linear__search", undefined);
    expect(decl.annotations).toEqual({
      readOnlyHint: true,
      // destructiveHint is scoped to non-read-only tools; defaulting must not
      // manufacture a read-only-yet-destructive bag.
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      executedBy: "mcp:linear",
    });
  });

  it("relays an ADVERTISED read-only-yet-destructive contradiction as the server's own claim", () => {
    const contradictory: McpToolDescriptor = {
      ...tool,
      annotations: { readOnlyHint: true, destructiveHint: true },
    };
    const decl = mcpDeclaration("sess-1", "linear", contradictory, "linear__search", undefined);
    expect(decl.annotations?.readOnlyHint).toBe(true);
    expect(decl.annotations?.destructiveHint).toBe(true);
  });

  it("a server that annotates nothing describes a destructive, open-world tool", () => {
    const decl = mcpDeclaration("sess-1", "linear", tool, "linear__search", undefined);
    expect(decl.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      executedBy: "mcp:linear",
    });
  });

  it("drops a hint the server sent with the wrong type, then defaults it", () => {
    const lying: McpToolDescriptor = {
      ...tool,
      annotations: { readOnlyHint: "yes", openWorldHint: false },
    };
    const decl = mcpDeclaration("sess-1", "linear", lying, "linear__search", undefined);
    expect(decl.annotations?.readOnlyHint).toBe(false);
    expect(decl.annotations?.openWorldHint).toBe(false);
  });
});

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
