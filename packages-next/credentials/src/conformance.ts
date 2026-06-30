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
 * import { runCredentialsStoreConformance } from "@agentick/credentials-next";
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

import { describe, expect, it } from "vitest";

import type { CredentialsStore } from "./store.js";

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

  describe(`CredentialsStore conformance — ${opts.label}`, () => {
    it("returns undefined for an absent key", async () => {
      const store = await setupStore();
      expect(await store.get("ns", "missing")).toBeUndefined();
    });

    it("reports a stable backend identifier", async () => {
      const store = await setupStore();
      expect(typeof store.backend).toBe("string");
      expect(store.backend.length).toBeGreaterThan(0);
    });

    it.skipIf(!writable)("round-trips a value through set/get", async () => {
      const store = await setupStore();
      await store.set("ns", "k", { token: "abc", expires: 1000 });
      expect(await store.get<{ token: string; expires: number }>("ns", "k")).toEqual({
        token: "abc",
        expires: 1000,
      });
    });

    it.skipIf(!writable)("isolates entries across namespaces", async () => {
      const store = await setupStore();
      await store.set("ns-a", "k", "value-a");
      await store.set("ns-b", "k", "value-b");
      expect(await store.get<string>("ns-a", "k")).toBe("value-a");
      expect(await store.get<string>("ns-b", "k")).toBe("value-b");
    });

    it.skipIf(!writable)("overwrites prior values on repeat set", async () => {
      const store = await setupStore();
      await store.set("ns", "k", "first");
      await store.set("ns", "k", "second");
      expect(await store.get<string>("ns", "k")).toBe("second");
    });

    it.skipIf(!writable)("has() returns true after set, false after delete", async () => {
      const store = await setupStore();
      expect(await store.has("ns", "k")).toBe(false);
      await store.set("ns", "k", "v");
      expect(await store.has("ns", "k")).toBe(true);
      const removed = await store.delete("ns", "k");
      expect(removed).toBe(true);
      expect(await store.has("ns", "k")).toBe(false);
    });

    it.skipIf(!writable)("delete() is idempotent — returns false on absent key", async () => {
      const store = await setupStore();
      expect(await store.delete("ns", "never-set")).toBe(false);
    });

    it.skipIf(!writable)("keys() enumerates only the named namespace", async () => {
      const store = await setupStore();
      await store.set("ns-a", "key1", "v1");
      await store.set("ns-a", "key2", "v2");
      await store.set("ns-b", "key3", "v3");

      const aKeys = [...(await store.keys("ns-a"))].sort();
      expect(aKeys).toEqual(["key1", "key2"]);

      const bKeys = await store.keys("ns-b");
      expect(bKeys).toEqual(["key3"]);

      const emptyKeys = await store.keys("ns-c");
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

        await store.set("ns", "k", "v");
        await store.delete("ns", "k");

        expect(events).toEqual([
          { namespace: "ns", key: "k" },
          { namespace: "ns", key: "k" },
        ]);

        unsubscribe();
        await store.set("ns", "k2", "v2");
        expect(events).toHaveLength(2);
      },
    );
  });
}
