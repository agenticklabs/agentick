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
import type { KnobsHarnessProtocol } from "@agentick/spec";

export interface KnobsHarnessFactoryDeps {
  /** Construct a fresh harness. Caller MUST await `harness.ready`. */
  readonly make: () => Promise<KnobsHarnessProtocol>;
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
}
