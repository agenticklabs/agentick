/**
 * Standard Schema v1 — minimal types-only interface for cross-validator
 * schemas, plus runtime helpers for adopters bringing arbitrary
 * validator libraries (Zod, Valibot, ArkType, raw JSON Schema, custom).
 *
 * Types inlined (~30 LOC) to preserve `@agentick/spec-next`'s
 * zero-dependency claim. The upstream `@standard-schema/spec` package
 * provides the same shape; if we ever depend on it directly, this file
 * can be replaced with a re-export.
 *
 * Validators that implement Standard Schema (Zod 4, Valibot, ArkType,
 * Effect Schema, etc.) all satisfy this interface. Adopters bring
 * their preferred validator; the framework speaks the common shape.
 *
 * The runtime helpers (`jsonSchema`, `toJsonSchema`,
 * `registerJsonSchemaConverter`) bridge the validator → JSON Schema
 * gap at the wire-emission boundary (where OpenAI / Anthropic / etc.
 * expect JSON Schema, not arbitrary validators).
 *
 * @see https://github.com/standard-schema/standard-schema
 */

// ============================================================================
// Type definitions (zero-dep, type-only)
// ============================================================================

/**
 * A Standard Schema v1 validator.
 *
 * Implementations expose validation behavior via the `~standard`
 * property — a tilde-prefixed key chosen by the upstream spec to avoid
 * collisions with user-visible property names.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaProps<Input, Output>;
}

export interface StandardSchemaProps<Input = unknown, Output = Input> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (
    value: unknown,
  ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
  /** Optional type-only marker for inference. Never present at runtime. */
  readonly types?: { readonly input: Input; readonly output: Output };
}

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly value?: undefined; readonly issues: readonly StandardSchemaIssue[] };

export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

/**
 * Convenience type to extract the validated output of a schema.
 */
export type InferOutput<S extends StandardSchemaV1> =
  S extends StandardSchemaV1<unknown, infer O> ? O : never;

/**
 * Convenience type to extract the input shape of a schema.
 */
export type InferInput<S extends StandardSchemaV1> =
  S extends StandardSchemaV1<infer I, unknown> ? I : never;

// ============================================================================
// Raw JSON Schema adapter
// ============================================================================

/**
 * Symbol used to attach a raw JSON Schema object to a StandardSchemaV1
 * wrapper. `toJsonSchema()` recovers the stored object verbatim.
 *
 * Symbol-keyed (not string) so it doesn't collide with validator-library
 * property names and doesn't show up in standard introspection.
 */
const RAW_JSON_SCHEMA_MARKER: unique symbol = Symbol("agentick.rawJsonSchema");

/**
 * Wrap a raw JSON Schema object as a `StandardSchemaV1`. The stored
 * schema is recovered at wire-emission time by `toJsonSchema()`,
 * preserving every field of the input verbatim.
 *
 * Adopter validation is a pass-through by default (the wire schema is
 * the authoritative shape; the runtime trusts upstream validation).
 * Pass `options.validator` to plug in runtime validation backed by an
 * external JSON Schema validator (Ajv, etc.).
 *
 * @example
 * ```ts
 * <Tool inputSchema={jsonSchema({
 *   type: "object",
 *   properties: { id: { type: "string" } },
 *   required: ["id"],
 * })} handler={...} />
 * ```
 */
export function jsonSchema<Output = unknown>(
  schema: Readonly<Record<string, unknown>>,
  options?: {
    readonly vendor?: string;
    readonly validator?: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
  },
): StandardSchemaV1<unknown, Output> {
  const validate =
    options?.validator ??
    ((value: unknown) => ({ value: value as Output }) as StandardSchemaResult<Output>);
  const wrapper = {
    "~standard": {
      version: 1 as const,
      vendor: options?.vendor ?? "agentick.json-schema",
      validate,
    },
    [RAW_JSON_SCHEMA_MARKER]: schema,
  };
  return wrapper as unknown as StandardSchemaV1<unknown, Output>;
}

// ============================================================================
// Vendor converter registry
// ============================================================================

/**
 * Converter function: receives the schema, returns its JSON Schema
 * representation, or `undefined` if conversion is not possible (in
 * which case `toJsonSchema()` falls through to introspection / fallback).
 */
export type JsonSchemaConverter = (
  schema: StandardSchemaV1,
) => Readonly<Record<string, unknown>> | undefined;

const converterRegistry = new Map<string, JsonSchemaConverter>();

