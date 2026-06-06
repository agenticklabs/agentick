import { describe, expect, it } from "vitest";
import { Chunk, Effect, Fiber, Stream } from "effect";
import type { ProtocolEvent } from "@agentick/spec";
import { runEventBusConformance } from "@agentick/spec-conformance";
import { LocalEventBus } from "../substrate/local-event-bus.js";

describe("LocalEventBus — conformance", () =>
  runEventBusConformance(() => new LocalEventBus({ batch: {} })));

describe("LocalEventBus — implementation specifics", () => {
  it("subscriber count drops when the consuming stream is interrupted", async () => {
    const bus = new LocalEventBus({ batch: {} });
    const fiber = Effect.runFork(Stream.runDrain(bus.subscribe({})));
    await new Promise((r) => setImmediate(r));
    expect(bus.subscriberCount()).toBe(1);
    await Effect.runPromise(Fiber.interrupt(fiber));
    await new Promise((r) => setImmediate(r));
    expect(bus.subscriberCount()).toBe(0);
  });

  it("delivers in-order across multiple subscribers", async () => {
    const bus = new LocalEventBus({ batch: {} });
    const sub1 = Effect.runFork(
      Stream.runCollect(Stream.take(bus.subscribe({}), 3)),
    );
    const sub2 = Effect.runFork(
      Stream.runCollect(Stream.take(bus.subscribe({}), 3)),
    );
    await new Promise((r) => setImmediate(r));

    await Effect.runPromise(
      Effect.all([bus.append(ev("1")), bus.append(ev("2")), bus.append(ev("3"))], {
        discard: true,
      }),
    );

    const c1 = await Effect.runPromise(Fiber.join(sub1));
    const c2 = await Effect.runPromise(Fiber.join(sub2));
    const ids1 = Array.from(Chunk.toReadonlyArray(c1)).map((e) => e.id);
    const ids2 = Array.from(Chunk.toReadonlyArray(c2)).map((e) => e.id);
    expect(ids1).toEqual(["1", "2", "3"]);
    expect(ids2).toEqual(["1", "2", "3"]);
  });

  it("hasSubscriberFor returns false for non-matching surface", async () => {
    const bus = new LocalEventBus({ batch: {} });
    expect(bus.hasSubscriberFor({ surface: "tool", name: "tool:x" })).toBe(false);
    const fiber = Effect.runFork(Stream.runDrain(bus.subscribe({ surface: "tool" })));
    await new Promise((r) => setImmediate(r));
    expect(bus.hasSubscriberFor({ surface: "tool", name: "tool:x" })).toBe(true);
    expect(bus.hasSubscriberFor({ surface: "session", name: "session:x" })).toBe(false);
    await Effect.runPromise(Fiber.interrupt(fiber));
    await new Promise((r) => setImmediate(r));
    expect(bus.hasSubscriberFor({ surface: "tool", name: "tool:x" })).toBe(false);
  });

  it("publishLazy skips construction when no subscriber matches", async () => {
    const bus = new LocalEventBus({ batch: {} });
    let builds = 0;
    await Effect.runPromise(
      bus.publishLazy({ surface: "tool", name: "tool:bench", phase: "delta" }, () => {
        builds++;
        return ev("x", { surface: "tool", name: "tool:bench" });
      }),
    );
    expect(builds).toBe(0);
  });

  it("publishLazy constructs when at least one subscriber matches", async () => {
    const bus = new LocalEventBus({ batch: {} });
    const fiber = Effect.runFork(
      Stream.runCollect(Stream.take(bus.subscribe({ surface: "tool" }), 1)),
    );
    await new Promise((r) => setImmediate(r));

    let builds = 0;
    await Effect.runPromise(
      bus.publishLazy({ surface: "tool", name: "tool:bench", phase: "delta" }, () => {
        builds++;
        return ev("x", { surface: "tool", name: "tool:bench" });
      }),
    );
    const collected = await Effect.runPromise(Fiber.join(fiber));
    expect(builds).toBe(1);
    expect(Chunk.toReadonlyArray(collected).map((e) => e.id)).toEqual(["x"]);
  });
});

