/**
 * `stubCredentialsStore` — canned-answer test double per the Meszaros
 * taxonomy. Returns pre-seeded values for specific keys; writes and
 * unmapped reads behave as adopter-specified.
 *
 * Use when a consumer-under-test only needs the read path to return
 * specific tokens — `fakeCredentialsHarness()` is the right default for
 * exercising the full harness round-trip; `stubCredentialsStore` is for
 * the narrower case where the test cares only about what the consumer
 * does WITH the credential and not about persistence behavior.
 *
 * **Not conformant by design.** Stubs throw on write (read-only), use
 * a custom `keyOf` composition rather than the standard
 * `(namespace, key)` tuple internally, and ship no `onChange`. Do NOT
 * run `runCredentialsStoreConformance` against a stub — by intent it
 * fails the writable + enumeration cases. Use the in-memory adapter
 * (or `fakeCredentialsStore`) when you need a working impl.
 */

import { CredentialsBackendUnavailable, CredentialsWriteFailed } from "@agentick/spec-next";
import type { StoreCtx } from "@agentick/spec-next";

import type {
  CredentialEntry,
  CredentialMutation,
  CredentialQuery,
  CredentialsStore,
} from "../store.js";

export interface StubCredentialsStoreOptions {
  /** `(namespace, key)` → canned value. */
  readonly seed: ReadonlyMap<string, unknown> | Record<string, unknown>;
  /**
   * How to compose the key from `(namespace, key)`. Defaults to
   * `"<namespace>:<key>"` — matches the convention adopters use in
   * specs.
   */
  readonly keyOf?: (namespace: string, key: string) => string;
  /** Throw on `set` / `delete`. Defaults to true — stubs are read-only. */
  readonly readOnly?: boolean;
}

export function stubCredentialsStore(options: StubCredentialsStoreOptions): CredentialsStore {
  const keyOf = options.keyOf ?? ((ns: string, k: string) => `${ns}:${k}`);
  const readOnly = options.readOnly ?? true;
  const seed =
    options.seed instanceof Map ? new Map(options.seed) : new Map(Object.entries(options.seed));

  return {
    backend: "stub",

    async get<T>(namespace: string, key: string, _ctx: StoreCtx): Promise<T | undefined> {
      return seed.get(keyOf(namespace, key)) as T | undefined;
    },

    async set<T>(namespace: string, key: string, value: T, _ctx: StoreCtx): Promise<void> {
      if (readOnly) {
        throw new CredentialsWriteFailed({
          namespace,
          key,
          cause: new Error("stubCredentialsStore is read-only"),
        });
      }
      seed.set(keyOf(namespace, key), value);
    },

    async delete(namespace: string, key: string, _ctx: StoreCtx): Promise<boolean> {
      if (readOnly) {
        throw new CredentialsWriteFailed({
          namespace,
          key,
          cause: new Error("stubCredentialsStore is read-only"),
        });
      }
      return seed.delete(keyOf(namespace, key));
    },

    async has(namespace: string, key: string, _ctx: StoreCtx): Promise<boolean> {
      return seed.has(keyOf(namespace, key));
    },

    async keys(namespace: string, _ctx: StoreCtx): Promise<readonly string[]> {
      const prefix = keyOf(namespace, "");
      const out: string[] = [];
      for (const k of seed.keys()) {
        if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
      }
      return out;
    },

    // Store seam. `query({ namespace })` projects the seed's entries for that
    // namespace (via the custom `keyOf` prefix); a namespace-less query returns
    // `[]` (the stub can't split its custom composite key back). `mutate`
    // mirrors `set`/`delete` — throws when read-only.
    async query(
      q: CredentialQuery | undefined,
      _ctx: StoreCtx,
    ): Promise<readonly CredentialEntry[]> {
      const namespace = q?.namespace;
      if (namespace === undefined) return [];
      const prefix = keyOf(namespace, "");
      const entries: CredentialEntry[] = [];
      for (const [k, value] of seed) {
        if (k.startsWith(prefix)) entries.push({ namespace, key: k.slice(prefix.length), value });
      }
      return entries;
    },

    async mutate(m: CredentialMutation, _ctx: StoreCtx): Promise<void> {
      if (readOnly) {
        throw new CredentialsWriteFailed({
          namespace: "set" in m ? m.set.namespace : m.delete.namespace,
          key: "set" in m ? m.set.key : m.delete.key,
          cause: new Error("stubCredentialsStore is read-only"),
        });
      }
      if ("set" in m) seed.set(keyOf(m.set.namespace, m.set.key), m.set.value);
      else seed.delete(keyOf(m.delete.namespace, m.delete.key));
    },
  } satisfies CredentialsStore & { backend: string };
}

/**
 * Convenience: a stub that always errors with
 * `CredentialsBackendUnavailable`. Useful for testing fallback paths.
 */
export function unavailableCredentialsStore(reason = "stub unavailable"): CredentialsStore {
  const fail = async (): Promise<never> => {
    throw new CredentialsBackendUnavailable({
      backend: "stub-unavailable",
      cause: new Error(reason),
    });
  };
  return {
    backend: "stub-unavailable",
    get: fail,
    set: fail,
    delete: fail,
    has: fail,
    keys: fail,
    query: fail,
    mutate: fail,
  };
}
