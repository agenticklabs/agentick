import { describe, expect, it } from "vitest";

import { createNotifier } from "../notifier.js";

describe("createNotifier — Layer 1 (single-channel observer)", () => {
  it("delivers parameterless notify() to every subscriber", () => {
    const n = createNotifier();
    const calls: string[] = [];
    n.subscribe(() => calls.push("a"));
    n.subscribe(() => calls.push("b"));
    n.notify();
    expect(calls).toEqual(["a", "b"]);
  });

  it("delivers typed payload to subscribers when T != void", () => {
    const n = createNotifier<{ readonly count: number }>();
    let last = -1;
    n.subscribe((s) => {
      last = s.count;
    });
    n.notify({ count: 42 });
    expect(last).toBe(42);
  });

  it("unsubscribe removes only the matching listener", () => {
    const n = createNotifier();
    const calls: string[] = [];
    const offA = n.subscribe(() => calls.push("a"));
    n.subscribe(() => calls.push("b"));
    offA();
    n.notify();
    expect(calls).toEqual(["b"]);
  });

  it("tolerates listener errors (isolation)", () => {
    const n = createNotifier();
    const calls: string[] = [];
    n.subscribe(() => {
      throw new Error("boom");
    });
    n.subscribe(() => calls.push("ok"));
    expect(() => n.notify()).not.toThrow();
    expect(calls).toEqual(["ok"]);
  });

  it("tolerates mid-iteration unsubscribe", () => {
    const n = createNotifier();
    const calls: string[] = [];
    let off2: (() => void) | undefined;
    n.subscribe(() => {
      calls.push("a");
      off2?.();
    });
    off2 = n.subscribe(() => calls.push("b"));
    n.subscribe(() => calls.push("c"));
    n.notify();
    // `b` was snapshotted into the iteration list before being removed.
    expect(calls).toEqual(["a", "b", "c"]);
    calls.length = 0;
    n.notify();
    expect(calls).toEqual(["a", "c"]);
  });

  it("size reflects active listeners", () => {
    const n = createNotifier();
    expect(n.size).toBe(0);
    const off = n.subscribe(() => {});
    n.subscribe(() => {});
    expect(n.size).toBe(2);
    off();
    expect(n.size).toBe(1);
  });

  it("clear() drops every subscriber", () => {
    const n = createNotifier();
    const calls: string[] = [];
    n.subscribe(() => calls.push("a"));
    n.subscribe(() => calls.push("b"));
    n.clear();
    expect(n.size).toBe(0);
    n.notify();
    expect(calls).toEqual([]);
  });
});
