import { describe, expect, it } from "vitest";

import { mergeAbortSignals } from "../abort-signals.js";

describe("mergeAbortSignals", () => {
  it("returns undefined when no signals are supplied", () => {
    expect(mergeAbortSignals()).toBeUndefined();
    expect(mergeAbortSignals(undefined, undefined)).toBeUndefined();
  });

  it("returns the lone live signal as-is (no wrapper)", () => {
    const c = new AbortController();
    expect(mergeAbortSignals(undefined, c.signal, undefined)).toBe(c.signal);
  });

  it("returns an already-aborted source directly (synchronous .aborted)", () => {
    const live = new AbortController();
    const dead = new AbortController();
    dead.abort("boom");
    const merged = mergeAbortSignals(live.signal, dead.signal);
    expect(merged).toBe(dead.signal);
    expect(merged?.aborted).toBe(true);
  });

  it("fires + propagates reason when the FIRST source aborts", () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = mergeAbortSignals(a.signal, b.signal)!;
    expect(merged.aborted).toBe(false);
    a.abort("first");
    expect(merged.aborted).toBe(true);
    expect(merged.reason).toBe("first");
  });

  it("fires when the SECOND source aborts", () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = mergeAbortSignals(a.signal, b.signal)!;
    b.abort("second");
    expect(merged.aborted).toBe(true);
    expect(merged.reason).toBe("second");
  });
});
