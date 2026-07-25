/**
 * `withMCP({ narrate })` opt-out (Pass B) — MCP tools narrate by default;
 * an explicit `false` stamps `annotations.narrate: false` on the declaration
 * so the model-narration projector skips injecting `_summary`. This tests the
 * declaration MAPPING; that `buildTools` then skips `_summary` for a
 * `narrate: false` tool is covered by
 * `packages/model/src/__tests__/narration-injection.spec.ts`.
 */

import { describe, expect, it } from "vitest";

import type { McpToolDescriptor } from "../../client/types.js";
import { mcpDeclaration } from "../with-mcp.js";

const TOOL: McpToolDescriptor = {
  name: "search",
  description: "Search the docs",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};

describe("mcpDeclaration — narrate opt-out", () => {
  it("stamps annotations.narrate = false when narrate is false", () => {
    const decl = mcpDeclaration("sess", "srv", TOOL, "srv__search", false);
    expect(decl.annotations?.narrate).toBe(false);
  });

  it("leaves narrate unset (default ON) when narrate is undefined or true", () => {
    const off = mcpDeclaration("sess", "srv", TOOL, "srv__search", undefined);
    // No other annotations on this tool → the whole bag stays undefined (ON).
    expect(off.annotations?.narrate).toBeUndefined();

    const on = mcpDeclaration("sess", "srv", TOOL, "srv__search", true);
    expect(on.annotations?.narrate).toBeUndefined();
  });

  it("merges narrate:false WITHOUT clobbering a mapped taskSupport annotation", () => {
    const taskTool: McpToolDescriptor = {
      ...TOOL,
      execution: { taskSupport: "required" },
    };
    const decl = mcpDeclaration("sess", "srv", taskTool, "srv__search", false);
    expect(decl.annotations?.narrate).toBe(false);
    // `execution.taskSupport` → `annotations.taskSupport` survives the merge.
    expect(decl.annotations?.taskSupport).toBe("required");
  });

  it("preserves the tool's own advertised annotations alongside narrate:false", () => {
    const annotatedTool: McpToolDescriptor = {
      ...TOOL,
      annotations: { title: "Doc Search" },
    };
    const decl = mcpDeclaration("sess", "srv", annotatedTool, "srv__search", false);
    expect(decl.annotations?.narrate).toBe(false);
    expect(decl.annotations?.title).toBe("Doc Search");
  });
});