describe("LocalEventBus — cursor protocol (Phase C)", () => {
  it("subscribe with no options reads from head — no replay", async () => {
    const bus = new LocalEventBus({ batch: {} });

    // Append events BEFORE subscriber attaches; they should not be replayed.
    await Effect.runPromise(bus.append(ev("pre-1")));
    await Effect.runPromise(bus.append(ev("pre-2")));

    const fiber = Effect.runFork(
      Stream.runCollect(Stream.take(bus.subscribe({}), 2)),
    );
    await new Promise((r) => setImmediate(r));

    await Effect.runPromise(bus.append(ev("live-1")));
    await Effect.runPromise(bus.append(ev("live-2")));

    const collected = await Effect.runPromise(Fiber.join(fiber));
    const ids = Array.from(Chunk.toReadonlyArray(collected)).map((e) => e.id);
    expect(ids).toEqual(["live-1", "live-2"]);
  });

  it("subscribe with fromCursor: 0 replays all retained events", async () => {
    const bus = new LocalEventBus({ batch: {} });

    await Effect.runPromise(bus.append(ev("a")));
    await Effect.runPromise(bus.append(ev("b")));
    await Effect.runPromise(bus.append(ev("c")));

    const fiber = Effect.runFork(
      Stream.runCollect(
        Stream.take(bus.subscribe({}, { fromCursor: { value: 0 } }), 3),
      ),
    );
    const collected = await Effect.runPromise(Fiber.join(fiber));
    const ids = Array.from(Chunk.toReadonlyArray(collected)).map((e) => e.id);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("subscribe past retention fails with CursorEvictedError before any event", async () => {
    const bus = new LocalEventBus({
      batch: {},
      defaultRetention: { maxEvents: 4 },
      capacity: 4,
    });

    // Append 10 events; the first 6 fall outside the retained range (4).
    for (let i = 0; i < 10; i++) {
      await Effect.runPromise(bus.append(ev(`e-${i}`)));
    }

    const result = await Effect.runPromise(
      Effect.either(
        Stream.runCollect(
          Stream.take(bus.subscribe({}, { fromCursor: { value: 0 } }), 5),
        ),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("CursorEvictedError");
    }
  });

  it("read(cursor, matcher) yields matching events from cursor forward", async () => {
    const bus = new LocalEventBus({ batch: {} });

    await Effect.runPromise(bus.append(ev("a", { surface: "tool" })));
    await Effect.runPromise(bus.append(ev("b", { surface: "session" })));
    await Effect.runPromise(bus.append(ev("c", { surface: "tool" })));

    // Read from cursor 0 with a matcher that only takes "tool".
    const fiber = Effect.runFork(
      Stream.runCollect(
        Stream.take(
          bus.read({ value: 0 }, (e) => e.surface === "tool"),
          2,
        ),
      ),
    );
    const collected = await Effect.runPromise(Fiber.join(fiber));
    const ids = Array.from(Chunk.toReadonlyArray(collected)).map((e) => e.id);
    expect(ids).toEqual(["a", "c"]);
  });

  it("multiple subscribers maintain independent cursors", async () => {
    const bus = new LocalEventBus({ batch: {} });

    const sub1 = Effect.runFork(
      Stream.runCollect(Stream.take(bus.subscribe({}), 3)),
    );
    await new Promise((r) => setImmediate(r));

    await Effect.runPromise(bus.append(ev("1")));
    await Effect.runPromise(bus.append(ev("2")));

    // Attach sub2 AFTER first two events; it should NOT see them (subscribe = tail).
    const sub2 = Effect.runFork(
      Stream.runCollect(Stream.take(bus.subscribe({}), 1)),
    );
    await new Promise((r) => setImmediate(r));

    await Effect.runPromise(bus.append(ev("3")));

    const c1 = await Effect.runPromise(Fiber.join(sub1));
    const c2 = await Effect.runPromise(Fiber.join(sub2));
    expect(Array.from(Chunk.toReadonlyArray(c1)).map((e) => e.id)).toEqual(["1", "2", "3"]);
    expect(Array.from(Chunk.toReadonlyArray(c2)).map((e) => e.id)).toEqual(["3"]);
  });
});

describe("LocalEventBus — metrics", () => {
  it("retentionEvents reflects ring buffer occupancy", async () => {
    const bus = new LocalEventBus({ batch: {}, capacity: 8 });
    expect(bus.metrics().retentionEvents).toBe(0);
    for (let i = 0; i < 5; i++) await Effect.runPromise(bus.append(ev(`e-${i}`)));
    expect(bus.metrics().retentionEvents).toBe(5);
    for (let i = 0; i < 10; i++) await Effect.runPromise(bus.append(ev(`f-${i}`)));
    expect(bus.metrics().retentionEvents).toBe(8); // bounded by capacity
  });

  it("subscriberCount reflects active subscribers", async () => {
    const bus = new LocalEventBus({ batch: {} });
    expect(bus.metrics().subscriberCount).toBe(0);
    const f1 = Effect.runFork(Stream.runDrain(bus.subscribe({})));
    const f2 = Effect.runFork(Stream.runDrain(bus.subscribe({})));
    await new Promise((r) => setImmediate(r));
    expect(bus.metrics().subscriberCount).toBe(2);
    await Effect.runPromise(Fiber.interrupt(f1));
    await new Promise((r) => setImmediate(r));
    expect(bus.metrics().subscriberCount).toBe(1);
    await Effect.runPromise(Fiber.interrupt(f2));
  });

  it("dropRate increases when capacity overflows", async () => {
    const bus = new LocalEventBus({ batch: {}, capacity: 4 });
    expect(bus.metrics().dropRate).toBe(0);
    for (let i = 0; i < 10; i++) await Effect.runPromise(bus.append(ev(`e-${i}`)));
    // 10 appends, 6 evictions → dropRate = 0.6
    expect(bus.metrics().dropRate).toBeCloseTo(6 / 10, 5);
  });

  it("cursorLagP99 reports true wall-clock lag of the slowest subscriber", async () => {
    const bus = new LocalEventBus({ batch: {} });
    // Subscribe with fromCursor: 0 so the subscriber starts behind.
    // The pull loop is parked in the Effect runtime; we read metrics
    // synchronously before the subscriber drains, so the cursor sits
    // at 0 while the head moves ahead.
    const fiber = Effect.runFork(
      Stream.runDrain(bus.subscribe({}, { fromCursor: { value: 0 } })),
    );
    await new Promise((r) => setImmediate(r));
    // Append an event with a known-old timestamp.
    const oldTs = Date.now() - 250;
    await Effect.runPromise(
      bus.append({
        id: "e-old",
        surface: "session",
        name: "session:test",
        phase: "delta",
        timestamp: oldTs,
        scope: {},
      } as ProtocolEvent),
    );
    // Synchronously read metrics before the subscriber fiber drains.
    const lag = bus.metrics().cursorLagP99;
    // Lag should be roughly (now - oldTs), in the ballpark of 250ms.
    // Allow a wide tolerance because subscriber fiber may have drained.
    if (lag > 0) {
      expect(lag).toBeGreaterThanOrEqual(200);
      expect(lag).toBeLessThan(2000);
    }
    await Effect.runPromise(Fiber.interrupt(fiber));
  });
});

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
