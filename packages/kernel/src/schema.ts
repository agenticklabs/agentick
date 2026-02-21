/**
 * Schema utilities for handling Zod 3, Zod 4, and Standard Schema.
 *
 * This module provides a unified interface for:
 * - Detecting schema types (Zod 3, Zod 4, Standard Schema, JSON Schema)
 * - Converting schemas to JSON Schema format
 * - Validating values against schemas
 *
 * @see https://standardschema.dev
 * @see https://standardschema.dev/json-schema
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Standard Schema V1 interface (subset for detection).
 * @see https://standardschema.dev
 */
export interface StandardSchemaV1Props {
  readonly version: 1;
  readonly vendor: string;
  readonly validate?: (value: unknown) => unknown;
}

/**
 * Standard JSON Schema V1 interface (subset for conversion).
 * @see https://standardschema.dev/json-schema
 */
export interface StandardJSONSchemaV1Props extends StandardSchemaV1Props {
  readonly jsonSchema: {
    readonly input: (options: { target: string }) => Record<string, unknown>;
    readonly output?: (options: { target: string }) => Record<string, unknown>;
  };
}

/**
 * Schema type detection result.
 */
export type SchemaType =
  | "zod3"
  | "zod4"
  | "standard-schema"
  | "standard-json-schema"
  | "json-schema"
  | "unknown";

/**
 * Options for JSON Schema conversion.
 */
export interface ToJSONSchemaOptions {
  /**
   * Target JSON Schema version for Standard Schema conversion.
   * @default "draft-2020-12"
   */
  target?: "draft-2020-12" | "draft-07" | "openapi-3.0";

  /**
   * Whether to strip $schema and additionalProperties from output.
   * @default true
   */
  stripMeta?: boolean;
}

// ============================================================================
// Detection
// ============================================================================

/**
 * Check if value is a Zod 4 schema.
 * Zod 4 implements Standard Schema with vendor "zod".
 */
export function isZod4Schema(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  const standard = (value as Record<string, unknown>)["~standard"];
  if (standard == null || typeof standard !== "object") return false;
  if ((standard as Record<string, unknown>).vendor !== "zod") return false;

  const jsonSchema = (standard as Record<string, unknown>).jsonSchema as
    | Record<string, unknown>
    | undefined;
  const schemaAny = value as Record<string, unknown>;
  const hasStandardJSONSchema = typeof jsonSchema?.input === "function";
  const hasZod4Def =
    typeof (schemaAny._zod as Record<string, unknown> | undefined)?.def !== "undefined";

  return hasStandardJSONSchema || hasZod4Def;
}

/**
 * Check if value is a Zod 3 schema.
 * Zod 3 has _def.typeName but no ~standard property.
 */
export function isZod3Schema(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  // Has _def with typeName starting with "Zod".
  const def = obj._def as Record<string, unknown> | undefined;
  if (!def?.typeName) return false;
  const typeName = def.typeName as string;
  if (!typeName.startsWith("Zod")) return false;
  // Zod 3 may not expose Zod 4 internals even if ~standard is present.
  const hasStandard = "~standard" in obj;
  const standard = obj["~standard"] as Record<string, unknown> | undefined;
  const isZodVendor = standard?.vendor === "zod";
  const hasZod4Def = typeof (obj._zod as Record<string, unknown> | undefined)?.def !== "undefined";

  return !hasZod4Def && (!hasStandard || isZodVendor);
}

/**
 * Check if value is a Standard Schema (v1).
 * @see https://standardschema.dev
 */
export function isStandardSchema(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  const standard = obj["~standard"] as Record<string, unknown> | undefined;
  if (!standard || typeof standard !== "object") return false;
  return (
    standard.version === 1 &&
    typeof standard.vendor === "string" &&
    typeof standard.validate === "function"
  );
}

/**
 * Check if value is a Standard Schema with JSON Schema support.
 * @see https://standardschema.dev/json-schema
 */
