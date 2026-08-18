import { describe, expect, it } from "vitest";
import { Chunk, Effect, Fiber, Stream } from "effect";
import type { ProtocolEvent } from "@agentick/spec";
import { LocalEventBus } from "../substrate/local-event-bus.js";

/**
 * Production-shaped stress and edge cases for the bus wake path.
 *
 * Motivated by the 2026-08-18 assistant-api outage: an indiscriminate
 * subscriber wake made every append cost O(subscribers) fiber
 * round-trips, which unit-scale tests (2–3 subscribers) can never
 * surface. These specs run at the shape that killed production:
 * hundreds of parked subscribers, thousands of appends.
 */

const settle = () => new Promise((r) => setImmediate(r));

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

describe("LocalEventBus — production-shaped load", () => {
  it("200 parked non-matching subscribers do not amplify a 5k-event burst", async () => {
    const bus = new LocalEventBus({ batch: {}, capacity: 16_384 });

    // 200 subscribers on a surface that never fires, plus one real consumer.
    const parked = Array.from({ length: 200 }, () =>
      Effect.runFork(Stream.runCollect(Stream.take(bus.subscribe({ surface: "tool" }), 1))),
    );
    const consumer = Effect.runFork(
      Stream.runCollect(Stream.take(bus.subscribe({ surface: "session" }), 5_000)),
    );
    await settle();

    const started = Date.now();
    for (let i = 0; i < 5_000; i++) {
      await Effect.runPromise(bus.append(ev(`e${i}`)));
    }
    const collected = await Effect.runPromise(Fiber.join(consumer));
    const elapsed = Date.now() - started;

    expect(Chunk.size(collected)).toBe(5_000);
    // Pre-fix this shape is ~1M fiber wake/park round-trips (measured
    // 641ms); targeted wake makes it ~1M matcher predicate calls
    // (measured 131ms). The generous bound exists to catch the
    // complexity class coming back, not to benchmark.
    expect(elapsed).toBeLessThan(2_500);

    // The parked subscribers are still live and deliverable.
    await Effect.runPromise(bus.append(ev("t", { surface: "tool", name: "tool:x" })));
    for (const fiber of parked) {
      const got = await Effect.runPromise(Fiber.join(fiber));
      expect(Chunk.toReadonlyArray(got).map((e) => e.id)).toEqual(["t"]);
    }
  });

  it("interleaved matching and non-matching bursts deliver exactly the matching set, in order", async () => {
    const bus = new LocalEventBus({ batch: {}, capacity: 8_192 });
    const consumer = Effect.runFork(
      Stream.runCollect(Stream.take(bus.subscribe({ surface: "tool" }), 50)),
    );
    await settle();

    const expected: string[] = [];
    for (let i = 0; i < 50; i++) {
      for (let j = 0; j < 20; j++) {
        await Effect.runPromise(bus.append(ev(`noise-${i}-${j}`)));
      }
      const id = `tool-${i}`;
      expected.push(id);
      await Effect.runPromise(bus.append(ev(id, { surface: "tool", name: "tool:x" })));
    }

    const collected = await Effect.runPromise(Fiber.join(consumer));
    expect(Chunk.toReadonlyArray(collected).map((e) => e.id)).toEqual(expected);
  });
});

describe("LocalEventBus — wake-path edges", () => {
  it("ring wrap landing exactly on a parked subscriber's cursor does not strand it", async () => {
    const capacity = 8;
    const bus = new LocalEventBus({
      batch: {},
      capacity,
      defaultRetention: { maxEvents: capacity },
    });
    const consumer = Effect.runFork(
      Stream.runCollect(Stream.take(bus.subscribe({ surface: "tool" }), 1)),
    );
    await settle();

    // Append exactly `capacity` non-matching events: head - capacity ==
    // the subscriber's original cursor, the tightest wrap boundary.
    for (let i = 0; i < capacity; i++) {
      await Effect.runPromise(bus.append(ev(`s${i}`)));
    }
    await Effect.runPromise(bus.append(ev("t", { surface: "tool", name: "tool:x" })));

    const collected = await Effect.runPromise(Fiber.join(consumer));
    expect(Chunk.toReadonlyArray(collected).map((e) => e.id)).toEqual(["t"]);
  });

  it("subscriber churn during an append storm neither loses deliveries nor leaks subscribers", async () => {
    const bus = new LocalEventBus({ batch: {}, capacity: 16_384 });

    // Waves of short-lived subscribers, each attaching mid-storm and
    // consuming 5 events from the 200 appended while it is live.
    for (let wave = 0; wave < 10; wave++) {
      const fibers = Array.from({ length: 20 }, () =>
        Effect.runFork(Stream.runCollect(Stream.take(bus.subscribe({ surface: "session" }), 5))),
      );
      await settle();
      for (let i = 0; i < 200; i++) {
        await Effect.runPromise(bus.append(ev(`e${wave}-${i}`)));
      }
      for (const f of fibers) {
        const got = await Effect.runPromise(Fiber.join(f));
        expect(Chunk.size(got)).toBe(5);
      }
    }

    await settle();
    expect(bus.subscriberCount()).toBe(0);
  });

  it("close() while non-matching subscribers are parked terminates their streams cleanly", async () => {
    const bus = new LocalEventBus({ batch: {} });
    const parked = Array.from({ length: 50 }, () =>
      Effect.runFork(Stream.runCollect(bus.subscribe({ surface: "tool" }))),
    );
    await settle();

    for (let i = 0; i < 20; i++) {
      await Effect.runPromise(bus.append(ev(`s${i}`)));
    }
    bus.close();

    for (const fiber of parked) {
      const got = await Effect.runPromise(Fiber.join(fiber));
      expect(Chunk.size(got)).toBe(0);
    }
  });

  it("fan-in: a child-bus storm reaches only the parent subscribers whose matcher matches", async () => {
    const parent = new LocalEventBus({ batch: {}, capacity: 8_192 });
    const child = new LocalEventBus({ batch: {}, parent, capacity: 8_192 });

    const parentTool = Effect.runFork(
      Stream.runCollect(Stream.take(parent.subscribe({ surface: "tool" }), 1)),
    );
    const parentSession = Effect.runFork(
      Stream.runCollect(Stream.take(parent.subscribe({ surface: "session" }), 1_000)),
    );
    await settle();

    for (let i = 0; i < 1_000; i++) {
      await Effect.runPromise(child.append(ev(`e${i}`)));
    }
    const sessions = await Effect.runPromise(Fiber.join(parentSession));
    expect(Chunk.size(sessions)).toBe(1_000);

    await Effect.runPromise(child.append(ev("t", { surface: "tool", name: "tool:x" })));
    const tools = await Effect.runPromise(Fiber.join(parentTool));
    expect(Chunk.toReadonlyArray(tools).map((e) => e.id)).toEqual(["t"]);
  });
});
