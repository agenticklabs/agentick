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
 *   - checkpoint (opt-in, {@link StateHarnessFactoryDeps.makeOverStore}):
 *     persist → hydrate on a fresh instance sharing the store, REPLACE
 *     semantics, scope partitioning, and persist rejection on a failed write
 *   - branch (same opt-in): the fork transport — copy the source scope, leave
 *     the parent alone, no-op into a non-empty scope, empty source is inert
 */

import { describe, expect, it } from "vitest";
import type { BranchCapable, CheckpointCapable, StateHarnessProtocol } from "@agentick/spec";
import { stubStoreCtx } from "@agentick/store";

import { createStateStore, stateScope, stateStoreKey, type StateStore } from "./store.js";

export interface StateHarnessFactoryDeps {
  /** Construct a fresh harness. Caller MUST await `harness.ready`. */
  readonly make: () => Promise<StateHarnessProtocol>;
  /**
   * Construct a harness over a CALLER-OWNED store — the seam the checkpoint and
   * branch sections need, since durability across instances requires the store
   * to outlive the harness. Omit it and both sections are skipped (an
   * implementation with no durable state has nothing to prove); supply it and
   * the implementation owes both contracts.
   */
  readonly makeOverStore?: (
    store: StateStore,
    scope: string,
  ) => Promise<StateHarnessProtocol & CheckpointCapable & BranchCapable>;
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