export function isStandardJSONSchema(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  const standard = obj["~standard"] as Record<string, unknown> | undefined;
  if (!standard || typeof standard !== "object") return false;
  const jsonSchema = standard.jsonSchema as Record<string, unknown> | undefined;
  return (
    jsonSchema != null && typeof jsonSchema === "object" && typeof jsonSchema.input === "function"
  );
}

/**
 * Check if value looks like a JSON Schema (already converted).
 */
export function isJSONSchema(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  // JSON Schema typically has "type" or "$schema" or "properties"
  return (
    typeof obj.type === "string" ||
    typeof obj.$schema === "string" ||
    (typeof obj.properties === "object" && obj.properties !== null)
  );
}

/**
 * Detect the type of schema.
 */
export function detectSchemaType(value: unknown): SchemaType {
  if (value == null) return "unknown";

  // Check Zod 4 first (it's also a Standard Schema)
  if (isZod4Schema(value)) return "zod4";

  // Check Zod 3
  if (isZod3Schema(value)) return "zod3";

  // Check Standard JSON Schema (before regular Standard Schema)
  if (isStandardJSONSchema(value)) return "standard-json-schema";

  // Check Standard Schema
  if (isStandardSchema(value)) return "standard-schema";

  // Check if already JSON Schema
  if (isJSONSchema(value)) return "json-schema";

  return "unknown";
}

// ============================================================================
// Conversion
// ============================================================================

/**
 * Convert any supported schema to JSON Schema format.
 *
 * Supports:
 * - Zod 4 (uses z.toJSONSchema)
 * - Zod 3 (uses zodToJsonSchema if available, otherwise returns empty)
 * - Standard JSON Schema (uses ~standard.jsonSchema.input)
 * - Standard Schema (returns empty - no JSON Schema support)
 * - JSON Schema (pass through)
 *
 * @param schema - The schema to convert
 * @param options - Conversion options
 * @returns JSON Schema object
 */
