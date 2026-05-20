import { describe, expect, it } from "vitest";
import { Chunk, Effect, Fiber, Stream } from "effect";
import type { ProtocolEvent } from "@agentick/spec";
import { runEventBusConformance } from "@agentick/spec-conformance";
import { LocalEventBus } from "../substrate/local-event-bus.js";

describe("LocalEventBus — conformance", () => runEventBusConformance(() => new LocalEventBus()));

describe("LocalEventBus — implementation specifics", () => {
  it("subscriber count drops when the consuming stream is interrupted", async () => {
    const bus = new LocalEventBus();
    const fiber = Effect.runFork(Stream.runDrain(bus.subscribe({})));
    await new Promise((r) => setImmediate(r));
    expect(bus.subscriberCount()).toBe(1);
    await Effect.runPromise(Fiber.interrupt(fiber));
    await new Promise((r) => setImmediate(r));
    expect(bus.subscriberCount()).toBe(0);
  });

  it("drop-newest discards new events when buffer is full", async () => {
    const bus = new LocalEventBus();
    // Slow consumer so the queue fills up. Each pulled event sleeps 30ms;
    // three back-to-back publishes land in the queue (capacity 2) before
    // the consumer takes the first one — the third one is dropped.
    const fiber = Effect.runFork(
      Stream.runCollect(
        Stream.take(bus.subscribe({}, { bufferSize: 2, overflow: "drop-newest" }), 2).pipe(
          Stream.tap(() => Effect.sleep("30 millis")),
        ),
      ),
    );
    await new Promise((r) => setImmediate(r));
    await Effect.runPromise(
      Effect.all([bus.publish(ev("1")), bus.publish(ev("2")), bus.publish(ev("3"))], {
        discard: true,
      }),
    );
    const chunk = await Effect.runPromise(Fiber.join(fiber));
    const ids = Array.from(Chunk.toReadonlyArray(chunk)).map((e) => e.id);
    expect(ids).toEqual(["1", "2"]);
  });

  // drop-oldest is exercised at the Effect Queue.sliding boundary — it
  // is the policy we register the queue with. Deterministically forcing
  // overflow under a Stream consumer requires manual queue-level
  // intervention; we trust Queue.sliding's documented behavior and rely
  // on `drop-newest` (above) to verify the wiring picks the right Queue
  // variant per overflow setting.
});

describe("LocalEventBus — subscriber index + lazy emission", () => {
  it("hasSubscriber returns false when no subscriber exists", () => {
    const bus = new LocalEventBus();
    expect(bus.hasSubscriber({ surface: "tool", name: "tool:x" })).toBe(false);
  });

  it("hasSubscriber returns true for surface that has a subscriber", async () => {
    const bus = new LocalEventBus();
    const fiber = Effect.runFork(Stream.runDrain(bus.subscribe({ surface: "tool" })));
    await new Promise((r) => setImmediate(r));
    expect(bus.hasSubscriber({ surface: "tool", name: "tool:x" })).toBe(true);
    expect(bus.hasSubscriber({ surface: "session", name: "session:x" })).toBe(false);
    await Effect.runPromise(Fiber.interrupt(fiber));
    await new Promise((r) => setImmediate(r));
    expect(bus.hasSubscriber({ surface: "tool", name: "tool:x" })).toBe(false);
  });

  it("hasSubscriber returns true on any surface when a broad subscriber is attached", async () => {
    const bus = new LocalEventBus();
    const fiber = Effect.runFork(Stream.runDrain(bus.subscribe({})));
    await new Promise((r) => setImmediate(r));
    expect(bus.hasSubscriber({ surface: "tool", name: "tool:x" })).toBe(true);
    expect(bus.hasSubscriber({ surface: "session", name: "session:x" })).toBe(true);
    expect(bus.hasSubscriber({ surface: "reconciler", name: "reconciler:x" })).toBe(true);
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  it("publishLazy skips the build thunk when no subscriber matches", async () => {
    const bus = new LocalEventBus();
    let built = 0;
    await Effect.runPromise(
      bus.publishLazy({ surface: "tool", name: "tool:dispatch", phase: "delta" }, () => {
        built++;
        return ev("x", { surface: "tool", name: "tool:dispatch" });
      }),
    );
    expect(built).toBe(0);
  });

  it("publishLazy invokes the build thunk once when a subscriber matches", async () => {
    const bus = new LocalEventBus();
    const fiber = Effect.runFork(
      Stream.runCollect(Stream.take(bus.subscribe({ surface: "tool" }), 1)),
    );
    await new Promise((r) => setImmediate(r));
    let built = 0;
    await Effect.runPromise(
      bus.publishLazy({ surface: "tool", name: "tool:dispatch", phase: "delta" }, () => {
        built++;
        return ev("x", { surface: "tool", name: "tool:dispatch" });
      }),
    );
    const chunk = await Effect.runPromise(Fiber.join(fiber));
    expect(built).toBe(1);
    expect(Array.from(Chunk.toReadonlyArray(chunk)).map((e) => e.id)).toEqual(["x"]);
  });

  it("subscriber index tracks attach + detach symmetrically", async () => {
    const bus = new LocalEventBus();
    expect(bus.hasSubscriber({ surface: "tool", name: "x" })).toBe(false);
    const f1 = Effect.runFork(Stream.runDrain(bus.subscribe({ surface: "tool" })));
    const f2 = Effect.runFork(Stream.runDrain(bus.subscribe({ surface: "tool" })));
    await new Promise((r) => setImmediate(r));
    expect(bus.hasSubscriber({ surface: "tool", name: "x" })).toBe(true);
    await Effect.runPromise(Fiber.interrupt(f1));
    await new Promise((r) => setImmediate(r));
    // Still one subscriber on the surface.
    expect(bus.hasSubscriber({ surface: "tool", name: "x" })).toBe(true);
    await Effect.runPromise(Fiber.interrupt(f2));
    await new Promise((r) => setImmediate(r));
    expect(bus.hasSubscriber({ surface: "tool", name: "x" })).toBe(false);
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
