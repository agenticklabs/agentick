/**
 * `Resolvable<T>` / `ResolvableAsync<T>` + `resolveSync` / `resolveAsync`.
 * Tiny primitive but the contract is load-bearing for adopter
 * configs that defer a value until factory-invocation time
 * (env-var reads, id generation, etc.).
 */

import { describe, expect, it } from "vitest";

import { resolveAsync, resolveSync, type Resolvable, type ResolvableAsync } from "../resolvable.js";

describe("resolveSync", () => {
  it("returns a literal value unchanged", () => {
    expect(resolveSync<string>("hello")).toBe("hello");
    expect(resolveSync<number>(42)).toBe(42);
    expect(resolveSync<boolean>(false)).toBe(false);
    expect(resolveSync<null>(null)).toBeNull();
  });

  it("invokes a thunk and returns its result", () => {
    let calls = 0;
    const thunk = (): string => {
      calls += 1;
      return "from-thunk";
    };
    expect(resolveSync(thunk)).toBe("from-thunk");
    expect(calls).toBe(1);
  });

  it("invokes the thunk once per resolveSync call (no internal memoization)", () => {
    let calls = 0;
    const thunk: Resolvable<number> = () => ++calls;
    expect(resolveSync(thunk)).toBe(1);
    expect(resolveSync(thunk)).toBe(2);
    expect(resolveSync(thunk)).toBe(3);
  });

  it("propagates thunk errors at the resolution site", () => {
    const thunk: Resolvable<string> = () => {
      throw new Error("boom");
    };
    expect(() => resolveSync(thunk)).toThrow(/boom/);
  });

  it("preserves narrow literal types via the input shape", () => {
    // Type-level check: resolveSync<"a" | "b">(literal) keeps the
    // narrow type. We exercise the runtime path; the TS compiler
    // catches the static-type contract at typecheck time.
    const v: Resolvable<"a" | "b"> = "a";
    const out: "a" | "b" = resolveSync(v);
    expect(out).toBe("a");
  });
});

describe("resolveAsync", () => {
  it("returns a literal value unchanged", async () => {
    await expect(resolveAsync<string>("hello")).resolves.toBe("hello");
  });

  it("invokes a sync thunk and returns its result", async () => {
    const thunk: ResolvableAsync<number> = () => 7;
    await expect(resolveAsync(thunk)).resolves.toBe(7);
  });

  it("invokes an async thunk and awaits its Promise", async () => {
    const thunk: ResolvableAsync<string> = async () => {
      await new Promise((r) => setTimeout(r, 1));
      return "deferred";
    };
    await expect(resolveAsync(thunk)).resolves.toBe("deferred");
  });

  it("propagates rejected Promises", async () => {
    const thunk: ResolvableAsync<string> = async () => {
      throw new Error("async-boom");
    };
    await expect(resolveAsync(thunk)).rejects.toThrow(/async-boom/);
  });

  it("propagates sync thunk errors as rejected Promises", async () => {
    const thunk: ResolvableAsync<string> = () => {
      throw new Error("sync-boom");
    };
    await expect(resolveAsync(thunk)).rejects.toThrow(/sync-boom/);
  });
});
