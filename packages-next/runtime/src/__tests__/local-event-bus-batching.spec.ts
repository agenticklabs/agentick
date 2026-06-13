/**
 * LocalEventBus — Phase B per-surface batching tests.
 *
 * Covers: default policy, count-trigger, time-trigger, both compose,
 * no-policy fast path, adopter override, wildcard vs exact key
 * precedence, publishBatch direct path, fan-in batching, close drains
 * pending, empty policy disables batching.
 *
 * @see docs/proposals/v2/blueprint/29-bus-overhaul.md §Phase B
 */

import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import type { EventPhase, EventSurface, ProtocolEvent } from "@agentick/spec-next";
import { DEFAULT_LOCAL_BUS_BATCH_POLICY, LocalEventBus } from "../substrate/local-event-bus.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flush = () => new Promise((r) => setImmediate(r));

function ev(
  id: string,
  surface: EventSurface = "executor",
  phase: EventPhase = "delta",
  partial: Partial<ProtocolEvent> = {},
): ProtocolEvent {
  return {
    id,
    surface,
    name: `${surface}:${phase}`,
    phase,
    timestamp: Date.now(),
    scope: {},
    ...partial,
  } as ProtocolEvent;
}

/**
 * Collect every event from `bus.subscribe(query)` into an array. The
 * fiber stays running until `dispose()` is called.
 */
function collect(bus: LocalEventBus, surface?: EventSurface) {
  const received: ProtocolEvent[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(bus.subscribe(surface ? { surface } : {}), (e) =>
      Effect.sync(() => {
        received.push(e);
      }),
    ),
  );
  return {
    received,
    dispose: async () => {
      await Effect.runPromise(Effect.interrupt.pipe(Effect.fork)); // no-op; rely on bus.close to shut the queue
      void fiber;
    },
  };
}

describe("LocalEventBus — default batch policy", () => {
  it("executor:delta — count trigger flushes when 4 events accumulate", async () => {
    const bus = new LocalEventBus();
    const c = collect(bus, "executor");
    await flush();

    // Three publishes do NOT flush yet (count threshold = 4).
    await Effect.runPromise(bus.append(ev("1")));
    await Effect.runPromise(bus.append(ev("2")));
    await Effect.runPromise(bus.append(ev("3")));
    await flush();
    expect(c.received).toHaveLength(0);
    expect(bus.pendingBatchedCount()).toBe(3);

    // The fourth publish trips the count trigger and flushes.
    await Effect.runPromise(bus.append(ev("4")));
    await flush();
    expect(c.received.map((e) => e.id)).toEqual(["1", "2", "3", "4"]);
    expect(bus.pendingBatchedCount()).toBe(0);

    bus.close();
  });

  it("executor:delta — time trigger flushes after 8ms even below count cap", async () => {
    const bus = new LocalEventBus();
    const c = collect(bus, "executor");
    await flush();

    await Effect.runPromise(bus.append(ev("1")));
    await flush();
    // Pending — count threshold (4) not reached; timer set for 8ms.
    expect(c.received).toHaveLength(0);
    expect(bus.pendingBatchedCount()).toBe(1);

    await wait(20);
    expect(c.received.map((e) => e.id)).toEqual(["1"]);
    expect(bus.pendingBatchedCount()).toBe(0);

    bus.close();
  });

  it("time-only policy (no count cap) flushes purely on the timer", async () => {
    // Time-only shape — adopter declares `flushAfterMs` with no
    // `flushAfterCount`. Pick a non-default surface/phase so the test
    // is independent of which defaults the bus ships.
    const bus = new LocalEventBus({
      batch: { "tool:terminal": { flushAfterMs: 30 } },
    });
    const c = collect(bus, "tool");
    await flush();

    await Effect.runPromise(bus.append(ev("a", "tool", "terminal")));
    await Effect.runPromise(bus.append(ev("b", "tool", "terminal")));
    await Effect.runPromise(bus.append(ev("c", "tool", "terminal")));
    await flush();
    expect(c.received).toHaveLength(0);
    expect(bus.pendingBatchedCount()).toBe(3);

    await wait(50);
    expect(c.received.map((e) => e.id)).toEqual(["a", "b", "c"]);

    bus.close();
  });
});

