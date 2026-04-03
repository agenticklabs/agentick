/**
 * Authentication utilities for @agentick/server
 *
 * Provides standalone auth functions that can be used by Gateway
 * and framework adapters.
 *
 * @module @agentick/server/auth
 */

import type { UserContext } from "@agentick/kernel";

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
   * The protected resource URL (RFC 9728).
   * Included in the `WWW-Authenticate: Bearer resource="..."` header on 401 responses,
   * allowing MCP/OAuth clients to discover the authorization server via
   * `/.well-known/oauth-protected-resource`.
   */
  resource?: string;

  /**
   * Hydrate user context after validation.
   * Called with the auth result - fetch additional data from DB, etc.
   * Return the complete UserContext that will be available in methods.
   */
  hydrateUser?: (authResult: AuthResult) => Promise<UserContext>;

  /**
   * Authorize access to a session after authentication.
   * Called before any session-accessing operation (send, subscribe, tool-response, abort, close).
   * Return true to allow, false to deny (403).
   *
   * If not provided, all authenticated users can access all sessions.
   */
  authorizeSession?: (
    user: UserContext,
    sessionId: string,
    action: "send" | "subscribe" | "tool-response" | "abort" | "close" | "channel",
  ) => Promise<boolean>;
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
      validate: (token: string | undefined) => Promise<AuthResult>;
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
/**
 * Build the WWW-Authenticate header value for 401 responses.
 * Includes the `resource` parameter per RFC 9728 when configured,
 * enabling MCP/OAuth clients to discover the authorization server.
 */
export function wwwAuthenticateHeader(config: AuthConfig | undefined): string {
  const resource = config && "resource" in config ? config.resource : undefined;
  return resource ? `Bearer resource="${resource}"` : "Bearer";
}

export async function validateAuth(
  token: string | undefined,
  config: AuthConfig | undefined,
): Promise<AuthResult> {
  // No auth configured
  if (!config || config.type === "none") {
    return { valid: true };
  }

  // Token required but not provided (custom validators handle undefined themselves)
  if (!token && config.type !== "custom") {
    return { valid: false };
  }

  let result: AuthResult;

  if (config.type === "token") {
    result = { valid: token === config.token };
  } else if (config.type === "custom") {
    result = await config.validate(token);
  } else if (config.type === "jwt") {
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