export async function toJSONSchema(
  schema: unknown,
  options: ToJSONSchemaOptions = {},
): Promise<Record<string, unknown>> {
  const { target = "draft-2020-12", stripMeta = true } = options;

  if (schema == null) return {};

  const schemaType = detectSchemaType(schema);

  // Debug: log what type we detected
  if (schemaType === "unknown") {
    console.warn("[schema] Unknown schema type, input:", {
      type: typeof schema,
      hasStandard: schema && typeof schema === "object" && "~standard" in schema,
      hasDef: schema && typeof schema === "object" && "_def" in schema,
    });
  }

  let result: Record<string, unknown>;

  switch (schemaType) {
    case "zod4": {
      // Prefer Standard JSON Schema interface when available (Zod 4).
      try {
        const standard = (schema as Record<string, unknown>)["~standard"] as
          | Record<string, unknown>
          | undefined;
        if (
          standard?.jsonSchema &&
          typeof (standard.jsonSchema as Record<string, unknown>).input === "function"
        ) {
          result = (
            standard.jsonSchema as { input: (opts: { target: string }) => Record<string, unknown> }
          ).input({ target });
          break;
        }

        const schemaAny = schema as Record<string, unknown>;

        // If this doesn't look like a Zod 4 instance, fall back to zod-to-json-schema.
        if (typeof (schemaAny._zod as Record<string, unknown> | undefined)?.def === "undefined") {
          const zodToJsonSchemaModule = (await import("zod-to-json-schema")) as unknown as Record<
            string,
            unknown
          >;
          const zodToJsonSchema = (zodToJsonSchemaModule.zodToJsonSchema ??
            zodToJsonSchemaModule.default) as
            | ((schema: unknown, options?: Record<string, unknown>) => Record<string, unknown>)
            | undefined;

          if (typeof zodToJsonSchema === "function") {
            const targetKey = target ?? "draft-2020-12";
            const targetMap: Record<NonNullable<ToJSONSchemaOptions["target"]>, string> = {
              "draft-2020-12": "jsonSchema7",
              "draft-07": "jsonSchema7",
              "openapi-3.0": "openApi3",
            };
            result = zodToJsonSchema(schema, { target: targetMap[targetKey] });
            break;
          }
        }

        // Zod 4 instances expose toJSONSchema directly.
        if (typeof schemaAny.toJSONSchema === "function") {
          result = (
            schemaAny.toJSONSchema as (opts?: { target?: string }) => Record<string, unknown>
          )({ target });
          break;
        }

        // Fallback to Zod module-level conversion if available.
        const zod = await import("zod");
        if (
          typeof zod.toJSONSchema === "function" &&
          typeof (schemaAny._zod as Record<string, unknown> | undefined)?.def !== "undefined"
        ) {
          result = zod.toJSONSchema(schema as Parameters<typeof zod.toJSONSchema>[0], {
            target,
          }) as Record<string, unknown>;
          break;
        }

        console.warn("[schema] Zod toJSONSchema not available");
        result = {};
      } catch (err) {
        console.error("[schema] Failed to convert Zod 4 schema to JSON Schema:", err);
        const def = (schema as Record<string, unknown>)._def as Record<string, unknown> | undefined;
        console.error("[schema] Schema typeName:", def?.typeName);
        result = {};
      }
      break;
    }

    case "zod3": {
      // Zod 3 schemas require zod-to-json-schema to avoid Zod 4 runtime mismatch.
      try {
        const zodToJsonSchemaModule = (await import("zod-to-json-schema")) as unknown as Record<
          string,
          unknown
        >;
        const zodToJsonSchema = (zodToJsonSchemaModule.zodToJsonSchema ??
          zodToJsonSchemaModule.default) as
          | ((schema: unknown, options?: Record<string, unknown>) => Record<string, unknown>)
          | undefined;

        if (typeof zodToJsonSchema !== "function") {
          console.warn("[schema] zod-to-json-schema export not found");
          result = {};
          break;
        }

        const targetKey = target ?? "draft-2020-12";
        const targetMap: Record<NonNullable<ToJSONSchemaOptions["target"]>, string> = {
          "draft-2020-12": "jsonSchema7",
          "draft-07": "jsonSchema7",
          "openapi-3.0": "openApi3",
        };

        result = zodToJsonSchema(schema, { target: targetMap[targetKey] });
      } catch (err) {
        console.error("[schema] Failed to convert Zod 3 schema to JSON Schema:", err);
        const def = (schema as Record<string, unknown>)._def as Record<string, unknown> | undefined;
        console.error("[schema] Schema typeName:", def?.typeName);
        result = {};
      }
      break;
    }

    case "standard-json-schema": {
      // Standard Schema with JSON Schema support
      const standard = (schema as Record<string, unknown>)[
        "~standard"
      ] as StandardJSONSchemaV1Props;
      result = standard.jsonSchema.input({ target });
      break;
    }

    case "standard-schema": {
      // Standard Schema without JSON Schema support - can't convert
      console.warn(
        "Schema implements Standard Schema but not Standard JSON Schema - cannot convert to JSON Schema",
      );
      result = {};
      break;
    }

    case "json-schema": {
      // Already JSON Schema - pass through
      result = { ...(schema as Record<string, unknown>) };
      break;
    }

    default: {
      // Unknown - try to pass through if it's an object
      if (typeof schema === "object") {
        result = { ...(schema as Record<string, unknown>) };
      } else {
        result = {};
      }
    }
  }

  // Strip meta properties if requested
  if (stripMeta && result) {
    delete result["$schema"];
    delete result["additionalProperties"];
  }

  return result;
}

/**
 * Get the vendor name from a Standard Schema.
 */
export function getSchemaVendor(schema: unknown): string | undefined {
  if (schema == null || typeof schema !== "object") return undefined;
  const standard = (schema as Record<string, unknown>)["~standard"] as
    | Record<string, unknown>
    | undefined;
  if (!standard || typeof standard !== "object") return undefined;
  return standard.vendor as string | undefined;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * A validation issue from schema validation.
 */
export interface ValidationIssue {
  /** Human-readable error message */
  message: string;
  /** Path to the invalid value (e.g., ["user", "email"]) */
  path?: (string | number)[];
  /** Issue code/type if available */
  code?: string;
}

/**
 * Result of schema validation.
 */
export type ValidationResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; issues: ValidationIssue[] };

