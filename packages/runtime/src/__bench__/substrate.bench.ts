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
} from "@agentick/spec";
import { afterAll, bench, describe } from "vitest";

import { MemoryJournal } from "../substrate/memory-journal.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { LocalChannelPublisher } from "../substrate/local-channel-publisher.js";
import { BaseHarness } from "../substrate/base-harness.js";

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
  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
  ) {
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
    await Effect.runPromise(bus.publish(event));
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
    await Effect.runPromise(bus.publish(event));
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
    await Effect.runPromise(bus.publish(event));
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
        addressedTo: "bench:addr",
        type: "ping",
        messageId: `m-${counter}`,
        timestamp: Date.now(),
      }),
    );
  });
});

describe("inbox.send — idempotent replay", () => {
  const inbox = new LocalInbox();
  Effect.runSync(inbox.register("bench:addr2", () => Effect.succeed(undefined)));
  const msg = {
    addressedTo: "bench:addr2",
    type: "ping",
    messageId: "m-dup",
    timestamp: Date.now(),
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
    await Effect.runPromise(
      pub.publish({ channel: "bench-progress", payload: { i: counter } }),
    );
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
    await Effect.runPromise(
      pub.publish({ channel: "bench-progress", payload: { i: counter } }),
    );
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
