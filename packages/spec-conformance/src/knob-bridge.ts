/**
 * Conformance suite for `KnobBridge` implementations.
 *
 * Invariants:
 *   - get(id) returns the current value (undefined when unset)
 *   - set(id, value) updates the value and fires subscribers
 *   - list() reports all registered ids + values
 *   - subscribe(id, listener) → unsubscribe; listener fires on set
 *   - subscribers are id-scoped (set("a", ...) doesn't fire "b" listeners)
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
  });
}
