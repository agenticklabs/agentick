export { MCPServer, SessionNotFoundError } from "./server.js";

// Elicitation — sugar errors and capability helpers
export {
  ElicitationDeclined,
  ElicitationCancelled,
  ElicitationModeNotSupported,
  inspectElicitationCapabilities,
  validateFormSchemaFlatness,
} from "./elicitation.js";

// Security — defaults
export {
  localOnlyGuard,
  rejectAllAuth,
  allowAllGuard,
  allowAllAuth,
  allowAllAuthz,
  allowAllRateLimit,
  passthroughSanitizer,
  resolveSecurityDefaults,
} from "./security/index.js";

export { SecurityError } from "./security/index.js";

// Security — production stages
export {
  bearerTokenAuth,
  roleBasedAuthz,
  slidingWindowLimiter,
  allowListGuard,
  pathTraversalSanitizer,
  type BearerTokenAuthOptions,
  type RoleBasedAuthzOptions,
  type SlidingWindowLimiterOptions,
  type AllowListGuardOptions,
  type PathTraversalSanitizerOptions,
} from "./security/index.js";
