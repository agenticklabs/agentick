/**
 * Conformance suite for `CompletionsHarnessProtocol` implementations.
 *
 * Validates the invariants every impl MUST honor:
 *
 *   1. **register / has / list** — a bound name is reported by `has`, appears in
 *      the sorted `list()`, and disappears when its `Unsubscribe` runs.
 *   2. **UPSERT** — re-registering a name replaces the resolver, and the STALE
 *      handle does not delete the replacement.
 *   3. **`subscribeAll` fires** on register AND unregister.
 *   4. **resolve, both return shapes** — a bare `string[]` folds to
 *      `{ values }`; a full `CompletionResult` passes `total` / `hasMore` through.
 *   5. **`resolvedArguments` reach the resolver ctx** — the whole point of
 *      conditional completion.
 *   6. **the ctx carries the OperationCtx trunk + facets** — `sessionId` from the
 *      owning scope, callable `log` / `run`.
 *   7. **`signal` passthrough** — the caller's `AbortSignal` arrives on the ctx.
 *   8. **unknown name → `CompletionNotFound`**; resolver throw →
 *      `CompletionResolveFailed`.
 *   9. **NO TRUNCATION AT ANY SIZE** — 250 registered values resolve to 250.
 *      This is the no-cap claim: MCP's 100-value ceiling is applied at MCP's
 *      projection, never in the primitive or the builders.
 *  10. **`completeDependent`** gates on unmet requires without invoking the
 *      loader, and exposes `requires` as readable metadata.
 *
 * Factory contract: the impl constructs its own substrate and exposes a
 * `close()`. `sessionId` is the owning scope the suite asserts on the derived ctx.
 */

import { describe, expect, it } from "vitest";
import type { CompletionCtx, CompletionsHarnessProtocol } from "@agentick/spec";

import { completeDependent, isDependentResolver } from "./builders.js";

// ============================================================================
// Factory contract
// ============================================================================

export interface CompletionsConformanceFactoryInput {
  readonly harnessId: string;
  /** The owning session scope — asserted on the resolver's derived ctx. */
  readonly sessionId: string;
}

export interface CompletionsConformanceShell {
  readonly harness: CompletionsHarnessProtocol;
  close(): Promise<void>;
}

export type CompletionsConformanceFactory = (
  input: CompletionsConformanceFactoryInput,
) => Promise<CompletionsConformanceShell>;

// ============================================================================
// Suite
// ============================================================================

