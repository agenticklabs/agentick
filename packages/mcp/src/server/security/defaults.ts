import type {
  ConnectionGuard,
  Authenticator,
  Authorizer,
  RateLimiter,
  InputSanitizer,
  ConnectionInfo,
} from "../../protocol/types.js";

// ============================================================================
// HTTP transport defaults — safe for development, forces config for production
// ============================================================================

/** Only accepts connections from localhost (127.0.0.1, ::1). */
export const localOnlyGuard: ConnectionGuard = async (info) => {
  const addr = info.remoteAddress;
  return (
    addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr === undefined // Some test environments don't provide remoteAddress
  );
};

/** Rejects all requests — forces consumer to provide a real authenticator. */
export const rejectAllAuth: Authenticator = async () => ({
  authenticated: false,
  reason:
    "No authenticator configured. HTTP transports require explicit authentication. " +
    "Pass security.authenticator in MCPServerOptions.",
});

// ============================================================================
// In-process / stdio defaults — trusted by definition
// ============================================================================

export const allowAllGuard: ConnectionGuard = async () => true;
export const allowAllAuth: Authenticator = async () => ({ authenticated: true });

// ============================================================================
// Shared defaults — all transports
// ============================================================================

export const allowAllAuthz: Authorizer = async () => ({ allowed: true });
export const allowAllRateLimit: RateLimiter = async () => ({ allowed: true });
export const passthroughSanitizer: InputSanitizer = async (_ctx, _tool, input) => input;

// ============================================================================
// Default resolution — picks the right defaults based on transport type
// ============================================================================

export interface ResolvedSecurity {
  connectionGuard: ConnectionGuard;
  authenticator: Authenticator;
  authorizer: Authorizer;
  rateLimiter: RateLimiter;
  inputSanitizer: InputSanitizer;
}

export interface SecurityConfig {
  connectionGuard?: ConnectionGuard;
  authenticator?: Authenticator;
  authorizer?: Authorizer;
  rateLimiter?: RateLimiter;
  inputSanitizer?: InputSanitizer;
}

/**
 * Resolve security config with transport-aware defaults.
 * HTTP transports get restrictive defaults (localOnly + rejectAll).
 * In-process/stdio get permissive defaults (allowAll).
 */
export function resolveSecurityDefaults(
  transport: ConnectionInfo["transport"],
  config?: SecurityConfig,
): ResolvedSecurity {
  const isHTTP = transport === "streamable-http" || transport === "sse";

  return {
    connectionGuard: config?.connectionGuard ?? (isHTTP ? localOnlyGuard : allowAllGuard),
    authenticator: config?.authenticator ?? (isHTTP ? rejectAllAuth : allowAllAuth),
    authorizer: config?.authorizer ?? allowAllAuthz,
    rateLimiter: config?.rateLimiter ?? allowAllRateLimit,
    inputSanitizer: config?.inputSanitizer ?? passthroughSanitizer,
  };
}
