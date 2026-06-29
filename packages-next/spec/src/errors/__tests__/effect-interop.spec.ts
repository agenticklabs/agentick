/**
 * Effect interop — `AgentickError` instances work with `Effect.catchTag`,
 * `Effect.catchTags`, and discriminated narrowing through the `_tag`
 * literal.
 *
 * Pins the load-bearing claim from ADR 41 §"Risks": Effect's runtime
 * pattern-matching reads the `_tag` own-property of the failure value;
 * class instances expose `_tag` as an own property (via the field
 * initializer), so the existing call sites work unchanged after the
 * conversion from POJO to class.
 *
 * If this test ever fails, the entire migration plan is in question —
 * every `Effect.catchTag` in v2 depends on this invariant.
 */

import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";

import { AgentickError } from "../base.js";

class FooInteropError extends AgentickError {
  readonly _tag = "FooInteropError" as const;
  readonly fooId: string;
  constructor(args: { readonly fooId: string }) {
    super(`foo ${args.fooId} failed`);
    this.fooId = args.fooId;
  }
}

class BarInteropError extends AgentickError {
  readonly _tag = "BarInteropError" as const;
  readonly barId: number;
  constructor(args: { readonly barId: number }) {
    super(`bar ${args.barId} failed`);
    this.barId = args.barId;
  }
}

describe("AgentickError × Effect interop", () => {
  it("Effect.catchTag matches by _tag on a class-instance failure", async () => {
    const program = Effect.fail(new FooInteropError({ fooId: "f-1" })).pipe(
      Effect.catchTag("FooInteropError", (err) => Effect.succeed(`caught: ${err.fooId}`)),
    );
    const result = await Effect.runPromise(program);
    expect(result).toBe("caught: f-1");
  });

  it("Effect.catchTag does NOT match a different _tag (passes through)", async () => {
    const program: Effect.Effect<string, FooInteropError, never> = Effect.fail(
      new FooInteropError({ fooId: "f-2" }),
    ).pipe(Effect.catchTag("BarInteropError" as never, () => Effect.succeed("wrong-handler")));
    const exit = await Effect.runPromiseExit(program);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(failure).toBeInstanceOf(FooInteropError);
    }
  });

  it("Effect.catchTags discriminates across a class-instance error union", async () => {
    const failFoo: Effect.Effect<string, FooInteropError | BarInteropError, never> = Effect.fail(
      new FooInteropError({ fooId: "f-3" }),
    );
    const failBar: Effect.Effect<string, FooInteropError | BarInteropError, never> = Effect.fail(
      new BarInteropError({ barId: 42 }),
    );

    const fooResult = await Effect.runPromise(
      failFoo.pipe(
        Effect.catchTags({
          FooInteropError: (err) => Effect.succeed(`foo:${err.fooId}`),
          BarInteropError: (err) => Effect.succeed(`bar:${err.barId}`),
        }),
      ),
    );
    expect(fooResult).toBe("foo:f-3");

    const barResult = await Effect.runPromise(
      failBar.pipe(
        Effect.catchTags({
          FooInteropError: (err) => Effect.succeed(`foo:${err.fooId}`),
          BarInteropError: (err) => Effect.succeed(`bar:${err.barId}`),
        }),
      ),
    );
    expect(barResult).toBe("bar:42");
  });

  it("uncaught failure preserves the original class instance through the Exit", async () => {
    const program = Effect.fail(new FooInteropError({ fooId: "f-4" }));
    const exit = await Effect.runPromiseExit(program);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(FooInteropError);
      expect(exit.cause.error).toBeInstanceOf(AgentickError);
      expect(exit.cause.error._tag).toBe("FooInteropError");
    }
  });
});
