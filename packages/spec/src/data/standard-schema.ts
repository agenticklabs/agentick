/**
 * Standard Schema v1 — minimal types-only interface for cross-validator
 * tool input schemas.
 *
 * Inlined (~30 LOC) to preserve `@agentick/spec`'s zero-dependency
 * claim. The upstream package `@standard-schema/spec` provides the same
 * shape; if we ever depend on it directly, this file can be removed
 * and replaced with a re-export.
 *
 * Validators that implement Standard Schema (Zod, Valibot, ArkType,
 * Effect Schema, etc.) all satisfy this interface, allowing tool
 * authors to bring their preferred validator.
 *
 * @see https://github.com/standard-schema/standard-schema
 */

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
  ) =>
    | StandardSchemaResult<Output>
    | Promise<StandardSchemaResult<Output>>;
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
