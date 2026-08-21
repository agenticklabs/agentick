/**
 * Flat JSON Schema property builders — the shape vocabulary every
 * elicitation form field is described with.
 *
 * These are PURE schema construction: each builder turns the option bag
 * an {@link Elicit} sugar method already accepts (`pattern`, `format`,
 * `min`/`max`, `labels`, `default`, …) into the JSON Schema fragment that
 * describes the answer being asked for. No transport, no validation, no
 * routing — a subscriber that receives one of these can render a typed
 * field without knowing which wire carried it.
 *
 * Two consumers, two wrappings:
 *
 *   - The in-process sugar (`elicit-sugar.ts`) uses a property schema AS
 *     the request schema. The in-process reply is the bare value
 *     (`ClientElicitationHandle.accept(value)` → `response.value`), so the
 *     schema describes that value directly: `{ type: "string", … }`.
 *   - The MCP server projection wraps one property in
 *     {@link flatObjectSchema} under a single key, because MCP's
 *     `elicitation/create` requires `requestedSchema` to be a flat object
 *     and returns `result.content` keyed by property name.
 *
 * The MCP-specific rules — flatness enforcement, protocol-version gates —
 * stay at the MCP wire (see {@link checkFlatSchema} for the validator MCP
 * bridge code calls). This module only builds shapes.
 *
 * @see https://modelcontextprotocol.io/specification/2025-11-25/elicitation
 * @verifiedBy ./__tests__/elicit-sugar-schema.spec.ts
 */

import type { ElicitFieldAnnotations as FieldAnnotations } from "@agentick/spec";

/** A single JSON Schema fragment describing one form field. */
export type FlatProperty = Readonly<Record<string, unknown>>;

/** Stamp the {@link FieldAnnotations} onto a built property, if any were given. */
function annotate(out: Record<string, unknown>, opts?: FieldAnnotations): Record<string, unknown> {
  if (opts?.hint !== undefined) out["hint"] = opts.hint;
  if (opts?.info !== undefined) out["info"] = opts.info;
  if (opts?.placeholder !== undefined) out["placeholder"] = opts.placeholder;
  return out;
}

/**
 * Wrap named properties in the flat object schema MCP's
 * `requestedSchema` requires. Every property is required and
 * `additionalProperties` is closed — the client fills exactly this form.
 */
export function flatObjectSchema(properties: Readonly<Record<string, FlatProperty>>): FlatProperty {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export function textProp(
  opts?: FieldAnnotations & {
    default?: string;
    pattern?: string;
    format?: "email" | "uri" | "date" | "date-time";
    minLength?: number;
    maxLength?: number;
  },
): FlatProperty {
  const out: Record<string, unknown> = { type: "string" };
  if (opts?.default !== undefined) out["default"] = opts.default;
  if (opts?.pattern !== undefined) out["pattern"] = opts.pattern;
  if (opts?.format !== undefined) out["format"] = opts.format;
  if (opts?.minLength !== undefined) out["minLength"] = opts.minLength;
  if (opts?.maxLength !== undefined) out["maxLength"] = opts.maxLength;
  return annotate(out, opts);
}

export function numberProp(
  opts?: FieldAnnotations & {
    min?: number;
    max?: number;
    integer?: boolean;
    default?: number;
  },
): FlatProperty {
  const out: Record<string, unknown> = { type: opts?.integer ? "integer" : "number" };
  if (opts?.min !== undefined) out["minimum"] = opts.min;
  if (opts?.max !== undefined) out["maximum"] = opts.max;
  if (opts?.default !== undefined) out["default"] = opts.default;
  return annotate(out, opts);
}

export function booleanProp(opts?: FieldAnnotations & { default?: boolean }): FlatProperty {
  const out: Record<string, unknown> = { type: "boolean" };
  if (opts?.default !== undefined) out["default"] = opts.default;
  return annotate(out, opts);
}

/**
 * Single-select. `labels` projects to `enumNames` — positionally aligned
 * with `enum`, with the raw option as the fallback for any unlabelled
 * choice, which is the shape MCP clients read for display text.
 */
export function enumProp<T extends readonly string[]>(
  options: T,
  opts?: FieldAnnotations & { default?: T[number]; labels?: Partial<Record<T[number], string>> },
): FlatProperty {
  const out: Record<string, unknown> = { type: "string", enum: options };
  if (opts?.default !== undefined) out["default"] = opts.default;
  if (opts?.labels) out["enumNames"] = options.map((o) => opts.labels?.[o as T[number]] ?? o);
  return annotate(out, opts);
}

/** Multi-select — an array whose items are the {@link enumProp} choices. */
export function multiEnumProp<T extends readonly string[]>(
  options: T,
  opts?: FieldAnnotations & {
    default?: ReadonlyArray<T[number]>;
    min?: number;
    max?: number;
    labels?: Partial<Record<T[number], string>>;
  },
): FlatProperty {
  // Annotations belong on the ARRAY field, not its item enum — the items carry
  // only the choices and their labels.
  const itemSchema = enumProp(options, opts?.labels ? { labels: opts.labels } : undefined);
  const out: Record<string, unknown> = { type: "array", items: itemSchema, uniqueItems: true };
  if (opts?.default !== undefined) out["default"] = opts.default;
  if (opts?.min !== undefined) out["minItems"] = opts.min;
  if (opts?.max !== undefined) out["maxItems"] = opts.max;
  return annotate(out, opts);
}
