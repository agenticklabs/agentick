import { describe, it, expect } from "vitest";
import { z } from "zod";
import { resolveTools } from "./normalization.js";

describe("resolveTools — inputSchema enrichment", () => {
  it("converts Zod input to JSON Schema on ToolMetadata", async () => {
    const tools = await resolveTools([
      {
        name: "test",
        description: "A test tool",
        input: z.object({
          query: z.string().describe("Search query"),
          limit: z.number().optional(),
        }),
      } as any,
    ]);

    expect(tools).toHaveLength(1);
    const meta = tools[0].metadata as any;

    // inputSchema should be a JSON Schema object, not a Zod schema
    expect(meta.inputSchema).toBeDefined();
    expect(meta.inputSchema.type).toBe("object");
    expect(meta.inputSchema.properties?.query).toBeDefined();
    expect(meta.inputSchema.properties?.limit).toBeDefined();
  });

  it("passes through existing JSON Schema without re-conversion", async () => {
    const jsonSchema = {
      type: "object",
      properties: { uri: { type: "string" } },
      required: ["uri"],
    };

    const tools = await resolveTools([
      {
        name: "read",
        description: "Read a resource",
        input: jsonSchema,
        inputSchema: jsonSchema,
      } as any,
    ]);

    expect(tools).toHaveLength(1);
    const meta = tools[0].metadata as any;
    expect(meta.inputSchema).toBe(jsonSchema); // same reference — not re-converted
  });

  it("handles ExecutableTool with Zod input", async () => {
    const tool = {
      metadata: {
        name: "query",
        description: "Query DB",
        input: z.object({ table: z.string() }),
      },
      run: async () => [{ type: "text" as const, text: "ok" }],
    };

    const tools = await resolveTools([tool as any]);
    const meta = tools[0].metadata as any;

    expect(meta.inputSchema).toBeDefined();
    expect(meta.inputSchema.type).toBe("object");
    expect(meta.inputSchema.properties?.table?.type).toBe("string");
  });

  it("handles missing input gracefully", async () => {
    const tools = await resolveTools([
      {
        name: "noinput",
        description: "No input",
        input: undefined,
      } as any,
    ]);

    // Tool with no input should still resolve without error
    expect(tools).toHaveLength(1);
  });
});
