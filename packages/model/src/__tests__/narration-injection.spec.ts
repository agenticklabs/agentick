/**
 * Tool-call presentation — model-narration `_summary` injection (Pass B).
 *
 * `buildTools` injects the reserved {@link TOOL_NARRATION_FIELD} into each
 * model-facing tool schema so the model can self-narrate a call. The
 * injection is gated on the app-level narrate switch, the per-tool
 * `annotations.narrate` opt-out, and an already-present `_summary` field.
 *
 * @verifiedBy this suite
 */

import { describe, expect, it } from "vitest";

import type { ToolDeclaration } from "@agentick/spec";
import { jsonSchema, TOOL_NARRATION_FIELD } from "@agentick/spec";

import { buildTools } from "../canonical-projection.js";

function tool(overrides: Partial<ToolDeclaration> = {}): ToolDeclaration {
  return {
    id: "search",
    name: "search",
    description: "Search the docs",
    inputSchema: jsonSchema({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    }),
    exposure: ["model"],
    ...overrides,
  };
}

function narrationProp(schema: Record<string, unknown>): unknown {
  const props = schema.properties as Record<string, unknown> | undefined;
  return props?.[TOOL_NARRATION_FIELD];
}

describe("buildTools — model-narration `_summary` injection", () => {
  it("injects a `_summary` string property when narration is enabled (default)", () => {
    const [projected] = buildTools([tool()]);
    const prop = narrationProp(projected.inputSchema) as Record<string, unknown>;
    expect(prop).toBeDefined();
    expect(prop.type).toBe("string");
    expect(typeof prop.description).toBe("string");
    // The author's own field survives alongside the injected one.
    expect((projected.inputSchema.properties as Record<string, unknown>).query).toBeDefined();
  });

  it("adds `_summary` to `required`, preserving the author's own required keys", () => {
    const [projected] = buildTools([tool()]);
    expect(projected.inputSchema.required).toEqual(["query", TOOL_NARRATION_FIELD]);
  });

  it("adds `_summary` to `required` on a schema that declared none", () => {
    const [projected] = buildTools([
      tool({
        inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } } }),
      }),
    ]);
    expect(projected.inputSchema.required).toEqual([TOOL_NARRATION_FIELD]);
  });

  it("leaves `required` untouched when narration is disabled", () => {
    const [projected] = buildTools([tool()], false);
    expect(projected.inputSchema.required).toEqual(["query"]);
  });

  it("skips injection when narration is globally disabled (narrate=false)", () => {
    const [projected] = buildTools([tool()], false);
    expect(narrationProp(projected.inputSchema)).toBeUndefined();
    // Author fields untouched.
    expect((projected.inputSchema.properties as Record<string, unknown>).query).toBeDefined();
  });

  it("skips injection for a tool that opts out via annotations.narrate === false", () => {
    const [projected] = buildTools([tool({ annotations: { narrate: false } })]);
    expect(narrationProp(projected.inputSchema)).toBeUndefined();
  });

  it("still injects when annotations.narrate is true or unset while enabled globally", () => {
    const [onTrue] = buildTools([tool({ annotations: { narrate: true } })]);
    expect(narrationProp(onTrue.inputSchema)).toBeDefined();
  });

  it("leaves the author's `_summary` field intact (implicit opt-out on collision)", () => {
    const authorSummary = { type: "number" as const };
    const [projected] = buildTools([
      tool({
        inputSchema: jsonSchema({
          type: "object",
          properties: { [TOOL_NARRATION_FIELD]: authorSummary },
        }),
      }),
    ]);
    // The author's typing wins — we never clobber it.
    expect(narrationProp(projected.inputSchema)).toEqual(authorSummary);
  });

  it("does not mutate the source schema object (shallow copy on inject)", () => {
    // `toJsonSchema` returns the wrapped raw schema BY REFERENCE (shared
    // across projections). Injecting ON then re-projecting the SAME source
    // with narration OFF must show no `_summary` — proving the first
    // injection never wrote back into the shared raw object.
    const source = jsonSchema({
      type: "object",
      properties: { query: { type: "string" } },
    });
    const [on] = buildTools([tool({ inputSchema: source })]);
    expect(narrationProp(on.inputSchema)).toBeDefined();
    const [off] = buildTools([tool({ inputSchema: source })], false);
    expect(narrationProp(off.inputSchema)).toBeUndefined();
  });

  it("only projects model-exposed tools (dispatch-only tools are dropped)", () => {
    const projected = buildTools([tool({ exposure: ["dispatch"] })]);
    expect(projected).toHaveLength(0);
  });
});
