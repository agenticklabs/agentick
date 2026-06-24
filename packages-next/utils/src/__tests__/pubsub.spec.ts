import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { createKeyedNotifier, createLocalPubSub, createNotifier } from "../pubsub.js";

describe("createNotifier — Layer 1 (single-channel observer)", () => {
  it("delivers parameterless notify() to every subscriber", () => {
    const n = createNotifier();
    const calls: string[] = [];
    n.subscribe(() => calls.push("a"));
    n.subscribe(() => calls.push("b"));
    n.notify();
    expect(calls).toEqual(["a", "b"]);
  });

  it("delivers typed payload to subscribers when T != void", () => {
    const n = createNotifier<{ readonly count: number }>();
    let last = -1;
    n.subscribe((s) => {
      last = s.count;
    });
    n.notify({ count: 42 });
    expect(last).toBe(42);
  });

  it("unsubscribe removes only the matching listener", () => {
    const n = createNotifier();
    const calls: string[] = [];
    const offA = n.subscribe(() => calls.push("a"));
    n.subscribe(() => calls.push("b"));
    offA();
    n.notify();
    expect(calls).toEqual(["b"]);
  });

  it("tolerates listener errors (isolation)", () => {
    const n = createNotifier();
    const calls: string[] = [];
    n.subscribe(() => {
      throw new Error("boom");
    });
    n.subscribe(() => calls.push("ok"));
    expect(() => n.notify()).not.toThrow();
    expect(calls).toEqual(["ok"]);
  });

  it("tolerates mid-iteration unsubscribe", () => {
    const n = createNotifier();
    const calls: string[] = [];
    let off2: (() => void) | undefined;
    n.subscribe(() => {
      calls.push("a");
      off2?.();
    });
    off2 = n.subscribe(() => calls.push("b"));
    n.subscribe(() => calls.push("c"));
    n.notify();
    // `b` was snapshotted into the iteration list before being removed.
    expect(calls).toEqual(["a", "b", "c"]);
    calls.length = 0;
    n.notify();
    expect(calls).toEqual(["a", "c"]);
  });

  it("size reflects active listeners", () => {
    const n = createNotifier();
    expect(n.size).toBe(0);
    const off = n.subscribe(() => {});
    n.subscribe(() => {});
    expect(n.size).toBe(2);
    off();
    expect(n.size).toBe(1);
  });

  it("clear() drops every subscriber", () => {
    const n = createNotifier();
    const calls: string[] = [];
    n.subscribe(() => calls.push("a"));
    n.subscribe(() => calls.push("b"));
    n.clear();
    expect(n.size).toBe(0);
    n.notify();
    expect(calls).toEqual([]);
  });
});

describe("createKeyedNotifier — Layer 2 (keyed + wildcards)", () => {
  it("notify(key) fires keyed bucket then wildcards", () => {
    const n = createKeyedNotifier();
    const order: string[] = [];
    n.subscribe("a", () => order.push("a:1"));
    n.subscribe("a", () => order.push("a:2"));
    n.subscribe("b", () => order.push("b:1"));
    n.subscribeAll(() => order.push("*"));
    n.notify("a");
    expect(order).toEqual(["a:1", "a:2", "*"]);
  });

  it("notify(key) on unknown key fires only wildcards", () => {
    const n = createKeyedNotifier();
    const order: string[] = [];
    n.subscribeAll(() => order.push("*"));
    n.notify("missing");
    expect(order).toEqual(["*"]);
  });

  it("typed payload reaches keyed and wildcard listeners", () => {
    type Ev = { readonly tag: string };
    const n = createKeyedNotifier<string, Ev>();
    const keyed: Ev[] = [];
    const wild: Ev[] = [];
    n.subscribe("x", (e) => keyed.push(e));
    n.subscribeAll((e) => wild.push(e));
    n.notify("x", { tag: "hi" });
    expect(keyed).toEqual([{ tag: "hi" }]);
    expect(wild).toEqual([{ tag: "hi" }]);
  });

  it("auto-collects empty buckets on last unsubscribe", () => {
    const n = createKeyedNotifier();
    const offA = n.subscribe("a", () => {});
    const offB = n.subscribe("a", () => {});
    expect(n.count("a")).toBe(2);
    offA();
    expect(n.count("a")).toBe(1);
    offB();
    expect(n.count("a")).toBe(0);
    expect(n.size).toBe(0);
  });

  it("size accounts for keyed + wildcards", () => {
    const n = createKeyedNotifier();
    n.subscribe("a", () => {});
    n.subscribe("a", () => {});
    n.subscribe("b", () => {});
    n.subscribeAll(() => {});
    expect(n.count("a")).toBe(2);
    expect(n.count("b")).toBe(1);
    expect(n.wildcardCount).toBe(1);
    expect(n.size).toBe(4);
  });

  it("clear() drops keyed + wildcard subscribers", () => {
    const n = createKeyedNotifier();
    const calls: string[] = [];
    n.subscribe("a", () => calls.push("a"));
    n.subscribeAll(() => calls.push("*"));
    n.clear();
    expect(n.size).toBe(0);
    expect(n.wildcardCount).toBe(0);
    n.notify("a");
    n.notifyAll();
    expect(calls).toEqual([]);
  });

  it("notifyAll fires wildcards only (keyed subscribers untouched)", () => {
    const n = createKeyedNotifier();
    const calls: string[] = [];
    n.subscribe("a", () => calls.push("a"));
    n.subscribe("b", () => calls.push("b"));
    n.subscribeAll(() => calls.push("*"));
    n.notifyAll();
    expect(calls).toEqual(["*"]);
  });

  it("notifyAsync awaits each listener serially", async () => {
    type Ev = { readonly n: number };
    const n = createKeyedNotifier<string, Ev>();
    const order: string[] = [];
    n.subscribe("k", async (e) => {
      await Promise.resolve();
      order.push(`first:${e.n}`);
    });
    n.subscribe("k", async (e) => {
      await Promise.resolve();
      order.push(`second:${e.n}`);
    });
    n.subscribeAll(async (e) => {
      await Promise.resolve();
      order.push(`*:${e.n}`);
    });
    await n.notifyAsync("k", { n: 1 });
    expect(order).toEqual(["first:1", "second:1", "*:1"]);
  });

  it("notifyAsync propagates listener errors", async () => {
    const n = createKeyedNotifier<string, void>();
    n.subscribe("k", () => {
      throw new Error("boom");
    });
    await expect(n.notifyAsync("k")).rejects.toThrow("boom");
  });

  it("sync notify swallows listener errors (isolation)", () => {
    const n = createKeyedNotifier();
    const calls: string[] = [];
    n.subscribe("k", () => {
      throw new Error("boom");
    });
    n.subscribe("k", () => calls.push("ok"));
    n.subscribeAll(() => calls.push("*"));
    expect(() => n.notify("k")).not.toThrow();
    expect(calls).toEqual(["ok", "*"]);
  });
});

