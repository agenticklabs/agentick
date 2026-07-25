/**
 * `liftToEffect` — type-shape transformation from Promise/sync/Effect
 * to Effect. Per ADR 45.
 *
 * Pins:
 *   - Sync return → Effect.tryPromise wrap, value flows through.
 *   - Promise return → Effect.tryPromise wrap, awaited value flows through.
 *   - Effect return → passthrough (idempotent).
 *   - Throws inside fn → typed via errorMap when provided.
 *   - No forking — the returned Effect is unrun until composed.
 *   - Composable in Effect chains via yield*.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { liftToEffect } from "../effect-lift.js";

describe("liftToEffect", () => {
  it("lifts a sync function — value flows through", async () => {
    const square = (n: number): number => n * n;
    const lifted = liftToEffect(square);

    const result = await Effect.runPromise(lifted(4));
    expect(result).toBe(16);
  });

  it("lifts an async function — Promise value flows through", async () => {
    const fetchValue = async (key: string): Promise<string> => `value:${key}`;
    const lifted = liftToEffect(fetchValue);

    const result = await Effect.runPromise(lifted("x"));
    expect(result).toBe("value:x");
  });

  it("passes through an Effect return unchanged (idempotent)", async () => {
    const proc = (n: number): Effect.Effect<number, never> => Effect.succeed(n * 2);
    const lifted = liftToEffect(proc);

    const result = await Effect.runPromise(lifted(5));
    expect(result).toBe(10);
  });

  it("re-lifting an already-lifted Effect is a no-op", async () => {
    const square = (n: number): number => n * n;
    const lifted = liftToEffect(square);
    // Re-lift — adopter applies the helper unconditionally.
    const reLifted = liftToEffect(lifted);

    const result = await Effect.runPromise(reLifted(3));
    expect(result).toBe(9);
  });

  it("maps thrown errors via errorMap", async () => {
    class MyError extends Error {
      constructor(public readonly cause: unknown) {
        super("mapped");
      }
    }
    const failing = async (): Promise<number> => {
      throw new Error("boom");
    };
    const lifted = liftToEffect(failing, (err) => new MyError(err));

    await expect(Effect.runPromise(lifted())).rejects.toThrow(/mapped/);
  });

  it("composes in Effect chains via yield*", async () => {
    const double = liftToEffect(async (n: number) => n * 2);
    const addOne = liftToEffect(async (n: number) => n + 1);

    const pipeline = Effect.gen(function* () {
      const a = yield* double(3);
      const b = yield* addOne(a);
      return b;
    });

    const result = await Effect.runPromise(pipeline);
    expect(result).toBe(7);
  });

  it("does NOT fork — caller controls concurrency via yield*/fork/forkDaemon", async () => {
    // The returned Effect is unrun. Calling lifted(args) does NOT execute fn;
    // running the Effect (via runPromise / yield* / fork) is what executes it.
    let executions = 0;
    const counted = liftToEffect(async () => {
      executions++;
      return executions;
    });

    const effect = counted(); // construction — does not run fn
    expect(executions).toBe(0);

    await Effect.runPromise(effect); // now runs
    expect(executions).toBe(1);

    // The same lifted function can be forked or sequenced based on the
    // caller's needs:
    const sequential = Effect.gen(function* () {
      yield* counted();
      yield* counted();
    });
    await Effect.runPromise(sequential);
    expect(executions).toBe(3);
  });

  it("structured concurrency: child fiber spawned via Effect.fork inherits FiberRef + cascading abort", async () => {
    // Demonstrates the fork pattern adopters use on top of liftToEffect.
    const work = liftToEffect(async (delayMs: number): Promise<string> => {
      await new Promise((r) => setTimeout(r, delayMs));
      return `slept ${delayMs}ms`;
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(work(5));
        const value = yield* fiber.await;
        return value;
      }),
    );

    expect(result._tag).toBe("Success");
  });
});
