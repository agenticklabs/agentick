/**
 * `CredentialsHarnessProtocol` — substrate-level credential storage
 * primitive. Adopter-pluggable backend adapter (the
 * `CredentialsStore` interface, defined in `@agentick/credentials`)
 * plus reactive change notification.
 *
 * Server-resident always — `bridges.credentials` is populated by an
 * app- or gateway-level `withCredentials({ store })` install and
 * threaded into every session's bridge tree. The slot itself never
 * crosses the wire; only adopter-defined verbs over the wire-extensions
 * framework (#280) drive it from client code.
 *
 * The protocol exposes the same CRUD shape as the underlying
 * `CredentialsStore` adapter — `get`, `set`, `delete`, `has`, `keys`
 * — wrapped with reactive `subscribe` semantics so adopter UIs can
 * render credential state without polling.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md — ADR 27
 *      modularity pattern that drives every substrate harness's slot
 *      shape.
 */

import type { Unsubscribe } from "./inbox.js";
import type { StoreCtx } from "./store-ctx.js";

/**
 * Change-notification payload. The harness emits one of these whenever
 * a credential entry transitions — internal writes (a `set` / `delete`
 * routed through the harness) AND external writes (the underlying
 * store's native change events, when the adapter implements `onChange`)
 * are surfaced through the same channel.
 *
 * Payload is intentionally **just the coordinates**, not the value.
 * Listeners that need the current state of the key call `get(...)`
 * after receiving the event. Keeping the value out of the change event
 * preserves the "credentials never spread" invariant — even diagnostic
 * subscribers don't see token material unless they explicitly read.
 */
export interface CredentialsChangeEvent {
  readonly namespace: string;
  readonly key: string;
}

/**
 * Substrate primitive surfaced via `bridges.credentials` on the
 * session bridge tree.
 */
export interface CredentialsHarnessProtocol {
  /**
   * Harness identifier. Composes into the inbox address as
   * `credentials:{id}` per the BaseHarness convention.
   */
  readonly id: string;

  /**
   * Cluster-portable inbox address — `${surface}:${scopeId}`. Surfaced
   * for symmetry with other harness protocols even though the
   * credentials harness ships no inbox protocol in 281b.1
   * (credentials are server-resident; external actors don't drive
   * the harness via inbox messages today).
   */
  readonly address: string;

  /**
   * Read stored credentials. Resolves `undefined` for absent keys;
   * never throws on absence. MAY throw the adapter's declared error
   * classes (`CredentialsBackendUnavailable`, `CredentialsCorrupted`)
   * — these round-trip via the typed-error codec.
   */
  get<T>(namespace: string, key: string): Promise<T | undefined>;

  /**
   * Persist credentials. Overwrites any prior entry at the same
   * `(namespace, key)`. Publishes a {@link CredentialsChangeEvent}
   * on success (subscribers see internal writes).
   */
  set<T>(namespace: string, key: string, value: T): Promise<void>;

  /**
   * Drop credentials. Idempotent. Returns `true` if a value was
   * actually removed. Publishes a {@link CredentialsChangeEvent}
   * on every call that touched a real key (no event on no-op delete).
   */
  delete(namespace: string, key: string): Promise<boolean>;

  /**
   * Existence check.
   */
  has(namespace: string, key: string): Promise<boolean>;

  /**
   * Enumerate keys in a namespace. Foundation primitive — every
   * collection surface ships enumeration alongside per-item reads
   * (see the `enumeration-is-foundational` rule). Returns `[]` for
   * unknown namespaces.
   */
  keys(namespace: string): Promise<readonly string[]>;

  /**
   * Subscribe to change events across ALL namespaces this harness
   * surfaces. Listener fires once per `set` / `delete` (internal) and
   * once per external rotation (adapters that implement
   * `CredentialsStore.onChange`).
   *
   * Listener errors are caught per-listener; a buggy consumer cannot
   * corrupt sibling listeners or the producer's state (matches the
   * `createNotifier` convention from `@agentick/pubsub`).
   *
   * Returns an unsubscribe — call to stop receiving events.
   */
  subscribe(listener: (event: CredentialsChangeEvent) => void): Unsubscribe;

