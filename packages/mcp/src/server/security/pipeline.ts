/**
 * Connection-level admission.
 *
 * `evaluateConnectionGuard(security, info)` runs once per transport
 * connection, BEFORE the `mcp:command:initialize` crossing op — a refused
 * connection is admission, not work (ADR 92 §Family 1.3). Trusted transports
 * (stdio, in-memory) skip the guard.
 *
 * The four PER-REQUEST stages no longer live here. ADR 92 §Slice A mapped
 * them onto the crossing op's seams: `Authenticator` runs pre-op inside
 * `runCrossing` (admission), and `Authorizer` / `RateLimiter` /
 * `InputSanitizer` are interceptors on the crossing's guard seam — see
 * `securityStageInterceptors` in `../projection/crossing.ts`. There is ONE
 * enforcement path; the staged `auth: {...}` config is sugar over it.
 *
 * Each rejection still throws its `McpServerError` subclass, which the
 * transport layer maps to the HTTP-equivalent JSON-RPC code:
 *
 *   McpServerConnectionRejected  →  403  (-32000)
 *   McpServerAuthRejected        →  401
 *   McpServerAuthzDenied         →  403
 *   McpServerRateLimited         →  429  (Retry-After)
 */

import type { McpServerError } from "@agentick/spec";
import {
  McpServerAuthRejected,
  McpServerAuthzDenied,
  McpServerConnectionRejected,
  McpServerRateLimited,
} from "@agentick/spec";

import type { McpConnectionInfo, ResolvedSecurity } from "./stages.js";

/** Trusted transport kinds — `ConnectionGuard` skipped. */
const TRUSTED_TRANSPORTS = new Set<string>(["stdio", "in-memory"]);

/**
 * Evaluate connection-level acceptance. Returns when accepted; throws
 * `McpServerConnectionRejected` when rejected. Trusted transports
 * short-circuit to accept without consulting the guard.
 */
export async function evaluateConnectionGuard(
  security: ResolvedSecurity,
  info: McpConnectionInfo,
): Promise<void> {
  if (TRUSTED_TRANSPORTS.has(info.transportKind)) return;
  const accepted = await security.connectionGuard(info);
  if (!accepted) {
    throw new McpServerConnectionRejected({
      reason: `Connection rejected from ${info.origin ?? info.remoteAddress ?? "unknown"}`,
    });
  }
}

/**
 * Type guard for security-pipeline rejections — useful at catch sites
 * that need to distinguish security errors from other thrown values.
 * Matches the four concrete classes the pipeline throws.
 */
export function isMcpSecurityError(value: unknown): value is McpServerError {
  return (
    value instanceof McpServerConnectionRejected ||
    value instanceof McpServerAuthRejected ||
    value instanceof McpServerAuthzDenied ||
    value instanceof McpServerRateLimited
  );
}
