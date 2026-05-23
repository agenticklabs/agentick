/**
 * Conformance suite for {@link StateHarnessProtocol} implementations.
 *
 * Validates the contract every StateHarness implementation must satisfy:
 *
 *   - Sync surface: get / has / list / subscribe / subscribeAll
 *   - Async surface: set / delete
 *   - subscribe fires per-key; subscribeAll fires on any mutation
 *   - snapshot round-trip preserves entries + fires subscribers on
 *     changed keys
 */

import { describe, expect, it } from "vitest";
import type { StateHarnessProtocol } from "@agentick/spec";

export interface StateHarnessFactoryDeps {
  /** Construct a fresh harness. Caller MUST await `harness.ready`. */
  readonly make: () => Promise<StateHarnessProtocol>;
}

export function runStateHarnessConformance(deps: StateHarnessFactoryDeps): void {
  describe("StateHarness — sync surface", () => {
    it("get() returns undefined for unknown keys", async () => {
      const h = await deps.make();
      expect(h.get("missing")).toBeUndefined();
      await h.close();
    });

    it("has() reflects whether a value exists for the key", async () => {
      const h = await deps.make();
      expect(h.has("foo")).toBe(false);
      await h.set({ key: "foo", value: 1 });
      expect(h.has("foo")).toBe(true);
      await h.close();
    });

    it("list() returns current keys", async () => {
      const h = await deps.make();
      await h.set({ key: "a", value: 1 });
      await h.set({ key: "b", value: 2 });
      expect([...h.list()].sort()).toEqual(["a", "b"]);
      await h.close();
    });
  });

  describe("StateHarness — set + subscribe", () => {
    it("set() + get() round-trip", async () => {
      const h = await deps.make();
      await h.set({ key: "x", value: "hello" });
      expect(h.get("x")).toBe("hello");
      await h.close();
    });

    it("subscribe() fires when the subscribed key changes", async () => {
      const h = await deps.make();
      let count = 0;
      const unsub = h.subscribe("x", () => {
        count++;
      });
      await h.set({ key: "x", value: 1 });
      await h.set({ key: "x", value: 2 });
      expect(count).toBe(2);
      unsub();
      await h.set({ key: "x", value: 3 });
      expect(count).toBe(2);
      await h.close();
    });

    it("subscribe() is key-scoped (other keys do not trigger)", async () => {
      const h = await deps.make();
      let count = 0;
      h.subscribe("x", () => {
        count++;
      });
      await h.set({ key: "y", value: "ignored" });
      expect(count).toBe(0);
      await h.close();
    });

    it("subscribeAll() fires on every mutation", async () => {
      const h = await deps.make();
      let count = 0;
      const unsub = h.subscribeAll(() => {
        count++;
      });
      await h.set({ key: "a", value: 1 });
      await h.set({ key: "b", value: 2 });
      await h.set({ key: "c", value: 3 });
      expect(count).toBe(3);
      unsub();
      await h.set({ key: "a", value: 99 });
      expect(count).toBe(3);
      await h.close();
    });
  });

  describe("StateHarness — delete", () => {
    it("delete() removes the key and fires subscribers", async () => {
      const h = await deps.make();
      await h.set({ key: "x", value: 1 });
      let count = 0;
      h.subscribe("x", () => {
        count++;
      });
      await h.delete({ key: "x" });
      expect(h.has("x")).toBe(false);
      expect(h.get("x")).toBeUndefined();
      expect(count).toBe(1);
      await h.close();
    });

    it("delete() of an unknown key is a no-op (no listener fire)", async () => {
      const h = await deps.make();
      let count = 0;
      h.subscribeAll(() => {
        count++;
      });
      await h.delete({ key: "missing" });
      expect(count).toBe(0);
      await h.close();
    });
  });

  describe("StateHarness — snapshot/restore", () => {
    it("exportSnapshot returns current entries", async () => {
      const h = await deps.make();
      await h.set({ key: "a", value: 1 });
      await h.set({ key: "b", value: "two" });
      expect(h.exportSnapshot()).toMatchObject({ a: 1, b: "two" });
      await h.close();
    });

    it("importSnapshot replaces entries and fires subscribers for changed keys", async () => {
      const h = await deps.make();
      await h.set({ key: "a", value: 1 });
      let aChanges = 0;
      let cChanges = 0;
      h.subscribe("a", () => aChanges++);
      h.subscribe("c", () => cChanges++);
      h.importSnapshot({ a: 1, b: 2, c: 3 });
      // `a` is in both old + new; `c` is new — both notified.
      expect(aChanges).toBeGreaterThan(0);
      expect(cChanges).toBe(1);
      expect(h.get("a")).toBe(1);
      expect(h.get("c")).toBe(3);
      await h.close();
    });
  });
}
