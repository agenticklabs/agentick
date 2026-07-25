/**
 * Tier-4 call-scoped middleware (ADR 76) — the ADR 77 spine payoff.
 *
 * `withCallMiddleware([mw], effect)` scopes `mw` around EVERY nested
 * `runOperation` the effect transitively reaches — in ANY harness, ACROSS
 * CONSTRUCTION-SIBLINGS — then evaporates. This is only possible because the
 * spine made the call ONE fiber: the `CallMiddlewareRef` FiberRef propagates
 * through it. Before the spine (~40 independent `runPromise` roots) a
 * FiberRef could not cross harness boundaries and tier 4 was impossible.
 *
 * The two harnesses below have NO construction relationship (parent
 * undefined) — mirroring the real topology where the app builds the loop /
 * executor / tool as shared siblings. Structural inheritance (tier 3) cannot
 * express "wrap both of these for THIS call"; tier 4 can.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import {
  BaseHarness,
  getContext,
  liftMiddleware,
  withCallMiddleware,
  type Middleware,
} from "@agentick/runtime";
import type { MessageEnvelope, MessageHandlerError, Operation } from "@agentick/spec";
import { HandlerError } from "@agentick/spec";

/** Minimal harness exposing an un-run `runOperation` Effect (`opFx`). */
class MwHarness extends BaseHarness<"tool"> {
  /** Captures the inner op's `parentOpId` for the causal-tree test. */
  capturedParent: string | undefined;

  constructor(scopeId: string) {
    super("tool", scopeId, new MemoryJournal(), new LocalEventBus(), new LocalInbox());
  }

  /** The composable op Effect (un-run) — composes in the caller's fiber. */
  opFx(name: string): Effect.Effect<number, unknown, never> {
    const op: Operation<{ n: number }, number> = {
      opId: `tool:${name}:1`,
      surface: "tool",
      name: `tool:${name}`,
      scope: {},
      input: { n: 1 },
    };
    return this.runOperation(op, (i) => Effect.succeed(i.n));
  }

  /** An "outer" op whose body runs an "inner" op that records its parentOpId. */
  nestedFx(): Effect.Effect<number, unknown, never> {
    const outer: Operation<{ n: number }, number> = {
      opId: "tool:outer:1",
      surface: "tool",
      name: "tool:outer",
      scope: {},
      input: { n: 1 },
    };
    return this.runOperation(outer, () => this.innerFx());
  }

  private innerFx(): Effect.Effect<number, unknown, never> {
    const inner: Operation<{ n: number }, number> = {
      opId: "tool:inner:1",
      surface: "tool",
      name: "tool:inner",
      scope: {},
      input: { n: 1 },
    };
    return this.runOperation(inner, () =>
      Effect.gen(this, function* () {
        const ctx = yield* getContext;
        this.capturedParent = ctx.parentOpId;
        return 1;
      }),
    );
  }

  useMw(mw: Middleware<unknown, unknown, unknown>): () => void {
    return this.fx.use(mw);
  }

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: new Error("n/a") }));
  }
}

async function mkHarness(id: string): Promise<MwHarness> {
  const h = new MwHarness(id);
  await h.ready;
  return h;
}

