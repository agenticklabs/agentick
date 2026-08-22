/**
 * Conformance suite for {@link KnobsHarnessProtocol} implementations.
 *
 * Validates the contract every KnobsHarness implementation must satisfy:
 *
 *   - Sync surface: get / has / list / subscribe / subscribeAll
 *   - Async surface: set / register / dispatch
 *   - list() returns a stable reference between mutations
 *   - subscribe fires per-id; subscribeAll fires on any mutation
 *   - register preserves existing values; initializes new ones via
 *     defaultValue
 *   - dispatch validates inputs and surfaces errors as content blocks
 *
 * Alternative implementations (e.g., a redis-backed KnobsHarness for
 * cluster deployment, or a test stub) opt into this suite to prove
 * they satisfy the protocol.
 */

import { describe, expect, it } from "vitest";
import type {
  BranchCapable,
  CheckpointCapable,
  DropCapable,
  CollectionMutation,
  KnobsHarnessProtocol,
  Store,
} from "@agentick/spec";
import { stubStoreCtx } from "@agentick/store";

import {
  createKnobStore,
  knobsScope,
  knobStoreKey,
  type KnobEntry,
  type KnobStoreQuery,
} from "./store.js";

/** The value store a checkpoint-capable implementation is constructed over. */
export type KnobsConformanceStore = Store<KnobEntry, KnobStoreQuery, CollectionMutation<KnobEntry>>;

export interface KnobsHarnessFactoryDeps {
  /** Construct a fresh harness. Caller MUST await `harness.ready`. */
  readonly make: () => Promise<KnobsHarnessProtocol>;
  /**
   * Construct a harness over a CALLER-OWNED store — the seam the checkpoint and
   * branch sections need, since durability across instances requires the store
   * to outlive the harness. Omit it and both sections are skipped (an
   * implementation with no durable state has nothing to prove); supply it and
   * the implementation owes both contracts.
   */
  readonly makeOverStore?: (
    store: KnobsConformanceStore,
    scope: string,
  ) => Promise<KnobsHarnessProtocol & CheckpointCapable & BranchCapable & DropCapable>;
}

