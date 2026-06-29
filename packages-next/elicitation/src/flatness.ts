/**
 * Form-mode schema flatness validation — MCP spec compliance.
 *
 * The MCP `elicitation/create` request schema is intentionally
 * constrained: an LLM client renders elicitation requests as a flat
 * UI form. Nested objects and arbitrary value types don't fit. The
 * spec restricts the request schema to a flat object with primitive
 * properties.
 *
 * This module validates a JSON Schema (the projected wire form of an
 * adopter's Standard-Schema) against that rule, BEFORE the request
 * leaves the substrate. Bad schemas raise
 * {@link ElicitSchemaTooComplex} synchronously — the wire never sees
 * a malformed elicit.
 *
 * Ported from v1's `validateFormSchemaFlatness` in
 * `packages/mcp/src/server/elicitation.ts`; v2 lifts it to a stable
 * surface adopters can call directly (e.g., to pre-validate generated
 * schemas).
 *
 * @see https://modelcontextprotocol.io/specification/2025-11-25/elicitation
 */

import { ElicitSchemaTooComplex } from "@agentick/spec-next";

/**
 * Inspect a JSON Schema and return the list of flatness violations.
 * Empty array → the schema is wire-compatible.
 *
 * Allowed at the property level:
 *   - `string` / `number` / `integer` / `boolean` primitives.
 *   - Single-select string enum (`type: "string"` + `enum: [...]`)
 *     OR titled enum (`oneOf: [{ const, title }, ...]`).
 *   - `array` whose items enumerate options — either
 *     `{ type: "string", enum: [...] }` (untitled multi-select) or
 *     `{ anyOf: [{ const, title }, ...] }` (titled multi-select).
 *
 * Disallowed:
 *   - Nested `object` types — split into multiple elicitations.
 *   - Free-form `array` (string-typed items without `enum` /
 *     `anyOf`) — the spec restricts multi-select to enumerated
 *     options.
 *   - Discriminated unions / intersections / `anyOf` at the property
 *     level (other than the spec-defined `oneOf` + `const` + `title`
 *     labeled-enum form).
 *
 * Pure function; no I/O. Safe to call from non-Effect code.
 */
export function checkFlatSchema(schema: Readonly<Record<string, unknown>>): readonly string[] {
  const issues: string[] = [];
  if (schema.type !== "object") {
    issues.push(`top-level schema must be type:"object", got ${String(schema.type)}`);
  }
  const properties = (schema.properties as Record<string, unknown>) ?? {};
  if (typeof properties !== "object" || properties === null) {
    issues.push("schema.properties must be an object");
    return issues;
  }
  for (const [key, prop] of Object.entries(properties)) {
    if (typeof prop !== "object" || prop === null) {
      issues.push(`property '${key}' is not a valid schema`);
      continue;
    }
    const p = prop as Record<string, unknown>;
    const t = p.type;

    if (t === "string") continue;
    if (t === "number" || t === "integer") continue;
    if (t === "boolean") continue;

    if (t === "array") {
      const items = p.items as Record<string, unknown> | undefined;
      if (!items || typeof items !== "object") {
        issues.push(`property '${key}': array items missing or invalid`);
        continue;
      }
      const hasEnum = items.type === "string" && Array.isArray(items.enum);
      const hasAnyOf = Array.isArray(items.anyOf);
      if (hasEnum || hasAnyOf) continue;
      issues.push(
        `property '${key}': array items must enumerate options ` +
          `(items.enum or items.anyOf with const+title) — free-form string arrays are not allowed in form-mode schemas`,
      );
      continue;
    }

    if (t === "object") {
      issues.push(`property '${key}': nested objects are not allowed in form-mode schemas`);
      continue;
    }

    // Anything else — null, undefined-shaped, multi-type unions, etc.
    issues.push(`property '${key}': unsupported type '${String(t)}'`);
  }
  return issues;
}

/**
 * Throw {@link ElicitSchemaTooComplex} if the schema fails flatness;
 * no-op otherwise. Use this at the harness boundary (before serializing
 * the wire payload).
 */
export function assertFlatSchema(schema: Readonly<Record<string, unknown>>): void {
  const issues = checkFlatSchema(schema);
  if (issues.length === 0) return;
  throw new ElicitSchemaTooComplex({ issues, schema });
}
