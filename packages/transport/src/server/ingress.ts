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

import type { AuthSource, IngressAdmissionFailure, IngressContext } from "@agentick/spec";

/**
 * Report a REFUSED crossing (ADR 92 §Family 1.3). The helper builds the
 * failure from what the crossing itself carries; the edge supplies this
 * callback, enriches with whatever else it knows (a peer address), and
 * publishes it on its host's bus via `DispatchHost.emitAdmissionFailure`.
 *
 * A callback rather than a host reference on purpose: the helper stays a pure
 * function of its inputs — testable with a recording callback, with no bus, no
 * gateway, and no knowledge of where the report lands.
 */
export type IngressRejectionReporter = (failure: IngressAdmissionFailure) => void;

/**
 * Run ingress authentication for one crossing and return the enriched
 * context (with `identity` set when an AuthSource ran and admitted the
 * caller; left undefined for the local pole).
 *
 * Throws whatever the `AuthSource` throws — fail-closed. The caller
 * (transport edge) maps the throw to its native rejection, and `onRejected`
 * (when supplied) sees the refusal first so the audit trail records the
 * attempt. The report is a side-channel: it never alters admission, and a
 * throwing reporter is nobody's problem but its own (it propagates — a
 * reporter that throws is a bug at the edge, not a silent condition).
 */
export async function authenticateIngress(
  context: IngressContext,
  authSource?: AuthSource,
  onRejected?: IngressRejectionReporter,
): Promise<IngressContext> {
  // No AuthSource → local/trusted pole. No principal stamped.
  if (!authSource) return context;

  // Configured AuthSource → run it. A rejection propagates (fail
  // closed); we deliberately do NOT catch-and-continue.
  try {
    const identity = await authSource.authenticate(context.credential);
    return { ...context, identity };
  } catch (cause) {
    if (onRejected) {
      const reason = admissionReason(cause);
      // NEVER `context.credential` — not the token, not the header bag.
      onRejected({
        failureClass: "authenticate",
        transportKind: context.transportKind,
        ...(context.connectionId !== undefined ? { connectionId: context.connectionId } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
    }
    throw cause;
  }
}

/**
 * Reduce a rejection to a short string for the audit event. An `Error`
 * contributes only its message; anything else is stringified.
 */
function admissionReason(cause: unknown): string | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
