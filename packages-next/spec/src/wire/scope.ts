/**
 * Subscription scope — the wire-side discriminator identifying which
 * server-side resource a subscription targets.
 *
 * Distinct from `EventScope` (which appears ON every event envelope to
 * record the runtime coordinates the event originated from).
 * `SubscriptionScope` selects which scope's events to receive.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md §"Wire protocol"
 */

export type SubscriptionScope =
  | { readonly kind: "gateway" }
  | { readonly kind: "app"; readonly id: string }
  | { readonly kind: "session"; readonly id: string };

export function isGatewayScope(s: SubscriptionScope): s is { kind: "gateway" } {
  return s.kind === "gateway";
}

export function isAppScope(
  s: SubscriptionScope,
): s is { kind: "app"; id: string } {
  return s.kind === "app";
}

export function isSessionScope(
  s: SubscriptionScope,
): s is { kind: "session"; id: string } {
  return s.kind === "session";
}
