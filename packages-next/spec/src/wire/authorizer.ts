/**
 * `Authorizer` — the identity-authorization port (ADR 51 §4.2).
 *
 * ONE enforcement point: wire dispatch, before a wire command becomes
 * an inbox message. Harnesses are authz-unaware, permanently —
 * in-harness checks are the runtime-filter anti-pattern ADR 47/48
 * killed.
 *
 * Triad: the enforcement point is the framework's opinion; this port is
 * the protocol; the policy is the adopter's. Promise-shaped — zero
 * Effect at the adopter edge.
 *
 * Grant DERIVATION (OAuth scope claims, ingress-verified declarations)
 * is ADR 34's AuthSource concern; the Authorizer consumes grants
 * regardless of issuance.
 */

import type { EventScope } from "../data/events.js";

export interface AuthorizeInput {
  /**
   * Authenticated caller identity, stamped at ingress. Undefined on
   * unauthenticated connections (the local pole).
   */
  readonly principal?: string;
  /**
   * Scope label — the canonical verb by default (`"timeline:compact"`).
   * Named porcelain methods default to their underlying verb's label
   * (ADR 51 §3.3 anti-bypass rule): grants are written once and cover
   * both lanes.
   */
  readonly scope: string;
  /**
   * Target scope for the target rule. Default rule: same-principal —
   * the target session's `principal` must equal the caller's (ADR 48
   * fusion rule); elevation via grants.
   */
  readonly target?: EventScope;
}

export interface AuthorizeResult {
  readonly allowed: boolean;
  /** Optional machine-readable denial reason (never leaks to clients verbatim). */
  readonly reason?: string;
}

export interface Authorizer {
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  /** Self-identifying label for observability (`"static"`, `"permissive"`). */
  readonly backend: string;
}

/**
 * Identity established at the transport ingress edge (ADR 51 §4.1 /
 * ADR 34). Authentication happens ONCE per connection (or per request
 * on stateless transports); the identity is stamped structurally from
 * there — `WireExtensionContext.principal` for wire dispatch, scope
 * principal for downstream provenance.
 */
export interface IngressIdentity {
  readonly principal?: string;
  /** Adopter-shaped user record (RuntimeContextUser concern, ADR 34). */
  readonly user?: Readonly<Record<string, unknown>>;
  /**
   * Scope grants carried by the credential (OAuth-style claims).
   * Grant DERIVATION input — an Authorizer may consume these instead
   * of (or layered over) a static grants table.
   */
  readonly scopes?: readonly string[];
}

/**
 * `AuthSource` — transport token → identity (ADR 34). Runs at the
 * ingress edge, once per connection/request. Promise-shaped. Throwing
 * REJECTS the connection/request (authentication failure); returning
 * `{}` admits an anonymous (local-pole) caller.
 */
export interface AuthSource {
  authenticate(input: {
    /** Bearer credential extracted by the transport (header, query, subprotocol). */
    readonly token?: string;
    /** Raw transport headers, for adopter schemes beyond bearer tokens. */
    readonly headers?: Readonly<Record<string, string | undefined>>;
  }): Promise<IngressIdentity>;
  readonly backend: string;
}
