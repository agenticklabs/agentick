import { describe, expect, it } from "vitest";
import {
  Cause,
  Chunk,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Stream,
  Tracer,
} from "effect";
import { waitFor } from "@agentick/utils-next/testing";
import { HandlerError } from "@agentick/spec-next";
import type {
  HandlerVerdict,
  MessageEnvelope,
  MessageHandlerError,
  Operation,
  ProtocolEvent,
} from "@agentick/spec-next";
import {
  BaseHarness,
  OperationOutcomeError,
  withCallMiddleware,
  type Middleware,
} from "../substrate/base-harness.js";
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

  /**
   * Run an op with a caller-supplied body, FORKED, returning the fiber so a
   * test can interrupt the live operation (exercises interruption crossing the
   * middleware chain).
   */
  runForked(
    opId: string,
    body: (i: AddInput) => Effect.Effect<number>,
  ): Fiber.RuntimeFiber<number, unknown> {
    const op: Operation<AddInput, number> = {
      opId,
      surface: "tool",
      name: "tool:test:forked",
      scope: { sessionId: "s_1", executionId: "e_1", tickId: "t_1" },
      input: { a: 0, b: 0 },
    };
    return Effect.runFork(this.runOperation(op, body));
  }

  /**
   * Return the composed operation Effect (unrun) so a test can run it on a
   * caller-supplied runtime — e.g. one carrying a collecting tracer, to assert
   * span nesting across the middleware chain.
   */
  runOpEffect(
    opId: string,
    body: (i: AddInput) => Effect.Effect<number, unknown>,
  ): Effect.Effect<number, unknown> {
    const op: Operation<AddInput, number> = {
      opId,
      surface: "tool",
      name: "tool:test:span-op",
      scope: { sessionId: "s_1", executionId: "e_1", tickId: "t_1" },
      input: { a: 0, b: 0 },
    };
    return this.runOperation(op, body);
  }

  onBefore(fn: (input: AddInput) => HandlerVerdict<number> | void): () => void {
    return this.handlers.register<AddInput, number>("before", (input) =>
      Effect.sync(() => fn(input)),
    );
  }

  // Middleware registers through the two inherited surfaces: `use` takes the
  // pure-JS `AsyncMiddleware` (severs the fiber, gets `ctx` explicitly),
  // `fx.use` takes the Effect-native `Middleware` (in-fiber). No override needed.

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

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.suspend((): Effect.Effect<unknown, MessageHandlerError, never> => {
      if (msg.type === "echo") return Effect.succeed(msg.payload);
      return Effect.fail(
        new HandlerError({
          cause: new Error(`unknown message: ${msg.type}`),
        }),
      );
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

/** A harness that declares a command via `this.command()` (so it registers in
 *  the command registry) and exposes the `.fx` Effect surface over it. */
class FxTestHarness extends BaseHarness<"tool"> {
  readonly add: (input: AddInput) => Promise<number>;

  constructor(scopeId: string, journal: MemoryJournal, bus: LocalEventBus, inbox: LocalInbox) {
    super("tool", scopeId, journal, bus, inbox);
    this.add = this.command({
      name: "tool:add",
      handler: (i: AddInput) => Effect.succeed(i.a + i.b),
    });
  }

  /** Typed-per-harness `.fx` getter over the base runtime Proxy. */
  get fx() {
    return this.fxProxy();
  }

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: new Error(`unknown: ${msg.type}`) }));
  }
}

