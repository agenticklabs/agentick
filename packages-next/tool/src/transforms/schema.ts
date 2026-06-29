/**
 * Schema transforms: replace input/output schemas on tools.
 *
 * **Scope decision.** Introspecting + masking arbitrary
 * Standard-Schema validators is non-trivial — every adopter library
 * (Zod, Valibot, ArkType, Effect Schema, raw JSON Schema) exposes a
 * different surface for "drop this field." Doing it generically inside
 * the framework would require either:
 *  - bringing in a JSON Schema mask library (extra dep, slow), or
 *  - per-library shims (maintenance burden, leaky abstraction).
 *
 * Instead: the framework ships `replaceInputSchema` /
 * `replaceOutputSchema` — explicit swap primitives. Adopters write
 * their narrower schema (already in their preferred validator
 * library) and supply it via the map. Three lines of caller code; no
 * magic. Adopters who want a "mask-by-field-list" helper for a
 * specific library write it locally — `restrictZodInput(["secret"])`
 * is a ~5-line wrapper.
 */

import type { StandardSchemaV1, ToolDeclaration } from "@agentick/spec-next";

import type { ToolTransform } from "./transform.js";

/**
 * Replace `inputSchema` for tools by name. Tools whose name is not in
 * the map flow through unchanged.
 *
 * The replacement schema MUST be Standard-Schema-compliant. Adopters
 * supply it via their validator library of choice (or wrap raw JSON
 * Schema via `jsonSchema({ ... })`).
 *
 *   replaceInputSchema({
 *     "send_email": z.object({ to: z.string(), body: z.string() }),  // dropped: cc, bcc
 *   })
 *
 * Runtime validation uses whatever schema is in effect at execution
 * time. The MCP wire emits the projected schema. Both observe the
 * transform.
 */
export function replaceInputSchema<C = unknown>(
  map: Readonly<Record<string, StandardSchemaV1>>,
): ToolTransform<C> {
  return {
    name: "replaceInputSchema",
    apply: (tool) => {
      const schema = map[tool.name];
      if (schema === undefined) return tool;
      return { ...tool, inputSchema: schema };
    },
  };
}

/**
 * Replace `outputSchema` for tools by name. Same semantics as
 * {@link replaceInputSchema} but for the result shape. Setting a
 * schema where none was present is fine — the tool gains an
 * outputSchema on the wire.
 *
 *   replaceOutputSchema({
 *     "search": z.object({ items: z.array(SearchHit) }),
 *   })
 *
 * To REMOVE an outputSchema (rare), use the `transform` primitive
 * directly:
 *
 *   {
 *     name: "drop-output-schema",
 *     apply: (tool) => tool.name === "x"
 *       ? { ...tool, outputSchema: undefined }
 *       : tool,
 *   }
 */
export function replaceOutputSchema<C = unknown>(
  map: Readonly<Record<string, StandardSchemaV1>>,
): ToolTransform<C> {
  return {
    name: "replaceOutputSchema",
    apply: (tool) => {
      const schema = map[tool.name];
      if (schema === undefined) return tool;
      return { ...tool, outputSchema: schema };
    },
  };
}

/**
 * Lower-level: map both schemas with a function. The function sees
 * the existing schema (or `undefined` for `outputSchema`) and returns
 * the replacement. Returning the same reference is a no-op for that
 * tool.
 *
 * Use for cross-cutting concerns like "wrap every tool's input in a
 * `{ requestId, payload }` envelope" without listing every tool.
 *
 *   mapSchemas({
 *     mapInput: (schema, tool) => wrapWithRequestId(schema),
 *   })
 */
export function mapSchemas<C = unknown>(options: {
  readonly mapInput?: (schema: StandardSchemaV1, tool: ToolDeclaration, ctx: C) => StandardSchemaV1;
  readonly mapOutput?: (
    schema: StandardSchemaV1 | undefined,
    tool: ToolDeclaration,
    ctx: C,
  ) => StandardSchemaV1 | undefined;
}): ToolTransform<C> {
  return {
    name: "mapSchemas",
    apply: (tool, ctx) => {
      let next: ToolDeclaration = tool;
      if (options.mapInput) {
        const inputSchema = options.mapInput(tool.inputSchema, tool, ctx);
        if (inputSchema !== tool.inputSchema) {
          next = { ...next, inputSchema };
        }
      }
      if (options.mapOutput) {
        const outputSchema = options.mapOutput(tool.outputSchema, tool, ctx);
        if (outputSchema !== tool.outputSchema) {
          next = { ...next, outputSchema };
        }
      }
      return next;
    },
  };
}
