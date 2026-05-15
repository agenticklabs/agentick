import { describe, expect, it } from "vitest";
import type { ProtocolEvent } from "@agentick/spec";
import { LocalEventBus } from "../substrate/local-event-bus.js";

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

describe("LocalEventBus", () => {
  it("publishes to matching subscribers only (lazy fan-out)", async () => {
    const bus = new LocalEventBus();
    const ctrl = new AbortController();
    const iter = bus.subscribe({ surface: "tool" }, { signal: ctrl.signal });
    const it1 = iter[Symbol.asyncIterator]();
    const pending = it1.next();
    await bus.publish(ev("a", { surface: "session" })); // no match
    await bus.publish(ev("b", { surface: "tool" })); // match
    const result = await pending;
    expect(result.done).toBe(false);
    if (!result.done) expect(result.value.id).toBe("b");
    ctrl.abort();
  });

  it("buffers up to bufferSize then drops oldest by default", async () => {
    const bus = new LocalEventBus();
    const iter = bus.subscribe({}, { bufferSize: 2 });
    const it1 = iter[Symbol.asyncIterator]();
    await bus.publish(ev("1"));
    await bus.publish(ev("2"));
    await bus.publish(ev("3"));
    const a = await it1.next();
    const b = await it1.next();
    expect([a.value!.id, b.value!.id]).toEqual(["2", "3"]);
    await it1.return?.();
  });

  it("subscriber abort terminates the iterable", async () => {
    const bus = new LocalEventBus();
    const ctrl = new AbortController();
    const iter = bus.subscribe({}, { signal: ctrl.signal });
    const it1 = iter[Symbol.asyncIterator]();
    const pending = it1.next();
    ctrl.abort();
    const result = await pending;
    expect(result.done).toBe(true);
  });

  it("no subscribers → publish is a no-op", async () => {
    const bus = new LocalEventBus();
    await bus.publish(ev("solo"));
    expect(bus.subscriberCount()).toBe(0);
  });
});
