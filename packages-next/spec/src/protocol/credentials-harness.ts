/**
 * `CredentialsHarnessProtocol` — substrate-level credential storage
 * primitive. Adopter-pluggable backend adapter (the
 * `CredentialsStore` interface, defined in `@agentick/credentials-next`)
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
   * `createNotifier` convention from `@agentick/pubsub-next`).
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
