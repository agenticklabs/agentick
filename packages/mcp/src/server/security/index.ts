// Security defaults
export {
  localOnlyGuard,
  rejectAllAuth,
  allowAllGuard,
  allowAllAuth,
  allowAllAuthz,
  allowAllRateLimit,
  passthroughSanitizer,
  resolveSecurityDefaults,
  type ResolvedSecurity,
  type SecurityConfig,
} from "./defaults.js";

// Security pipeline
export {
  SecurityError,
  evaluateConnectionGuard,
  buildRequestContext,
  evaluateRequestPipeline,
} from "./pipeline.js";

// Production stages
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
} from "./stages.js";