describe("LocalEventBus — adopter policy override", () => {
  it("custom exact key — flushes via count trigger", async () => {
    const bus = new LocalEventBus({
      batch: { "tool:delta": { flushAfterCount: 2 } },
    });
    const c = collect(bus, "tool");
    await flush();

    await Effect.runPromise(bus.append(ev("t1", "tool")));
    await flush();
    expect(c.received).toHaveLength(0);

    await Effect.runPromise(bus.append(ev("t2", "tool")));
    await flush();
    expect(c.received.map((e) => e.id)).toEqual(["t1", "t2"]);

    bus.close();
  });

  it("custom exact key — time-only trigger", async () => {
    const bus = new LocalEventBus({
      batch: { "tool:delta": { flushAfterMs: 20 } },
    });
    const c = collect(bus, "tool");
    await flush();

    await Effect.runPromise(bus.append(ev("t1", "tool")));
    await flush();
    expect(c.received).toHaveLength(0);

    await wait(40);
    expect(c.received.map((e) => e.id)).toEqual(["t1"]);

    bus.close();
  });

  it("wildcard `<surface>:*` matches every phase under that surface", async () => {
    const bus = new LocalEventBus({
      batch: { "tool:*": { flushAfterCount: 3 } },
    });
    const c = collect(bus, "tool");
    await flush();

    await Effect.runPromise(bus.append(ev("a", "tool", "before")));
    await Effect.runPromise(bus.append(ev("b", "tool", "delta")));
    await flush();
    expect(c.received).toHaveLength(0);

    await Effect.runPromise(bus.append(ev("c", "tool", "terminal")));
    await flush();
    expect(c.received.map((e) => e.id)).toEqual(["a", "b", "c"]);

    bus.close();
  });

  it("exact key wins over wildcard for the same surface", async () => {
    const bus = new LocalEventBus({
      batch: {
        "tool:*": { flushAfterMs: 1000 }, // 1s — should NOT be used
        "tool:delta": { flushAfterCount: 2 }, // exact — wins
      },
    });
    const c = collect(bus, "tool");
    await flush();

    await Effect.runPromise(bus.append(ev("d1", "tool", "delta")));
    await Effect.runPromise(bus.append(ev("d2", "tool", "delta")));
    await flush();
    // Exact policy fired immediately; if wildcard had won we'd still be
    // waiting on the 1s timer.
    expect(c.received.map((e) => e.id)).toEqual(["d1", "d2"]);

    bus.close();
  });

  it("empty policy `{}` disables batching entirely (immediate publish)", async () => {
    const bus = new LocalEventBus({ batch: {} });
    const c = collect(bus, "executor");
    await flush();

    await Effect.runPromise(bus.append(ev("x", "executor", "delta")));
    await flush();
    // No batching → subscriber sees the event without waiting on a timer
    // or count threshold.
    expect(c.received.map((e) => e.id)).toEqual(["x"]);
    expect(bus.pendingBatchedCount()).toBe(0);

    bus.close();
  });
});

describe("LocalEventBus — non-batched fast path", () => {
  it("surface/phase with no policy entry publishes immediately", async () => {
    const bus = new LocalEventBus({ batch: {} });
    const c = collect(bus, "session");
    await flush();

    await Effect.runPromise(bus.append(ev("a", "session", "terminal")));
    await flush();
    expect(c.received.map((e) => e.id)).toEqual(["a"]);
  });
});