/**
 * Register a vendor-specific JSON Schema converter. Adopters call this
 * once at app boot to teach `toJsonSchema()` how to handle their
 * validator. Zod 4's converter is a top-level function (`z.toJSONSchema`),
 * Valibot's lives in `@valibot/to-json-schema`, etc. — adopters wire
 * them in via this registry.
 *
 * Re-registering the same vendor replaces the previous converter
 * (last-write-wins). Returns an `unregister()` function for symmetric
 * teardown (useful in tests).
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { registerJsonSchemaConverter } from "@agentick/spec-next";
 *
 * registerJsonSchemaConverter("zod", (schema) => z.toJSONSchema(schema));
 * ```
 */
export function registerJsonSchemaConverter(
  vendor: string,
  converter: JsonSchemaConverter,
): () => void {
  converterRegistry.set(vendor, converter);
  return () => {
    if (converterRegistry.get(vendor) === converter) {
      converterRegistry.delete(vendor);
    }
  };
}

/**
 * Diagnostic: list registered vendor converters. Test-only utility.
 */
export function listJsonSchemaConverters(): readonly string[] {
  return Array.from(converterRegistry.keys());
}

// ============================================================================
// JSON Schema extraction
// ============================================================================

/** Tracks vendors we've already warned about, to keep the log non-spammy. */
const warnedVendors = new Set<string>();

/**
 * Method names commonly used by validator libraries to expose a JSON
 * Schema representation. Probed in order; the first method that
 * returns an object wins.
 */
const COMMON_METHOD_NAMES = ["toJsonSchema", "toJSONSchema", "jsonSchema"] as const;

/**
 * Resolution order:
 *
 *   1. Raw JSON Schema stored by `jsonSchema()` → return verbatim.
 *   2. Adopter-registered converter for `schema["~standard"].vendor` → use it.
 *   3. Best-effort method probe (`.toJsonSchema()`, `.toJSONSchema()`,
 *      `.jsonSchema()`) → call the first one that returns an object.
 *   4. Fallback: `{ type: "object" }` + a one-shot `console.warn` per
 *      vendor explaining how to make the conversion work.
 *
 * Used at the wire-emission boundary — where `ToolDeclaration.inputSchema`
 * (a `StandardSchemaV1`) needs to become the JSON Schema object that
 * model providers (OpenAI / Anthropic / Google / ...) actually expect.
 */
export function toJsonSchema(schema: StandardSchemaV1): Readonly<Record<string, unknown>> {
  // 1. Raw adapter
  const raw = (
    schema as unknown as { [RAW_JSON_SCHEMA_MARKER]?: Readonly<Record<string, unknown>> }
  )[RAW_JSON_SCHEMA_MARKER];
  if (raw !== undefined) return raw;

  const vendor = schema["~standard"]?.vendor ?? "unknown";

  // 2. Registered converter
  const registered = converterRegistry.get(vendor);
  if (registered) {
    try {
      const result = registered(schema);
      if (isPlainObject(result)) return result;
    } catch {
      // Converter threw — fall through to introspection.
    }
  }

  // 3. Best-effort introspection
  for (const method of COMMON_METHOD_NAMES) {
    const candidate = (schema as unknown as Record<string, unknown>)[method];
    if (typeof candidate === "function") {
      try {
        const result = (candidate as () => unknown).call(schema);
        if (isPlainObject(result)) return result as Readonly<Record<string, unknown>>;
      } catch {
        // Method threw — try the next candidate.
      }
    }
  }

  // 4. Fallback + one-shot loud warning per vendor
  if (!warnedVendors.has(vendor)) {
    warnedVendors.add(vendor);
    // eslint-disable-next-line no-console
    console.warn(
      `[agentick] toJsonSchema: cannot derive JSON Schema for vendor "${vendor}". ` +
        `Falling back to { type: "object" }. To fix one of:\n` +
        `  1. Wrap the schema with \`jsonSchema({ ...rawSchema })\` to provide an explicit wire schema.\n` +
        `  2. Register a converter with \`registerJsonSchemaConverter("${vendor}", schema => ...)\`.\n` +
        `  3. Use a library that exposes \`.toJsonSchema()\` / \`.toJSONSchema()\` on the schema instance.`,
    );
  }
  return { type: "object" };
}

/**
 * Type guard: does `value` satisfy the StandardSchemaV1 contract?
 */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (typeof value !== "object" || value === null) return false;
  const std = (value as { "~standard"?: unknown })["~standard"];
  if (typeof std !== "object" || std === null) return false;
  const props = std as { version?: unknown; vendor?: unknown; validate?: unknown };
  return (
    props.version === 1 && typeof props.vendor === "string" && typeof props.validate === "function"
  );
}

/**
 * Test-only: reset the warned-vendors set so the same vendor warns
 * again on the next fallback. Useful in tests asserting warning emission.
 */
export function _resetToJsonSchemaWarnings(): void {
  warnedVendors.clear();
}

// ============================================================================
// Internals
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
