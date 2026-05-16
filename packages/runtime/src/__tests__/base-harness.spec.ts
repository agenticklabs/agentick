import { describe, expect, it } from "vitest";
import { Cause, Chunk, Effect, Exit, Option, Stream } from "effect";
import type {
  HandlerVerdict,
  MessageEnvelope,
  MessageHandlerError,
  Operation,
  ProtocolEvent,
} from "@agentick/spec";
import { BaseHarness, OperationOutcomeError } from "../substrate/base-harness.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { MemoryJournal } from "../substrate/memory-journal.js";
import { getContext, type RuntimeContext } from "../substrate/runtime-context.js";

interface AddInput {
  readonly a: number;
  readonly b: number;
}

class TestHarness extends BaseHarness<"tool"> {
  /** Captured RuntimeContext during the most recent body run. */
  lastContext: RuntimeContext | undefined;

  constructor(scopeId: string, journal: MemoryJournal, bus: LocalEventBus, inbox: LocalInbox) {
    super("tool", scopeId, journal, bus, inbox);
  }

  async add(opId: string, input: AddInput): Promise<number> {
    const op: Operation<AddInput, number> = {
      opId,
      surface: "tool",
      name: "tool:test:add",
      scope: { sessionId: "s_1", executionId: "e_1", tickId: "t_1" },
      input,
    };
    const exit = await Effect.runPromiseExit(
      this.runOperation(op, (i) =>
        Effect.gen(this, function* () {
          this.lastContext = yield* getContext;
          return i.a + i.b;
        }),
      ),
    );
    if (Exit.isSuccess(exit)) return exit.value as number;
    // Unwrap the typed failure so callers can pattern-match
    // (`instanceof OperationOutcomeError`, `toMatchObject({...})`).
    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) throw failure.value;
    throw new Error(Cause.pretty(exit.cause));
  }

  onBefore(fn: (input: AddInput) => HandlerVerdict<number> | void): () => void {
    return this.handlers.register<AddInput, number>("before", (input) =>
      Effect.sync(() => fn(input)),
    );
  }

  use(
    mw: (
      input: AddInput,
      next: (i: AddInput) => Effect.Effect<number, never, never>,
    ) => Effect.Effect<number, never, never>,
  ): () => void {
    return this.middleware.use(mw as never);
  }

  ping(): Promise<void> {
    return Effect.runPromise(
      this.emit({
        opId: undefined,
        name: "tool:test:ping",
        phase: "terminal",
        outcome: "succeeded",
        scope: { sessionId: "s_1" },
        payload: { hello: "world" },
      }),
    );
  }

  protected handleMessage(msg: MessageEnvelope): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.suspend((): Effect.Effect<unknown, MessageHandlerError, never> => {
      if (msg.type === "echo") return Effect.succeed(msg.payload);
      return Effect.fail({
        _tag: "HandlerError",
        cause: new Error(`unknown message: ${msg.type}`),
      });
    });
  }
}

async function harness() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const h = new TestHarness("scope-1", journal, bus, inbox);
  await h.ready;
  return { h, journal, bus, inbox };
}

async function collectJournal(j: MemoryJournal): Promise<ProtocolEvent[]> {
  const chunk = await Effect.runPromise(Stream.runCollect(j.read({}, "beginning")));
  return Array.from(Chunk.toReadonlyArray(chunk));
}

describe("BaseHarness — phase contract", () => {
  it("emits requested → terminal on success", async () => {
    const { h, journal } = await harness();
    const out = await h.add("op-1", { a: 2, b: 3 });
    expect(out).toBe(5);
    const events = await collectJournal(journal);
    const phases = events.map((e) => e.phase);
    // requested + terminal are journaled by default; before is bus-only.
    expect(phases).toEqual(["requested", "terminal"]);
    expect(events.at(-1)!.outcome).toBe("succeeded");
  });

  it("same opId returns cached terminal (idempotent replay)", async () => {
    const { h } = await harness();
    let calls = 0;
    h.use((i, next) =>
      Effect.gen(function* () {
        calls++;
        return yield* next(i);
      }),
    );
    const r1 = await h.add("op-idem", { a: 1, b: 1 });
    const r2 = await h.add("op-idem", { a: 99, b: 99 });
    expect(r1).toBe(2);
    expect(r2).toBe(2);
    expect(calls).toBe(1);
  });

  it("publishes the RuntimeContext FiberRef visible to body Effects", async () => {
    const { h } = await harness();
    await h.add("op-ctx", { a: 1, b: 2 });
    expect(h.lastContext).toMatchObject({
      sessionId: "s_1",
      executionId: "e_1",
      tickId: "t_1",
      opId: "op-ctx",
    });
  });
});

