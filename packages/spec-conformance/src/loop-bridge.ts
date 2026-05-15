/**
 * Conformance suite for `LoopBridge` implementations.
 *
 * Minimal surface — the bridge is two imperative entry points the loop
 * executor uses to receive component requests (`useLoopControl` →
 * `bridge.continueAfterTick()` / `bridge.stopAfterTick(reason?)`).
 *
 * The actual interpretation of those calls is the loop executor's
 * concern; the bridge is just the channel.
 */

import { describe, expect, it } from "vitest";
import type { LoopBridge } from "@agentick/spec";

export function runLoopBridgeConformance(factory: () => LoopBridge): void {
  describe("LoopBridge", () => {
    it("continueAfterTick() is callable with no args", () => {
      const bridge = factory();
      expect(() => bridge.continueAfterTick()).not.toThrow();
    });

    it("continueAfterTick(reason) accepts an optional reason", () => {
      const bridge = factory();
      expect(() => bridge.continueAfterTick("user-asked")).not.toThrow();
    });

    it("stopAfterTick() is callable with no args", () => {
      const bridge = factory();
      expect(() => bridge.stopAfterTick()).not.toThrow();
    });

    it("stopAfterTick(reason) accepts an optional reason", () => {
      const bridge = factory();
      expect(() => bridge.stopAfterTick("done")).not.toThrow();
    });
  });
}
