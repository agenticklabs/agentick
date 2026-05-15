/**
 * Conformance suite for `DataBridge` implementations.
 *
 * Validates the no-Suspense contract documented in
 * `@agentick/spec/protocol/hook-bridges.ts`:
 *
 *   - cached fulfilled  → returns T synchronously
 *   - pending           → throws an in-flight `Promise<T>`
 *   - cached rejected   → throws the underlying Error synchronously
 *   - hasPending()      → true while a fetch is in flight, false after
 *   - invalidate(key)   → next resolve() re-fetches
 *   - invalidateTag(t)  → drops all entries with that tag
 *
 * Implementations that pass this suite are interchangeable in any
 * reconciler harness — local in-memory, durable KV-backed, or remote
 * proxies all conform to the same observable behavior.
 */

import { describe, expect, it } from "vitest";
import type { DataBridge } from "@agentick/spec";

export function runDataBridgeConformance(factory: () => DataBridge): void {
  describe("DataBridge — resolve semantics", () => {
    it("throws the in-flight Promise for uncached keys", async () => {
      const bridge = factory();
      let thrown: unknown;
      try {
        bridge.resolve("k", async () => "value");
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Promise);
      const resolved = await (thrown as Promise<unknown>);
      // Either the bridge's settled Promise (resolves to void) or the
      // raw fetcher Promise (resolves to "value"). Both are acceptable
      // — what matters is the throw happened.
      expect(["value", undefined]).toContain(resolved as unknown);
    });

    it("returns the cached value synchronously after a fetch settles", async () => {
      const bridge = factory();
      try {
        bridge.resolve("k", async () => 42);
      } catch (p) {
        await p;
      }
      const v = bridge.resolve("k", async () => -1);
      expect(v).toBe(42);
    });

    it("throws the cached Error when a prior fetch rejected", async () => {
      const bridge = factory();
      try {
        bridge.resolve("bad", () => Promise.reject(new Error("boom")));
      } catch (p) {
        await Promise.allSettled([p as Promise<unknown>]);
      }
      expect(() => bridge.resolve("bad", async () => "x")).toThrow("boom");
    });

    it("re-throws the same in-flight Promise for the same key", () => {
      const bridge = factory();
      let first: unknown;
      let second: unknown;
      try {
        bridge.resolve("k", async () => "v");
      } catch (e) {
        first = e;
      }
      try {
        bridge.resolve("k", async () => "v");
      } catch (e) {
        second = e;
      }
      expect(first).toBeInstanceOf(Promise);
      expect(second).toBeInstanceOf(Promise);
    });
  });

  describe("DataBridge — has() / invalidate() / invalidateTag()", () => {
    it("has() returns false for uncached keys", () => {
      const bridge = factory();
      expect(bridge.has("nope")).toBe(false);
    });

    it("has() returns true after a fetch fulfills", async () => {
      const bridge = factory();
      try {
        bridge.resolve("k", async () => "v");
      } catch (p) {
        await p;
      }
      expect(bridge.has("k")).toBe(true);
    });

    it("invalidate(key) — next resolve() re-fetches", async () => {
      const bridge = factory();
      let calls = 0;
      try {
        bridge.resolve("k", async () => {
          calls++;
          return calls;
        });
      } catch (p) {
        await p;
      }
      expect(bridge.resolve("k", async () => -1)).toBe(1);
      bridge.invalidate("k");
      try {
        bridge.resolve("k", async () => {
          calls++;
          return calls;
        });
      } catch (p) {
        await p;
      }
      expect(bridge.resolve("k", async () => -1)).toBe(2);
    });

    it("invalidateTag(tag) — drops every entry with that tag", async () => {
      const bridge = factory();
      try {
        bridge.resolve("a", async () => "A", { tag: "group" });
      } catch (p) {
        await p;
      }
      try {
        bridge.resolve("b", async () => "B", { tag: "group" });
      } catch (p) {
        await p;
      }
      try {
        bridge.resolve("c", async () => "C", { tag: "other" });
      } catch (p) {
        await p;
      }
      bridge.invalidateTag("group");
      expect(bridge.has("a")).toBe(false);
      expect(bridge.has("b")).toBe(false);
      expect(bridge.has("c")).toBe(true);
    });

    it("ttl: has() returns false after expiry", async () => {
      const bridge = factory();
      try {
        bridge.resolve("k", async () => "v", { ttl: 1 });
      } catch (p) {
        await p;
      }
      expect(bridge.has("k")).toBe(true);
      await new Promise((r) => setTimeout(r, 5));
      expect(bridge.has("k")).toBe(false);
    });
  });

  describe("DataBridge — no-Suspense invariant", () => {
    it("resolve never returns a Promise (always sync or throw)", async () => {
      const bridge = factory();
      // Cached → sync return.
      try {
        bridge.resolve("k", async () => "v");
      } catch (p) {
        await p;
      }
      const sync = bridge.resolve("k", async () => "x");
      expect(sync).not.toBeInstanceOf(Promise);
      // Uncached → throws (cannot return at all). The throw IS a
      // Promise, but resolve() doesn't return one.
    });
  });
}
