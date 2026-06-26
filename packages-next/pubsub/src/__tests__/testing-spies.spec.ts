/**
 * Tests for the `/testing` spy doubles. Each spy MUST behave as a
 * working notifier (listeners fire, state tracked correctly) AND
 * record every notify/publish call for assertion.
 */

import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { spyKeyedNotifier, spyLocalPubSub, spyNotifier } from "../testing/index.js";

describe("spyNotifier", () => {
  it("records every notify() call for a void notifier", () => {
    const spy = spyNotifier();
    spy.notify();
    spy.notify();
    expect(spy.callCount).toBe(2);
    expect(spy.calls).toHaveLength(2);
  });

  it("records typed values for a typed notifier", () => {
    const spy = spyNotifier<{ tick: number }>();
    spy.notify({ tick: 1 });
    spy.notify({ tick: 2 });
    expect(spy.calls).toEqual([{ tick: 1 }, { tick: 2 }]);
  });

  it("still fires subscribers normally", () => {
    const spy = spyNotifier<string>();
    const received: string[] = [];
    spy.subscribe((s) => {
      received.push(s);
    });
    spy.notify("hello");
    spy.notify("world");
    expect(received).toEqual(["hello", "world"]);
  });

  it("size reflects active subscribers", () => {
    const spy = spyNotifier();
    expect(spy.size).toBe(0);
    const off = spy.subscribe(() => {});
    expect(spy.size).toBe(1);
    off();
    expect(spy.size).toBe(0);
  });

  it("reset() clears recorded calls but keeps subscribers", () => {
    const spy = spyNotifier<number>();
    const received: number[] = [];
    spy.subscribe((n) => {
      received.push(n);
    });
    spy.notify(1);
    spy.reset();
    expect(spy.callCount).toBe(0);
    spy.notify(2);
    expect(spy.calls).toEqual([2]);
    // Subscriber still active across reset.
    expect(received).toEqual([1, 2]);
  });
});

describe("spyKeyedNotifier", () => {
  it("records notify(key) for void", () => {
    const spy = spyKeyedNotifier();
    spy.notify("a");
    spy.notify("b");
    expect(spy.calls).toEqual([
      { kind: "notify", key: "a", value: undefined },
      { kind: "notify", key: "b", value: undefined },
    ]);
  });

  it("records notify(key, value) for typed", () => {
    type Ev = { delta: number };
    const spy = spyKeyedNotifier<string, Ev>();
    spy.notify("counter", { delta: 1 });
    spy.notify("counter", { delta: 2 });
    expect(spy.calls).toEqual([
      { kind: "notify", key: "counter", value: { delta: 1 } },
      { kind: "notify", key: "counter", value: { delta: 2 } },
    ]);
  });

  it("records notifyAll() distinctly", () => {
    const spy = spyKeyedNotifier();
    spy.notify("a");
    spy.notifyAll();
    expect(spy.calls.map((c) => c.kind)).toEqual(["notify", "notifyAll"]);
  });

  it("records notifyAsync() distinctly + awaits listeners", async () => {
    type Ev = { tag: string };
    const spy = spyKeyedNotifier<string, Ev>();
    const received: string[] = [];
    spy.subscribe("k", async (e) => {
      await Promise.resolve();
      received.push(e.tag);
    });
    await spy.notifyAsync("k", { tag: "x" });
    expect(spy.calls).toEqual([{ kind: "notifyAsync", key: "k", value: { tag: "x" } }]);
    expect(received).toEqual(["x"]);
  });

  it("callsFor(key) filters by key", () => {
    const spy = spyKeyedNotifier();
    spy.notify("a");
    spy.notify("b");
    spy.notify("a");
    expect(spy.callsFor("a")).toHaveLength(2);
    expect(spy.callsFor("b")).toHaveLength(1);
  });

  it("still fires keyed + wildcard subscribers", () => {
    const spy = spyKeyedNotifier();
    const keyed: string[] = [];
    const wild: string[] = [];
    spy.subscribe("a", () => {
      keyed.push("a");
    });
    spy.subscribeAll(() => {
      wild.push("*");
    });
    spy.notify("a");
    spy.notify("b");
    expect(keyed).toEqual(["a"]);
    expect(wild).toEqual(["*", "*"]);
  });

  it("count / wildcardCount / size pass through", () => {
    const spy = spyKeyedNotifier();
    spy.subscribe("a", () => {});
    spy.subscribe("a", () => {});
    spy.subscribeAll(() => {});
    expect(spy.count("a")).toBe(2);
    expect(spy.wildcardCount).toBe(1);
    expect(spy.size).toBe(3);
  });

  it("reset() clears recorded calls but keeps subscribers", () => {
    const spy = spyKeyedNotifier();
    spy.subscribe("a", () => {});
    spy.notify("a");
    spy.reset();
    expect(spy.callCount).toBe(0);
    spy.notify("a");
    expect(spy.callCount).toBe(1);
    expect(spy.count("a")).toBe(1); // subscriber survived
  });
});

describe("spyLocalPubSub", () => {
  it("records every published event", async () => {
    const spy = spyLocalPubSub<{ id: number }>();
    spy.publish({ id: 1 });
    spy.publish({ id: 2 });
    expect(spy.publishCalls).toEqual([{ id: 1 }, { id: 2 }]);
    expect(spy.publishCallCount).toBe(2);
    await spy.close();
  });

  it("still delivers events to active subscribers", async () => {
    const spy = spyLocalPubSub<string>();
    const received: string[] = [];

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        spy.subscribe().pipe(
          Stream.take(2),
          Stream.runForEach((s) =>
            Effect.sync(() => {
              received.push(s);
            }),
          ),
        ),
      );
      yield* Effect.sleep("10 millis");
      spy.publish("hello");
      spy.publish("world");
      yield* fiber;
    });

    await Effect.runPromise(program);
    expect(received).toEqual(["hello", "world"]);
    expect(spy.publishCalls).toEqual(["hello", "world"]);
    await spy.close();
  });

  it("reset() clears recorded publishes; further publishes record", async () => {
    const spy = spyLocalPubSub<number>();
    spy.publish(1);
    spy.publish(2);
    spy.reset();
    expect(spy.publishCallCount).toBe(0);
    spy.publish(3);
    expect(spy.publishCalls).toEqual([3]);
    await spy.close();
  });

  it("subscriberCount passes through", async () => {
    const spy = spyLocalPubSub<number>();
    expect(spy.subscriberCount).toBe(0);

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(spy.subscribe().pipe(Stream.take(1), Stream.runDrain));
      yield* Effect.sleep("10 millis");
      const seen = spy.subscriberCount;
      spy.publish(1);
      yield* fiber;
      return seen;
    });

    const seenWhileActive = await Effect.runPromise(program);
    expect(seenWhileActive).toBe(1);
    await spy.close();
  });
});
