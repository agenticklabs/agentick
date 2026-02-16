/**
 * Tool Audience Filtering Tests
 *
 * Verifies that tools with audience: "user" are:
 * - Stored in ctx.tools (available for dispatch)
 * - Excluded from ctx.toolDefinitions (not sent to model)
 *
 * And that audience: "all" tools are:
 * - Stored in ctx.tools (available for dispatch)
 * - Included in ctx.toolDefinitions (sent to model)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { COM } from "../object-model";
import { z } from "zod";
import type { ExecutableTool, ToolMetadata } from "../../tool/tool";

function makeTool(overrides: Partial<ToolMetadata> = {}): ExecutableTool {
  return {
    metadata: {
      name: overrides.name ?? "test-tool",
      description: overrides.description ?? "A test tool",
      input: z.object({ value: z.string() }),
      ...overrides,
    },
    run: {
      exec: async () => [{ type: "text" as const, text: "result" }],
    },
  } as ExecutableTool;
}

describe("tool audience filtering", () => {
  let ctx: COM;

  beforeEach(() => {
    ctx = new COM();
  });

  it("should include normal tools (no audience) in both tools and toolDefinitions", async () => {
    await ctx.addTool(makeTool({ name: "normal-tool" }));

    expect(ctx.getTool("normal-tool")).toBeDefined();

    const input = ctx.toInput();
    expect(input.tools.some((t) => t.name === "normal-tool")).toBe(true);
  });

  it("should include audience: 'model' tools in both tools and toolDefinitions", async () => {
    await ctx.addTool(makeTool({ name: "model-tool", audience: "model" as const }));

    expect(ctx.getTool("model-tool")).toBeDefined();

    const input = ctx.toInput();
    expect(input.tools.some((t) => t.name === "model-tool")).toBe(true);
  });

  it("should store audience: 'user' tool for dispatch but exclude from model definitions", async () => {
    await ctx.addTool(makeTool({ name: "user-tool", audience: "user" as const }));

    // Available for dispatch
    expect(ctx.getTool("user-tool")).toBeDefined();

    // NOT in model-facing definitions
    const input = ctx.toInput();
    expect(input.tools.some((t) => t.name === "user-tool")).toBe(false);
  });

  it("should include audience: 'all' tools in both tools and toolDefinitions", async () => {
    await ctx.addTool(makeTool({ name: "all-tool", audience: "all" as const }));

    // Available for dispatch
    expect(ctx.getTool("all-tool")).toBeDefined();

    // Also in model-facing definitions
    const input = ctx.toInput();
    expect(input.tools.some((t) => t.name === "all-tool")).toBe(true);
  });

  it("should handle mix of audience values", async () => {
    await ctx.addTool(makeTool({ name: "default-tool" }));
    await ctx.addTool(makeTool({ name: "user-only", audience: "user" as const }));
    await ctx.addTool(makeTool({ name: "model-only", audience: "model" as const }));
    await ctx.addTool(makeTool({ name: "both", audience: "all" as const }));

    // All four stored for dispatch
    expect(ctx.getTool("default-tool")).toBeDefined();
    expect(ctx.getTool("user-only")).toBeDefined();
    expect(ctx.getTool("model-only")).toBeDefined();
    expect(ctx.getTool("both")).toBeDefined();

    // Only non-user-audience tools in model definitions
    const input = ctx.toInput();
    const toolNames = input.tools.map((t) => t.name);
    expect(toolNames).toContain("default-tool");
    expect(toolNames).toContain("model-only");
    expect(toolNames).toContain("both");
    expect(toolNames).not.toContain("user-only");
  });

  it("should preserve aliases on the stored tool metadata", async () => {
    await ctx.addTool(
      makeTool({ name: "mount-cmd", audience: "user" as const, aliases: ["mount", "mnt"] }),
    );

    const tool = ctx.getTool("mount-cmd");
    expect(tool).toBeDefined();
    expect(tool!.metadata.aliases).toEqual(["mount", "mnt"]);
  });

  it("should resolve tools by alias via getToolByAlias", async () => {
    await ctx.addTool(
      makeTool({ name: "mount-cmd", audience: "user" as const, aliases: ["mount", "mnt"] }),
    );

    expect(ctx.getToolByAlias("mount")?.metadata.name).toBe("mount-cmd");
    expect(ctx.getToolByAlias("mnt")?.metadata.name).toBe("mount-cmd");
    expect(ctx.getToolByAlias("nonexistent")).toBeUndefined();
  });

  it("should clear aliasIndex on clear()", async () => {
    await ctx.addTool(makeTool({ name: "cmd", audience: "user" as const, aliases: ["al"] }));
    expect(ctx.getToolByAlias("al")).toBeDefined();
    ctx.clear();
    expect(ctx.getToolByAlias("al")).toBeUndefined();
  });

  it("should remove aliases when removeTool() is called", async () => {
    await ctx.addTool(makeTool({ name: "cmd", audience: "user" as const, aliases: ["al", "al2"] }));
    expect(ctx.getToolByAlias("al")).toBeDefined();
    expect(ctx.getToolByAlias("al2")).toBeDefined();
    ctx.removeTool("cmd");
    expect(ctx.getToolByAlias("al")).toBeUndefined();
    expect(ctx.getToolByAlias("al2")).toBeUndefined();
  });

  it("should warn on alias collision and keep first registration", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await ctx.addTool(makeTool({ name: "tool-a", aliases: ["shared-alias"] }));
    await ctx.addTool(makeTool({ name: "tool-b", aliases: ["shared-alias"] }));

    // First registration wins
    expect(ctx.getToolByAlias("shared-alias")?.metadata.name).toBe("tool-a");

    // Warning was issued
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Alias "shared-alias" already registered for tool "tool-a"'),
    );

    warnSpy.mockRestore();
  });
});
