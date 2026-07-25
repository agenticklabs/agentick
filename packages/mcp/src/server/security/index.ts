/**
 * `@agentick/mcp/server/security` — security pipeline + stages.
 *
 *   pipeline.ts       — runner + `SecurityError`
 *   stages.ts         — `ConnectionGuard` / `Authenticator` / ... signatures + result types
 *   defaults.ts       — transport-aware defaults + `resolveSecurity()`
 *   built-ins/        — production-ready stages (bearer, roleBased, slidingWindow, allowList)
 *
 * @see docs/proposals/v2/blueprint/40-mcp-server-harness.md §5
 */

export {
  evaluateConnectionGuard,
  evaluateRequestPipeline,
  isMcpSecurityError,
} from "./pipeline.js";
export {
  type AuthnResult,
  type Authenticator,
  type Authorizer,
  type AuthzResult,
  type ConnectionGuard,
  type InputSanitizer,
  type McpConnectionInfo,
  type OperationInfo,
  type RateLimitResult,
  type RateLimiter,
  type ResolvedSecurity,
} from "./stages.js";
export {
  allowAllAuth,
  allowAllAuthz,
  allowAllGuard,
  allowAllRateLimit,
  localOnlyGuard,
  passthroughSanitizer,
  rejectAllAuth,
  resolveSecurity,
} from "./defaults.js";
export * from "./built-ins/index.js";
