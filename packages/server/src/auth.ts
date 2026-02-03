/**
 * Authentication utilities for @tentickle/server
 *
 * Provides standalone auth functions that can be used by Gateway
 * and framework adapters.
 *
 * @module @tentickle/server/auth
 */

import type { UserContext } from "@tentickle/kernel";

/**
 * Result returned by auth validation.
 */
export interface AuthResult {
  valid: boolean;
  /** User context from token - may be hydrated further */
  user?: UserContext;
  /** Auth metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Base auth options available on all auth types.
 */
interface AuthBaseOptions {
  /**
   * Hydrate user context after validation.
   * Called with the auth result - fetch additional data from DB, etc.
   * Return the complete UserContext that will be available in methods.
   */
  hydrateUser?: (authResult: AuthResult) => Promise<UserContext>;
}

/**
 * Authentication configuration.
 */
export type AuthConfig =
  | ({ type: "none" } & AuthBaseOptions)
  | ({ type: "token"; token: string } & AuthBaseOptions)
  | ({ type: "jwt"; secret: string; issuer?: string } & AuthBaseOptions)
  | ({
      type: "custom";
      validate: (token: string) => Promise<AuthResult>;
    } & AuthBaseOptions);

/**
 * Extract auth token from a request.
 * Looks for Bearer token in Authorization header.
 */
export function extractToken(req: {
  headers?: { authorization?: string; [key: string]: string | string[] | undefined };
}): string | undefined {
  const auth = req.headers?.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return undefined;
}

/**
 * Validate an auth token against the configured auth method.
 */
export async function validateAuth(
  token: string | undefined,
  config: AuthConfig | undefined,
): Promise<AuthResult> {
  // No auth configured
  if (!config || config.type === "none") {
    return { valid: true };
  }

  // Token required but not provided
  if (!token) {
    return { valid: false };
  }

  let result: AuthResult;

  if (config.type === "token") {
    result = { valid: token === config.token };
  } else if (config.type === "custom") {
    result = await config.validate(token);
  } else if (config.type === "jwt") {
    // TODO: Implement JWT validation
    result = { valid: false };
  } else {
    result = { valid: false };
  }

  // Run hydrateUser hook if configured and auth succeeded
  if (result.valid && config.hydrateUser) {
    result.user = await config.hydrateUser(result);
  }

  return result;
}
