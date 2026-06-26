import { describe, expect, it } from "vitest";

import { createKeyedNotifier } from "../keyed-notifier.js";

describe("createKeyedNotifier — Layer 2 (keyed + wildcards)", () => {
  it("notify(key) fires keyed bucket then wildcards", () => {
    const n = createKeyedNotifier();
    const order: string[] = [];
    n.subscribe("a", () => {
      order.push("a:1");
    });
    n.subscribe("a", () => {
      order.push("a:2");
    });
    n.subscribe("b", () => {
      order.push("b:1");
    });
    n.subscribeAll(() => {
      order.push("*");
    });
    n.notify("a");
    expect(order).toEqual(["a:1", "a:2", "*"]);
  });

  it("notify(key) on unknown key fires only wildcards", () => {
    const n = createKeyedNotifier();
    const order: string[] = [];
    n.subscribeAll(() => {
      order.push("*");
    });
    n.notify("missing");
    expect(order).toEqual(["*"]);
  });

  it("typed payload reaches keyed and wildcard listeners", () => {
    type Ev = { readonly tag: string };
    const n = createKeyedNotifier<string, Ev>();
    const keyed: Ev[] = [];
    const wild: Ev[] = [];
    n.subscribe("x", (e) => {
      keyed.push(e);
    });
    n.subscribeAll((e) => {
      wild.push(e);
    });
    n.notify("x", { tag: "hi" });
    expect(keyed).toEqual([{ tag: "hi" }]);
    expect(wild).toEqual([{ tag: "hi" }]);
  });

  it("auto-collects empty buckets on last unsubscribe", () => {
    const n = createKeyedNotifier();
    const offA = n.subscribe("a", () => {});
    const offB = n.subscribe("a", () => {});
    expect(n.count("a")).toBe(2);
    offA();
    expect(n.count("a")).toBe(1);
    offB();
    expect(n.count("a")).toBe(0);
    expect(n.size).toBe(0);
  });

  it("size accounts for keyed + wildcards", () => {
    const n = createKeyedNotifier();
    n.subscribe("a", () => {});
    n.subscribe("a", () => {});
    n.subscribe("b", () => {});
    n.subscribeAll(() => {});
    expect(n.count("a")).toBe(2);
    expect(n.count("b")).toBe(1);
    expect(n.wildcardCount).toBe(1);
    expect(n.size).toBe(4);
  });

  it("clear() drops keyed + wildcard subscribers", () => {
    const n = createKeyedNotifier();
    const calls: string[] = [];
    n.subscribe("a", () => {
      calls.push("a");
    });
    n.subscribeAll(() => {
      calls.push("*");
    });
    n.clear();
    expect(n.size).toBe(0);
    expect(n.wildcardCount).toBe(0);
    n.notify("a");
    n.notifyAll();
    expect(calls).toEqual([]);
  });

  it("notifyAll fires wildcards only (keyed subscribers untouched)", () => {
    const n = createKeyedNotifier();
    const calls: string[] = [];
    n.subscribe("a", () => {
      calls.push("a");
    });
    n.subscribe("b", () => {
      calls.push("b");
    });
    n.subscribeAll(() => {
      calls.push("*");
    });
    n.notifyAll();
    expect(calls).toEqual(["*"]);
  });

  it("notifyAsync awaits each listener serially", async () => {
    type Ev = { readonly n: number };
    const n = createKeyedNotifier<string, Ev>();
    const order: string[] = [];
    n.subscribe("k", async (e) => {
      await Promise.resolve();
      order.push(`first:${e.n}`);
    });
    n.subscribe("k", async (e) => {
      await Promise.resolve();
      order.push(`second:${e.n}`);
    });
    n.subscribeAll(async (e) => {
      await Promise.resolve();
      order.push(`*:${e.n}`);
    });
    await n.notifyAsync("k", { n: 1 });
    expect(order).toEqual(["first:1", "second:1", "*:1"]);
  });

  it("notifyAsync propagates listener errors", async () => {
    const n = createKeyedNotifier<string, void>();
    n.subscribe("k", () => {
      throw new Error("boom");
    });
    await expect(n.notifyAsync("k")).rejects.toThrow("boom");
  });

  it("sync notify swallows listener errors (isolation)", () => {
    const n = createKeyedNotifier();
    const calls: string[] = [];
    n.subscribe("k", () => {
      throw new Error("boom");
    });
    n.subscribe("k", () => {
      calls.push("ok");
    });
    n.subscribeAll(() => {
      calls.push("*");
    });
    expect(() => n.notify("k")).not.toThrow();
    expect(calls).toEqual(["ok", "*"]);
  });
});