describe("BaseHarness — verdict merge", () => {
  it("veto short-circuits with outcome=vetoed", async () => {
    const { h } = await harness();
    h.onBefore(() => ({ kind: "veto", reason: "denied" }));
    await expect(h.add("op-veto", { a: 1, b: 1 })).rejects.toBeInstanceOf(
      OperationOutcomeError,
    );
  });

  it("replace short-circuits with caller-supplied result", async () => {
    const { h } = await harness();
    h.onBefore(() => ({ kind: "replace", result: 999 }));
    const r = await h.add("op-replace", { a: 1, b: 1 });
    expect(r).toBe(999);
  });

  it("multiple proceed handlers collapse to proceed", async () => {
    const { h } = await harness();
    h.onBefore(() => ({ kind: "proceed" }));
    h.onBefore(() => undefined);
    const r = await h.add("op-proceed", { a: 1, b: 1 });
    expect(r).toBe(2);
  });

  it("first veto wins over a later replace", async () => {
    const { h } = await harness();
    h.onBefore(() => ({ kind: "veto", reason: "first" }));
    h.onBefore(() => ({ kind: "replace", result: 7 }));
    await expect(h.add("op-veto-first", { a: 1, b: 1 })).rejects.toMatchObject({
      outcome: "vetoed",
    });
  });
});

describe("BaseHarness — middleware", () => {
  it("composes outer-wraps-inner", async () => {
    const { h } = await harness();
    const trace: string[] = [];
    h.use((i, next) =>
      Effect.gen(function* () {
        trace.push("outer:before");
        const r = yield* next(i);
        trace.push("outer:after");
        return r;
      }),
    );
    h.use((i, next) =>
      Effect.gen(function* () {
        trace.push("inner:before");
        const r = yield* next(i);
        trace.push("inner:after");
        return r;
      }),
    );
    await h.add("op-mw", { a: 1, b: 2 });
    expect(trace).toEqual(["outer:before", "inner:before", "inner:after", "outer:after"]);
  });
});

describe("BaseHarness — discrete events", () => {
  it("emit publishes to the bus", async () => {
    const { h, bus, journal } = await harness();
    const fiber = Effect.runFork(
      Stream.runHead(bus.subscribe({ name: { exact: "tool:test:ping" } })),
    );
    await new Promise((r) => setImmediate(r));
    await h.ping();
    const head = await Effect.runPromise(fiber.await);
    expect(Exit.isSuccess(head)).toBe(true);
    if (Exit.isSuccess(head)) {
      const opt = head.value as unknown as { value?: ProtocolEvent };
      expect(opt.value?.payload).toEqual({ hello: "world" });
    }
    // Discrete terminal events without an opId still match the alwaysJournal
    // policy by phase, so they appear in the journal.
    const journaled = await collectJournal(journal);
    expect(journaled.some((j) => j.name === "tool:test:ping")).toBe(true);
  });
});

describe("BaseHarness — inbox dispatch", () => {
  it("messages routed by address are handled by handleMessage", async () => {
    const { inbox } = await harness();
    const r = await Effect.runPromise(
      inbox.ask("tool:scope-1", {
        addressedTo: "tool:scope-1",
        type: "echo",
        messageId: "m-echo",
        timestamp: Date.now(),
        payload: { ok: true },
      }),
    );
    expect(r).toEqual({ ok: true });
  });
});
