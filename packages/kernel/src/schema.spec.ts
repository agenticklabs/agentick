import { upgradeToJsonSchema2020, toJSONSchema, toJSONSchemaSync } from "./schema.js";
import { z as z4 } from "zod";

describe("upgradeToJsonSchema2020", () => {
  it("is idempotent on already-2020-12 schemas", () => {
    const input = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { name: { type: "string" } },
    };
    expect(upgradeToJsonSchema2020(input)).toEqual(input);
  });

  it("rewrites $schema URI to draft-2020-12", () => {
    const input = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "string",
    };
    const out = upgradeToJsonSchema2020(input);
    expect(out["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("converts tuple draft-7 (items as array) to prefixItems", () => {
    const input = {
      type: "array",
      items: [{ type: "string" }, { type: "number" }],
    };
    const out = upgradeToJsonSchema2020(input) as Record<string, unknown>;
    expect(out["prefixItems"]).toEqual([{ type: "string" }, { type: "number" }]);
    expect(out["items"]).toBeUndefined();
  });

  it("preserves additionalItems as items in 2020-12 tuples", () => {
    const input = {
      type: "array",
      items: [{ type: "string" }],
      additionalItems: { type: "boolean" },
    };
    const out = upgradeToJsonSchema2020(input) as Record<string, unknown>;
    expect(out["prefixItems"]).toEqual([{ type: "string" }]);
    expect(out["items"]).toEqual({ type: "boolean" });
    expect(out["additionalItems"]).toBeUndefined();
  });

  it("preserves single-schema items shape (homogeneous arrays)", () => {
    const input = {
      type: "array",
      items: { type: "string" },
    };
    const out = upgradeToJsonSchema2020(input);
    expect(out).toEqual(input);
  });

  it("recurses into properties", () => {
    const input = {
      type: "object",
      properties: {
        coords: {
          type: "array",
          items: [{ type: "number" }, { type: "number" }],
        },
      },
    };
    const out = upgradeToJsonSchema2020(input) as Record<string, unknown>;
    const props = out["properties"] as Record<string, Record<string, unknown>>;
    expect(props["coords"]?.["prefixItems"]).toEqual([{ type: "number" }, { type: "number" }]);
  });

  it("recurses into anyOf / oneOf / allOf", () => {
    const input = {
      anyOf: [{ type: "array", items: [{ type: "string" }] }, { type: "string" }],
    };
    const out = upgradeToJsonSchema2020(input) as Record<string, unknown>;
    const anyOf = out["anyOf"] as Array<Record<string, unknown>>;
    expect(anyOf[0]?.["prefixItems"]).toEqual([{ type: "string" }]);
  });

  it("recurses into $defs", () => {
    const input = {
      $defs: {
        Point: { type: "array", items: [{ type: "number" }, { type: "number" }] },
      },
    };
    const out = upgradeToJsonSchema2020(input) as Record<string, unknown>;
    const defs = out["$defs"] as Record<string, Record<string, unknown>>;
    expect(defs["Point"]?.["prefixItems"]).toEqual([{ type: "number" }, { type: "number" }]);
  });

  it("returns empty for null/non-object input", () => {
    expect(upgradeToJsonSchema2020(null)).toEqual({});
    expect(upgradeToJsonSchema2020(undefined)).toEqual({});
    expect(upgradeToJsonSchema2020("string")).toEqual({});
  });

  // ── Adversarial cases ────────────────────────────────────────────────

  it("preserves $ref references untouched", () => {
    const input = {
      $ref: "#/$defs/Point",
      $defs: { Point: { type: "array", items: [{ type: "number" }] } },
    };
    const out = upgradeToJsonSchema2020(input) as Record<string, unknown>;
    expect(out["$ref"]).toBe("#/$defs/Point");
    const defs = out["$defs"] as Record<string, Record<string, unknown>>;
    expect(defs["Point"]?.["prefixItems"]).toEqual([{ type: "number" }]);
  });

  it("deep-nested tuples inside oneOf inside properties inside $defs", () => {
    const input = {
      $defs: {
        Inner: {
          type: "object",
          properties: {
            options: {
              oneOf: [
                { type: "array", items: [{ type: "string" }, { type: "boolean" }] },
                { type: "null" },
              ],
            },
          },
        },
      },
    };
    const out = upgradeToJsonSchema2020(input) as Record<string, unknown>;
    const defs = out["$defs"] as Record<string, Record<string, unknown>>;
    const inner = defs["Inner"] as Record<string, unknown>;
    const props = inner["properties"] as Record<string, Record<string, unknown>>;
    const oneOf = props["options"]?.["oneOf"] as Array<Record<string, unknown>>;
    expect(oneOf[0]?.["prefixItems"]).toEqual([{ type: "string" }, { type: "boolean" }]);
    expect(oneOf[0]?.["items"]).toBeUndefined();
  });

  it("handles empty tuple (items: []) by emitting empty prefixItems", () => {
    const input = { type: "array", items: [] };
    const out = upgradeToJsonSchema2020(input) as Record<string, unknown>;
    expect(out["prefixItems"]).toEqual([]);
    expect(out["items"]).toBeUndefined();
  });

  it("preserves additionalItems: false as items: false", () => {
    const input = {
      type: "array",
      items: [{ type: "string" }],
      additionalItems: false,
    };
    const out = upgradeToJsonSchema2020(input) as Record<string, unknown>;
    expect(out["prefixItems"]).toEqual([{ type: "string" }]);
    // additionalItems: false → in 2020-12, items: false (no extra items beyond prefix)
    expect(out["items"]).toBe(false);
    expect(out["additionalItems"]).toBeUndefined();
  });

  it("does NOT touch homogeneous arrays that already use single-schema items", () => {
    const input = {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" } } },
    };
    const out = upgradeToJsonSchema2020(input);
    expect(out).toEqual(input);
  });

  it("is fully idempotent on already-2020-12 schemas with prefixItems", () => {
    const input = {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: false,
    };
    expect(upgradeToJsonSchema2020(input)).toEqual(input);
  });

  it("handles patternProperties recursion", () => {
    const input = {
      type: "object",
      patternProperties: {
        "^x-": { type: "array", items: [{ type: "string" }] },
      },
    };
    const out = upgradeToJsonSchema2020(input) as Record<string, unknown>;
    const pp = out["patternProperties"] as Record<string, Record<string, unknown>>;
    expect(pp["^x-"]?.["prefixItems"]).toEqual([{ type: "string" }]);
  });

  it("handles `not` schema recursion", () => {
    const input = {
      type: "array",
      not: { type: "array", items: [{ type: "string" }] },
    };
    const out = upgradeToJsonSchema2020(input) as Record<string, unknown>;
    const not = out["not"] as Record<string, unknown>;
    expect(not["prefixItems"]).toEqual([{ type: "string" }]);
  });

  it("handles propertyNames schema recursion", () => {
    const input = {
      type: "object",
      propertyNames: { type: "string", minLength: 1 },
    };
    const out = upgradeToJsonSchema2020(input) as Record<string, unknown>;
    expect(out["propertyNames"]).toEqual({ type: "string", minLength: 1 });
  });

  it("handles contains schema recursion", () => {
    const input = {
      type: "array",
      contains: { type: "array", items: [{ type: "string" }] },
    };
    const out = upgradeToJsonSchema2020(input) as Record<string, unknown>;
    const contains = out["contains"] as Record<string, unknown>;
    expect(contains["prefixItems"]).toEqual([{ type: "string" }]);
  });

  it("handles additionalProperties as a schema (not boolean)", () => {
    const input = {
      type: "object",
      additionalProperties: { type: "array", items: [{ type: "number" }] },
    };
    const out = upgradeToJsonSchema2020(input) as Record<string, unknown>;
    const ap = out["additionalProperties"] as Record<string, unknown>;
    expect(ap["prefixItems"]).toEqual([{ type: "number" }]);
  });

  it("preserves additionalProperties: true / false as boolean", () => {
    expect(
      (
        upgradeToJsonSchema2020({ type: "object", additionalProperties: true }) as Record<
          string,
          unknown
        >
      )["additionalProperties"],
    ).toBe(true);
    expect(
      (
        upgradeToJsonSchema2020({ type: "object", additionalProperties: false }) as Record<
          string,
          unknown
        >
      )["additionalProperties"],
    ).toBe(false);
  });

  it("does not double-process when called twice on the same input", () => {
    const draft7 = { type: "array", items: [{ type: "string" }] };
    const once = upgradeToJsonSchema2020(draft7);
    const twice = upgradeToJsonSchema2020(once);
    expect(twice).toEqual(once);
  });

  it("does not mutate the input schema", () => {
    const input = { type: "array", items: [{ type: "string" }] };
    const snapshot = JSON.parse(JSON.stringify(input));
    upgradeToJsonSchema2020(input);
    expect(input).toEqual(snapshot);
  });

  it("preserves arrays that look like primitives (enum), not as tuples", () => {
    // `enum` is an array but is NOT a schema list — must not be touched.
    const input = {
      type: "string",
      enum: ["a", "b", "c"],
    };
    const out = upgradeToJsonSchema2020(input);
    expect(out).toEqual(input);
  });

  it("preserves required array (not a schema list)", () => {
    const input = {
      type: "object",
      required: ["a", "b"],
      properties: { a: { type: "string" }, b: { type: "number" } },
    };
    const out = upgradeToJsonSchema2020(input) as Record<string, unknown>;
    expect(out["required"]).toEqual(["a", "b"]);
  });

  it("handles deeply recursive nesting without stack overflow on reasonable depth", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 50; i++) {
      schema = { type: "array", items: [schema] };
    }
    const out = upgradeToJsonSchema2020(schema);
    expect(out).toBeDefined();
    // Walk the result and assert each level converted
    let cursor: unknown = out;
    for (let i = 0; i < 50; i++) {
      const node = cursor as Record<string, unknown>;
      expect(node["prefixItems"]).toBeDefined();
      cursor = (node["prefixItems"] as unknown[])[0];
    }
  });
});

