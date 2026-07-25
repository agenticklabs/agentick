/**
 * Conformance suite for {@link CredentialsStore} implementations.
 *
 * Every bundled adapter and adopter-written adapter (1Password, Vault,
 * AWS Secrets Manager, etc.) MUST pass this suite. Behaviors pinned
 * here are the substrate contract the harness layer depends on —
 * adapters that diverge break the harness in subtle ways
 * (lost change notifications, namespace bleed, stale `keys()`).
 *
 * Usage from an adapter package's test file:
 *
 * ```ts
 * import { runCredentialsStoreConformance } from "@agentick/credentials";
 * import { myCustomCredentialsStore } from "../src/index.js";
 *
 * runCredentialsStoreConformance({
 *   label: "my-custom-store",
 *   factory: () => myCustomCredentialsStore({  ... }),
 * });
 * ```
 *
 * Backends that don't support a behavior (e.g. env-store is read-only
 * by default, doesn't fire change notifications) signal via the
 * `capabilities` option — the suite skips the corresponding cases
 * with a clear reason rather than asserting failure.
 */

import { expect, it } from "vitest";

import { runStoreConformance, stubStoreCtx } from "@agentick/store";

import type { CredentialsStore } from "./store.js";

// The credentials port now threads a `StoreCtx` as the final arg of every DATA
// method (Run B). The bundled reference adapters ignore it; conformance passes
// the canned `stubStoreCtx()` per call.
const ctx = stubStoreCtx();

export interface CredentialsStoreConformanceOptions {
  /** Display label for the suite (`describe` block heading). */
  readonly label: string;
  /** Fresh store per test — must be isolated. */
  readonly factory: () => CredentialsStore | Promise<CredentialsStore>;
  /** Capabilities the suite should skip if unsupported. */
  readonly capabilities?: {
    /** Set/delete supported (defaults to true). Read-only stores set this false. */
    readonly writable?: boolean;
    /** External-change notification supported (defaults to true if `onChange` exists). */
    readonly reactivity?: boolean;
  };
}

export function runCredentialsStoreConformance(opts: CredentialsStoreConformanceOptions): void {
  const writable = opts.capabilities?.writable ?? true;
  const reactivity = opts.capabilities?.reactivity ?? true;

  const setupStore = async (): Promise<CredentialsStore> => opts.factory();

  // Delegate the three store-agnostic cases (stable backend id, unknown-key →
  // empty value, idempotent delete-of-absent) to the shared `runStoreConformance`
  // skeleton. The KV `(namespace, key)` shape is accommodated purely by CLOSURES
  // that pin a fixed namespace — validating run-#1 finding #2 (the shared probes
  // work for a keyed-value store, not just a single-key collection). Idempotent
  // delete is write-dependent, so for a read-only store (`writable: false`) the
  // probe is a settling no-op rather than a real delete (a read-only store throws
  // on delete) — the faithful translation of the old `it.skipIf(!writable)`.
  runStoreConformance<CredentialsStore>({
    label: opts.label,
    factory: opts.factory,
    emptyRead: {
      read: (store, key) => store.get("ns", key, ctx),
      expected: undefined,
    },
    idempotentDelete: (store, key) => (writable ? store.delete("ns", key, ctx) : Promise.resolve()),
    // Credentials-specific cases nest under the shared describe. These exercise
    // the KV composite-key shape the generic skeleton can't: value round-trip,
    // namespace isolation, per-namespace enumeration, and the credentials
    // `{ namespace, key }` onChange event.
    cases: () => {
      it.skipIf(!writable)("round-trips a value through set/get", async () => {
        const store = await setupStore();
        await store.set("ns", "k", { token: "abc", expires: 1000 }, ctx);
        expect(await store.get<{ token: string; expires: number }>("ns", "k", ctx)).toEqual({
          token: "abc",
          expires: 1000,
        });
      });

      it.skipIf(!writable)("isolates entries across namespaces", async () => {
        const store = await setupStore();
        await store.set("ns-a", "k", "value-a", ctx);
        await store.set("ns-b", "k", "value-b", ctx);
        expect(await store.get<string>("ns-a", "k", ctx)).toBe("value-a");
        expect(await store.get<string>("ns-b", "k", ctx)).toBe("value-b");
      });

      it.skipIf(!writable)("overwrites prior values on repeat set", async () => {
        const store = await setupStore();
        await store.set("ns", "k", "first", ctx);
        await store.set("ns", "k", "second", ctx);
        expect(await store.get<string>("ns", "k", ctx)).toBe("second");
      });

      it.skipIf(!writable)("has() returns true after set, false after delete", async () => {
        const store = await setupStore();
        expect(await store.has("ns", "k", ctx)).toBe(false);
        await store.set("ns", "k", "v", ctx);
        expect(await store.has("ns", "k", ctx)).toBe(true);
        const removed = await store.delete("ns", "k", ctx);
        expect(removed).toBe(true);
        expect(await store.has("ns", "k", ctx)).toBe(false);
      });

      it.skipIf(!writable)("delete() returns false on an absent key", async () => {
        const store = await setupStore();
        expect(await store.delete("ns", "never-set", ctx)).toBe(false);
      });

      it.skipIf(!writable)("keys() enumerates only the named namespace", async () => {
        const store = await setupStore();
        await store.set("ns-a", "key1", "v1", ctx);
        await store.set("ns-a", "key2", "v2", ctx);
        await store.set("ns-b", "key3", "v3", ctx);

        const aKeys = [...(await store.keys("ns-a", ctx))].sort();
        expect(aKeys).toEqual(["key1", "key2"]);

        const bKeys = await store.keys("ns-b", ctx);
        expect(bKeys).toEqual(["key3"]);

        const emptyKeys = await store.keys("ns-c", ctx);
        expect(emptyKeys).toEqual([]);
      });

      it.skipIf(!writable || !reactivity)(
        "notifies subscribers of internal set/delete events",
        async () => {
          const store = await setupStore();
          if (!store.onChange) {
            throw new Error(
              `${opts.label}: capabilities.reactivity=true but store.onChange is undefined`,
            );
          }
          const events: Array<{ namespace: string; key: string }> = [];
          const unsubscribe = store.onChange((ev) => {
            events.push({ namespace: ev.namespace, key: ev.key });
          });

          await store.set("ns", "k", "v", ctx);
          await store.delete("ns", "k", ctx);

          expect(events).toEqual([
            { namespace: "ns", key: "k" },
            { namespace: "ns", key: "k" },
          ]);

          unsubscribe();
          await store.set("ns", "k2", "v2", ctx);
          expect(events).toHaveLength(2);
        },
      );
    },
  });
}
