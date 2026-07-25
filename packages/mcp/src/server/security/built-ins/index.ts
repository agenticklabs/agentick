/**
 * `@agentick/mcp/server/security/built-ins` — production-ready
 * security stages.
 *
 * All four port from v1 `packages/mcp/src/server/security/stages.ts`
 * with v2 type substitutions. v1's stages were thoroughly tested and
 * shipped to production; v2 preserves their behavior exactly.
 *
 * @see docs/proposals/v2/blueprint/40-mcp-server-harness.md §5
 */

export { allowListGuard, type AllowListGuardOptions } from "./allow-list.js";
export { bearerTokenAuth, type BearerTokenAuthOptions } from "./bearer.js";
export { roleBasedAuthz, type RoleBasedAuthzOptions } from "./role-based-authz.js";
export { slidingWindowLimiter, type SlidingWindowLimiterOptions } from "./sliding-window.js";
