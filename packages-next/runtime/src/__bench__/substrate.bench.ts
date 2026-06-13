/**
 * Substrate hot-path benchmarks.
 *
 * Tracks the budgets documented in
 * `docs/proposals/v2/blueprint/17-open-questions.md` §Substrate
 * scalability + observability. Run with:
 *
 *   pnpm vitest bench --run packages/runtime/src/__bench__/substrate.bench.ts
 *
 * Targets (mean time per op):
 *
 *   runOperation (empty body):        < 10 μs
 *   bus.publish (no subscribers):     <  1 μs
 *   bus.publish (1 subscriber):       <  5 μs
 *   bus.publishLazy (no match):       <  1 μs (lazy fast path)
 *   journal.append:                   <  5 μs
 *
 * Each bench callback measures exactly one substrate operation against
 * pre-built fixtures created in describe-scope. The framework iterates
 * many times to amortize jitter; the `mean` column is per-op cost.
 */

import { Effect, Fiber, Stream } from "effect";
import type {
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  Operation,
  OperationJournal,
  ProtocolEvent,
} from "@agentick/spec-next";
import { afterAll, bench, describe } from "vitest";

import { MemoryJournal } from "../substrate/memory-journal.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { LocalChannelPublisher } from "../substrate/local-channel-publisher.js";
import { BaseHarness } from "../substrate/base-harness.js";
import { compileQuery, matchesQuery } from "../substrate/query.js";

function mkEvent(id: string, overrides: Partial<ProtocolEvent> = {}): ProtocolEvent {
  return {
    id,
    surface: "tool",
    name: "tool:bench:event",
    phase: "delta",
    timestamp: Date.now(),
    scope: { sessionId: "s_bench" },
    ...overrides,
  } as ProtocolEvent;
}

class BenchHarness extends BaseHarness<"tool"> {
  constructor(scopeId: string, journal: OperationJournal, bus: EventBus, inbox: MessageInbox) {
    super("tool", scopeId, journal, bus, inbox);
  }

