/**
 * OperationRunner (Tier 2) — the operation-execution substrate, tested in
 * ISOLATION against a FAKE journal + bus (no BaseHarness, no inbox, no
 * construction tree).
 *
 * This is the isolation win the extraction buys: the phase contract (requested
 * → before → terminal), idempotent replay via `lookupTerminal`, the terminal
 * outcomes, the interceptor cascade order (incl. guard-outermost + tier-4
 * call-scoped), the signal → terminal mapping, and identity stamping are all
 * provable WITHOUT a harness. The injected `interceptors` closure stands in for
 * the harness's live construction-tree snapshot.
 *
 * End-to-end coverage (through a real BaseHarness) stays in `base-harness.spec.ts`,
 * `guard-ordering.spec.ts`, `call-middleware.spec.ts`, and the per-harness suites.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md
 * @see docs/proposals/v2/blueprint/83-interceptor-collapse.md
 */

import { describe, expect, it } from "vitest";
import { Effect, Exit, Stream } from "effect";
import { DEFAULT_JOURNALING_POLICY } from "@agentick/spec";
import type {
  EventBus,
  EventScope,
  JournalingPolicy,
  Maybe,
  Middleware,
  Operation,
  OperationJournal,
  ProtocolEvent,
  TerminalEvent,
} from "@agentick/spec";
import {
  createOperationRunner,
  OperationOutcomeError,
  type OperationRunner,
} from "../substrate/operation-runner.js";
import { withCallMiddleware } from "../substrate/middleware.js";
import {
  OperationDefer,
  OperationReplace,
  OperationVeto,
  tagInterceptor,
} from "../substrate/op-signals.js";

// ── fakes ──────────────────────────────────────────────────────────────────

const NO_METRICS = {
  eventsPerSecond: 0,
  subscriberCount: 0,
  cursorLagP99: 0,
  dropRate: 0,
  retentionEvents: 0,
} as const;

/**
 * A fake {@link OperationJournal} recording every appended envelope and serving
 * a pre-seeded terminal map from {@link OperationJournal.lookupTerminal}. Fully
 * typed — the unused stream/query members are inert (`Stream.empty`) so a spec
 * change to a member the runner USES breaks this double at compile time.
 */
function fakeJournal(seedTerminals: Record<string, TerminalEvent> = {}): OperationJournal & {
  readonly appended: ProtocolEvent[];
} {
  const appended: ProtocolEvent[] = [];
  const terminals = new Map<string, TerminalEvent>(Object.entries(seedTerminals));
  return {
    appended,
    append: (e) =>
      Effect.sync(() => {
        appended.push(e);
      }),
    appendBatch: (events) =>
      Effect.sync(() => {
        for (const e of events) appended.push(e);
      }),
    read: () => Stream.empty,
    hasSubscriberFor: () => false,
    metrics: () => NO_METRICS,
    lookupTerminal: (opId) =>
      Effect.sync((): Maybe<TerminalEvent> => {
        const t = terminals.get(opId);
        return t ? { some: true, value: t } : { some: false };
      }),
    readByQuery: () => Stream.empty,
    tail: () => Stream.empty,
    findOrphaned: () => Effect.succeed([]),
  };
}

/** A fake {@link EventBus} recording every appended envelope. */
function fakeBus(): EventBus & { readonly appended: ProtocolEvent[] } {
  const appended: ProtocolEvent[] = [];
  return {
    appended,
    append: (e) =>
      Effect.sync(() => {
        appended.push(e);
      }),
    appendBatch: (events) =>
      Effect.sync(() => {
        for (const e of events) appended.push(e);
      }),
    read: () => Stream.empty,
    hasSubscriberFor: () => false,
    metrics: () => NO_METRICS,
    publishLazy: (_key, build) =>
      Effect.sync(() => {
        appended.push(build());
      }),
    subscribe: () => Stream.empty,
  };
}

interface Fixture {
  readonly runner: OperationRunner;
  readonly journal: ReturnType<typeof fakeJournal>;
  readonly bus: ReturnType<typeof fakeBus>;
  /** Records interceptor entry/exit + body, in run order. */
  readonly trace: string[];
  /** The current injected construction-tree interceptor list (mutable). */
  interceptors: Middleware<unknown, unknown, unknown>[];
}

function fixture(opts?: {
  seedTerminals?: Record<string, TerminalEvent>;
  principal?: string;
  policy?: JournalingPolicy;
  parentScope?: EventScope;
}): Fixture {
  const journal = fakeJournal(opts?.seedTerminals);
  const bus = fakeBus();
  const trace: string[] = [];
  const state: { interceptors: Middleware<unknown, unknown, unknown>[] } = { interceptors: [] };
  const runner = createOperationRunner({
    surface: "test",
    principal: opts?.principal,
    parentScope: opts?.parentScope,
    journal,
    bus,
    policy: opts?.policy ?? DEFAULT_JOURNALING_POLICY,
    interceptors: () => state.interceptors,
    spanAttributes: (op) => ({ "test.op_id": op.opId }),
  });
  return {
    runner,
    journal,
    bus,
    trace,
    get interceptors() {
      return state.interceptors;
    },
    set interceptors(v) {
      state.interceptors = v;
    },
  };
}

