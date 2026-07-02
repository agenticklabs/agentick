import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ProtocolEvent } from "@agentick/spec-next";
import { waitFor, waitForStable } from "@agentick/utils-next/testing";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { forkBusSubscription } from "../substrate/fork-bus-subscription.js";

describe("forkBusSubscription", () => {
  it("delivers matching events to the listener, in order", async () => {
    const bus = new LocalEventBus({ batch: {} });
    const received: string[] = [];
    const unsub = forkBusSubscription(bus, {}, (event) => {
      received.push(event.id);
    });
    await waitFor(() => bus.subscriberCount() === 1);

    await Effect.runPromise(
      Effect.all([bus.append(ev("1")), bus.append(ev("2")), bus.append(ev("3"))], {
        discard: true,
      }),
    );

    await waitFor(() => received.length === 3, { description: "3 events delivered" });
    expect(received).toEqual(["1", "2", "3"]);
    unsub();
  });

  it("respects the filter — non-matching events are not delivered", async () => {
    const bus = new LocalEventBus({ batch: {} });
    const received: string[] = [];
    const unsub = forkBusSubscription(bus, { surface: "tool" }, (event) => {
      received.push(event.id);
    });
    await waitFor(() => bus.subscriberCount() === 1);

    await Effect.runPromise(bus.append(ev("session-ev", { surface: "session" })));
    await Effect.runPromise(bus.append(ev("tool-ev", { surface: "tool", name: "tool:x" })));

    await waitFor(() => received.length === 1, { description: "matching event delivered" });
    await waitForStable(() => received.length);
    expect(received).toEqual(["tool-ev"]);
    unsub();
  });

  it("isolates a REJECTING async listener per-event — the Effect.promise regression", async () => {
    // The bug this helper exists to prevent: `Effect.promise` treats a
    // listener rejection as a fiber-killing defect — one bad event
    // silently stops all future delivery. Async rejection is the exact
    // failure mode that shipped in the gateway installer's hand-rolled
    // copy.
    const bus = new LocalEventBus({ batch: {} });
    const received: string[] = [];
    const unsub = forkBusSubscription(bus, {}, async (event) => {
      received.push(event.id);
      if (event.id === "1") throw new Error("listener rejects on first event");
    });
    await waitFor(() => bus.subscriberCount() === 1);

    await Effect.runPromise(bus.append(ev("1")));
    await Effect.runPromise(bus.append(ev("2")));

    await waitFor(() => received.length === 2, {
      description: "delivery survives a rejecting listener",
    });
    expect(received).toEqual(["1", "2"]);
    unsub();
  });

  it("isolates a THROWING sync listener per-event", async () => {
    const bus = new LocalEventBus({ batch: {} });
    const received: string[] = [];
    const unsub = forkBusSubscription(bus, {}, (event) => {
      received.push(event.id);
      throw new Error("sync throw every event");
    });
    await waitFor(() => bus.subscriberCount() === 1);

    await Effect.runPromise(bus.append(ev("1")));
    await Effect.runPromise(bus.append(ev("2")));

    await waitFor(() => received.length === 2, {
      description: "delivery survives a throwing listener",
    });
    expect(received).toEqual(["1", "2"]);
    unsub();
  });

  it("unsubscribe stops delivery — deterministic via subscriberCount", async () => {
    // `Fiber.interrupt` is async under a sync Unsubscribe thunk, so
    // "publish immediately after unsub" would race. subscriberCount()
    // dropping to 0 IS the interruption having completed — poll it,
    // then publish, then assert stability.
    const bus = new LocalEventBus({ batch: {} });
    const received: string[] = [];
    const unsub = forkBusSubscription(bus, {}, (event) => {
      received.push(event.id);
    });
    await waitFor(() => bus.subscriberCount() === 1);

    await Effect.runPromise(bus.append(ev("1")));
    await waitFor(() => received.length === 1);

    unsub();
    await waitFor(() => bus.subscriberCount() === 0, {
      description: "fiber interrupted (subscription released)",
    });

    await Effect.runPromise(bus.append(ev("2")));
    await waitForStable(() => received.length);
    expect(received).toEqual(["1"]);
  });

  it("unsubscribe is idempotent", async () => {
    const bus = new LocalEventBus({ batch: {} });
    const unsub = forkBusSubscription(bus, {}, () => {});
    await waitFor(() => bus.subscriberCount() === 1);
    unsub();
    await waitFor(() => bus.subscriberCount() === 0);
    expect(() => unsub()).not.toThrow();
  });

  it("multiple subscriptions are independent — unsubscribing one leaves the other live", async () => {
    const bus = new LocalEventBus({ batch: {} });
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = forkBusSubscription(bus, {}, (event) => {
      a.push(event.id);
    });
    const unsubB = forkBusSubscription(bus, {}, (event) => {
      b.push(event.id);
    });
    await waitFor(() => bus.subscriberCount() === 2);

    unsubA();
    await waitFor(() => bus.subscriberCount() === 1);

    await Effect.runPromise(bus.append(ev("1")));
    await waitFor(() => b.length === 1, { description: "surviving subscription delivers" });
    await waitForStable(() => a.length);
    expect(a).toEqual([]);
    expect(b).toEqual(["1"]);
    unsubB();
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