describe("toJSONSchema with 2020-12 target", () => {
  it("Zod 4 schema emits 2020-12-compatible output", async () => {
    const schema = z4.object({
      name: z4.string(),
      age: z4.number().optional(),
    });
    const out = await toJSONSchema(schema, { target: "draft-2020-12", stripMeta: false });
    expect(out["type"]).toBe("object");
    // Zod 4 emits 2020-12 natively — no draft-7 tuple shape should leak
    const props = out["properties"] as Record<string, Record<string, unknown>>;
    expect(props["name"]?.["type"]).toBe("string");
  });

  it("JSON Schema passthrough is upgraded to 2020-12 when targeted", async () => {
    const draft7 = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "array",
      items: [{ type: "string" }, { type: "number" }],
    };
    const out = await toJSONSchema(draft7, { target: "draft-2020-12", stripMeta: false });
    expect(out["prefixItems"]).toEqual([{ type: "string" }, { type: "number" }]);
    expect(out["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
  });
});

describe("toJSONSchemaSync with 2020-12 target", () => {
  it("Zod 4 schema emits 2020-12-compatible output synchronously", () => {
    const schema = z4.object({ id: z4.string() });
    const out = toJSONSchemaSync(schema, { target: "draft-2020-12", stripMeta: false });
    expect(out["type"]).toBe("object");
  });

  it("JSON Schema passthrough is upgraded sync", () => {
    const draft7 = {
      type: "array",
      items: [{ type: "string" }],
    };
    const out = toJSONSchemaSync(draft7, { target: "draft-2020-12", stripMeta: false });
    expect(out["prefixItems"]).toEqual([{ type: "string" }]);
  });
});