describe("LocalEventBus — publishBatch direct path", () => {
  it("delivers events without going through the accumulator", async () => {
    const bus = new LocalEventBus(); // default policy includes executor:delta batching
    const c = collect(bus, "executor");
    await flush();

    await Effect.runPromise(bus.appendBatch([ev("a"), ev("b"), ev("c"), ev("d"), ev("e")]));
    await flush();
    // Caller-supplied batch bypasses the accumulator — all 5 events
    // delivered immediately, no time-window or count-cap effects.
    expect(c.received.map((e) => e.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(bus.pendingBatchedCount()).toBe(0);
  });

  it("publishBatch of empty array is a no-op", async () => {
    const bus = new LocalEventBus();
    const c = collect(bus, "executor");
    await flush();

    await Effect.runPromise(bus.appendBatch([]));
    await flush();
    expect(c.received).toHaveLength(0);
  });
});

describe("LocalEventBus — fan-in to parent under batching", () => {
  it("parent sees events at flush time (not at publish time)", async () => {
    const parent = new LocalEventBus({ batch: {} }); // parent does not re-batch
    const child = new LocalEventBus({
      parent,
      batch: { "executor:delta": { flushAfterMs: 20, flushAfterCount: 100 } },
    });

    const parentReceived: ProtocolEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(parent.subscribe({ surface: "executor" }), (e) =>
        Effect.sync(() => {
          parentReceived.push(e);
        }),
      ),
    );
    await flush();

    await Effect.runPromise(child.append(ev("1")));
    await Effect.runPromise(child.append(ev("2")));
    await flush();

    // Child has batched; parent must not have seen them yet either.
    expect(parentReceived).toHaveLength(0);

    await wait(40);
    // After the child's flush timer fires, parent receives both events
    // via the upstream forwarding path (prefers publishBatch).
    expect(parentReceived.map((e) => e.id)).toEqual(["1", "2"]);

    void fiber;
    child.close();
    parent.close();
  });
});

describe("LocalEventBus — close drains pending batches", () => {
  it("pending events deliver before subscriber queue shuts down", async () => {
    const bus = new LocalEventBus({
      batch: { "executor:delta": { flushAfterMs: 10_000 } }, // long timer so we KNOW the drain triggers it
    });
    const received: ProtocolEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(bus.subscribe({ surface: "executor" }), (e) =>
        Effect.sync(() => {
          received.push(e);
        }),
      ),
    );
    await flush();

    await Effect.runPromise(bus.append(ev("a")));
    await Effect.runPromise(bus.append(ev("b")));
    await flush();
    expect(received).toHaveLength(0);
    expect(bus.pendingBatchedCount()).toBe(2);

    bus.close();
    // Drain is fire-and-forget via Effect.runFork — give the runtime a
    // tick to deliver before asserting.
    await wait(10);
    expect(received.map((e) => e.id)).toEqual(["a", "b"]);
    void fiber;
  });
});

describe("LocalEventBus — DEFAULT_LOCAL_BUS_BATCH_POLICY shape", () => {
  it("targets only executor:delta — every other key is adopter-supplied", () => {
    expect(DEFAULT_LOCAL_BUS_BATCH_POLICY).toEqual({
      "executor:delta": { flushAfterMs: 8, flushAfterCount: 4 },
    });
  });

  it("adopters can spread defaults and add entries", () => {
    // Anchor the spread to the declared shape — TS narrows on literal
    // spread otherwise, losing the inherited "executor:delta" key from
    // the union after pattern-matching.
    const policy: Readonly<Record<string, { flushAfterCount?: number; flushAfterMs?: number }>> = {
      ...DEFAULT_LOCAL_BUS_BATCH_POLICY,
      "tool:delta": { flushAfterCount: 16 },
    };
    expect(policy["executor:delta"]).toBeDefined();
    expect(policy["tool:delta"]?.flushAfterCount).toBe(16);
  });
});

describe("LocalEventBus — count trigger preserves Effect.publish semantics", () => {
  it("count-trigger flush is awaited by the caller's Effect", async () => {
    const bus = new LocalEventBus({
      batch: { "tool:delta": { flushAfterCount: 2 } },
    });
    const c = collect(bus, "tool");
    await flush();

    await Effect.runPromise(bus.append(ev("a", "tool")));
    // The second publish's Effect carries the synchronous flush — by
    // the time `await` returns, the fan-out has happened. (Compare:
    // time-trigger flush completes on a setTimeout callback, so the
    // caller's Effect resolves before subscribers see anything.)
    await Effect.runPromise(bus.append(ev("b", "tool")));
    await flush(); // give subscriber fiber a tick to drain its Queue
    expect(c.received.map((e) => e.id)).toEqual(["a", "b"]);
  });
});
