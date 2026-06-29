/**
 * Transport-aware default stages + config resolution.
 *
 *   stdio / in-memory  →  allowAll guard, allowAll authn, allowAll authz, no limit, passthrough sanitizer
 *   HTTP / WebSocket   →  localOnly guard, REJECT-ALL authn (forces explicit config), allowAll authz, no limit, passthrough sanitizer
 *
 * The HTTP/WS authn default is deliberately `rejectAll`: refusing
 * unauthenticated requests is the safe default on a network port. The
 * framework will not silently expose internal tools.
 */

import type {
  Authenticator,
  Authorizer,
  ConnectionGuard,
  InputSanitizer,
  RateLimiter,
  ResolvedSecurity,
} from "./stages.js";
import type { McpServerAuthConfig } from "@agentick/spec-next";

const TRUSTED_TRANSPORTS = new Set<string>(["stdio", "in-memory"]);

/** Accepts every connection. Default for trusted transports. */
export const allowAllGuard: ConnectionGuard = async () => true;

/**
 * Accepts only loopback addresses (`127.0.0.1`, `::1`,
 * `::ffff:127.0.0.1`). Default for HTTP/WS until adopter overrides.
 */
export const localOnlyGuard: ConnectionGuard = async (info) => {
  const addr = info.remoteAddress;
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
};

export const allowAllAuth: Authenticator = async () => ({
  authenticated: true,
  user: { id: "anonymous" },
});

/**
 * Rejects every request. Default for HTTP/WS — adopters MUST supply an
 * explicit `authenticator` before the server will serve traffic.
 */
export const rejectAllAuth: Authenticator = async () => ({
  authenticated: false,
  reason: "Authentication required — configure an authenticator (e.g., bearerTokenAuth)",
});

export const allowAllAuthz: Authorizer = async () => ({ allowed: true });

export const allowAllRateLimit: RateLimiter = async () => ({ allowed: true });

export const passthroughSanitizer: InputSanitizer = async (_ctx, _toolName, input) => ({
  ...input,
});

/**
 * Resolve adopter-supplied {@link McpServerAuthConfig} against the
 * transport-aware defaults. Returns a fully-populated
 * {@link ResolvedSecurity}.
 *
 * The caller passes the PRIMARY transport kind — for servers with
 * multiple transports of mixed trust, the harness chooses defaults
 * conservatively (any HTTP/WS transport in the list → reject-all).
 */
export function resolveSecurity(
  auth: McpServerAuthConfig | undefined,
  transportKinds: readonly string[],
): ResolvedSecurity {
  const allTrusted = transportKinds.every((kind) => TRUSTED_TRANSPORTS.has(kind));

  return {
    connectionGuard:
      (auth?.connectionGuard as ConnectionGuard | undefined) ??
      (allTrusted ? allowAllGuard : localOnlyGuard),
    authenticator:
      (auth?.authenticator as Authenticator | undefined) ??
      (allTrusted ? allowAllAuth : rejectAllAuth),
    authorizer: (auth?.authorizer as Authorizer | undefined) ?? allowAllAuthz,
    rateLimiter: (auth?.rateLimiter as RateLimiter | undefined) ?? allowAllRateLimit,
    inputSanitizer: (auth?.inputSanitizer as InputSanitizer | undefined) ?? passthroughSanitizer,
  };
}
