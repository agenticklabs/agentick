/**
 * `inMemoryCredentialsStore` — `MemoryCollection`-backed reference adapter.
 *
 * Default for tests and ephemeral CLIs; data is lost on process exit.
 * Production deployments swap in keychain / libsecret /
 * encrypted-file / KV.
 *
 * Composes the generic {@link MemoryCollection} from `@agentick/store-next`
 * rather than hand-rolling a `Map` + a bespoke change fan-out. The credentials
 * KV surface (`get`/`set(ns,key,val)`/`has`/`keys(ns)`/`delete`/`onChange`) is a
 * different method SHAPE than `CollectionStore` (composite `(namespace, key)`
 * addressing, value-projection on read), so this adapter does NOT extend
 * `CollectionStore` — it COMPOSES a `MemoryCollection<CredentialEntry>` and maps
 * its KV verbs onto the collection's `put`/`get`/`list`/`delete`. The composite
 * key `namespace\x1fkey` is the collection's primary key; the store's own
 * `onChange` adapts the collection's `{ key, value?, prev? }` delta back to the
 * credentials `{ namespace, key }` event.
 *
 * Supports optional external-change notification — useful for tests
 * that simulate "another process edited the keychain" by calling
 * `store.set(...)` from outside the harness and checking that
 * subscribers see the change. That reactivity is now inherited from
 * `MemoryCollection.onChange` (the shared-store observation seam) — the
 * hand-rolled listener set this adapter previously carried is gone.
 */

import type { StoreCtx } from "@agentick/spec-next";
import { MemoryCollection } from "@agentick/store-next";

import type { CredentialsStore } from "../store.js";

// ASCII Unit Separator (US, 0x1F) — purpose-built field separator that
// can't appear in any sensible namespace or key string. Explicit escape
// keeps the intent visible in source (vs. embedding a literal control
// character that renders as a glyph and surprises readers).
const SEP = "\x1f";
const compositeKey = (namespace: string, key: string): string => `${namespace}${SEP}${key}`;

/**
 * The record `MemoryCollection` holds: the composite-addressed
 * `(namespace, key)` pair plus its opaque value. `namespace` + `key` are stored
 * as fields (not only encoded in the composite key) so `keys(namespace)`
 * enumeration and `onChange` decoding read them directly rather than splitting
 * the separator-encoded string.
 */
interface CredentialEntry {
  readonly namespace: string;
  readonly key: string;
  readonly value: unknown;
}

/** Query shape for `keys(namespace)` — filters the collection to one namespace. */
interface CredentialQuery {
  readonly namespace: string;
}

class InMemoryCredentialsStore implements CredentialsStore {
  readonly backend = "in-memory" as const;

  private readonly collection = new MemoryCollection<CredentialEntry, CredentialQuery>({
    backend: "in-memory",
    keyOf: (e) => compositeKey(e.namespace, e.key),
    // Namespace match — `list(undefined)` (no query) returns every entry; a
    // `{ namespace }` query filters to that namespace. Matched on the stored
    // field rather than a composite-key prefix so it can't false-positive on a
    // namespace that is a string prefix of another.
    matchQuery: (e, q) => q === undefined || e.namespace === q.namespace,
  });

  // The in-memory collection holds no identity-scoped state, so `ctx` is
  // forwarded verbatim and ignored — an identity-aware adapter would resolve
  // `ctx.principal` here instead.
  async get<T>(namespace: string, key: string, ctx: StoreCtx): Promise<T | undefined> {
    const entry = await this.collection.get(compositeKey(namespace, key), ctx);
    return entry?.value as T | undefined;
  }

  async set<T>(namespace: string, key: string, value: T, ctx: StoreCtx): Promise<void> {
    await this.collection.put({ namespace, key, value }, ctx);
  }

  async delete(namespace: string, key: string, ctx: StoreCtx): Promise<boolean> {
    return this.collection.delete(compositeKey(namespace, key), ctx);
  }

  async has(namespace: string, key: string, ctx: StoreCtx): Promise<boolean> {
    return (await this.collection.get(compositeKey(namespace, key), ctx)) !== undefined;
  }

  async keys(namespace: string, ctx: StoreCtx): Promise<readonly string[]> {
    const entries = await this.collection.list({ namespace }, ctx);
    return entries.map((e) => e.key);
  }

  onChange(
    listener: (event: { readonly namespace: string; readonly key: string }) => void,
  ): () => void {
    // Adapt the collection's `{ key: composite, value?, prev? }` delta back to
    // the credentials `{ namespace, key }` event. On a `put` the new value
    // carries the pair; on a `delete` only `prev` does — take whichever side is
    // present. The collection already fires only on real changes (every put;
    // deletes that removed a key), matching this store's prior notify semantics.
    return this.collection.onChange((change) => {
      const entry = change.value ?? change.prev;
      if (entry === undefined) return;
      listener({ namespace: entry.namespace, key: entry.key });
    });
  }
}

/**
 * Construct a fresh in-memory credentials store. Each call returns
 * an isolated instance.
 */
export function inMemoryCredentialsStore(): CredentialsStore {
  return new InMemoryCredentialsStore();
}
