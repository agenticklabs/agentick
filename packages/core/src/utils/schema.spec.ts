import { describe, expect, it } from "vitest";
import { z } from "zod";
import { z as zod3 } from "zod/v3";
import { detectSchemaType, toJSONSchema } from "./schema";

describe("schema utils", () => {
  it("detects Zod 4 schemas", () => {
    const schema = z.object({
      action: z.literal("create"),
      title: z.string().optional(),
    });

    expect(detectSchemaType(schema)).toBe("zod4");
  });

  it("detects Zod 3 schemas", () => {
    const schema = zod3.object({
      action: zod3.literal("create"),
      title: zod3.string().optional(),
    });

    expect(detectSchemaType(schema)).toBe("zod3");
  });

  it("converts Zod 4 schemas to JSON Schema", async () => {
    const schema = z.object({
      action: z.literal("create"),
      title: z.string().optional(),
    });

    const jsonSchema = await toJSONSchema(schema);

    expect(Object.keys(jsonSchema).length).toBeGreaterThan(0);
    expect(jsonSchema).toHaveProperty("type");
  });

  it("converts Zod 3 discriminated unions to JSON Schema", async () => {
    const schema = zod3.discriminatedUnion("action", [
      zod3.object({
        action: zod3.literal("create"),
        task: zod3.string(),
      }),
      zod3.object({
        action: zod3.literal("list"),
      }),
    ]);

    const jsonSchema = await toJSONSchema(schema);

    expect(Object.keys(jsonSchema).length).toBeGreaterThan(0);
    expect("type" in jsonSchema || "anyOf" in jsonSchema).toBe(true);
  });
});
