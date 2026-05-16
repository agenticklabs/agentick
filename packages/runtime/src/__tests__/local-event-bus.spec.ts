import { describe, expect, it } from "vitest";
import { Chunk, Effect, Fiber, Stream } from "effect";
import type { ProtocolEvent } from "@agentick/spec";
import { runEventBusConformance } from "@agentick/spec-conformance";
import { LocalEventBus } from "../substrate/local-event-bus.js";

describe("LocalEventBus — conformance", () =>
  runEventBusConformance(() => new LocalEventBus()));

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
