/**
 * §The {@link Ops} facet contract (ADR 19/83) — `ctx.run` + `ctx.runner`, the
 * ad-hoc-operation ladder rungs. Any ctx surface carrying the facet passes
 * this suite for the SURFACE-INDEPENDENT invariants: both `run` overloads
 * execute `fn` and resolve with its value, and `runner` is a run-only view.
 *
 * The substrate-integration proofs — that an ad-hoc `ctx.run` op is journaled,
 * parents under the enclosing op, is observed by a string-keyed hook, and can
 * be vetoed by a guard — require a real harness and live in the owning
 * package's tests (see `@agentick/tool-executor` `ctx-run.spec.ts`).
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md
 */

import { describe, expect, it } from "vitest";
import type { Ops } from "@agentick/spec";

/** Produces the facet-bearing ctx under test (sync or async construction). */
export type OpsCtxFactory = () => Ops | Promise<Ops>;

/** Run the {@link Ops} facet conformance suite against one surface. */
export function runOpsCtxConformance(label: string, factory: OpsCtxFactory): void {
  describe(`Ops facet — ${label}`, () => {
    it("lands `run` + `runner` flat on ctx", async () => {
      const ctx = await factory();
      expect(typeof ctx.run).toBe("function");
      expect(typeof ctx.runner.runOperation).toBe("function");
    });

    it("run(name, fn) executes fn and resolves with its value", async () => {
      const ctx = await factory();
      const out = await ctx.run("conformance.step", () => 21);
      expect(out).toBe(21);
    });

    it("run(name, opts, fn) executes fn (opts is envelope data, fn takes no args)", async () => {
      const ctx = await factory();
      const out = await ctx.run(
        "conformance.step",
        { input: { a: 1 }, metadata: { r: "x" } },
        async () => "value",
      );
      expect(out).toBe("value");
    });

    it("runner is a run-only view — no makeEvent/publish surface leaked", async () => {
      const ctx = await factory();
      expect("makeEvent" in ctx.runner).toBe(false);
      expect("publish" in ctx.runner).toBe(false);
      expect("decideFromShape" in ctx.runner).toBe(false);
    });
  });
}
