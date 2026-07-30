/**
 * The `complete*` sugar family — unit tests for each builder, and the ONE claim
 * that changed in the lift out of `@agentick/mcp`: **no cap**. v1 clamped inside
 * every builder at 100 values; the cap now lives at the MCP projection, so a
 * builder called directly returns everything it found.
 */

import { describe, expect, it } from "vitest";
import type { CompletionCtx } from "@agentick/spec";
import { deriveTestContext } from "@agentick/runtime/testing";

import {
  completeDependent,
  completeFromAsync,
  completeFromEnum,
  completeFromList,
  completePrefixMatch,
  isDependentResolver,
  normalizeCompletionResult,
} from "../builders.js";

/** A real branded ctx (the test deriver routes through `deriveContext`). */
const ctx = (resolvedArguments: Readonly<Record<string, string>> = {}): CompletionCtx => ({
  ...deriveTestContext(),
  resolvedArguments,
});

describe("normalizeCompletionResult", () => {
  it("folds a bare array into { values } and passes a full result through", () => {
    expect(normalizeCompletionResult(["a", "b"])).toEqual({ values: ["a", "b"] });
    expect(normalizeCompletionResult({ values: ["a"], total: 9, hasMore: true })).toEqual({
      values: ["a"],
      total: 9,
      hasMore: true,
    });
  });
});

describe("completeFromList", () => {
  it("prefix-filters case-sensitively", async () => {
    const r = await completeFromList(["alpha", "alphabet", "beta"])("alph", ctx());
    expect(r).toEqual({ values: ["alpha", "alphabet"] });
  });

  it("returns the full list for empty input", async () => {
    const r = await completeFromList(["a", "b", "c"])("", ctx());
    expect(r).toEqual({ values: ["a", "b", "c"] });
  });
});

describe("completeFromEnum", () => {
  it("reads .options structurally (Zod 3 / Zod 4 compatible)", async () => {
    const r = await completeFromEnum({ options: ["red", "green", "grey"] })("gre", ctx());
    expect(r).toEqual({ values: ["green", "grey"] });
  });
});

describe("completePrefixMatch", () => {
  it("lazy-loads the full set once per call and filters it", async () => {
    let loads = 0;
    const resolver = completePrefixMatch(async () => {
      loads += 1;
      return ["proj-a", "proj-b", "other"];
    });
    expect(await resolver("proj", ctx())).toEqual({ values: ["proj-a", "proj-b"] });
    expect(loads).toBe(1);
  });
});

describe("completeDependent", () => {
  it("returns empty WITHOUT invoking the loader when a required dep is missing", async () => {
    let invoked = 0;
    const resolver = completeDependent({ requires: ["projectId"] }, () => {
      invoked += 1;
      return ["x"];
    });
    expect(await resolver("any", ctx())).toEqual({ values: [] });
    expect(invoked).toBe(0);
  });

  it("passes the resolved deps, the typed value, and the ctx to the loader", async () => {
    const resolver = completeDependent({ requires: ["projectId"] }, (typed, deps, c) => [
      `${deps.projectId}/${typed}/${c.sessionId ?? "no-session"}`,
    ]);
    const r = await resolver("frame", {
      ...deriveTestContext({ sessionId: "s-1" }),
      resolvedArguments: { projectId: "p1" },
    });
    expect(r).toEqual({ values: ["p1/frame/s-1"] });
  });

  it("exposes `requires` as readable, non-enumerable metadata", () => {
    const resolver = completeDependent({ requires: ["job", "phase"] }, () => []);
    expect(isDependentResolver(resolver)).toBe(true);
    expect(resolver.requires).toEqual(["job", "phase"]);
    // Non-enumerable: it never shows up in a spread of a resolver bag.
    expect(Object.keys(resolver)).not.toContain("requires");
  });

  it("a plain resolver is not mistaken for a dependent one", () => {
    expect(isDependentResolver(completeFromList(["a"]))).toBe(false);
  });
});

describe("completeFromAsync", () => {
  it("supports explicit total / hasMore", async () => {
    const resolver = completeFromAsync(() => ({ values: ["a", "b"], total: 100, hasMore: true }));
    expect(await resolver("", ctx())).toEqual({ values: ["a", "b"], total: 100, hasMore: true });
  });

  it("threads the value and the full ctx (trunk + facets + siblings)", async () => {
    let seen: CompletionCtx | undefined;
    const resolver = completeFromAsync((value, c) => {
      seen = c;
      return [`${value}!`];
    });
    const r = await resolver("q", {
      ...deriveTestContext({ sessionId: "compl-91" }),
      resolvedArguments: { projectId: "p1" },
    });
    expect(r).toEqual({ values: ["q!"] });
    expect(seen?.sessionId).toBe("compl-91");
    expect(seen?.resolvedArguments).toEqual({ projectId: "p1" });
    expect(typeof seen?.log).toBe("function");
    expect(typeof seen?.run).toBe("function");
  });
});

describe("no cap in the primitive (the deliberate change from v1)", () => {
  it("completeFromList returns all 150 values, hasMore unset", async () => {
    const huge = Array.from({ length: 150 }, (_, i) => `v${i}`);
    const r = normalizeCompletionResult(await completeFromList(huge)("", ctx()));
    expect(r.values).toHaveLength(150);
    expect(r.hasMore).toBeUndefined();
  });

  it("completeFromAsync does not truncate a 250-value answer", async () => {
    const many = Array.from({ length: 250 }, (_, i) => `v${i}`);
    const r = normalizeCompletionResult(await completeFromAsync(() => many)("", ctx()));
    expect(r.values).toHaveLength(250);
    expect(r.hasMore).toBeUndefined();
  });
});
