/**
 * Conformance suite for `KnobBridge` implementations.
 *
 * Invariants:
 *   - get(id) returns the current value (undefined when unset)
 *   - set(id, value) updates the value and fires subscribers
 *   - list() reports every registered id with descriptor + current value
 *   - subscribe(id, listener) → unsubscribe; listener fires on set
 *   - subscribers are id-scoped (set("a", …) doesn't fire "b" listeners)
 *   - subscribeAll(listener) fires on ANY value or descriptor change
 *   - register(id, descriptor) attaches metadata and initializes value
 *     to descriptor.defaultValue when no value yet exists
 *   - register(id, …) on an already-valued id preserves the value
 */

import { describe, expect, it } from "vitest";
import type { KnobBridge } from "@agentick/spec";

export function runKnobBridgeConformance(factory: () => KnobBridge): void {
  describe("KnobBridge", () => {
    it("get() returns undefined for unknown ids", () => {
      const bridge = factory();
      expect(bridge.get("missing")).toBeUndefined();
    });

    it("set() + get() round-trip", () => {
      const bridge = factory();
      bridge.set("mood", "curious");
      expect(bridge.get("mood")).toBe("curious");
    });

    it("list() reports all set values", () => {
      const bridge = factory();
      bridge.set("a", 1);
      bridge.set("b", 2);
      const items = bridge.list();
      const map = Object.fromEntries(items.map((i) => [i.id, i.value]));
      expect(map.a).toBe(1);
      expect(map.b).toBe(2);
    });

    it("subscribe() fires when the subscribed id changes", () => {
      const bridge = factory();
      let count = 0;
      const unsub = bridge.subscribe("x", () => {
        count++;
      });
      bridge.set("x", 1);
      bridge.set("x", 2);
      expect(count).toBe(2);
      unsub();
      bridge.set("x", 3);
      expect(count).toBe(2);
    });

    it("subscribe() is id-scoped (other ids do not trigger)", () => {
      const bridge = factory();
      let count = 0;
      bridge.subscribe("x", () => {
        count++;
      });
      bridge.set("y", "anything");
      expect(count).toBe(0);
    });

    it("multiple subscribers on the same id all fire", () => {
      const bridge = factory();
      let a = 0;
      let b = 0;
      bridge.subscribe("k", () => {
        a++;
      });
      bridge.subscribe("k", () => {
        b++;
      });
      bridge.set("k", 1);
      expect(a).toBe(1);
      expect(b).toBe(1);
    });

    it("subscribeAll() fires on every value change", () => {
      const bridge = factory();
      let count = 0;
      const unsub = bridge.subscribeAll(() => {
        count++;
      });
      bridge.set("a", 1);
      bridge.set("b", 2);
      bridge.set("c", 3);
      expect(count).toBe(3);
      unsub();
      bridge.set("a", 99);
      expect(count).toBe(3);
    });

    it("subscribeAll() fires when a descriptor is registered", () => {
      const bridge = factory();
      let count = 0;
      bridge.subscribeAll(() => {
        count++;
      });
      bridge.register("a", { description: "first" });
      bridge.register("b", { description: "second" });
      expect(count).toBe(2);
    });

    it("register() attaches descriptor metadata visible via list()", () => {
      const bridge = factory();
      bridge.register("mood", {
        description: "current mood",
        valueType: "string",
        options: ["happy", "sad"],
      });
      bridge.set("mood", "happy");
      const items = bridge.list();
      const mood = items.find((i) => i.id === "mood");
      expect(mood).toMatchObject({
        id: "mood",
        value: "happy",
        description: "current mood",
        valueType: "string",
        options: ["happy", "sad"],
      });
    });

    it("register() initializes value to defaultValue when no value yet exists", () => {
      const bridge = factory();
      bridge.register("count", { defaultValue: 7, valueType: "number" });
      expect(bridge.get("count")).toBe(7);
    });

    it("register() preserves an existing value (descriptor updates don't clobber)", () => {
      const bridge = factory();
      bridge.set("count", 42);
      bridge.register("count", { defaultValue: 0, valueType: "number" });
      expect(bridge.get("count")).toBe(42);
    });

    it("register() called twice updates the descriptor without losing value", () => {
      const bridge = factory();
      bridge.register("mood", { description: "v1", options: ["a", "b"] });
      bridge.set("mood", "a");
      bridge.register("mood", { description: "v2", options: ["a", "b", "c"] });
      expect(bridge.get("mood")).toBe("a");
      const mood = bridge.list().find((i) => i.id === "mood");
      expect(mood?.description).toBe("v2");
      expect(mood?.options).toEqual(["a", "b", "c"]);
    });
  });
}
