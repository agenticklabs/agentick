/**
 * Conformance suite for `EventBus` implementations.
 *
 * Validates the invariants in `docs/proposals/v2/blueprint/19-foundation.md`
 * §The PubSub bus. The bus is pure pub/sub — multi-subscriber,
 * fire-and-forget, with per-subscriber bounded buffers.
 */

import { describe, expect, it } from "vitest";
import { Chunk, Effect, Fiber, Stream } from "effect";
import type { EventBus, ProtocolEvent } from "@agentick/spec";

export function runEventBusConformance(factory: () => EventBus): void {
  describe("EventBus — lazy fan-out", () => {
    it("delivers to matching subscribers; ignores non-matching", async () => {
      const bus = factory();
      const fiber = Effect.runFork(
        Stream.runCollect(
          Stream.take(bus.subscribe({ surface: "tool" }), 1),
        ),
      );
      await new Promise((r) => setImmediate(r));
      await Effect.runPromise(bus.publish(ev("a", { surface: "session" })));
      await Effect.runPromise(bus.publish(ev("b", { surface: "tool" })));
      const collected = await Effect.runPromise(Fiber.join(fiber));
      const ids = Array.from(Chunk.toReadonlyArray(collected)).map((e) => e.id);
      expect(ids).toEqual(["b"]);
    });

    it("publish with no subscribers is a no-op", async () => {
      const bus = factory();
      await Effect.runPromise(bus.publish(ev("solo")));
      // No assertion needed — completing without error is the conformance.
    });
  });

  describe("EventBus — bounded buffer", () => {
    it("delivers all published events to a keeping-up subscriber", async () => {
      const bus = factory();
      const fiber = Effect.runFork(
        Stream.runCollect(Stream.take(bus.subscribe({}, { bufferSize: 256 }), 3)),
      );
      await new Promise((r) => setImmediate(r));
      await Effect.runPromise(bus.publish(ev("1")));
      await Effect.runPromise(bus.publish(ev("2")));
      await Effect.runPromise(bus.publish(ev("3")));
      const collected = await Effect.runPromise(Fiber.join(fiber));
      const ids = Array.from(Chunk.toReadonlyArray(collected)).map((e) => e.id);
      expect(ids).toEqual(["1", "2", "3"]);
    });
  });

  // Buffer-overflow semantics under fast-publisher / slow-consumer
  // conditions are impl-specific (drop-oldest vs drop-newest vs fail).
  // Reference impls exercise these scenarios in their own spec.
}

function ev(id: string, partial: Partial<ProtocolEvent> = {}): ProtocolEvent {
  return {
    id,
    surface: "session",
    name: "session:test",
    phase: "delta",
    timestamp: Date.now(),
    scope: {},
    ...partial,
  } as ProtocolEvent;
}