async function collectJournal(j: MemoryJournal): Promise<ProtocolEvent[]> {
  const chunk = await Effect.runPromise(Stream.runCollect(j.readByQuery({}, "beginning")));
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
    h.fx.use((i, next) =>
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
    await expect(h.add("op-veto", { a: 1, b: 1 })).rejects.toBeInstanceOf(OperationOutcomeError);
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
    h.fx.use((i, next) =>
      Effect.gen(function* () {
        trace.push("outer:before");
        const r = yield* next(i);
        trace.push("outer:after");
        return r;
      }),
    );
    h.fx.use((i, next) =>
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

  it("hands an async (`use`) middleware the operation's RuntimeContext as the 3rd arg", async () => {
    const { h } = await harness();
    let seen: RuntimeContext | undefined;
    h.use(async (input, next, ctx) => {
      // The async middleware runs OUTSIDE the fiber — it can't read getContext
      // itself, so the lift captures it at the op boundary and passes it here.
      seen = ctx;
      return next(input);
    });
    const out = await h.add("op-ctx", { a: 2, b: 3 });
    expect(out).toBe(5); // body still ran through the async middleware
    // `add` stamps scope { sessionId: "s_1", executionId: "e_1", tickId: "t_1" }
    // and opId "op-ctx" onto the operation — the ctx snapshot must carry them.
    expect(seen?.sessionId).toBe("s_1");
    expect(seen?.executionId).toBe("e_1");
    expect(seen?.opId).toBe("op-ctx");
  });

  it("interrupting an op tears down the inner call an async (`use`) middleware wraps", async () => {
    const { h } = await harness();
    let bodyStarted = false;
    let bodyInterrupted = false;
    // An async middleware forwards to `next`. Its continuation is forked (a
    // detached root) — without interrupt re-threading, an aborted op would
    // leave the body below running forever. We prove the interrupt reaches it.
    h.use(async (input, next) => next(input));
    const body = (_i: AddInput): Effect.Effect<number> =>
      Effect.gen(function* () {
        bodyStarted = true;
        yield* Effect.never; // hang until interrupted
        return 0;
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            bodyInterrupted = true;
          }),
        ),
      );
    const fiber = h.runForked("op-abort", body);
    await waitFor(() => bodyStarted); // body reached its hang point through the mw
    await Effect.runPromise(Fiber.interrupt(fiber)); // abort the outer op
    await waitFor(() => bodyInterrupted); // the forked continuation was torn down
    expect(bodyInterrupted).toBe(true);
  });

  it("an async (`use`) middleware can short-circuit without calling next()", async () => {
    const { h } = await harness();
    let bodyRan = false;
    h.use(async () => 999); // never calls next → body skipped
    h.fx.use((i, next) =>
      Effect.gen(function* () {
        bodyRan = true; // this inner mw + the body are both short-circuited
        return yield* next(i);
      }),
    );
    const out = await h.add("op-short", { a: 1, b: 1 });
    expect(out).toBe(999);
    expect(bodyRan).toBe(false);
  });
});

/** A tracer that records each span it opens + its parent (Option<Span>). */
function collectingTracer() {
  const spans: { name: string; parent: Option.Option<unknown> }[] = [];
  const tracer = Tracer.make({
    span: (name, parent, context, links, startTime, kind) => {
      spans.push({ name, parent: parent as Option.Option<unknown> });
      const attributes = new Map<string, unknown>();
      return {
        _tag: "Span",
        spanId: `s${spans.length}`,
        traceId: "t",
        name,
        parent,
        context,
        status: { _tag: "Started", startTime },
        attributes,
        links,
        kind,
        sampled: true,
        end() {},
        attribute(key: string, value: unknown) {
          attributes.set(key, value);
        },
        event() {},
        addLinks() {},
      } as unknown as Tracer.Span;
    },
    context: (f) => f(),
  });
  const layer = Layer.mergeAll(Layer.setTracer(tracer), Layer.setTracerEnabled(true));
  return { layer: layer as Layer.Layer<never, never, never>, spans };
}

