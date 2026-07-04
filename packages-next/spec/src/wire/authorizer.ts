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