export function runCompletionsHarnessConformance(
  label: string,
  factory: CompletionsConformanceFactory,
): void {
  describe(`CompletionsHarnessProtocol conformance — ${label}`, () => {
    const sessionId = "conf-session";
    async function make(): Promise<CompletionsConformanceShell> {
      return factory({
        harnessId: `conf-${Math.random().toString(36).slice(2)}`,
        sessionId,
      });
    }

    it("register / has / list round-trips, and the Unsubscribe removes the binding", async () => {
      const { harness, close } = await make();
      const unregister = harness.register("b.source", () => ["x"]);
      harness.register("a.source", () => ["y"]);
      expect(harness.has("a.source")).toBe(true);
      expect(harness.has("missing")).toBe(false);
      expect(harness.list()).toEqual(["a.source", "b.source"]);
      unregister();
      expect(harness.has("b.source")).toBe(false);
      expect(harness.list()).toEqual(["a.source"]);
      await close();
    });

    it("register is an UPSERT, and a stale Unsubscribe does not delete the replacement", async () => {
      const { harness, close } = await make();
      const stale = harness.register("dup", () => ["first"]);
      harness.register("dup", () => ["second"]);
      expect((await harness.resolve("dup", { value: "" })).values).toEqual(["second"]);
      stale();
      expect(harness.has("dup")).toBe(true);
      expect((await harness.resolve("dup", { value: "" })).values).toEqual(["second"]);
      await close();
    });

    it("subscribeAll fires on register and unregister", async () => {
      const { harness, close } = await make();
      let changes = 0;
      const unsub = harness.subscribeAll(() => {
        changes += 1;
      });
      const unregister = harness.register("watched", () => []);
      expect(changes).toBe(1);
      unregister();
      expect(changes).toBe(2);
      unsub();
      harness.register("after", () => []);
      expect(changes).toBe(2);
      await close();
    });

    it("resolve folds a bare string[] and passes a full result through", async () => {
      const { harness, close } = await make();
      harness.register("bare", (value) => [`${value}-a`, `${value}-b`]);
      harness.register("full", () => ({ values: ["one"], total: 42, hasMore: true }));
      expect(await harness.resolve("bare", { value: "q" })).toEqual({ values: ["q-a", "q-b"] });
      expect(await harness.resolve("full", { value: "" })).toEqual({
        values: ["one"],
        total: 42,
        hasMore: true,
      });
      await close();
    });

    it("resolvedArguments reach the resolver ctx (empty object when omitted)", async () => {
      const { harness, close } = await make();
      let seen: Readonly<Record<string, string>> | undefined;
      harness.register("args", (_value, ctx) => {
        seen = ctx.resolvedArguments;
        return [];
      });
      await harness.resolve("args", { value: "", resolvedArguments: { job: "Miller" } });
      expect(seen).toEqual({ job: "Miller" });
      await harness.resolve("args", { value: "" });
      expect(seen).toEqual({});
      await close();
    });

    it("the resolver ctx carries the OperationCtx trunk and facets", async () => {
      const { harness, close } = await make();
      let seen: CompletionCtx | undefined;
      harness.register("ctx", (_value, ctx) => {
        seen = ctx;
        return [];
      });
      await harness.resolve("ctx", { value: "" });
      expect(seen?.sessionId).toBe(sessionId);
      expect(typeof seen?.log).toBe("function");
      expect(typeof seen?.run).toBe("function");
      await close();
    });

    it("passes the caller's AbortSignal through to the resolver ctx", async () => {
      const { harness, close } = await make();
      let seen: AbortSignal | undefined;
      harness.register("abortable", (_value, ctx) => {
        seen = ctx.signal;
        return [];
      });
      const controller = new AbortController();
      await harness.resolve("abortable", { value: "", signal: controller.signal });
      expect(seen).toBe(controller.signal);
      controller.abort();
      expect(seen?.aborted).toBe(true);
      await close();
    });

    it("resolve of an unknown name rejects with CompletionNotFound", async () => {
      const { harness, close } = await make();
      await expect(harness.resolve("nope", { value: "" })).rejects.toMatchObject({
        _tag: "CompletionNotFound",
        completionName: "nope",
      });
      await close();
    });

    it("a resolver throw rejects with CompletionResolveFailed carrying the cause", async () => {
      const { harness, close } = await make();
      const boom = new Error("upstream down");
      harness.register("broken", () => {
        throw boom;
      });
      await expect(harness.resolve("broken", { value: "" })).rejects.toMatchObject({
        _tag: "CompletionResolveFailed",
        completionName: "broken",
        cause: boom,
      });
      await close();
    });

    it("does NOT truncate at any size — 250 values in, 250 values out", async () => {
      const { harness, close } = await make();
      const many = Array.from({ length: 250 }, (_, i) => `v${i}`);
      harness.register("many", () => many);
      const result = await harness.resolve("many", { value: "" });
      expect(result.values).toHaveLength(250);
      expect(result.hasMore).toBeUndefined();
      await close();
    });

    it("completeDependent gates on unmet requires and exposes them as metadata", async () => {
      const { harness, close } = await make();
      let invoked = 0;
      const resolver = completeDependent({ requires: ["job"] }, (typed, { job }) => {
        invoked += 1;
        return [`${job}:${typed}`];
      });
      harness.register("phases", resolver);

      // Metadata is readable off the resolver — a composer knows the slot is not
      // completable yet without issuing a doomed request.
      expect(isDependentResolver(resolver)).toBe(true);
      expect(resolver.requires).toEqual(["job"]);

      expect(await harness.resolve("phases", { value: "fra" })).toEqual({ values: [] });
      expect(invoked).toBe(0);

      const hit = await harness.resolve("phases", {
        value: "fra",
        resolvedArguments: { job: "Miller" },
      });
      expect(hit.values).toEqual(["Miller:fra"]);
      expect(invoked).toBe(1);
      await close();
    });
  });
}