  runEmpty(opId: string): Promise<number> {
    const op: Operation<undefined, number> = {
      opId,
      surface: "tool",
      name: "tool:bench:noop",
      scope: { sessionId: "s_bench" },
      input: undefined,
    };
    return Effect.runPromise(this.runOperation(op, () => Effect.succeed(1)));
  }

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.succeed(undefined);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// bus.publish — no subscribers (lazy fan-out fast path)
// ─────────────────────────────────────────────────────────────────────────────

describe("bus.publish — no subscribers", () => {
  const bus = new LocalEventBus();
  const event = mkEvent("e");

  bench("publish, no listeners", async () => {
    await Effect.runPromise(bus.append(event));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bus.publish — 1 subscriber on a matching surface
// ─────────────────────────────────────────────────────────────────────────────

describe("bus.publish — 1 matching subscriber", () => {
  const bus = new LocalEventBus();
  const event = mkEvent("e");
  let consumer: Fiber.RuntimeFiber<void, unknown> | undefined;
  let started = false;

  afterAll(async () => {
    if (consumer) await Effect.runPromise(Fiber.interrupt(consumer));
  });

  bench("publish, 1 matching subscriber", async () => {
    if (!started) {
      consumer = Effect.runFork(Stream.runDrain(bus.subscribe({ surface: "tool" })));
      await new Promise((r) => setImmediate(r));
      started = true;
    }
    await Effect.runPromise(bus.append(event));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bus.publish — 1 subscriber on a NON-matching surface (index short-circuit)
// ─────────────────────────────────────────────────────────────────────────────

describe("bus.publish — 1 non-matching subscriber", () => {
  const bus = new LocalEventBus();
  const event = mkEvent("e", { surface: "tool" });
  let consumer: Fiber.RuntimeFiber<void, unknown> | undefined;
  let started = false;

  afterAll(async () => {
    if (consumer) await Effect.runPromise(Fiber.interrupt(consumer));
  });

  bench("publish, 1 non-matching subscriber", async () => {
    if (!started) {
      consumer = Effect.runFork(Stream.runDrain(bus.subscribe({ surface: "session" })));
      await new Promise((r) => setImmediate(r));
      started = true;
    }
    await Effect.runPromise(bus.append(event));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bus.publishLazy — lazy emission savings
// ─────────────────────────────────────────────────────────────────────────────

describe("bus.publishLazy — lazy emission", () => {
  const bus = new LocalEventBus();

  bench("publishLazy, no subscribers (build SKIPPED)", async () => {
    await Effect.runPromise(
      bus.publishLazy({ surface: "tool", name: "tool:bench" }, () => mkEvent("e")),
    );
  });
});

describe("bus.publishLazy — lazy emission with subscriber", () => {
  const bus = new LocalEventBus();
  let consumer: Fiber.RuntimeFiber<void, unknown> | undefined;
  let started = false;

  afterAll(async () => {
    if (consumer) await Effect.runPromise(Fiber.interrupt(consumer));
  });

  bench("publishLazy, 1 subscriber (build RUNS)", async () => {
    if (!started) {
      consumer = Effect.runFork(Stream.runDrain(bus.subscribe({ surface: "tool" })));
      await new Promise((r) => setImmediate(r));
      started = true;
    }
    await Effect.runPromise(
      bus.publishLazy({ surface: "tool", name: "tool:bench" }, () => mkEvent("e")),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// journal.append
// ─────────────────────────────────────────────────────────────────────────────

describe("journal.append — fresh opIds", () => {
  const journal = new MemoryJournal({ capacity: 1_000_000 });
  let counter = 0;

  bench("append, unique opIds", async () => {
    counter++;
    await Effect.runPromise(
      journal.append(mkEvent(`u-${counter}`, { opId: `op-${counter}`, phase: "requested" })),
    );
  });
});

describe("journal.append — idempotent dedup", () => {
  const journal = new MemoryJournal({ capacity: 1_000_000 });
  const dupEvent = mkEvent("seed", { opId: "op-dup", phase: "requested" });
  Effect.runSync(journal.append(dupEvent));

  bench("append, repeated (opId, phase)", async () => {
    await Effect.runPromise(journal.append(dupEvent));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inbox.send
// ─────────────────────────────────────────────────────────────────────────────

describe("inbox.send — fresh messageIds", () => {
  const inbox = new LocalInbox();
  Effect.runSync(inbox.register("bench:addr", () => Effect.succeed(undefined)));
  let counter = 0;

  bench("send, fresh messageIds", async () => {
    counter++;
    await Effect.runPromise(
      inbox.send("bench:addr", {
        type: "ping",
        messageId: `m-${counter}`,
      }),
    );
  });
});

describe("inbox.send — idempotent replay", () => {
  const inbox = new LocalInbox();
  Effect.runSync(inbox.register("bench:addr2", () => Effect.succeed(undefined)));
  const msg = {
    type: "ping",
    messageId: "m-dup",
  };
  Effect.runSync(inbox.send("bench:addr2", msg));

  bench("send, same messageId (cache hit)", async () => {
    await Effect.runPromise(inbox.send("bench:addr2", msg));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BaseHarness.runOperation — the full phase contract overhead
// ─────────────────────────────────────────────────────────────────────────────

describe("runOperation — empty body, fresh opIds", () => {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const h = new BenchHarness("bench-1", journal, bus, inbox);
  let counter = 0;
  let ready = false;

  bench("empty body, unique opIds", async () => {
    if (!ready) {
      await h.ready;
      ready = true;
    }
    counter++;
    await h.runEmpty(`op-${counter}`);
  });
});

describe("runOperation — empty body, idempotent replay", () => {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const h = new BenchHarness("bench-2", journal, bus, inbox);
  let ready = false;
  let primed = false;

  bench("empty body, repeated opId", async () => {
    if (!ready) {
      await h.ready;
      ready = true;
    }
    if (!primed) {
      await h.runEmpty("op-dup");
      primed = true;
    }
    await h.runEmpty("op-dup");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Channel publisher
// ─────────────────────────────────────────────────────────────────────────────

describe("LocalChannelPublisher — no subscriber", () => {
  const bus = new LocalEventBus();
  const pub = new LocalChannelPublisher(bus);
  let counter = 0;

  bench("publish, no subscriber (lazy skip)", async () => {
    counter++;
    await Effect.runPromise(pub.publish({ channel: "bench-progress", payload: { i: counter } }));
  });
});

describe("LocalChannelPublisher — 1 subscriber", () => {
  const bus = new LocalEventBus();
  const pub = new LocalChannelPublisher(bus);
  let consumer: Fiber.RuntimeFiber<void, unknown> | undefined;
  let started = false;
  let counter = 0;

  afterAll(async () => {
    if (consumer) await Effect.runPromise(Fiber.interrupt(consumer));
  });

  bench("publish, 1 subscriber (full envelope)", async () => {
    if (!started) {
      consumer = Effect.runFork(Stream.runDrain(bus.subscribe({ surface: "session" })));
      await new Promise((r) => setImmediate(r));
      started = true;
    }
    counter++;
    await Effect.runPromise(pub.publish({ channel: "bench-progress", payload: { i: counter } }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Streaming simulation — realistic concurrent operation load
// ─────────────────────────────────────────────────────────────────────────────
// Each bench iteration runs 10 concurrent operations × 10 delta envelopes
// each. Mean per-iteration cost ÷ 100 gives the amortized per-emission cost
// under sustained load with the Effect runtime warm.

describe("streaming simulation — 10 ops × 10 deltas", () => {
  const journal = new MemoryJournal({ capacity: 1_000_000 });
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const h = new BenchHarness("stream", journal, bus, inbox);
  let ready = false;
  let runCounter = 0;

  bench("eager: ops emit delta unconditionally (no subscriber)", async () => {
    if (!ready) {
      await h.ready;
      ready = true;
    }
    runCounter++;
    const tasks = Array.from({ length: 10 }, (_, opIdx) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const op: Operation<undefined, number> = {
            opId: `op-eager-${runCounter}-${opIdx}`,
            surface: "tool",
            name: "tool:bench:stream",
            scope: { sessionId: "s_stream", executionId: `e-${runCounter}` },
            input: undefined,
          };
          return yield* h["runOperation"](op, () =>
            Effect.gen(function* () {
              for (let i = 0; i < 10; i++) {
                yield* h["emitDelta"](op, { token: i });
              }
              return 1;
            }),
          );
        }) as Effect.Effect<number, unknown, never>,
      ),
    );
    await Promise.all(tasks);
  });

  bench("lazy: ops emit delta via emitDeltaLazy (no subscriber)", async () => {
    if (!ready) {
      await h.ready;
      ready = true;
    }
    runCounter++;
    const tasks = Array.from({ length: 10 }, (_, opIdx) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const op: Operation<undefined, number> = {
            opId: `op-lazy-${runCounter}-${opIdx}`,
            surface: "tool",
            name: "tool:bench:stream",
            scope: { sessionId: "s_stream", executionId: `e-${runCounter}` },
            input: undefined,
          };
          return yield* h["runOperation"](op, () =>
            Effect.gen(function* () {
              for (let i = 0; i < 10; i++) {
                yield* h["emitDeltaLazy"](op, () => ({ token: i }));
              }
              return 1;
            }),
          );
        }) as Effect.Effect<number, unknown, never>,
      ),
    );
    await Promise.all(tasks);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// compileQuery — specialised matcher vs generic walk
//
// The generic `matchesQuery` walks the EventQuery union per event.
// `compileQuery` collapses the query to a closure at subscribe time.
// This bench measures the per-event filter cost in isolation
// (no Effect, no Queue, no fan-out) so we can size the savings
// independent of the bus pipeline. Target: ~10x speedup for typical
// { surface, phase } shapes.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Phase B — per-surface batching: publish-call CPU cost
//
// Measures the producer-side cost of a single `publish(event)` call on
// the `executor:delta` hot path. With Phase B's default policy active,
// matching events accumulate and return immediately; the per-call cost
// drops because the fan-out is deferred to a flush boundary.
//
// The unbatched baseline (`batch: {}`) keeps the rest of the bus shape
// identical so the comparison isolates the batching effect.
//
// Caveat: this is producer-only cost. End-to-end latency to subscribers
// goes up by up to `flushAfterMs` per batched event. The end-to-end
// bench below measures the full path.
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase B — publish(executor:delta), 1 subscriber, unbatched baseline", () => {
  const bus = new LocalEventBus({ batch: {} });
  const event = mkEvent("e", { surface: "executor", phase: "delta" });
  let consumer: Fiber.RuntimeFiber<void, unknown> | undefined;
  let started = false;

  afterAll(async () => {
    if (consumer) await Effect.runPromise(Fiber.interrupt(consumer));
  });

  bench("publish executor:delta (1 subscriber, batching OFF)", async () => {
    if (!started) {
      consumer = Effect.runFork(Stream.runDrain(bus.subscribe({ surface: "executor" })));
      await new Promise((r) => setImmediate(r));
      started = true;
    }
    await Effect.runPromise(bus.append(event));
  });
});

describe("Phase B — publish(executor:delta), 1 subscriber, default batching", () => {
  const bus = new LocalEventBus(); // default policy includes executor:delta
  const event = mkEvent("e", { surface: "executor", phase: "delta" });
  let consumer: Fiber.RuntimeFiber<void, unknown> | undefined;
  let started = false;

  afterAll(async () => {
    if (consumer) await Effect.runPromise(Fiber.interrupt(consumer));
  });

  bench("publish executor:delta (1 subscriber, batching ON)", async () => {
    if (!started) {
      consumer = Effect.runFork(Stream.runDrain(bus.subscribe({ surface: "executor" })));
      await new Promise((r) => setImmediate(r));
      started = true;
    }
    await Effect.runPromise(bus.append(event));
  });
});

describe("Phase B — publish(executor:delta), 3 subscribers, unbatched baseline", () => {
  const bus = new LocalEventBus({ batch: {} });
  const event = mkEvent("e", { surface: "executor", phase: "delta" });
  const consumers: Fiber.RuntimeFiber<void, unknown>[] = [];
  let started = false;

  afterAll(async () => {
    await Effect.runPromise(
      Effect.all(
        consumers.map((f) => Fiber.interrupt(f)),
        { discard: true },
      ),
    );
  });

  bench("publish executor:delta (3 subscribers, batching OFF)", async () => {
    if (!started) {
      for (let i = 0; i < 3; i++) {
        consumers.push(Effect.runFork(Stream.runDrain(bus.subscribe({ surface: "executor" }))));
      }
      await new Promise((r) => setImmediate(r));
      started = true;
    }
    await Effect.runPromise(bus.append(event));
  });
});

describe("Phase B — publish(executor:delta), 3 subscribers, default batching", () => {
  const bus = new LocalEventBus();
  const event = mkEvent("e", { surface: "executor", phase: "delta" });
  const consumers: Fiber.RuntimeFiber<void, unknown>[] = [];
  let started = false;

  afterAll(async () => {
    await Effect.runPromise(
      Effect.all(
        consumers.map((f) => Fiber.interrupt(f)),
        { discard: true },
      ),
    );
  });

  bench("publish executor:delta (3 subscribers, batching ON)", async () => {
    if (!started) {
      for (let i = 0; i < 3; i++) {
        consumers.push(Effect.runFork(Stream.runDrain(bus.subscribe({ surface: "executor" }))));
      }
      await new Promise((r) => setImmediate(r));
      started = true;
    }
    await Effect.runPromise(bus.append(event));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase B — publishBatch direct path
//
// Adopters who already have N events in hand can call `publishBatch`
// directly, skipping the accumulator. Measures the cost of one batched
// fan-out for 8 events through 1 subscriber.
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase B — publishBatch(8 events), 1 subscriber", () => {
  const bus = new LocalEventBus({ batch: {} }); // bypass accumulator's no-op interaction
  const events = Array.from({ length: 8 }, (_, i) =>
    mkEvent(`b-${i}`, { surface: "executor", phase: "delta" }),
  );
  let consumer: Fiber.RuntimeFiber<void, unknown> | undefined;
  let started = false;

  afterAll(async () => {
    if (consumer) await Effect.runPromise(Fiber.interrupt(consumer));
  });

  bench("publishBatch 8 events, 1 subscriber", async () => {
    if (!started) {
      consumer = Effect.runFork(Stream.runDrain(bus.subscribe({ surface: "executor" })));
      await new Promise((r) => setImmediate(r));
      started = true;
    }
    await Effect.runPromise(bus.appendBatch(events));
  });
});

describe("Phase B — equivalent 8x publish(), 1 subscriber, no batching", () => {
  const bus = new LocalEventBus({ batch: {} });
  const events = Array.from({ length: 8 }, (_, i) =>
    mkEvent(`s-${i}`, { surface: "executor", phase: "delta" }),
  );
  let consumer: Fiber.RuntimeFiber<void, unknown> | undefined;
  let started = false;

  afterAll(async () => {
    if (consumer) await Effect.runPromise(Fiber.interrupt(consumer));
  });

  bench("8x publish(), 1 subscriber, no batching", async () => {
    if (!started) {
      consumer = Effect.runFork(Stream.runDrain(bus.subscribe({ surface: "executor" })));
      await new Promise((r) => setImmediate(r));
      started = true;
    }
    for (const e of events) {
      await Effect.runPromise(bus.append(e));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase B — end-to-end: publish 64 deltas, 3 subscribers consume them all
//
// Measures the full producer-to-consumer path. Producer publishes 64
// `executor:delta` events; three subscribers drain. The bench resolves
// once all subscribers have observed all 64 events. Captures both the
// producer-side win AND the latency cost of the flush-window.
// ─────────────────────────────────────────────────────────────────────────────

async function runEndToEnd(bus: LocalEventBus, count: number, subscriberCount: number) {
  // Each subscriber drains exactly `count` events via Stream.take and
  // then completes. Bench resolves when all subscribers + the publisher
  // loop have finished.
  const consumerPromises = Array.from({ length: subscriberCount }, () =>
    Effect.runPromise(Stream.runDrain(Stream.take(bus.subscribe({ surface: "executor" }), count))),
  );
  // Give subscribers a tick to attach before producer starts.
  await new Promise((r) => setImmediate(r));

  for (let i = 0; i < count; i++) {
    await Effect.runPromise(bus.append(mkEvent(`e-${i}`, { surface: "executor", phase: "delta" })));
  }
  await Promise.all(consumerPromises);
}

describe("Phase B — end-to-end 64 deltas × 3 subscribers, unbatched", () => {
  bench("64 publishes × 3 subscribers, batching OFF", async () => {
    const bus = new LocalEventBus({ batch: {} });
    await runEndToEnd(bus, 64, 3);
    bus.close();
  });
});

describe("Phase B — end-to-end 64 deltas × 3 subscribers, default batching", () => {
  bench("64 publishes × 3 subscribers, batching ON", async () => {
    const bus = new LocalEventBus();
    await runEndToEnd(bus, 64, 3);
    bus.close();
  });
});

describe("compileQuery — typical { surface, phase } shape", () => {
  const event = mkEvent("e", { surface: "executor", phase: "delta" });
  const query = { surface: "executor" as const, phase: "delta" as const };
  const compiled = compileQuery(query);

  bench("matchesQuery (generic walk)", () => {
    matchesQuery(event, query);
  });

  bench("compiled closure", () => {
    compiled(event);
  });
});

describe("compileQuery — name prefix + surface", () => {
  const event = mkEvent("e", {
    surface: "executor",
    phase: "delta",
    name: "executor:command:run",
  });
  const query = {
    surface: "executor" as const,
    name: { prefix: "executor:" },
  };
  const compiled = compileQuery(query);

  bench("matchesQuery (generic walk)", () => {
    matchesQuery(event, query);
  });

  bench("compiled closure", () => {
    compiled(event);
  });
});

describe("compileQuery — composite query (all fields)", () => {
  const event = mkEvent("e", {
    surface: "executor",
    phase: "delta",
    name: "executor:command:run",
    tags: ["streaming"],
    scope: { sessionId: "s1", executionId: "e1", tickId: "t1" },
  });
  const query = {
    surface: ["executor", "tool"] as const,
    phase: "delta" as const,
    name: { exact: "executor:command:run" },
    tagsAny: ["streaming"],
    scope: { sessionId: "s1", executionId: "e1" },
  };
  const compiled = compileQuery(query);

  bench("matchesQuery (generic walk)", () => {
    matchesQuery(event, query);
  });

  bench("compiled closure", () => {
    compiled(event);
  });
});
