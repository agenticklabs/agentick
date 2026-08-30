/**
 * `CredentialProvider` — one namespace's credential source (ADR 107).
 *
 * The harness holds a REGISTRY of these, keyed by namespace, the way the
 * connectors harness holds connector specs. A provider serves exactly one
 * namespace and never sees another's keys, so `namespace` is a registration
 * fact rather than a parameter on every call.
 *
 * **`get` is a resolution verb, not a lookup.** An implementation may read from
 * a store, exchange a grant (RFC 8693), or mint on demand. The caller cannot
 * tell and must not need to — which is what lets a static Redis-backed store and
 * an on-demand token minter sit side by side, as Vault's static and dynamic
 * secret engines do at different mounts.
 *
 * **Everything past `get` is optional**, because the two kinds differ:
 * a minter has nothing to `set` and no meaningful `keys`. Calling an unsupported
 * verb is a typed refusal, not a silent no-op.
 *
 * **Server-resident.** Providers are constructed at boot and never reached from
 * client code; credential material never crosses the wire. A UI drives
 * credential lifecycle by sending action verbs the server resolves.
 *
 * @see docs/proposals/v2/blueprint/107-credentials-as-builtin.md
 */

import type { StoreCtx } from "@agentick/spec";

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
