import { describe, expect, it } from "vitest";

import { changeKind, createChangeNotifier, type ChangeEvent } from "../change-notifier.js";

describe("createChangeNotifier — the notify seam (typed push)", () => {
  it("emitChange fans the delta to every onChange listener", () => {
    const n = createChangeNotifier<number>();
    const seen: ChangeEvent<number>[] = [];
    n.onChange((c) => seen.push(c));
    n.onChange((c) => seen.push(c));

    n.emitChange({ key: "budget", value: 50, prev: 10 });

    expect(seen).toEqual([
      { key: "budget", value: 50, prev: 10 },
      { key: "budget", value: 50, prev: 10 },
    ]);
  });

  it("carries the full delta — key, value, and prev the producer supplied", () => {
    const n = createChangeNotifier<string>();
    let received: ChangeEvent<string> | undefined;
    n.onChange((c) => {
      received = c;
    });

    n.emitChange({ key: "mode", value: "fast", prev: "slow" });

    expect(received).toEqual({ key: "mode", value: "fast", prev: "slow" });
  });

  it("is a stateless pipe — holds no values, computes no prev itself", () => {
    const n = createChangeNotifier<number>();
    const seen: ChangeEvent<number>[] = [];
    n.onChange((c) => seen.push(c));

    // Two emits for the same key: the notifier does NOT remember the
    // first value and inject it as `prev` on the second. Prev is the
    // producer's to supply.
    n.emitChange({ key: "k", value: 1 });
    n.emitChange({ key: "k", value: 2 });

    expect(seen).toEqual([
      { key: "k", value: 1 },
      { key: "k", value: 2 },
    ]);
  });

  it("unsubscribe stops delivery to that listener only", () => {
    const n = createChangeNotifier<number>();
    const a: number[] = [];
    const b: number[] = [];
    const offA = n.onChange((c) => a.push(c.value ?? -1));
    n.onChange((c) => b.push(c.value ?? -1));

    n.emitChange({ key: "k", value: 1 });
    offA();
    n.emitChange({ key: "k", value: 2 });

    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });

  it("observers are fire-and-forget: a throwing listener cannot break the producer or siblings", () => {
    const n = createChangeNotifier<number>();
    const survived: number[] = [];
    n.onChange(() => {
      throw new Error("bad observer");
    });
    n.onChange((c) => survived.push(c.value ?? -1));

    // emitChange must not throw — the outcome is committed before notify.
    expect(() => n.emitChange({ key: "k", value: 7 })).not.toThrow();
    expect(survived).toEqual([7]);
  });

  it("snapshots listeners so mid-fan-out (un)subscribe doesn't corrupt the current emit", () => {
    const n = createChangeNotifier<number>();
    const seen: string[] = [];
    n.onChange(() => {
      seen.push("first");
      // Subscribing during fan-out must not fire for THIS emit.
      n.onChange(() => seen.push("late"));
    });

    n.emitChange({ key: "k", value: 1 });
    expect(seen).toEqual(["first"]);

    n.emitChange({ key: "k", value: 2 });
    expect(seen).toEqual(["first", "first", "late"]);
  });

  it("clear() drops every listener", () => {
    const n = createChangeNotifier<number>();
    const seen: number[] = [];
    n.onChange((c) => seen.push(c.value ?? -1));
    expect(n.size).toBe(1);

    n.clear();
    expect(n.size).toBe(0);
    n.emitChange({ key: "k", value: 1 });
    expect(seen).toEqual([]);
  });

  it("size reports the current listener count", () => {
    const n = createChangeNotifier<number>();
    expect(n.size).toBe(0);
    const off = n.onChange(() => {});
    n.onChange(() => {});
    expect(n.size).toBe(2);
    off();
    expect(n.size).toBe(1);
  });
});

describe("changeKind — mechanical CRUD derivation for consumers", () => {
  it("value present, prev absent → add", () => {
    expect(changeKind({ key: "k", value: 1 })).toBe("add");
  });

  it("value present, prev present → update", () => {
    expect(changeKind({ key: "k", value: 2, prev: 1 })).toBe("update");
  });

  it("value absent, prev present → remove", () => {
    expect(changeKind({ key: "k", prev: 1 })).toBe("remove");
  });

  it("classifies a JSON-Patch-style op sequence for one key", () => {
    const kinds = [
      changeKind<number, string>({ key: "k", value: 1 }), // add
      changeKind<number, string>({ key: "k", value: 2, prev: 1 }), // replace
      changeKind<number, string>({ key: "k", prev: 2 }), // remove
    ];
    expect(kinds).toEqual(["add", "update", "remove"]);
  });
});