export function runKnobsHarnessConformance(deps: KnobsHarnessFactoryDeps): void {
  describe("KnobsHarness — sync surface", () => {
    it("get() returns undefined for unknown ids", async () => {
      const h = await deps.make();
      expect(h.get("missing")).toBeUndefined();
      await h.close();
    });

    it("has() reflects whether a value exists for the id", async () => {
      const h = await deps.make();
      expect(h.has("verbose")).toBe(false);
      await h.set({ id: "verbose", value: true });
      expect(h.has("verbose")).toBe(true);
      await h.close();
    });

    it("list() returns the same reference between mutations", async () => {
      const h = await deps.make();
      await h.set({ id: "verbose", value: true });
      const a = h.list();
      const b = h.list();
      expect(a).toBe(b);
      await h.close();
    });

    it("list() returns a fresh reference after a mutation", async () => {
      const h = await deps.make();
      const before = h.list();
      await h.set({ id: "verbose", value: true });
      const after = h.list();
      expect(after).not.toBe(before);
      await h.close();
    });
  });

  describe("KnobsHarness — set + subscribe", () => {
    it("set() + get() round-trip", async () => {
      const h = await deps.make();
      await h.set({ id: "mood", value: "curious" });
      expect(h.get("mood")).toBe("curious");
      await h.close();
    });

    it("subscribe() fires when the subscribed id changes", async () => {
      const h = await deps.make();
      let count = 0;
      const unsub = h.subscribe("x", () => {
        count++;
      });
      await h.set({ id: "x", value: 1 });
      await h.set({ id: "x", value: 2 });
      expect(count).toBe(2);
      unsub();
      await h.set({ id: "x", value: 3 });
      expect(count).toBe(2);
      await h.close();
    });

    it("subscribe() is id-scoped (other ids do not trigger)", async () => {
      const h = await deps.make();
      let count = 0;
      h.subscribe("x", () => {
        count++;
      });
      await h.set({ id: "y", value: "ignored" });
      expect(count).toBe(0);
      await h.close();
    });

    it("subscribeAll() fires on every mutation", async () => {
      const h = await deps.make();
      let count = 0;
      const unsub = h.subscribeAll(() => {
        count++;
      });
      await h.set({ id: "a", value: 1 });
      await h.set({ id: "b", value: 2 });
      await h.set({ id: "c", value: 3 });
      expect(count).toBe(3);
      unsub();
      await h.set({ id: "a", value: 99 });
      expect(count).toBe(3);
      await h.close();
    });

    it("subscribeAll() fires when a descriptor is registered", async () => {
      const h = await deps.make();
      let count = 0;
      h.subscribeAll(() => {
        count++;
      });
      await h.register({ id: "a", descriptor: { description: "first" } });
      await h.register({ id: "b", descriptor: { description: "second" } });
      expect(count).toBe(2);
      await h.close();
    });
  });

  describe("KnobsHarness — register", () => {
    it("attaches descriptor metadata visible via list()", async () => {
      const h = await deps.make();
      await h.register({
        id: "mood",
        descriptor: {
          description: "current mood",
          valueType: "string",
          options: ["happy", "sad"],
        },
      });
      await h.set({ id: "mood", value: "happy" });
      const mood = h.list().find((k) => k.id === "mood");
      expect(mood).toMatchObject({
        id: "mood",
        value: "happy",
        description: "current mood",
        valueType: "string",
        options: ["happy", "sad"],
      });
      await h.close();
    });

    it("initializes value to defaultValue when no value yet exists", async () => {
      const h = await deps.make();
      await h.register({
        id: "count",
        descriptor: { defaultValue: 7, valueType: "number" },
      });
      expect(h.get("count")).toBe(7);
      await h.close();
    });

    it("preserves existing value when re-registering (descriptor updates don't clobber)", async () => {
      const h = await deps.make();
      await h.set({ id: "count", value: 42 });
      await h.register({
        id: "count",
        descriptor: { defaultValue: 0, valueType: "number" },
      });
      expect(h.get("count")).toBe(42);
      await h.close();
    });

    it("re-register updates the descriptor while preserving the value", async () => {
      const h = await deps.make();
      await h.register({
        id: "mood",
        descriptor: { description: "v1", options: ["a", "b"] },
      });
      await h.set({ id: "mood", value: "a" });
      await h.register({
        id: "mood",
        descriptor: { description: "v2", options: ["a", "b", "c"] },
      });
      expect(h.get("mood")).toBe("a");
      const mood = h.list().find((k) => k.id === "mood");
      expect(mood?.description).toBe("v2");
      expect(mood?.options).toEqual(["a", "b", "c"]);
      await h.close();
    });
  });

  describe("KnobsHarness — dispatch (validated mutation)", () => {
    it("rejects when both name and group are supplied", async () => {
      const h = await deps.make();
      const result = await h.dispatch({ name: "a", group: "g", value: 1 });
      expect(result[0]).toMatchObject({ type: "text" });
      expect((result[0] as { text: string }).text).toMatch(/either name or group, not both/);
      await h.close();
    });

    it("rejects when neither name nor group is supplied", async () => {
      const h = await deps.make();
      const result = await h.dispatch({ value: 1 });
      expect((result[0] as { text: string }).text).toMatch(/Provide either name or group/);
      await h.close();
    });

    it("commits on success and returns a confirmation block", async () => {
      const h = await deps.make();
      await h.register({
        id: "mood",
        descriptor: {
          defaultValue: "curious",
          valueType: "string",
          options: ["curious", "decisive"],
        },
      });
      const result = await h.dispatch({ name: "mood", value: "decisive" });
      expect((result[0] as { text: string }).text).toMatch(/Set mood to "decisive"/);
      expect(h.get("mood")).toBe("decisive");
      await h.close();
    });

    it("rejects values failing options whitelist; state unchanged", async () => {
      const h = await deps.make();
      await h.register({
        id: "mood",
        descriptor: {
          defaultValue: "curious",
          valueType: "string",
          options: ["curious", "decisive"],
        },
      });
      const result = await h.dispatch({ name: "mood", value: "playful" });
      expect((result[0] as { text: string }).text).toMatch(/Valid options/);
      expect(h.get("mood")).toBe("curious");
      await h.close();
    });

    it("group dispatch sets every member; rejects on type mismatch", async () => {
      const h = await deps.make();
      await h.register({ id: "a", descriptor: { valueType: "boolean", group: "gates" } });
      await h.register({ id: "b", descriptor: { valueType: "boolean", group: "gates" } });
      await h.register({ id: "c", descriptor: { valueType: "string", group: "gates" } });
      const result = await h.dispatch({ group: "gates", value: true });
      expect((result[0] as { text: string }).text).toMatch(/Type mismatch in group "gates"/);
      expect(h.get("a")).toBeUndefined();
      await h.close();
    });
  });

  const makeOverStore = deps.makeOverStore;
  if (makeOverStore === undefined) return;

  describe("KnobsHarness — checkpoint (persist / hydrate)", () => {
    const ctx = (sessionId: string) => ({ sessionId, tick: 0, storeCtx: stubStoreCtx() });

    it("persist → hydrate round-trips values onto a fresh instance sharing the store", async () => {
      const store = createKnobStore();
      const first = await makeOverStore(store, "cp");
      await first.set({ id: "mood", value: "curious" });
      await first.set({ id: "limit", value: 42 });
      await first.persist(ctx("cp"));
      await first.close();

      const second = await makeOverStore(store, "cp");
      await second.hydrate(ctx("cp"));

      expect(second.get("mood")).toBe("curious");
      expect(second.get("limit")).toBe(42);
      await second.close();
    });

    it("hydrate REPLACES the projection — the store is the authority", async () => {
      const store = createKnobStore();
      const h = await makeOverStore(store, "cp-replace");
      await h.set({ id: "gone", value: 1 });
      await h.persist(ctx("cp-replace"));
      await store.mutate({ delete: knobStoreKey("cp-replace", "gone") }, stubStoreCtx());

      await h.hydrate(ctx("cp-replace"));

      expect(h.has("gone")).toBe(false);
      await h.close();
    });

    it("hydrate reads only its own scope's partition", async () => {
      const store = createKnobStore();
      const a = await makeOverStore(store, "cp-a");
      const b = await makeOverStore(store, "cp-b");
      await a.set({ id: "mood", value: "curious" });
      await a.persist(ctx("cp-a"));

      await b.hydrate(ctx("cp-b"));

      expect(b.get("mood")).toBeUndefined();
      await a.close();
      await b.close();
    });

    it("dropScope deletes its OWN partition and leaves a sibling scope alone", async () => {
      // The destroy transport (checkpointing §6). One store, two scopes: after
      // the drop, a fresh instance on the dropped scope hydrates nothing while
      // the sibling still hydrates its own cells.
      const store = createKnobStore();
      const doomed = await makeOverStore(store, "drop-doomed");
      const bystander = await makeOverStore(store, "drop-bystander");
      await doomed.set({ id: "secret", value: "classified" });
      await bystander.set({ id: "secret", value: "kept" });
      await doomed.persist(ctx("drop-doomed"));
      await bystander.persist(ctx("drop-bystander"));

      await doomed.dropScope(ctx("drop-doomed"));
      await doomed.close();
      await bystander.close();

      const reopened = await makeOverStore(store, "drop-doomed");
      await reopened.hydrate(ctx("drop-doomed"));
      expect(reopened.has("secret")).toBe(false);
      await reopened.close();

      const sibling = await makeOverStore(store, "drop-bystander");
      await sibling.hydrate(ctx("drop-bystander"));
      expect(sibling.get("secret")).toBe("kept");
      await sibling.close();
    });

    it("dropScope is idempotent — an empty partition drops cleanly", async () => {
      const h = await makeOverStore(createKnobStore(), "drop-empty");
      await expect(h.dropScope(ctx("drop-empty"))).resolves.toBeUndefined();
      await expect(h.dropScope(ctx("drop-empty"))).resolves.toBeUndefined();
      await h.close();
    });

    it("persist rejects when the store write fails", async () => {
      const boom = new Error("store unavailable");
      const store = createKnobStore();
      const failing: KnobsConformanceStore = {
        backend: store.backend,
        query: (q, c) => store.query(q, c),
        mutate: () => Promise.reject(boom),
      };
      const h = await makeOverStore(failing, "cp-fail");
      await h.set({ id: "doomed", value: 1 });

      await expect(h.persist(ctx("cp-fail"))).rejects.toBe(boom);
      await h.close();
    });
  });

  describe("KnobsHarness — branch (the fork transport)", () => {
    const ctx = (sessionId: string, fromSessionId: string) => ({
      sessionId,
      fromSessionId,
      tick: 0,
      storeCtx: stubStoreCtx(),
    });
    const forked = (store: KnobsConformanceStore) => ({
      parent: makeOverStore(store, knobsScope("parent")),
      child: makeOverStore(store, knobsScope("child")),
    });

    it("copies the source scope's cells onto the child, visible after hydrate", async () => {
      const store = createKnobStore();
      const { parent, child } = forked(store);
      const p = await parent;
      await p.set({ id: "mood", value: "curious" });
      await p.set({ id: "limit", value: 42 });
      await p.persist(ctx("parent", "parent"));

      const c = await child;
      await c.branch(ctx("child", "parent"));
      await c.hydrate(ctx("child", "parent"));

      expect(c.get("mood")).toBe("curious");
      expect(c.get("limit")).toBe(42);
      await p.close();
      await c.close();
    });

    it("leaves the parent's own cells untouched", async () => {
      const store = createKnobStore();
      const { parent, child } = forked(store);
      const p = await parent;
      await p.set({ id: "mood", value: "curious" });
      await p.persist(ctx("parent", "parent"));

      const c = await child;
      await c.branch(ctx("child", "parent"));
      await c.set({ id: "mood", value: "decisive" });
      await c.persist(ctx("child", "parent"));
      await p.hydrate(ctx("parent", "parent"));

      expect(p.get("mood")).toBe("curious");
      await p.close();
      await c.close();
    });

    it("is a no-op into a non-empty scope (a retried fork never clobbers)", async () => {
      const store = createKnobStore();
      const { parent, child } = forked(store);
      const p = await parent;
      await p.set({ id: "mood", value: "curious" });
      await p.persist(ctx("parent", "parent"));

      const c = await child;
      await c.branch(ctx("child", "parent"));
      await c.set({ id: "mood", value: "decisive" });
      await c.persist(ctx("child", "parent"));
      await c.branch(ctx("child", "parent"));
      await c.hydrate(ctx("child", "parent"));

      expect(c.get("mood")).toBe("decisive");
      await p.close();
      await c.close();
    });

    it("resolves without effect when the source scope is empty", async () => {
      const store = createKnobStore();
      const c = await makeOverStore(store, knobsScope("child"));

      await c.branch(ctx("child", "never-existed"));
      await c.hydrate(ctx("child", "never-existed"));

      expect(c.list()).toEqual([]);
      await c.close();
    });
  });
}