describe("createLocalPubSub — Layer 3 (Effect.PubSub-backed Stream fan-out)", () => {
  it("delivers published events to a subscriber", async () => {
    const bus = createLocalPubSub<number>();
    const received: number[] = [];

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        bus.subscribe().pipe(
          Stream.take(3),
          Stream.runForEach((n) => Effect.sync(() => received.push(n))),
        ),
      );
      // Wait for subscriber to be active before publishing.
      yield* Effect.sleep("10 millis");
      bus.publish(1);
      bus.publish(2);
      bus.publish(3);
      yield* fiber;
    });

    await Effect.runPromise(program);
    expect(received).toEqual([1, 2, 3]);
    await bus.close();
  });

  it("fans out to multiple subscribers independently", async () => {
    const bus = createLocalPubSub<string>();
    const a: string[] = [];
    const b: string[] = [];

    const program = Effect.gen(function* () {
      const fa = yield* Effect.fork(
        bus.subscribe().pipe(
          Stream.take(2),
          Stream.runForEach((s) => Effect.sync(() => a.push(s))),
        ),
      );
      const fb = yield* Effect.fork(
        bus.subscribe().pipe(
          Stream.take(2),
          Stream.runForEach((s) => Effect.sync(() => b.push(s))),
        ),
      );
      yield* Effect.sleep("10 millis");
      bus.publish("x");
      bus.publish("y");
      yield* fa;
      yield* fb;
    });

    await Effect.runPromise(program);
    expect(a).toEqual(["x", "y"]);
    expect(b).toEqual(["x", "y"]);
    await bus.close();
  });

  it("filter predicate trims subscriber view", async () => {
    type Ev = { readonly kind: "a" | "b"; readonly n: number };
    const bus = createLocalPubSub<Ev>();
    const aOnly: number[] = [];

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        bus
          .subscribe((e) => e.kind === "a")
          .pipe(
            Stream.take(2),
            Stream.runForEach((e) => Effect.sync(() => aOnly.push(e.n))),
          ),
      );
      yield* Effect.sleep("10 millis");
      bus.publish({ kind: "b", n: 0 });
      bus.publish({ kind: "a", n: 1 });
      bus.publish({ kind: "b", n: 2 });
      bus.publish({ kind: "a", n: 3 });
      yield* fiber;
    });

    await Effect.runPromise(program);
    expect(aOnly).toEqual([1, 3]);
    await bus.close();
  });

  it("subscriberCount tracks active subscribers", async () => {
    const bus = createLocalPubSub<number>();
    expect(bus.subscriberCount).toBe(0);

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(bus.subscribe().pipe(Stream.take(1), Stream.runDrain));
      yield* Effect.sleep("10 millis");
      // Cross fiber boundary — subscriberCount visible to caller.
      const seen = bus.subscriberCount;
      bus.publish(1);
      yield* fiber;
      return seen;
    });

    const seenWhileActive = await Effect.runPromise(program);
    expect(seenWhileActive).toBe(1);
    // After the subscriber's scope releases the count returns to 0.
    expect(bus.subscriberCount).toBe(0);
    await bus.close();
  });

  it("close() shuts the pub/sub down — subsequent publishes are no-ops", async () => {
    const bus = createLocalPubSub<number>();
    await bus.close();
    // No throw; future publishes simply drop.
    expect(() => bus.publish(1)).not.toThrow();
    // Idempotent close.
    await bus.close();
  });
});
