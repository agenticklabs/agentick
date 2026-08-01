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

/**
 * Which server-side resource a subscription observes. The kind names the SHAPE
 * of what you watch, which is why the living-subtree case is its own kind
 * rather than a flag on `session`: it is enumerable on the wire, and a client
 * reading back its own subscriptions can tell the two apart.
 *
 * - `session` — one session's own events. Nothing a sub-agent it spawned emits
 *   appears here; a channel event is scoped to the session that emitted it.
 * - `session-tree` — that session AND its live spawn subtree. The rung for
 *   watching work that outlives a turn: detached tasks and cross-turn
 *   sub-agents have no turn stream to ride, so a client attached to the root
 *   sees their channels here or nowhere.
 *
 * The turn-scoped twin of `session-tree` is `session/send`'s `fanIn`, which
 * widens ONE turn's progress stream to that turn's descendants. Interiors of a
 * turn vs. a living subtree — different questions, different lifetimes.
 */
export type SubscriptionScope =
  | { readonly kind: "gateway" }
  | { readonly kind: "app"; readonly id: string }
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "session-tree"; readonly id: string };

export function isGatewayScope(s: SubscriptionScope): s is { kind: "gateway" } {
  return s.kind === "gateway";
}

export function isAppScope(s: SubscriptionScope): s is { kind: "app"; id: string } {
  return s.kind === "app";
}

export function isSessionScope(s: SubscriptionScope): s is { kind: "session"; id: string } {
  return s.kind === "session";
}

export function isSessionTreeScope(
  s: SubscriptionScope,
): s is { kind: "session-tree"; id: string } {
  return s.kind === "session-tree";
}
