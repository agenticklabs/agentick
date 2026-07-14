/**
 * ADR 83 — the deny-before-transform ordering proof + guard
 * introspectability.
 *
 * The collapse claim: a `guard`-kind interceptor and a `transform`-kind
 * interceptor live on ONE composed seam, and a STABLE guard-outermost sort
 * guarantees a guard DENIES before any transform reshapes the input — even when
 * the transform was registered first (insertion order) and even when the guard
 * is a broad-scope ancestor while the transform is a narrow-scope descendant.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { BaseHarness, type Middleware } from "@agentick/runtime-next";
import type { MessageEnvelope, MessageHandlerError, Operation } from "@agentick/spec-next";
import { HandlerError } from "@agentick/spec-next";

interface In {
  readonly a: number;
  readonly b: number;
}

let counter = 0;

class GuardHarness extends BaseHarness<"tool"> {
  constructor(id: string, parent?: GuardHarness) {
    super(
      "tool",
      id,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      // ADR 76 fold — snapshot the parent's resolved interceptors at construction.
      parent ? { inheritedInterceptors: parent.resolvedInterceptorsForTest() } : {},
    );
  }

  /** Public test accessor for the `protected resolvedInterceptors()` fold value. */
  resolvedInterceptorsForTest(): readonly Middleware<unknown, unknown, unknown>[] {
    return this.resolvedInterceptors();
  }

  /** Run `a + b` through the full interceptor seam. */
  run(input: In): Effect.Effect<number, unknown, never> {
    const op: Operation<In, number> = {
      opId: `tool:guard:run:${counter++}`,
      surface: "tool",
      name: "tool:guard:run",
      scope: {},
      input,
    };
    return this.runOperation(op, (i) => Effect.succeed(i.a + i.b));
  }

  /** Register a TRANSFORM-kind interceptor (untagged `.use` → transform). */
  useTransform(mw: Middleware<In, number, unknown>): () => void {
    return this.fx.use(mw as Middleware<unknown, unknown, unknown>);
  }

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: new Error("n/a") }));
  }
}

async function mk(id: string, parent?: GuardHarness): Promise<GuardHarness> {
  const h = new GuardHarness(id, parent);
  await h.ready;
  return h;
}

describe("ADR 83 — deny-before-transform ordering", () => {
  it("a guard denies BEFORE a transform reshapes the input, EVEN when the transform is registered first", async () => {
    const h = await mk("solo");
    const order: string[] = [];
    let gateSawA: number | undefined;
    let transformRan = false;

    // Register the TRANSFORM first. By insertion order alone it would compose
    // outermost and reshape the input (a,b → 999,999) before anything sees it.
    h.useTransform((_input, next) =>
      Effect.gen(function* () {
        transformRan = true;
        order.push("transform");
        return yield* next({ a: 999, b: 999 });
      }),
    );

    // Register the GATE second. The stable guard-outermost sort floats it ahead
    // of the transform, so it runs FIRST and sees the ORIGINAL input.
    h.guard<In, number>((input) => {
      gateSawA = input.a;
      order.push("guard");
      return { kind: "veto", reason: "denied" };
    });

    await expect(Effect.runPromise(h.run({ a: 1, b: 2 }))).rejects.toBeTruthy();
    expect(order).toEqual(["guard"]); // transform NEVER ran — deny came first
    expect(transformRan).toBe(false);
    expect(gateSawA).toBe(1); // guard saw the UN-reshaped input
  });

  it("a BROAD-scope (ancestor) guard denies BEFORE a NARROW-scope (descendant) transform", async () => {
    const app = await mk("app");

    const order: string[] = [];
    let transformRan = false;
    let gateSawA: number | undefined;

    // Broad (app) guard — registered BEFORE the session is constructed, so the
    // fold snapshots it into the session's inherited layer; composes outermost.
    app.guard<In, number>((input) => {
      gateSawA = input.a;
      order.push("app:guard");
      return { kind: "veto", reason: "app-policy" };
    });

    const session = await mk("session", app);

    // Narrow (session) transform — reshapes input.
    session.useTransform((_input, next) =>
      Effect.gen(function* () {
        transformRan = true;
        order.push("session:transform");
        return yield* next({ a: 100, b: 100 });
      }),
    );

    await expect(Effect.runPromise(session.run({ a: 1, b: 2 }))).rejects.toBeTruthy();
    expect(order).toEqual(["app:guard"]);
    expect(transformRan).toBe(false);
    expect(gateSawA).toBe(1);
  });

  it("when the guard PROCEEDS, the transform still runs (reshapes input) — guard is non-destructive on proceed", async () => {
    const h = await mk("proceed");
    const order: string[] = [];

    h.useTransform((_input, next) =>
      Effect.gen(function* () {
        order.push("transform");
        return yield* next({ a: 10, b: 20 });
      }),
    );
    h.guard<In, number>(() => {
      order.push("guard");
      return { kind: "proceed" };
    });

    const out = await Effect.runPromise(h.run({ a: 1, b: 2 }));
    expect(order).toEqual(["guard", "transform"]); // guard outermost, then transform
    expect(out).toBe(30); // body saw the reshaped {10,20}
  });
});

describe("ADR 83 — introspectability", () => {
  it("the assembled interceptor list is enumerable; guard-kind sorts outermost", async () => {
    const h = await mk("introspect");
    h.useTransform((i, next) => next(i)); // transform
    h.guard(() => undefined); // guard
    h.useTransform((i, next) => next(i)); // transform
    // Enumerable, guard-outermost, transforms keep their mutual (insertion) order.
    expect(h.listInterceptors("tool:guard:run")).toEqual(["guard", "transform", "transform"]);
  });

  it("no interceptors → empty enumerable list (behavior-preserving)", async () => {
    const h = await mk("empty");
    expect(h.listInterceptors("tool:guard:run")).toEqual([]);
  });
});
