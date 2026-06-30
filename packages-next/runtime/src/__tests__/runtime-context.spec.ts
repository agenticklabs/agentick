/**
 * Public-surface test for the runtime-context sync accessor —
 * `readContext`. The v2 analog of v1's `Context.get()`.
 *
 * NOTE: a `runWithContext` / `Context.run` analog is intentionally
 * NOT shipped. See the long comment in `runtime-context.ts` for the
 * `Effect.runSync` + FiberRef interaction that breaks the obvious
 * implementation. Adopters wanting scoped sync set use
 * `Effect.runPromise(withContext(scope, ...))` from Effect-land
 * until a deliberate design slice picks the AsyncLocalStorage-vs-
 * FiberRef story.
 */

import { describe, expect, it } from "vitest";

import { EMPTY_CONTEXT, readContext } from "../index.js";

describe("readContext", () => {
  it("returns EMPTY_CONTEXT when called outside any Effect fiber scope", () => {
    expect(readContext()).toEqual(EMPTY_CONTEXT);
  });

  it("returns a plain RuntimeContext object — never an Effect", () => {
    const ctx = readContext();
    // No Effect-shape leakage; adopters never have to enter
    // Effect-land for the read.
    expect(typeof (ctx as { pipe?: unknown }).pipe).toBe("undefined");
  });
});
