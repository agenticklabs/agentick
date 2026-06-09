/**
 * Validator implementations + adapters.
 *
 * The tool executor accepts any object satisfying the {@link Validator}
 * interface from `./types`. Two helpers are provided:
 *
 * - {@link permissiveValidator} accepts anything. Useful for tools
 *   whose schema authoring is deferred (e.g., bridge-from-MCP) or for
 *   tests that don't care about input shape.
 *
 * - {@link fromStandardSchema} wraps any
 *   {@link import("@agentick/spec-next").StandardSchemaV1} into a Validator.
 *   This covers Zod, Valibot, ArkType, Effect Schema, and any other
 *   library that implements Standard Schema v1.
 */

import type { StandardSchemaV1 } from "@agentick/spec-next";
import type { Validator, ValidatorResult } from "./types.js";

/**
 * A validator that accepts every input unchanged.
 */
export const permissiveValidator: Validator = {
  validate(value: unknown): ValidatorResult {
    return { value };
  },
};

/**
 * Adapt a {@link StandardSchemaV1} to the {@link Validator} interface.
 * The returned object delegates to the schema's `~standard.validate`,
 * preserving async behavior.
 */
export function fromStandardSchema<I, O>(schema: StandardSchemaV1<I, O>): Validator {
  return {
    validate(value: unknown): ValidatorResult | Promise<ValidatorResult> {
      const result = schema["~standard"].validate(value);
      // The Standard Schema result is structurally the same as
      // ValidatorResult — return verbatim (sync or thenable).
      return result as ValidatorResult | Promise<ValidatorResult>;
    },
  };
}
