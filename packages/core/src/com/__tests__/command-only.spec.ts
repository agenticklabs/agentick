/**
 * commandOnly Tool Filtering Tests
 *
 * Verifies that tools with commandOnly: true are:
 * - Stored in ctx.tools (available for dispatch)
 * - Excluded from ctx.toolDefinitions (not sent to model)
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

describe("commandOnly tool filtering", () => {
  let ctx: COM;

  beforeEach(() => {
    ctx = new COM();
  });

  it("should include normal tools in both tools and toolDefinitions", async () => {
    await ctx.addTool(makeTool({ name: "normal-tool" }));

    expect(ctx.getTool("normal-tool")).toBeDefined();

    const input = ctx.toInput();
    expect(input.tools.some((t) => t.name === "normal-tool")).toBe(true);
  });

  it("should store commandOnly tool for dispatch but exclude from model definitions", async () => {
    await ctx.addTool(makeTool({ name: "cmd-tool", commandOnly: true }));

    // Available for dispatch
    expect(ctx.getTool("cmd-tool")).toBeDefined();

    // NOT in model-facing definitions
    const input = ctx.toInput();
    expect(input.tools.some((t) => t.name === "cmd-tool")).toBe(false);
  });

  it("should handle mix of normal and commandOnly tools", async () => {
    await ctx.addTool(makeTool({ name: "visible-tool" }));
    await ctx.addTool(makeTool({ name: "hidden-cmd", commandOnly: true }));
    await ctx.addTool(makeTool({ name: "another-visible" }));

    // All three stored for dispatch
    expect(ctx.getTool("visible-tool")).toBeDefined();
    expect(ctx.getTool("hidden-cmd")).toBeDefined();
    expect(ctx.getTool("another-visible")).toBeDefined();

    // Only non-commandOnly tools in model definitions
    const input = ctx.toInput();
    const toolNames = input.tools.map((t) => t.name);
    expect(toolNames).toContain("visible-tool");
    expect(toolNames).toContain("another-visible");
    expect(toolNames).not.toContain("hidden-cmd");
  });

  it("should preserve aliases on the stored tool metadata", async () => {
    await ctx.addTool(
      makeTool({ name: "mount-cmd", commandOnly: true, aliases: ["mount", "mnt"] }),
    );

    const tool = ctx.getTool("mount-cmd");
    expect(tool).toBeDefined();
    expect(tool!.metadata.aliases).toEqual(["mount", "mnt"]);
  });

  it("should resolve tools by alias via getToolByAlias", async () => {
    await ctx.addTool(
      makeTool({ name: "mount-cmd", commandOnly: true, aliases: ["mount", "mnt"] }),
    );

    expect(ctx.getToolByAlias("mount")?.metadata.name).toBe("mount-cmd");
    expect(ctx.getToolByAlias("mnt")?.metadata.name).toBe("mount-cmd");
    expect(ctx.getToolByAlias("nonexistent")).toBeUndefined();
  });

  it("should clear aliasIndex on clear()", async () => {
    await ctx.addTool(makeTool({ name: "cmd", commandOnly: true, aliases: ["al"] }));
    expect(ctx.getToolByAlias("al")).toBeDefined();
    ctx.clear();
    expect(ctx.getToolByAlias("al")).toBeUndefined();
  });

  it("should remove aliases when removeTool() is called", async () => {
    await ctx.addTool(makeTool({ name: "cmd", commandOnly: true, aliases: ["al", "al2"] }));
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