describe("Tier-4 call-scoped middleware (ADR 76 / ADR 77 spine payoff)", () => {
  it("wraps ops across CONSTRUCTION-SIBLINGS in one fiber, then evaporates", async () => {
    const a = await mkHarness("a");
    const b = await mkHarness("b"); // no construction relationship to `a`

    let wraps = 0;
    const countMw: Middleware<unknown, unknown, unknown> = (input, next) => {
      wraps += 1;
      return next(input);
    };

    // Compose BOTH sibling harnesses' ops in ONE fiber under the call scope.
    const [ra, rb] = await Effect.runPromise(
      withCallMiddleware(
        [countMw],
        Effect.gen(function* () {
          const x = yield* a.opFx("a-op");
          const y = yield* b.opFx("b-op");
          return [x, y] as const;
        }),
      ),
    );
    expect([ra, rb]).toEqual([1, 1]);
    // The call-scoped mw wrapped BOTH ops — even though a and b are siblings.
    expect(wraps).toBe(2);

    // Evaporated: an op OUTSIDE the scope is not wrapped.
    await Effect.runPromise(a.opFx("a-outside"));
    expect(wraps).toBe(2);
  });

  it("composes OUTERMOST of the harness's own (tier-2) middleware", async () => {
    const a = await mkHarness("order");
    const order: string[] = [];
    a.useMw((input, next) => {
      order.push("own");
      return next(input);
    });
    const callMw: Middleware<unknown, unknown, unknown> = (input, next) => {
      order.push("call");
      return next(input);
    };

    await Effect.runPromise(withCallMiddleware([callMw], a.opFx("op")));
    // Call-scoped is broadest → runs first (outermost), then the own chain.
    expect(order).toEqual(["call", "own"]);
  });

  it("nested withCallMiddleware ACCUMULATE (outer stays outermost)", async () => {
    const a = await mkHarness("nest");
    const order: string[] = [];
    const mk =
      (label: string): Middleware<unknown, unknown, unknown> =>
      (input, next) => {
        order.push(label);
        return next(input);
      };

    await Effect.runPromise(
      withCallMiddleware([mk("outer")], withCallMiddleware([mk("inner")], a.opFx("op"))),
    );
    expect(order).toEqual(["outer", "inner"]);
  });

  it("empty middleware list is a pass-through (behavior-preserving)", async () => {
    const a = await mkHarness("empty");
    const r = await Effect.runPromise(withCallMiddleware([], a.opFx("op")));
    expect(r).toBe(1);
  });
});

describe("harness.use — pure-JS async middleware (the Promise-facade surface)", () => {
  it("an INLINE async middleware wraps an op — no Effect, params infer, no wrapper", async () => {
    const a = await mkHarness("async-use");
    const events: string[] = [];
    // `use` is single-typed (AsyncMiddleware) → the inline arrow's params infer;
    // no liftMiddleware wrapper. `await next(input)` proceeds. `use` lifts it
    // to Effect internally.
    a.use(async (input, next) => {
      events.push("before");
      const result = await next(input);
      events.push("after");
      return result;
    });

    const r = await Effect.runPromise(a.opFx("op"));
    expect(r).toBe(1);
    expect(events).toEqual(["before", "after"]);
  });

  it("an async middleware can SHORT-CIRCUIT (returns without calling next)", async () => {
    const a = await mkHarness("async-short");
    a.use(async () => 99); // never calls next → op body never runs
    const r = await Effect.runPromise(a.opFx("op"));
    expect(r).toBe(99); // the short-circuit value, not the body's 1
  });

  it("mixes with fx.use Effect middleware — both in one chain, outer→inner", async () => {
    const a = await mkHarness("async-mixed");
    const order: string[] = [];
    // Effect middleware via fx.use (registered first → outermost).
    a.fx.use((input, next) =>
      Effect.gen(function* () {
        order.push("effect");
        return yield* next(input);
      }),
    );
    // Async middleware via use (registered second → inner).
    a.use(async (input, next) => {
      order.push("async");
      return await next(input);
    });

    await Effect.runPromise(a.opFx("op"));
    expect(order).toEqual(["effect", "async"]);
  });

  it("a throw in an async middleware fails the op", async () => {
    const a = await mkHarness("async-throw");
    a.use(async () => {
      throw new Error("mw boom");
    });
    const exit = await Effect.runPromiseExit(a.opFx("op"));
    expect(exit._tag).toBe("Failure");
  });

  it("the causal tree survives the async boundary (parentOpId re-threaded)", async () => {
    const a = await mkHarness("async-ctx");
    // An async middleware severs the fiber (await next runs a fresh root), but
    // `use`'s lift re-threads RuntimeContext — so a NESTED op still sees its
    // real parentOpId even though the fiber (span-nesting) does not survive.
    a.use(async (input, next) => await next(input));

    await Effect.runPromise(a.nestedFx());
    expect(a.capturedParent).toBe("tool:outer:1");
  });

  it("a pure-JS async middleware works via withCallMiddleware (tier 4) through liftMiddleware", async () => {
    const a = await mkHarness("async-call");
    let wrapped = false;
    // withCallMiddleware takes Effect middleware; wrap async with liftMiddleware.
    const r = await Effect.runPromise(
      withCallMiddleware(
        [
          liftMiddleware(async (input, next) => {
            wrapped = true;
            return next(input);
          }),
        ],
        a.opFx("op"),
      ),
    );
    expect(r).toBe(1);
    expect(wrapped).toBe(true);
  });
});
