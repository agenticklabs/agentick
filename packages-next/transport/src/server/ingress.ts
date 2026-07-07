/**
 * Shared ingress-authentication helper (ADR 61 slice 1).
 *
 * Every transport edge (ws / http / unix) — and, in slice 2, connectors
 * — builds an {@link IngressContext} from its native credential and runs
 * it through this one helper. Slice 1 is the degenerate single-interceptor
 * form: call the configured {@link AuthSource} directly. Slice 3
 * (`GatewayInstaller.interceptIngress`) generalizes this into the
 * installed chain-of-responsibility; the edges keep calling one function.
 *
 * The rules (ADR 61 §"Default posture" + §"Security invariants"):
 *
 *   - **No `AuthSource` configured → the local/trusted pole.** The
 *     crossing carries NO principal (`identity` stays undefined); it is
 *     admitted. Pairs with the gateway's unconfigured/permissive
 *     Authorizer for dev / single-tenant hosts.
 *   - **`AuthSource` configured → run it, FAIL CLOSED.** A throw
 *     propagates to the edge (mapped to 401 / drop). The helper NEVER
 *     catches an auth failure and falls through to the local pole.
 *   - **Enrichment-only.** The helper stamps identity; it NEVER
 *     authorizes. Authorization is the Authorizer's job at dispatch.
 *
 * @see docs/proposals/v2/blueprint/61-ingress-authentication.md
 */

import type { AuthSource, IngressContext } from "@agentick/spec-next";

/**
 * Run ingress authentication for one crossing and return the enriched
 * context (with `identity` set when an AuthSource ran and admitted the
 * caller; left undefined for the local pole).
 *
 * Throws whatever the `AuthSource` throws — fail-closed. The caller
 * (transport edge) maps the throw to its native rejection.
 */
export async function authenticateIngress(
  context: IngressContext,
  authSource?: AuthSource,
): Promise<IngressContext> {
  // No AuthSource → local/trusted pole. No principal stamped.
  if (!authSource) return context;

  // Configured AuthSource → run it. A rejection propagates (fail
  // closed); we deliberately do NOT catch-and-continue.
  const identity = await authSource.authenticate(context.credential);
  return { ...context, identity };
}
