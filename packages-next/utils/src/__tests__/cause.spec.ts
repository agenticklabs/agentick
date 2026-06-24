import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { reasonOf, reasonOfCause, unwrapExit } from "../cause.js";

describe("reasonOf", () => {
  it("passes through string values verbatim", () => {
    expect(reasonOf("boom")).toBe("boom");
    expect(reasonOf("")).toBe("");
  });

  it("extracts Error.message", () => {
    expect(reasonOf(new Error("kaboom"))).toBe("kaboom");
    expect(reasonOf(new TypeError("bad type"))).toBe("bad type");
  });

  it("extracts _tag for Effect-style tagged errors", () => {
    expect(reasonOf({ _tag: "InvalidInput" })).toBe("InvalidInput");
    expect(reasonOf({ _tag: "AuthRequired", url: "https://x" })).toBe("AuthRequired");
  });

  it("ignores non-string _tag (falls through to JSON)", () => {
    const v = { _tag: 42, info: "x" };
    expect(reasonOf(v)).toBe(JSON.stringify(v));
  });

  it("JSON-stringifies plain objects", () => {
    expect(reasonOf({ code: 500, msg: "err" })).toBe(JSON.stringify({ code: 500, msg: "err" }));
    expect(reasonOf([1, 2, 3])).toBe("[1,2,3]");
  });

  it("falls back to String() when JSON.stringify throws", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    // Cyclic structures throw in JSON.stringify; we fall back to String().
    expect(reasonOf(cyclic)).toBe(String(cyclic));
  });

  it("falls back to String() for primitives that aren't strings", () => {
    expect(reasonOf(42)).toBe("42");
    expect(reasonOf(true)).toBe("true");
    expect(reasonOf(null)).toBe("null");
    expect(reasonOf(undefined)).toBe("undefined");
  });

  it("falls back to String() when JSON.stringify returns undefined (fns, symbols)", () => {
    expect(reasonOf(() => 0)).toBe(String(() => 0));
    expect(reasonOf(Symbol("x"))).toBe("Symbol(x)");
  });
});

describe("reasonOfCause", () => {
  it("returns reasonOf(value) for a typed Effect.fail", () => {
    const exit = Effect.runSyncExit(Effect.fail({ _tag: "Boom", info: "x" }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(reasonOfCause(exit.cause)).toBe("Boom");
    }
  });

  it("returns reasonOf(value) for an Effect.fail string", () => {
    const exit = Effect.runSyncExit(Effect.fail("string failure"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(reasonOfCause(exit.cause)).toBe("string failure");
    }
  });

  it("returns reasonOf(defect) for an Effect.die with an Error", () => {
    const exit = Effect.runSyncExit(Effect.die(new Error("dead")));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(reasonOfCause(exit.cause)).toBe("dead");
    }
  });

  it("returns Cause.pretty first line for interrupt-only causes", () => {
    const cause = Cause.interrupt(0 as unknown as number) as Cause.Cause<never>;
    const reason = reasonOfCause(cause);
    expect(reason).toBe(Cause.pretty(cause).split("\n")[0]);
    expect(reason.includes("\n")).toBe(false);
  });

  it("returns 'unknown' fallback for empty causes", () => {
    // Cause.pretty("Empty") is "All fibers interrupted without errors." — we
    // assert single-line and non-empty, not the exact pretty wording (which
    // is an Effect-internal detail).
    const cause = Cause.empty;
    const reason = reasonOfCause(cause);
    expect(reason.length).toBeGreaterThan(0);
    expect(reason.includes("\n")).toBe(false);
  });

  it("typed failure wins over composite (fail + interrupt) cause", () => {
    const composite = Cause.parallel(
      Cause.fail({ _tag: "Boom" }),
      Cause.interrupt(0 as unknown as number),
    );
    expect(reasonOfCause(composite)).toBe("Boom");
  });
});

describe("unwrapExit", () => {
  it("returns value on success", () => {
    const exit = Effect.runSyncExit(Effect.succeed(42));
    expect(unwrapExit(exit)).toBe(42);
  });

  it("throws the typed E value AS-IS for Effect.fail", () => {
    const tagged = { _tag: "Boom", info: "x" };
    const exit = Effect.runSyncExit(Effect.fail(tagged));
    expect(() => unwrapExit(exit)).toThrow(/.*/);
    try {
      unwrapExit(exit);
    } catch (e) {
      // Identity-preserved — same object reference, not wrapped in Error.
      expect(e).toBe(tagged);
    }
  });

  it("throws Error(Cause.pretty) for Effect.die defects", () => {
    const exit = Effect.runSyncExit(Effect.die(new Error("dead")));
    expect(() => unwrapExit(exit)).toThrow(Error);
    try {
      unwrapExit(exit);
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      // Cause.pretty includes the message; we don't pin the exact format.
      expect((e as Error).message).toContain("dead");
    }
  });

  it("throws Error(Cause.pretty) for interrupt-only causes", () => {
    const exit: Exit.Exit<number, never> = Exit.failCause(Cause.interrupt(0 as unknown as number));
    expect(() => unwrapExit(exit)).toThrow(Error);
  });
});
