/**
 * Conformance suite for `EventBus` implementations.
 *
 * Validates the contract: append-only log primitive (cursor-based read)
 * + bus-specific sugar (`subscribe(query)`, `publishLazy`,
 * `hasSubscriberFor`). Per Phase C of ADR 29, subscribers pull at
 * their own pace; subscribers that fall behind retention surface
 * {@link CursorEvictedError}.
 */

import { describe, expect, it } from "vitest";
import { Chunk, Effect, Fiber, Stream } from "effect";
import type { EventBus, ProtocolEvent } from "@agentick/spec";

export function runEventBusConformance(factory: () => EventBus): void {
  describe("EventBus — lazy fan-out", () => {
    it("delivers to matching subscribers; ignores non-matching", async () => {
      const bus = factory();
      const fiber = Effect.runFork(
        Stream.runCollect(Stream.take(bus.subscribe({ surface: "tool" }), 1)),
      );
      await new Promise((r) => setImmediate(r));
      await Effect.runPromise(bus.append(ev("a", { surface: "session" })));
      await Effect.runPromise(bus.append(ev("b", { surface: "tool" })));
      const collected = await Effect.runPromise(Fiber.join(fiber));
      const ids = Array.from(Chunk.toReadonlyArray(collected)).map((e) => e.id);
      expect(ids).toEqual(["b"]);
    });

    it("append with no subscribers is a no-op", async () => {
      const bus = factory();
      await Effect.runPromise(bus.append(ev("solo")));
      // No assertion needed — completing without error is the conformance.
    });
  });

  describe("EventBus — keeping-up subscriber receives every appended event", () => {
    it("delivers a sequence of appends in order", async () => {
      const bus = factory();
      const fiber = Effect.runFork(
        Stream.runCollect(Stream.take(bus.subscribe({}), 3)),
      );
      await new Promise((r) => setImmediate(r));
      await Effect.runPromise(bus.append(ev("1")));
      await Effect.runPromise(bus.append(ev("2")));
      await Effect.runPromise(bus.append(ev("3")));
      const collected = await Effect.runPromise(Fiber.join(fiber));
      const ids = Array.from(Chunk.toReadonlyArray(collected)).map((e) => e.id);
      expect(ids).toEqual(["1", "2", "3"]);
    });
  });

  describe("EventBus — appendBatch + hasSubscriberFor", () => {
    it("appendBatch delivers each event in order", async () => {
      const bus = factory();
      const fiber = Effect.runFork(
        Stream.runCollect(Stream.take(bus.subscribe({}), 3)),
      );
      await new Promise((r) => setImmediate(r));
      await Effect.runPromise(bus.appendBatch([ev("1"), ev("2"), ev("3")]));
      const collected = await Effect.runPromise(Fiber.join(fiber));
      const ids = Array.from(Chunk.toReadonlyArray(collected)).map((e) => e.id);
      expect(ids).toEqual(["1", "2", "3"]);
    });

    it("hasSubscriberFor returns false with no subscribers", () => {
      const bus = factory();
      expect(bus.hasSubscriberFor({ surface: "tool", name: "tool:x" })).toBe(false);
    });

    it("hasSubscriberFor reflects matching subscriber", async () => {
      const bus = factory();
      const fiber = Effect.runFork(Stream.runDrain(bus.subscribe({ surface: "tool" })));
      await new Promise((r) => setImmediate(r));
      expect(bus.hasSubscriberFor({ surface: "tool", name: "tool:x" })).toBe(true);
      expect(bus.hasSubscriberFor({ surface: "session", name: "session:x" })).toBe(false);
      await Effect.runPromise(Fiber.interrupt(fiber));
    });
  });

  // Cursor semantics + eviction are exercised in the impl-specific spec
  // (the reference LocalEventBus carries the ring buffer; alternative
  // impls may carry different retention shapes). Conformance focuses on
  // contract invariants every impl must satisfy.
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