describe("BaseHarness — async middleware fiber propagation", () => {
  // `liftMiddleware` forks each `use` continuation on the AMBIENT runtime
  // (`Effect.runtime()` — context + FiberRefs + tracer), not the default one.
  // These tests pin every property that inheritance is supposed to preserve
  // across the async boundary; a naive `Effect.runFork` would break each.

  it("a span opened in the body nests under the op span THROUGH an async `use` middleware", async () => {
    const { h } = await harness();
    const { layer, spans } = collectingTracer();
    const runtime = ManagedRuntime.make(layer);
    // A naive Effect.runFork would run the body on the DEFAULT runtime (no
    // tracer) — "child-span" wouldn't even be collected. Forking on the
    // captured runtime keeps the tracer AND the parent-span context.
    h.use(async (input, next) => next(input));
    const body = (_i: AddInput): Effect.Effect<number> =>
      Effect.succeed(0).pipe(Effect.withSpan("child-span"));
    await runtime.runPromise(h.runOpEffect("op-span", body));
    await runtime.dispose();

    const child = spans.find((s) => s.name === "child-span");
    const opSpan = spans.find((s) => s.name === "tool:test:span-op");
    expect(child).toBeDefined();
    expect(opSpan).toBeDefined();
    // child's parent must be SOME span named after the op — nesting survived.
    expect(Option.isSome(child!.parent)).toBe(true);
    const parent = Option.getOrNull(child!.parent) as { name?: string } | null;
    expect(parent?.name).toBe("tool:test:span-op");
  });

  it("the continuation body still reads the op's RuntimeContext after the fork", async () => {
    const { h } = await harness();
    h.use(async (input, next) => next(input));
    let bodyCtx: RuntimeContext | undefined;
    const body = (_i: AddInput): Effect.Effect<number> =>
      Effect.gen(function* () {
        bodyCtx = yield* getContext; // in-fiber read ON the forked continuation
        return 0;
      });
    await Effect.runPromise(h.runOpEffect("op-ctx-cont", body));
    expect(bodyCtx?.opId).toBe("op-ctx-cont");
    expect(bodyCtx?.sessionId).toBe("s_1");
  });

  it("a tier-4 withCallMiddleware still wraps a NESTED op reached through an async `use` middleware", async () => {
    const { h } = await harness();
    h.use(async (input, next) => next(input)); // forces the body to fork
    let wraps = 0;
    const callMw: Middleware<unknown, unknown, unknown> = (i, next) =>
      Effect.gen(function* () {
        wraps++;
        return yield* next(i);
      });
    // Outer op's body (forked by the async mw) invokes a NESTED op. The
    // tier-4 FiberRef must survive the fork for the nested op to see callMw.
    const outerBody = (_i: AddInput): Effect.Effect<number, unknown> =>
      h.runOpEffect("nested-op", () => Effect.succeed(7));
    await Effect.runPromise(withCallMiddleware([callMw], h.runOpEffect("outer-op", outerBody)));
    // 2 = callMw wrapped BOTH the outer op and the nested op — the CallMiddlewareRef
    // (a FiberRef) crossed the async boundary. A default-runtime fork → 1.
    expect(wraps).toBe(2);
  });

  it("a rejection from the wrapped body surfaces on the outer error channel", async () => {
    const { h } = await harness();
    h.use(async (input, next) => next(input));
    const boom = new Error("body boom");
    const body = (_i: AddInput): Effect.Effect<number, unknown> => Effect.fail(boom);
    await expect(Effect.runPromise(h.runOpEffect("op-body-fail", body))).rejects.toThrow(
      "body boom",
    );
  });

  it("a throw from the async middleware's own body surfaces on the outer error channel", async () => {
    const { h } = await harness();
    h.use(async () => {
      throw new Error("mw boom");
    });
    await expect(
      Effect.runPromise(h.runOpEffect("op-mw-fail", () => Effect.succeed(0))),
    ).rejects.toThrow("mw boom");
  });

  it("an async `use` middleware may call next() more than once (retry pattern)", async () => {
    const { h } = await harness();
    let bodyCalls = 0;
    const body = (_i: AddInput): Effect.Effect<number> =>
      Effect.sync(() => {
        bodyCalls++;
        if (bodyCalls < 2) throw new Error("transient");
        return 42;
      });
    h.use(async (input, next) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await next(input);
        } catch {
          /* retry */
        }
      }
      throw new Error("exhausted");
    });
    const out = await Effect.runPromise(h.runOpEffect("op-retry", body));
    expect(out).toBe(42);
    expect(bodyCalls).toBe(2); // failed once, succeeded on the second next()
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
        type: "echo",
        messageId: "m-echo",
        payload: { ok: true },
      }),
    );
    expect(r).toEqual({ ok: true });
  });
});

