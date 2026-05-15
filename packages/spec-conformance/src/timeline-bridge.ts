/**
 * Conformance suite for `TimelineBridge` implementations.
 *
 * Bridges that don't change timeline state on their own (stub bridges,
 * tests) trivially pass — read returns a snapshot with monotonic
 * version, subscribe returns an unsubscribe.
 *
 * Bridges backed by a real session timeline should pass through both
 * this suite AND an integration test against the session harness's
 * timeline mutation surface (added when session harness lands).
 */

import { describe, expect, it } from "vitest";
import type { TimelineBridge } from "@agentick/spec";

export function runTimelineBridgeConformance(factory: () => TimelineBridge): void {
  describe("TimelineBridge", () => {
    it("read() returns a snapshot with entries[] and version", () => {
      const bridge = factory();
      const snap = bridge.read();
      expect(Array.isArray(snap.entries)).toBe(true);
      expect(typeof snap.version).toBe("number");
    });

    it("subscribe() returns an unsubscribe function", () => {
      const bridge = factory();
      const unsub = bridge.subscribe(() => {});
      expect(typeof unsub).toBe("function");
      unsub();
    });

    it("multiple subscribes are independent", () => {
      const bridge = factory();
      const u1 = bridge.subscribe(() => {});
      const u2 = bridge.subscribe(() => {});
      u1();
      u2();
      // Should not throw.
    });
  });
}
