/**
 * The positional-op-id child-index counter — the mechanism behind auto-derived
 * positional keys. Proves the three properties the derivation relies on:
 * sequential increment within a scope, RESET per scope (so a re-run of the same
 * scope yields the same indices — the deterministic-replay property), and nested
 * isolation (a child scope's counter never leaks to or from its parent).
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  nextChildIndex,
  positionalOpId,
  withFreshChildScope,
} from "../substrate/positional-op-id.js";

describe("positional-op-id — child-index counter", () => {
  it("nextChildIndex increments from 0 within a scope", async () => {
    const result = await Effect.runPromise(
      withFreshChildScope(
        Effect.gen(function* () {
          return [yield* nextChildIndex, yield* nextChildIndex, yield* nextChildIndex];
        }),
      ),
    );
    expect(result).toEqual([0, 1, 2]);
  });

  it("resets per scope — a re-run of the same scope yields identical indices", async () => {
    const run = (): Effect.Effect<readonly number[]> =>
      withFreshChildScope(
        Effect.gen(function* () {
          return [yield* nextChildIndex, yield* nextChildIndex];
        }),
      );
    expect(await Effect.runPromise(run())).toEqual([0, 1]);
    expect(await Effect.runPromise(run())).toEqual([0, 1]); // fresh counter each run
  });

  it("a nested scope is isolated — the parent resumes its own count unaffected", async () => {
    const result = await Effect.runPromise(
      withFreshChildScope(
        Effect.gen(function* () {
          const parent0 = yield* nextChildIndex; // 0
          const nested = yield* withFreshChildScope(
            Effect.gen(function* () {
              return [yield* nextChildIndex, yield* nextChildIndex]; // 0, 1 (fresh)
            }),
          );
          const parent1 = yield* nextChildIndex; // 1 — parent continues, unperturbed
          return { parent0, nested, parent1 };
        }),
      ),
    );
    expect(result).toEqual({ parent0: 0, nested: [0, 1], parent1: 1 });
  });

  it("positionalOpId composes parent + index", () => {
    expect(positionalOpId("code:exec-0", 2)).toBe("code:exec-0:2");
  });
});