function op<I>(
  input: I,
  over?: Partial<Operation<I, unknown, unknown>>,
): Operation<I, unknown, unknown> {
  return {
    opId: "op:1",
    surface: "test",
    name: "test:command:doThing",
    scope: {},
    input,
    ...over,
  } as Operation<I, unknown, unknown>;
}

/** A transform interceptor that logs entry/exit around `next`. */
function tracer(trace: string[], label: string): Middleware<unknown, unknown, unknown> {
  return tagInterceptor("transform", (input, next) =>
    Effect.gen(function* () {
      trace.push(`in:${label}`);
      const r = yield* next(input);
      trace.push(`out:${label}`);
      return r;
    }),
  );
}

/** A `guard`-kind interceptor that raises `signal` (deny/replace/defer) before the body. */
function guardRaising(signal: unknown): Middleware<unknown, unknown, unknown> {
  const mw: Middleware<unknown, unknown, unknown> = () => Effect.fail(signal);
  return tagInterceptor("guard", mw);
}

// ── tests ────────────────────────────────────────────────────────────────

describe("OperationRunner — phase contract", () => {
  it("emits requested → before → terminal:succeeded around the body", async () => {
    const f = fixture();
    const result = await Effect.runPromise(
      f.runner.runOperation(op({ n: 2 }), (i) => Effect.succeed(i.n * 3)),
    );
    expect(result).toBe(6);

    const phases = f.bus.appended.map((e) => e.phase);
    expect(phases).toEqual(["requested", "before", "terminal"]);
    // `requested` binds the input as payload; terminal carries the result.
    expect(f.bus.appended[0]!.payload).toEqual({ n: 2 });
    const terminal = f.bus.appended[2]!;
    expect(terminal.outcome).toBe("succeeded");
    expect((terminal.payload as { result: number }).result).toBe(6);
  });

  it("runs the body exactly once and threads its return through", async () => {
    const f = fixture();
    let calls = 0;
    const r = await Effect.runPromise(
      f.runner.runOperation(op({ v: "x" }), () => {
        calls += 1;
        return Effect.succeed("done");
      }),
    );
    expect(calls).toBe(1);
    expect(r).toBe("done");
  });
});

describe("OperationRunner — idempotent replay", () => {
  it("replays a cached succeeded terminal WITHOUT running the body or re-emitting", async () => {
    const f = fixture({ seedTerminals: { "op:1": { outcome: "succeeded", result: 99 } } });
    let calls = 0;
    const r = await Effect.runPromise(
      f.runner.runOperation(op({}), () => {
        calls += 1;
        return Effect.succeed(1);
      }),
    );
    expect(r).toBe(99);
    expect(calls).toBe(0);
    // No requested/before/terminal re-emitted on the replay path.
    expect(f.bus.appended).toHaveLength(0);
  });

  it("replays a cached failed terminal as OperationOutcomeError", async () => {
    const terminal: TerminalEvent = { outcome: "failed", error: { name: "E", message: "boom" } };
    const f = fixture({ seedTerminals: { "op:1": terminal } });
    const exit = await Effect.runPromiseExit(
      f.runner.runOperation(op({}), () => Effect.succeed(1)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(err).toBeInstanceOf(OperationOutcomeError);
      expect((err as OperationOutcomeError).outcome).toBe("failed");
    }
  });
});

describe("OperationRunner — terminal outcomes", () => {
  it("emits terminal:failed and re-raises the ORIGINAL error on body failure", async () => {
    const f = fixture();
    class MyError {
      readonly _tag = "MyError" as const;
      constructor(readonly why: string) {}
    }
    const boom = new MyError("kaboom");
    const exit = await Effect.runPromiseExit(
      f.runner.runOperation(op({}), () => Effect.fail(boom)),
    );
    // The terminal:failed envelope is published…
    const terminal = f.bus.appended.at(-1)!;
    expect(terminal.phase).toBe("terminal");
    expect(terminal.outcome).toBe("failed");
    // …but the body's OWN typed error is re-raised (NOT wrapped in
    // OperationOutcomeError). `Effect.withSpan` reconstructs the top-level
    // failure value, so it matches by `_tag` / structure, not by identity
    // (see `annotateOperationSpan` doc §L5).
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const err = exit.cause.error as MyError;
      expect(err).not.toBeInstanceOf(OperationOutcomeError);
      expect(err._tag).toBe("MyError");
      expect(err.why).toBe("kaboom");
    }
  });
});

