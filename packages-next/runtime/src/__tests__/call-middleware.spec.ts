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

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { BaseHarness, withCallMiddleware, type Middleware } from "@agentick/runtime-next";
import type { MessageEnvelope, MessageHandlerError, Operation } from "@agentick/spec-next";
import { HandlerError } from "@agentick/spec-next";

/** Minimal harness exposing an un-run `runOperation` Effect (`opFx`). */
class MwHarness extends BaseHarness<"tool"> {
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

  useMw(mw: Middleware<unknown, unknown, unknown>): () => void {
    return this.middleware.use(mw);
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
