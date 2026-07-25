/**
 * Validator helpers — local duplicates of the same impls in
 * `@agentick/tool-executor/validator`. The two packages are peers
 * (both consume `@agentick/spec`); duplicating the 15 lines avoids a
 * cross-dependency that would pull the runtime harness into authoring
 * code.
 *
 * These should stay byte-for-byte equivalent to the tool-executor
 * versions. The Validator + ValidatorResult + StandardSchemaV1
 * types they target are spec-owned.
 */

import type { StandardSchemaV1, Validator, ValidatorResult } from "@agentick/spec";

/** A validator that accepts every input unchanged. */
export const permissiveValidator: Validator = {
  validate(value: unknown): ValidatorResult {
    return { value };
  },
};

/**
 * Adapt a `StandardSchemaV1` to the `Validator` interface. Covers
 * Zod, Valibot, ArkType, Effect Schema, and any other library that
 * implements Standard Schema v1.
 */
export function fromStandardSchema<I, O>(schema: StandardSchemaV1<I, O>): Validator {
  return {
    validate(value: unknown): ValidatorResult | Promise<ValidatorResult> {
      const result = schema["~standard"].validate(value);
      return result as ValidatorResult | Promise<ValidatorResult>;
    },
  };
}
