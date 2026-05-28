/**
 * Conformance suite for `DataBridge` implementations.
 *
 * Validates the split-primitive contract documented in
 * `@agentick/spec/protocol/hook-bridges.ts`:
 *
 *   - peek(key) returns the entry's tagged state (value/pending/error)
 *     or undefined.
 *   - fetch(key, fetcher) initiates a fetch, joins in-flight ones,
 *     returns resolved cached values, returns rejected cached errors.
 *   - subscribe(key, listener) fires on cache state changes.
 *   - invalidate(key) / invalidateTag(tag) drop entries; next fetch
 *     re-runs the fetcher.
 *   - has(key) is true iff a fresh value entry exists.
 *
 * Implementations that pass this suite are interchangeable in any
 * reconciler harness — local in-memory, durable KV-backed, or remote
 * proxies all conform to the same observable behavior.
 */

import { describe, expect, it } from "vitest";
import type { DataBridge } from "@agentick/spec";

export function runDataBridgeConformance(factory: () => DataBridge): void {
  describe("DataBridge — peek / fetch", () => {
    it("peek returns undefined for unknown keys", () => {
      const bridge = factory();
      expect(bridge.peek("nope")).toBeUndefined();
    });

    it("fetch initiates a fetch; peek reflects pending then value", async () => {
      const bridge = factory();
      const promise = bridge.fetch("k", async () => "value");
      const pending = bridge.peek<string>("k");
      expect(pending?.kind).toBe("pending");
      await promise;
      const resolved = bridge.peek<string>("k");
      expect(resolved).toMatchObject({ kind: "value", value: "value" });
    });

    it("fetch joins an in-flight Promise for the same key", () => {
      const bridge = factory();
      const first = bridge.fetch("k", async () => "v");
      const second = bridge.fetch("k", async () => "different");
      // Same in-flight Promise; second fetcher is ignored.
      expect(second).toBe(first);
    });

    it("fetch returns a resolved Promise of the cached value", async () => {
      const bridge = factory();
      await bridge.fetch("k", async () => 42);
      const v = await bridge.fetch("k", async () => -1);
      expect(v).toBe(42);
    });

    it("fetch returns a rejected Promise when the prior fetch errored", async () => {
      const bridge = factory();
      await bridge.fetch("bad", () => Promise.reject(new Error("boom"))).catch(() => {});
      await expect(bridge.fetch("bad", async () => "x")).rejects.toThrow("boom");
      // peek also sees the error.
      const peeked = bridge.peek("bad");
      expect(peeked?.kind).toBe("error");
    });
  });

  describe("DataBridge — subscribe", () => {
    it("notifies on fetch initiation, fulfillment, invalidation", async () => {
      const bridge = factory();
      const events: string[] = [];
      const unsub = bridge.subscribe("k", () => events.push("changed"));
      const p = bridge.fetch("k", async () => "v");
      expect(events.length).toBeGreaterThanOrEqual(1); // pending notification
      await p;
      expect(events.length).toBeGreaterThanOrEqual(2); // value notification
      const beforeInvalidate = events.length;
      bridge.invalidate("k");
      expect(events.length).toBe(beforeInvalidate + 1);
      unsub();
      bridge.fetch("k", async () => "v2");
      // No more notifications after unsubscribe.
      expect(events.length).toBe(beforeInvalidate + 1);
    });
  });

  describe("DataBridge — has() / invalidate() / invalidateTag()", () => {
    it("has() returns false for uncached keys", () => {
      const bridge = factory();
      expect(bridge.has("nope")).toBe(false);
    });

    it("has() returns true after a fetch fulfills", async () => {
      const bridge = factory();
      await bridge.fetch("k", async () => "v");
      expect(bridge.has("k")).toBe(true);
    });

    it("invalidate(key) — next fetch re-runs the fetcher", async () => {
      const bridge = factory();
      let calls = 0;
      await bridge.fetch("k", async () => ++calls);
      expect(await bridge.fetch("k", async () => -1)).toBe(1);
      bridge.invalidate("k");
      await bridge.fetch("k", async () => ++calls);
      expect(await bridge.fetch("k", async () => -1)).toBe(2);
    });

    it("invalidateTag(tag) — drops every entry with that tag", async () => {
      const bridge = factory();
      await bridge.fetch("a", async () => "A", { tag: "group" });
      await bridge.fetch("b", async () => "B", { tag: "group" });
      await bridge.fetch("c", async () => "C", { tag: "other" });
      bridge.invalidateTag("group");
      expect(bridge.has("a")).toBe(false);
      expect(bridge.has("b")).toBe(false);
      expect(bridge.has("c")).toBe(true);
    });

    it("ttl: has() returns false after expiry", async () => {
      const bridge = factory();
      await bridge.fetch("k", async () => "v", { ttl: 1 });
      expect(bridge.has("k")).toBe(true);
      await new Promise((r) => setTimeout(r, 5));
      expect(bridge.has("k")).toBe(false);
    });
  });
}
