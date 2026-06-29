/**
 * `bearerTokenAuth` — bearer-token `Authenticator` stage.
 *
 * Reads `Authorization: Bearer <token>` from `ctx.metadata.headers`
 * (transport-supplied, case-insensitive). Looks up against a static
 * map OR delegates to a custom `verify(token)` callback (JWT decode,
 * OAuth introspection, DB lookup, ...).
 *
 * Ported from v1 `packages/mcp/src/server/security/stages.ts`.
 */

import type { McpAuthenticatedUser, McpRequestContext } from "@agentick/spec-next";

import type { Authenticator } from "../stages.js";

export interface BearerTokenAuthOptions {
  /**
   * Static token → user map. Matches by exact string equality.
   * Convenient for tests + small deployments; use `verify` for real
   * production setups.
   */
  readonly tokens?: Readonly<Record<string, McpAuthenticatedUser>>;
  /**
   * Custom token resolver. Called when the bearer token isn't in the
   * static map; returns the authenticated user or `null` to reject.
   * Use for JWT decode, introspection endpoints, etc.
   */
  readonly verify?: (token: string, ctx: McpRequestContext) => Promise<McpAuthenticatedUser | null>;
  /**
   * Header extraction override. Default reads `Authorization` from
   * `ctx.metadata.headers` (case-insensitive). Adopters with non-
   * standard transport-supplied identity material override here.
   */
  readonly extract?: (ctx: McpRequestContext) => string | undefined;
}

export function bearerTokenAuth(options: BearerTokenAuthOptions = {}): Authenticator {
  const tokens = options.tokens ?? {};
  const extract = options.extract ?? defaultExtractBearer;

  return async (ctx) => {
    const token = extract(ctx);
    if (!token) {
      return { authenticated: false, reason: "Missing or invalid Authorization header" };
    }
    const staticUser = tokens[token];
    if (staticUser) {
      return { authenticated: true, user: staticUser };
    }
    if (options.verify) {
      const verified = await options.verify(token, ctx);
      if (verified) return { authenticated: true, user: verified };
    }
    return { authenticated: false, reason: "Invalid token" };
  };
}

function defaultExtractBearer(ctx: McpRequestContext): string | undefined {
  const headers = (ctx.metadata as { headers?: Readonly<Record<string, string | undefined>> })
    .headers;
  if (!headers) return undefined;
  // Case-insensitive lookup.
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization" && typeof value === "string") {
      const match = value.match(/^Bearer\s+(.+)$/i);
      return match ? match[1]?.trim() : undefined;
    }
  }
  return undefined;
}
