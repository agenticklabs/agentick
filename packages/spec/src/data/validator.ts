/**
 * `Validator` shape — the minimal interface the tool executor uses to
 * gate handler input. Mirrors `StandardSchemaV1.validate()` so impls
 * can wrap a Standard Schema through directly.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

import type { StandardSchemaIssue } from "./standard-schema.js";

export type ValidatorResult =
  | { readonly value: unknown; readonly issues?: undefined }
  | { readonly value?: undefined; readonly issues: readonly StandardSchemaIssue[] };

export interface Validator {
  validate(value: unknown): ValidatorResult | Promise<ValidatorResult>;
}
