/**
 * Bundled `Authorizer` implementations (ADR 51 §4.2).
 *
 * The triad: enforcement point (wire dispatch) is the framework's
 * opinion; the `Authorizer` port is the protocol; the POLICY is the
 * adopter's. These two cover the poles:
 *
 *   - `staticAuthorizer({ grants })` — principal → scope-pattern list.
 *     Covers the local pole and most cloud deployments.
 *   - `permissiveAuthorizer()` — explicit opt-in for no-auth local
 *     deployments.
 *
 * Unconfigured gateways get `unconfiguredAuthorizer`: allow only when
 * `principal` is undefined (graceful two-pole degradation, §4.2) —
 * an authenticated principal against an unconfigured policy is DENIED
 * (deny-by-default, §4.3).
 */

import type { AuthorizeInput, AuthorizeResult, Authorizer } from "@agentick/spec-next";

/** Scope patterns: exact (`"timeline:compact"`), surface glob (`"timeline:*"`), or `"*"`. */
function matchesScope(pattern: string, scope: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(":*")) return scope.startsWith(pattern.slice(0, -1));
  return pattern === scope;
}

/**
 * Same-principal target rule (ADR 48 fusion rule): when the target
 * scope carries a principal, it must equal the caller's. Elevation is
 * a grant concern (`"*"` or an explicit cross-principal pattern is
 * still subject to this rule today; a dedicated elevation scope is a
 * follow-up).
 */
function sameTarget(input: AuthorizeInput): boolean {
  const targetPrincipal = input.target?.principal;
  if (targetPrincipal === undefined) return true;
  return targetPrincipal === input.principal;
}

export interface StaticAuthorizerOptions {
  /** principal → allowed scope patterns. Deny-by-default for absent principals. */
  readonly grants: Readonly<Record<string, readonly string[]>>;
  /**
   * Grants applied to UNAUTHENTICATED callers (`principal` undefined).
   * Default: none — unauthenticated callers are denied everything.
   */
  readonly anonymous?: readonly string[];
}

export function staticAuthorizer(options: StaticAuthorizerOptions): Authorizer {
  return {
    backend: "static",
    authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
      if (!sameTarget(input)) {
        return Promise.resolve({ allowed: false, reason: "target-principal-mismatch" });
      }
      const patterns =
        input.principal !== undefined
          ? (options.grants[input.principal] ?? [])
          : (options.anonymous ?? []);
      const allowed = patterns.some((p) => matchesScope(p, input.scope));
      return Promise.resolve(allowed ? { allowed } : { allowed, reason: "no-grant" });
    },
  };
}

/** Allow everything. EXPLICIT opt-in for no-auth local deployments. */
export function permissiveAuthorizer(): Authorizer {
  return {
    backend: "permissive",
    authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
      return Promise.resolve(
        sameTarget(input)
          ? { allowed: true }
          : { allowed: false, reason: "target-principal-mismatch" },
      );
    },
  };
}

/**
 * The default when no authorizer is configured: allow only
 * unauthenticated callers (the local pole); deny any authenticated
 * principal — auth without policy is a misconfiguration, and
 * deny-by-default is the posture (§4.3).
 */
export function unconfiguredAuthorizer(): Authorizer {
  return {
    backend: "unconfigured",
    authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
      if (input.principal !== undefined) {
        return Promise.resolve({ allowed: false, reason: "authorizer-unconfigured" });
      }
      return Promise.resolve(
        sameTarget(input)
          ? { allowed: true }
          : { allowed: false, reason: "target-principal-mismatch" },
      );
    },
  };
}