    it("list() returns current entries", async () => {
      const h = await deps.make();
      await h.set({ key: "a", value: 1 });
      await h.set({ key: "b", value: 2 });
      expect([...h.list()].map((e) => e.key).sort()).toEqual(["a", "b"]);
      expect(new Map(h.list().map((e) => [e.key, e.value]))).toEqual(
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
      );
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

  describe("StateHarness — construction seed", () => {
    it("seed upserts entries and fires subscribers for the keys it touched", async () => {
      const h = await deps.make();
      await h.set({ key: "a", value: 1 });
      let aChanges = 0;
      let cChanges = 0;
      h.subscribe("a", () => aChanges++);
      h.subscribe("c", () => cChanges++);
      h.seed({ a: 9, c: 3 });
      expect(aChanges).toBeGreaterThan(0);
      expect(cChanges).toBe(1);
      expect(h.get("a")).toBe(9);
      expect(h.get("c")).toBe(3);
      await h.close();
    });

    it("seed UPSERTS — a key it does not name keeps its value", async () => {
      const h = await deps.make();
      await h.set({ key: "kept", value: "yes" });
      h.seed({ added: 1 });
      expect(h.get("kept")).toBe("yes");
      expect(h.get("added")).toBe(1);
      await h.close();
    });
  });

  const makeOverStore = deps.makeOverStore;
  if (makeOverStore === undefined) return;

  describe("StateHarness — checkpoint (persist / hydrate)", () => {
    const ctx = (sessionId: string) => ({ sessionId, tick: 0, storeCtx: stubStoreCtx() });

    it("persist → hydrate round-trips cells onto a fresh instance sharing the store", async () => {
      const store = createStateStore();
      const first = await makeOverStore(store, "cp");
      await first.set({ key: "mode", value: "final" });
      await first.set({ key: "maybe", value: undefined });
      await first.persist(ctx("cp"));
      await first.close();

      const second = await makeOverStore(store, "cp");
      await second.hydrate(ctx("cp"));

      expect(second.get("mode")).toBe("final");
      // `undefined` survives as a PRESENT key — presence is key membership.
      expect(second.has("maybe")).toBe(true);
      await second.close();
    });

    it("a seeded cell is durable like any other write", async () => {
      const store = createStateStore();
      const first = await makeOverStore(store, "cp-parity");
      first.seed({ a: 1, b: "two", c: { nested: true } });
      await first.persist(ctx("cp-parity"));
      await first.close();

      const second = await makeOverStore(store, "cp-parity");
      await second.hydrate(ctx("cp-parity"));

      expect(second.list()).toEqual(
        expect.arrayContaining([
          { key: "a", value: 1 },
          { key: "b", value: "two" },
          { key: "c", value: { nested: true } },
        ]),
      );
      await second.close();
    });

    it("hydrate REPLACES the projection — the store is the authority", async () => {
      const store = createStateStore();
      const h = await makeOverStore(store, "cp-replace");
      await h.set({ key: "gone", value: 1 });
      await h.persist(ctx("cp-replace"));
      await store.mutate({ delete: stateStoreKey("cp-replace", "gone") }, stubStoreCtx());

      await h.hydrate(ctx("cp-replace"));

      expect(h.has("gone")).toBe(false);
      await h.close();
    });

    it("hydrate reads only its own scope's partition", async () => {
      const store = createStateStore();
      const a = await makeOverStore(store, "cp-a");
      const b = await makeOverStore(store, "cp-b");
      await a.set({ key: "mode", value: "curious" });
      await a.persist(ctx("cp-a"));

      await b.hydrate(ctx("cp-b"));

      expect(b.get("mode")).toBeUndefined();
      await a.close();
      await b.close();
    });

    it("persist rejects when the store write fails", async () => {
      const boom = new Error("store unavailable");
      const store = createStateStore();
      const failing: StateStore = {
        backend: store.backend,
        query: (q, c) => store.query(q, c),
        mutate: () => Promise.reject(boom),
      };
      const h = await makeOverStore(failing, "cp-fail");
      await h.set({ key: "doomed", value: 1 });

      await expect(h.persist(ctx("cp-fail"))).rejects.toBe(boom);
      await h.close();
    });
  });

  describe("StateHarness — branch (the fork transport)", () => {
    const ctx = (sessionId: string, fromSessionId: string) => ({
      sessionId,
      fromSessionId,
      tick: 0,
      storeCtx: stubStoreCtx(),
    });
    const forked = (store: StateStore) => ({
      parent: makeOverStore(store, stateScope("parent")),
      child: makeOverStore(store, stateScope("child")),
    });

    it("copies the source scope's cells onto the child, visible after hydrate", async () => {
      const store = createStateStore();
      const { parent, child } = forked(store);
      const p = await parent;
      await p.set({ key: "mode", value: "final" });
      await p.set({ key: "count", value: 42 });
      await p.persist(ctx("parent", "parent"));

      const c = await child;
      await c.branch(ctx("child", "parent"));
      await c.hydrate(ctx("child", "parent"));

      expect(c.get("mode")).toBe("final");
      expect(c.get("count")).toBe(42);
      await p.close();
      await c.close();
    });

    it("leaves the parent's own cells untouched", async () => {
      const store = createStateStore();
      const { parent, child } = forked(store);
      const p = await parent;
      await p.set({ key: "mode", value: "final" });
      await p.persist(ctx("parent", "parent"));

      const c = await child;
      await c.branch(ctx("child", "parent"));
      await c.set({ key: "mode", value: "draft" });
      await c.persist(ctx("child", "parent"));
      await p.hydrate(ctx("parent", "parent"));

      expect(p.get("mode")).toBe("final");
      await p.close();
      await c.close();
    });

    it("is a no-op into a non-empty scope (a retried fork never clobbers)", async () => {
      const store = createStateStore();
      const { parent, child } = forked(store);
      const p = await parent;
      await p.set({ key: "mode", value: "final" });
      await p.persist(ctx("parent", "parent"));

      const c = await child;
      await c.branch(ctx("child", "parent"));
      await c.set({ key: "mode", value: "draft" });
      await c.persist(ctx("child", "parent"));
      await c.branch(ctx("child", "parent"));
      await c.hydrate(ctx("child", "parent"));

      expect(c.get("mode")).toBe("draft");
      await p.close();
      await c.close();
    });

    it("resolves without effect when the source scope is empty", async () => {
      const store = createStateStore();
      const c = await makeOverStore(store, stateScope("child"));

      await c.branch(ctx("child", "never-existed"));
      await c.hydrate(ctx("child", "never-existed"));

      expect(c.list()).toEqual([]);
      await c.close();
    });
  });
}