describe("BaseHarness — onMessage extension point", () => {
  it("routes a custom message type to the registered handler", async () => {
    const { h, inbox } = await harness();
    let seen: MessageEnvelope | undefined;
    h.onMessage("custom:ping", (msg) =>
      Effect.sync(() => {
        seen = msg;
        return { pong: true };
      }),
    );
    const r = await Effect.runPromise(
      inbox.ask("tool:scope-1", {
        type: "custom:ping",
        messageId: "m-onmsg-1",
        payload: { x: 1 },
      }),
    );
    expect(r).toEqual({ pong: true });
    expect(seen?.type).toBe("custom:ping");
    expect(seen?.payload).toEqual({ x: 1 });
  });

  it("custom handler overrides the subclass handleMessage for that type", async () => {
    const { h, inbox } = await harness();
    // TestHarness.handleMessage natively returns msg.payload for "echo".
    // Register an onMessage handler that wraps the payload instead.
    h.onMessage("echo", (msg) => Effect.succeed({ wrapped: msg.payload }));
    const r = await Effect.runPromise(
      inbox.ask("tool:scope-1", {
        type: "echo",
        messageId: "m-override-1",
        payload: { ok: true },
      }),
    );
    expect(r).toEqual({ wrapped: { ok: true } });
  });

  it("Unsubscribe restores the prior handler (or removes the entry)", async () => {
    const { h, inbox } = await harness();
    const unsubscribe = h.onMessage("echo", () => Effect.succeed({ overridden: true }));
    // While installed: custom handler wins.
    expect(
      await Effect.runPromise(
        inbox.ask("tool:scope-1", { type: "echo", messageId: "m-x1", payload: { ok: true } }),
      ),
    ).toEqual({ overridden: true });
    unsubscribe();
    // After unsubscribe: falls back to the subclass's handleMessage.
    expect(
      await Effect.runPromise(
        inbox.ask("tool:scope-1", { type: "echo", messageId: "m-x2", payload: { ok: true } }),
      ),
    ).toEqual({ ok: true });
  });

  it("re-registering replaces the prior handler; unsubscribing the second restores the first", async () => {
    const { h, inbox } = await harness();
    const off1 = h.onMessage("custom:layer", () => Effect.succeed({ layer: 1 }));
    const off2 = h.onMessage("custom:layer", () => Effect.succeed({ layer: 2 }));
    // Second registration wins while installed.
    expect(
      await Effect.runPromise(
        inbox.ask("tool:scope-1", { type: "custom:layer", messageId: "m-l1", payload: {} }),
      ),
    ).toEqual({ layer: 2 });
    // Unsubscribe second → first is restored.
    off2();
    expect(
      await Effect.runPromise(
        inbox.ask("tool:scope-1", { type: "custom:layer", messageId: "m-l2", payload: {} }),
      ),
    ).toEqual({ layer: 1 });
    // Unsubscribe first → no handler; falls through to handleMessage,
    // which fails for unknown types.
    off1();
    await expect(
      Effect.runPromise(
        inbox.ask("tool:scope-1", { type: "custom:layer", messageId: "m-l3", payload: {} }),
      ),
    ).rejects.toBeTruthy();
  });

  it("custom handlers do NOT intercept `request-response` (auto-intercept wins)", async () => {
    const { h, inbox } = await harness();
    let customRan = false;
    h.onMessage("request-response", () =>
      Effect.sync(() => {
        customRan = true;
        return undefined;
      }),
    );
    // request-response is meant for the registry's auto-intercept; an
    // adopter handler is silently bypassed. We assert by sending the
    // shape and observing that the registered handler never fires
    // (the message just no-ops because there's no pending registration).
    await Effect.runPromise(
      inbox.send("tool:scope-1", {
        type: "request-response",
        messageId: "m-rr-1",
        payload: { correlationId: "req:nope", response: { ok: true } },
      }),
    );
    expect(customRan).toBe(false);
  });
});

describe("BaseHarness — .fx surface (ADR 77/79 Stage 1)", () => {
  it("fx.<action> returns the composable Effect twin; the plain method returns a Promise", async () => {
    const h = new FxTestHarness("fx-1", new MemoryJournal(), new LocalEventBus(), new LocalInbox());
    await h.ready;

    // .fx.add hands back an Effect (not run) — composable, isEffect true.
    const eff = h.fx.add({ a: 2, b: 3 });
    expect(Effect.isEffect(eff)).toBe(true);
    expect(eff).not.toBeInstanceOf(Promise);
    const composed = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* eff;
      }),
    );
    expect(composed).toBe(5);

    // The plain method is the edge facade — a Promise with the same result,
    // from the SAME declared command.
    const p = h.add({ a: 4, b: 5 });
    expect(p).toBeInstanceOf(Promise);
    expect(await p).toBe(9);
  });

  it("fx twins compose into ONE fiber tree (nested yield*)", async () => {
    const h = new FxTestHarness("fx-2", new MemoryJournal(), new LocalEventBus(), new LocalInbox());
    await h.ready;
    const total = await Effect.runPromise(
      Effect.gen(function* () {
        const a = (yield* h.fx.add({ a: 1, b: 1 })) as number;
        return (yield* h.fx.add({ a, b: 3 })) as number;
      }),
    );
    expect(total).toBe(5); // 1+1 → 2, 2+3 → 5, composed in a single generator
  });
});
