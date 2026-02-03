/**
 * Schema utilities - re-exported from @tentickle/kernel
 *
 * @see @tentickle/kernel/schema for implementation
 */
export {
  // Types
  type StandardSchemaV1Props,
  type StandardJSONSchemaV1Props,
  type SchemaType,
  type ToJSONSchemaOptions,
  type ValidationIssue,
  type ValidationResult,
  // Detection
  isZod4Schema,
  isZod3Schema,
  isStandardSchema,
  isStandardJSONSchema,
  isJSONSchema,
  detectSchemaType,
  // Conversion
  toJSONSchema,
  getSchemaVendor,
  // Validation
  validateSchema,
  parseSchema,
} from "@tentickle/kernel";