  /**
   * Release any subscriptions to the underlying store and stop
   * fan-out. After `close()` resolves, `subscribe()` listeners are
   * cleared and the harness stops forwarding store events. Idempotent.
   */
  close(): Promise<void>;
}

// ============================================================================
// CredentialProvider — the adopter-implemented contract (ADR 107)
// ============================================================================
//
// Lives in spec, beside the harness protocol, for the same reason `ConnectorSpec`
// does: the gateway and app slots that accept providers must name the type
// without depending on the implementation package.

/**
 * One namespace's credential source.
 *
 * The harness holds a REGISTRY of these keyed by namespace, the way the
 * connectors harness holds connector specs. A provider serves exactly one
 * namespace and never sees another's keys, so `namespace` is a registration
 * fact rather than a parameter on every call.
 *
 * **`get` is a resolution verb, not a lookup.** An implementation may read from
 * a store, exchange a grant (RFC 8693), or mint on demand. The caller cannot
 * tell and must not need to — which is what lets a static store and an
 * on-demand minter sit side by side, as Vault's static and dynamic secret
 * engines do at different mounts.
 *
 * **Everything past `get` is optional**, because the two kinds differ: a minter
 * has nothing to `set` and no meaningful `keys`. Calling an unsupported verb is
 * a typed refusal, not a silent no-op.
 *
 * **Server-resident.** Providers are constructed at boot and never reached from
 * client code; credential material never crosses the wire.
 *
 * @see docs/proposals/v2/blueprint/107-credentials-as-builtin.md
 */
export interface CredentialProvider {
  /**
   * The namespace this provider serves. The harness routes on it, exact-match:
   * one owner per namespace, and an unregistered namespace is an error rather
   * than an empty result.
   */
  readonly namespace: string;

  /**
   * Stable backend identifier for diagnostics — `"in-memory"`, `"env"`,
   * `"redis"`. Rides no journal entry; the journaled coordinates are the
   * namespace and key.
   */
  readonly backend: string;

  /**
   * Resolve `key`. `undefined` when this provider has no such credential —
   * absence is not an error, an unknown NAMESPACE is.
   *
   * `ctx` carries the acting principal (`StoreCtx extends RuntimeContext`), so a
   * provider serving many principals enforces its own policy on read. A
   * namespace is a naming scheme; this is the boundary.
   */
  get<T>(key: string, ctx: StoreCtx): Promise<T | undefined>;

  /** Write. Absent ⇒ read-only provider (a minter, an env-backed store). */
  set?<T>(key: string, value: T, ctx: StoreCtx): Promise<void>;

  /** Remove. Resolves whether anything was removed. Absent ⇒ unsupported. */
  delete?(key: string, ctx: StoreCtx): Promise<boolean>;

  /** Absent ⇒ the harness answers from `get(key) !== undefined`. */
  has?(key: string, ctx: StoreCtx): Promise<boolean>;

  /**
   * Enumerate. Absent ⇒ unsupported, which is the honest answer for a minter:
   * there is no set of keys, only keys it would mint if asked.
   */
  keys?(ctx: StoreCtx): Promise<readonly string[]>;

  /**
   * External-change notification. The harness fans these out to its own
   * subscribers as `{ namespace, key }`. Absent ⇒ the harness synthesizes a
   * change event after its own successful `set` / `delete`.
   *
   * Carries the KEY only, never the value — a diagnostic subscriber must not
   * see credential material it did not explicitly read.
   */
  onChange?(listener: (key: string) => void): () => void;

  /**
   * Acquire whatever backs this provider — a Redis connection, a minting
   * client. Called by `credentials:start`, as a connector's `start` is.
   */
  start?(): Promise<void> | void;

  /** Release it. Called by `credentials:stop` and at harness teardown. */
  stop?(): Promise<void> | void;
}

/** What {@link defineCredentialProvider} accepts. */
export type CredentialProviderSpec = CredentialProvider;