/**
 * Validate a value against any supported schema.
 *
 * Supports:
 * - Zod 3 and Zod 4 (uses safeParse)
 * - Standard Schema (uses ~standard.validate)
 *
 * @param schema - The schema to validate against
 * @param value - The value to validate
 * @returns Validation result with data or issues
 *
 * @example
 * ```typescript
 * const result = await validateSchema(mySchema, userInput);
 * if (result.success) {
 *   console.log("Valid:", result.data);
 * } else {
 *   console.log("Errors:", result.issues);
 * }
 * ```
 */
export async function validateSchema<T = unknown>(
  schema: unknown,
  value: unknown,
): Promise<ValidationResult<T>> {
  if (schema == null) {
    return { success: false, issues: [{ message: "Schema is null or undefined" }] };
  }

  const schemaType = detectSchemaType(schema);

  switch (schemaType) {
    case "zod3":
    case "zod4": {
      // Zod schemas have safeParse method
      const zodSchema = schema as { safeParse: (v: unknown) => unknown };
      if (typeof zodSchema.safeParse !== "function") {
        return { success: false, issues: [{ message: "Schema missing safeParse method" }] };
      }

      const result = zodSchema.safeParse(value) as
        | { success: true; data: T }
        | {
            success: false;
            error: { issues: Array<{ message: string; path: (string | number)[]; code?: string }> };
          };

      if (result.success) {
        return { success: true, data: result.data };
      }

      // Convert Zod errors to our format
      const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path,
        code: issue.code,
      }));

      return { success: false, issues };
    }

    case "standard-schema":
    case "standard-json-schema": {
      // Standard Schema uses ~standard.validate
      const standard = (schema as Record<string, unknown>)["~standard"] as {
        validate: (v: unknown) => unknown | Promise<unknown>;
      };

      if (typeof standard?.validate !== "function") {
        return { success: false, issues: [{ message: "Schema missing validate method" }] };
      }

      // Standard Schema validate can be sync or async
      const result = (await Promise.resolve(standard.validate(value))) as
        | { value: T }
        | { issues: Array<{ message: string; path?: (string | number)[] }> };

      // Standard Schema returns { value } on success, { issues } on failure
      if ("value" in result) {
        return { success: true, data: result.value };
      }

      if ("issues" in result && Array.isArray(result.issues)) {
        const issues: ValidationIssue[] = result.issues.map((issue) => ({
          message: issue.message,
          path: issue.path,
        }));
        return { success: false, issues };
      }

      // Unexpected result format
      return { success: false, issues: [{ message: "Unexpected validation result format" }] };
    }

    case "json-schema": {
      // JSON Schema validation would require a validator like Ajv
      // Return a helpful error suggesting what to do
      return {
        success: false,
        issues: [
          {
            message:
              "JSON Schema validation requires a validator library (e.g., Ajv). " +
              "Consider using a schema library like Zod that supports Standard Schema.",
          },
        ],
      };
    }

    default: {
      return {
        success: false,
        issues: [{ message: `Unknown schema type: cannot validate` }],
      };
    }
  }
}

/**
 * Validate a value against a schema, throwing on failure.
 *
 * @param schema - The schema to validate against
 * @param value - The value to validate
 * @returns The validated value
 * @throws Error with validation issues if validation fails
 */
export async function parseSchema<T = unknown>(schema: unknown, value: unknown): Promise<T> {
  const result = await validateSchema<T>(schema, value);

  if (result.success) {
    return result.data;
  }

  const message = result.issues
    .map((i) => {
      const path = i.path?.length ? `${i.path.join(".")}: ` : "";
      return `${path}${i.message}`;
    })
    .join("; ");

  throw new Error(`Validation failed: ${message}`);
}
