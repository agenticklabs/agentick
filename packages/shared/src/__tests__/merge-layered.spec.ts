import { describe, expect, it } from "vitest";

import {
  append,
  isMergeStrategy,
  mergeLayered,
  omit,
  prepend,
  replace,
} from "../utils/merge-layered.js";

describe("mergeLayered — cascade semantics", () => {
  describe("scalars + undefined-filtering", () => {
    it("most-specific layer wins on scalar collision", () => {
      const out = mergeLayered<{ maxTicks: number }>(
        { maxTicks: 1 },
        { maxTicks: 2 },
        { maxTicks: 3 },
      );
      expect(out.maxTicks).toBe(3);
    });

    it("undefined slots fall through to earlier layers", () => {
      const out = mergeLayered<{ maxTicks: number }>({ maxTicks: 8 }, { maxTicks: undefined }, {});
      expect(out.maxTicks).toBe(8);
    });

    it("explicit-undefined in a layer is treated identical to omission", () => {
      const a = mergeLayered<{ x: number }>({ x: 1 }, { x: undefined });
      const b = mergeLayered<{ x: number }>({ x: 1 }, {});
      expect(a).toEqual(b);
    });

    it("undefined layer args are skipped wholesale", () => {
      const out = mergeLayered<{ a: number }>({ a: 1 }, undefined, { a: 2 }, undefined);
      expect(out.a).toBe(2);
    });
  });

  describe("objects — deep merge across layers", () => {
    it("deep-merges plain objects key-by-key", () => {
      const out = mergeLayered<{ meta: { gateway?: string; app?: string; tenant?: string } }>(
        { meta: { gateway: "g1" } },
        { meta: { app: "a1" } },
        { meta: { tenant: "acme" } },
      );
      expect(out.meta).toEqual({ gateway: "g1", app: "a1", tenant: "acme" });
    });

    it("most-specific leaf wins inside nested objects", () => {
      const out = mergeLayered<{ meta: { tier: string } }>(
        { meta: { tier: "free" } },
        { meta: { tier: "premium" } },
      );
      expect(out.meta.tier).toBe("premium");
    });

    it("recursive merge multiple levels deep", () => {
      const out = mergeLayered<{ a: { b: { c: { d: number; e?: number } } } }>(
        { a: { b: { c: { d: 1 } } } },
        { a: { b: { c: { e: 2 } } } },
      );
      expect(out.a.b.c).toEqual({ d: 1, e: 2 });
    });
  });

  describe("arrays — replace by default", () => {
    it("most-specific array wins by default (no implicit append)", () => {
      const out = mergeLayered<{ tools: readonly string[] }>(
        { tools: ["a", "b"] },
        { tools: ["c"] },
      );
      expect(out.tools).toEqual(["c"]);
    });
  });

  describe("opaque instances — replace by default", () => {
    it("class instances replace, never deep-merge", () => {
      class Executor {
        constructor(public modelId: string) {}
      }
      const a = new Executor("a");
      const b = new Executor("b");
      const out = mergeLayered<{ exec: Executor }>({ exec: a }, { exec: b });
      expect(out.exec).toBe(b);
    });

    it("function-valued fields (factories) replace", () => {
      const f = () => 1;
      const g = () => 2;
      const out = mergeLayered<{ factory: () => number }>({ factory: f }, { factory: g });
      expect(out.factory).toBe(g);
    });
  });

  describe("strategy: append", () => {
    it("appends incoming array onto parent's array", () => {
      const out = mergeLayered<{ extensions: readonly string[] }>(
        { extensions: ["a"] },
        { extensions: append(["b", "c"]) },
      );
      expect(out.extensions).toEqual(["a", "b", "c"]);
    });

    it("falls back to incoming array when parent slot is absent", () => {
      const out = mergeLayered<{ extensions: readonly string[] }>(
        {},
        {
          extensions: append(["b"]),
        },
      );
      expect(out.extensions).toEqual(["b"]);
    });

    it("chains across multiple layers", () => {
      const out = mergeLayered<{ xs: readonly number[] }>(
        { xs: [1] },
        { xs: append([2]) },
        { xs: append([3, 4]) },
      );
      expect(out.xs).toEqual([1, 2, 3, 4]);
    });
  });

  describe("strategy: prepend", () => {
    it("prepends incoming array (wrapped value first)", () => {
      const out = mergeLayered<{ xs: readonly number[] }>({ xs: [3, 4] }, { xs: prepend([1, 2]) });
      expect(out.xs).toEqual([1, 2, 3, 4]);
    });
  });

  describe("strategy: replace", () => {
    it("replaces parent's object verbatim (opts out of deep merge)", () => {
      const out = mergeLayered<{ a: Record<string, unknown> }>(
        { a: { x: 1, y: 2 } },
        { a: replace({ y: 9 }) },
      );
      expect(out.a).toEqual({ y: 9 });
    });

    it("replaces with primitive when adopter wants a non-object value", () => {
      const out = mergeLayered<{ a: unknown }>({ a: { keep: true } }, { a: replace(42) });
      expect(out.a).toBe(42);
    });
  });

  describe("strategy: omit", () => {
    it("removes the slot, even when a parent layer set it", () => {
      const out = mergeLayered<{ a?: number; b: number }>({ a: 1, b: 2 }, {
        a: omit(),
      } as Parameters<typeof mergeLayered<{ a?: number; b: number }>>[0]);
      expect("a" in out).toBe(false);
      expect(out.b).toBe(2);
    });

    it("omitting an absent slot is a no-op", () => {
      const out = mergeLayered<{ a?: number }>({}, {
        a: omit(),
      } as Parameters<typeof mergeLayered<{ a?: number }>>[0]);
      expect("a" in out).toBe(false);
    });
  });

  describe("type guard", () => {
    it("recognizes strategy wrappers", () => {
      expect(isMergeStrategy(append([1]))).toBe(true);
      expect(isMergeStrategy(prepend([1]))).toBe(true);
      expect(isMergeStrategy(replace(1))).toBe(true);
      expect(isMergeStrategy(omit())).toBe(true);
    });

    it("rejects plain values", () => {
      expect(isMergeStrategy(1)).toBe(false);
      expect(isMergeStrategy({})).toBe(false);
      expect(isMergeStrategy([1, 2])).toBe(false);
      expect(isMergeStrategy(null)).toBe(false);
      expect(isMergeStrategy(undefined)).toBe(false);
    });
  });

  describe("realistic cascade scenarios", () => {
    interface FrameworkConfig {
      readonly model: string;
      readonly maxTicks: number;
      readonly streaming?: boolean;
      readonly tools: readonly { id: string; name: string }[];
      readonly metadata: Record<string, unknown>;
    }

    it("framework defaults → env → adopter config → call-site", () => {
      const out = mergeLayered<FrameworkConfig>(
        // 1. Framework defaults
        {
          model: "gpt-4o-mini",
          maxTicks: 8,
          tools: [],
          metadata: { framework: "agentick" },
        },
        // 2. Env config — flips streaming on globally
        { streaming: true },
        // 3. Adopter project config — overrides model + adds metadata
        {
          model: "claude-3-5-sonnet",
          metadata: { tenant: "acme" },
          tools: [{ id: "t.echo", name: "echo" }],
        },
        // 4. Call-site override — switches model for one tick + appends tools
        {
          model: "gpt-4o",
          tools: append([{ id: "t.search", name: "search" }]),
        },
      );

      // Most-specific scalar wins
      expect(out.model).toBe("gpt-4o");
      expect(out.maxTicks).toBe(8); // fell through from defaults
      expect(out.streaming).toBe(true); // from env

      // Object deep-merged
      expect(out.metadata).toEqual({ framework: "agentick", tenant: "acme" });

      // Arrays: replace (project) then append (call-site)
      expect(out.tools).toEqual([
        { id: "t.echo", name: "echo" },
        { id: "t.search", name: "search" },
      ]);
    });
  });
});