describe("OperationRunner — interceptor cascade", () => {
  it("composes the injected interceptors outer→inner around the body", async () => {
    const f = fixture();
    f.interceptors = [tracer(f.trace, "A"), tracer(f.trace, "B")];
    await Effect.runPromise(
      f.runner.runOperation(op({}), () => {
        f.trace.push("body");
        return Effect.succeed(1);
      }),
    );
    // First in list = outermost.
    expect(f.trace).toEqual(["in:A", "in:B", "body", "out:B", "out:A"]);
  });

  it("floats a guard OUTERMOST (deny-before-transform) — a veto short-circuits the transform", async () => {
    const f = fixture();
    const guard = guardRaising(new OperationVeto("locked"));
    // Transform listed FIRST, guard SECOND — ordering must still run the guard first.
    f.interceptors = [tracer(f.trace, "T"), guard];
    const exit = await Effect.runPromiseExit(
      f.runner.runOperation(op({}), () => {
        f.trace.push("body");
        return Effect.succeed(1);
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    // Guard denied before the transform or body ran.
    expect(f.trace).toEqual([]);
    expect(f.bus.appended.at(-1)!.outcome).toBe("vetoed");
  });

  it("composes a tier-4 withCallMiddleware OUTERMOST of the injected list", async () => {
    const f = fixture();
    f.interceptors = [tracer(f.trace, "own")];
    const call = tagInterceptor("transform", (input, next) =>
      Effect.gen(function* () {
        f.trace.push("in:call");
        const r = yield* next(input);
        f.trace.push("out:call");
        return r;
      }),
    );
    await Effect.runPromise(
      withCallMiddleware(
        [call as Middleware<unknown, unknown, unknown>],
        f.runner.runOperation(op({}), () => {
          f.trace.push("body");
          return Effect.succeed(1);
        }),
      ),
    );
    // tier-4 (call) is broadest → outermost; own transform inside it.
    expect(f.trace).toEqual(["in:call", "in:own", "body", "out:own", "out:call"]);
  });
});

describe("OperationRunner — signal → terminal mapping", () => {
  it("veto → terminal:vetoed + OperationOutcomeError", async () => {
    const f = fixture();
    f.interceptors = [guardRaising(new OperationVeto("no"))];
    const exit = await Effect.runPromiseExit(
      f.runner.runOperation(op({}), () => Effect.succeed(1)),
    );
    expect(f.bus.appended.at(-1)!.outcome).toBe("vetoed");
    expect(Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error).toBeInstanceOf(
      OperationOutcomeError,
    );
  });

  it("replace → terminal:replaced + success(result)", async () => {
    const f = fixture();
    f.interceptors = [guardRaising(new OperationReplace(42, "swapped"))];
    const r = await Effect.runPromise(f.runner.runOperation(op({}), () => Effect.succeed(1)));
    expect(r).toBe(42);
    expect(f.bus.appended.at(-1)!.outcome).toBe("replaced");
  });

  it("defer → terminal:deferred + OperationOutcomeError", async () => {
    const f = fixture();
    f.interceptors = [guardRaising(new OperationDefer(500))];
    const exit = await Effect.runPromiseExit(
      f.runner.runOperation(op({}), () => Effect.succeed(1)),
    );
    expect(f.bus.appended.at(-1)!.outcome).toBe("deferred");
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("OperationRunner — identity + causality", () => {
  it("stamps the construction-bound principal AUTHORITATIVELY on every emitted event", async () => {
    const f = fixture({ principal: "acme/u1" });
    await Effect.runPromise(f.runner.runOperation(op({}), () => Effect.succeed(1)));
    expect(f.bus.appended.length).toBeGreaterThan(0);
    for (const e of f.bus.appended) expect(e.scope?.principal).toBe("acme/u1");
  });

  it("auto-threads parentOpId from the ambient RuntimeContext when not supplied", async () => {
    const f = fixture();
    // Nest an inner op inside an outer op's body — the inner should inherit the
    // outer opId as its parentOpId via the FiberRef context.
    await Effect.runPromise(
      f.runner.runOperation(op({}, { opId: "outer" }), () =>
        f.runner.runOperation(op({}, { opId: "inner", name: "test:command:nested" }), () =>
          Effect.succeed(1),
        ),
      ),
    );
    const innerRequested = f.bus.appended.find(
      (e) => e.opId === "inner" && e.phase === "requested",
    );
    expect(innerRequested?.parentOpId).toBe("outer");
  });
});

describe("OperationRunner — light-path helpers (harness delegation surface)", () => {
  it("makeEvent stamps identity (opId/surface/principal); publish routes to bus", async () => {
    const f = fixture({ principal: "p1" });
    const ev = f.runner.makeEvent(op({}, { opId: "z" }), "delta", {}, { payload: { tok: "hi" } });
    expect(ev.opId).toBe("z");
    expect(ev.surface).toBe("test");
    expect(ev.phase).toBe("delta");
    expect(ev.scope?.principal).toBe("p1");
    await Effect.runPromise(f.runner.publish(ev));
    expect(f.bus.appended).toContain(ev);
  });

  it("decideFromShape reflects the journaling policy", () => {
    const f = fixture();
    // `delta` is bus-only under the default policy; a terminal journals.
    expect(f.runner.decideFromShape("test:command:doThing", "delta")).toBe("bus-only");
    expect(["journal", "always"]).toContain(
      f.runner.decideFromShape("test:command:doThing", "terminal"),
    );
  });
});
