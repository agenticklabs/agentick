/**
 * The `as()` stance — identity-scoped views over harnesses.
 *
 * Every harness carries a construction-bound `principal` (ADR 48, the identity
 * axis of its structural identity); `as(identity)` is that axis's dynamic
 * counterpart: a per-call stance saying "run this AS an authenticated
 * identity". The stance is declared at the base (`BaseHarness.as`) the same
 * way `hook()` is — universal — but the SURFACE a scoped view exposes is each
 * harness's own: an app scopes session creation, a gateway scopes app
 * resolution behind its wire seam, a harness with no identity-meaningful verbs
 * exposes nothing beyond the binding itself.
 *
 * This root is deliberately minimal: the one thing every scoped view shares is
 * WHICH identity it is bound to. Concrete surfaces (`IdentityScopedApp`,
 * `IdentityScopedGateway`) extend it and covariantly narrow the harness's
 * `as()` return type.
 *
 * @see docs/proposals/v2/blueprint/100-identity-scoped-dispatch.md
 */

import type { IngressIdentity } from "../wire/authorizer.js";

export interface IdentityScoped {
  /** The identity this view is bound to — the authority for everything it runs. */
  readonly identity: IngressIdentity;
}
