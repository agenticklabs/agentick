/**
 * Filter-matchers for address-shaped and event-shaped subscription
 * filters. ONE canonical implementation, consumed by every adapter
 * that has to make filter routing decisions:
 *
 *   - `cluster-broker-next` (BaseBroker, BaseClusterClient)
 *   - `cluster-next/testing/local-cluster-registry`
 *   - any future external-broker adapter (cluster-redis-next, etc.)
 *
 * Why utils-next: the filter shapes are structurally simple value
 * predicates. They have nothing to do with the cluster protocol
 * specifically — any adapter that wants to filter "tell me about
 * events of surface X with name prefix Y" can use these. Putting
 * them here breaks the cluster-broker / cluster-next / cluster-redis
 * triangle that would otherwise force one to depend on another for
 * the shared matcher.
 *
 * Structural types: these matchers take INTERFACE-shaped filters
 * (anything with the matching fields). The cluster package's
 * `AddressFilter` and `EventFilter` are structurally assignable to
 * these inputs — no import contortions. Same for event-shaped values
 * via {@link EventLike}: any object with `surface`, `name`, optional
 * `scope` works.
 */

// ============================================================================
// Address filter
// ============================================================================

/**
 * Structural shape of an address-routing filter. Equivalent to
 * `@agentick/cluster-next`'s `AddressFilter`; declared here so the
 * matcher has zero domain-package dependencies.
 */
export interface AddressFilterShape {
  /** Match the surface prefix (e.g., `"tasks"`). */
  readonly surface?: string;
  /** Match the scope id (the portion after the first `:`). */
  readonly scopeId?: string;
  /** Match the full address verbatim. Most specific. */
  readonly address?: string;
}

/**
 * `true` when `address` satisfies every constraint in `filter`.
 * Empty filter (`{}`) matches every address.
 *
 * Match semantics follow the spec's addressing convention
 * `{surface}:{scopeId}`. Addresses without `:` treat the whole
 * address as both surface and scopeId so unfiltered subscribers
 * still see them.
 */
export function matchesAddressFilter(filter: AddressFilterShape, address: string): boolean {
  if (filter.address !== undefined && filter.address !== address) return false;
  const colon = address.indexOf(":");
  if (filter.scopeId !== undefined) {
    const scopeId = colon >= 0 ? address.slice(colon + 1) : address;
    if (scopeId !== filter.scopeId) return false;
  }
  if (filter.surface !== undefined) {
    const surface = colon >= 0 ? address.slice(0, colon) : address;
    if (surface !== filter.surface) return false;
  }
  return true;
}

// ============================================================================
// Event filter
// ============================================================================

/**
 * Structural shape of an event filter. Equivalent to
 * `@agentick/cluster-next`'s `EventFilter`.
 */
export interface EventFilterShape {
  readonly surface?: string;
  readonly name?: string | { readonly exact: string } | { readonly prefix: string };
  readonly scope?: {
    readonly appId?: string;
    readonly sessionId?: string;
    readonly nodeId?: string;
  };
}

/**
 * Minimum shape an event-like value needs to be matchable. The
 * cluster protocol's `EventEnvelope` (and the spec's `ProtocolEvent`)
 * is structurally assignable to this — pass them directly.
 */
export interface EventLike {
  readonly surface: string;
  readonly name: string;
  readonly scope?: {
    readonly appId?: string;
    readonly sessionId?: string;
    readonly nodeId?: string;
  };
}

/**
 * `true` when `event` satisfies every constraint in `filter`.
 * Empty filter matches every event.
 *
 * Supports three name-match shapes: exact-string (shorthand for
 * `{exact}`), `{exact: ...}` (explicit), or `{prefix: ...}` (starts-
 * with semantics for hierarchical names like `tool:dispatch:*`).
 *
 * For richer matching (phase, outcome, tagsAny), use
 * `@agentick/runtime-next`'s `matchesQuery` against the full
 * `EventQuery` shape.
 */
export function matchesEventFilter(filter: EventFilterShape, event: EventLike): boolean {
  if (filter.surface !== undefined && filter.surface !== event.surface) return false;
  if (filter.name !== undefined) {
    if (typeof filter.name === "string") {
      if (event.name !== filter.name) return false;
    } else if ("exact" in filter.name) {
      if (event.name !== filter.name.exact) return false;
    } else if ("prefix" in filter.name) {
      if (!event.name.startsWith(filter.name.prefix)) return false;
    }
  }
  if (filter.scope !== undefined) {
    const eventScope = event.scope;
    if (filter.scope.appId !== undefined && eventScope?.appId !== filter.scope.appId) return false;
    if (filter.scope.sessionId !== undefined && eventScope?.sessionId !== filter.scope.sessionId) {
      return false;
    }
    if (filter.scope.nodeId !== undefined && eventScope?.nodeId !== filter.scope.nodeId) {
      return false;
    }
  }
  return true;
}
