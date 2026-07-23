/**
 * §The {@link Observability} facet contract (ADR 64/78). Any ctx-shaped
 * surface that carries the facet — {@link import("@agentick/spec-next").ToolHandlerCtx}
 * (in-process + MCP), a wire-handler ctx, the runtime interceptor ctx —
 * passes this suite to claim the facet is landed correctly and FLAT.
 *
 * Run from any vitest test file, once per surface:
 *
 * ```ts
 * import { describe } from "vitest";
 * import { runObservabilityCtxConformance } from "@agentick/spec-conformance-next";
 * import { fakeToolHandlerCtx } from "@agentick/spec-conformance-next";
 *
 * runObservabilityCtxConformance("ToolHandlerCtx (in-process)", () => fakeToolHandlerCtx());
 * runObservabilityCtxConformance("ToolHandlerCtx (mcp)", () => fakeToolHandlerCtx({ transport: "mcp" }));
 * ```
 *
 * This suite proves the SURFACE-INDEPENDENT invariants: the facet is flat
 * (log/trace/metrics reachable directly), `trace` runs its callback and
 * propagates the value (sync + async), the span handle is annotatable
 * without throwing, and every emit is fire-and-forget (never throws into
 * the caller). Surface-SPECIFIC invariants that need the real substrate —
 * span PARENTING under the op span, metrics fan-out to the provider, and
 * the MCP NO-WIRE-LEAK rule (trace/metrics never touch the bus) — are
 * asserted in the owning package's integration tests, where a real
 * runtime + spy bus are available.
 *
 * @see docs/proposals/v2/blueprint/78-telemetry-via-runtime-substrate.md
 */

import { describe, expect, it } from "vitest";
import type { Observability } from "@agentick/spec-next";

/** Produces the facet-bearing ctx under test (sync or async construction). */
export type ObservabilityCtxFactory = () => Observability | Promise<Observability>;

/** Run the {@link Observability} facet conformance suite against one surface. */
export function runObservabilityCtxConformance(
  label: string,
  factory: ObservabilityCtxFactory,
): void {
  describe(`Observability facet — ${label}`, () => {
    it("lands the facet FLAT: log + trace + metrics reachable directly on ctx", async () => {
      const ctx = await factory();
      expect(typeof ctx.log).toBe("function");
      expect(typeof ctx.trace).toBe("function");
      expect(typeof ctx.metrics.count).toBe("function");
      expect(typeof ctx.metrics.record).toBe("function");
      expect(typeof ctx.metrics.gauge).toBe("function");
    });

    it("trace runs the callback, resolves with its value, and exposes an annotatable span", async () => {
      const ctx = await factory();
      let annotated = false;
      const out = await ctx.trace("conformance.span", (span) => {
        // Every span verb must be callable without throwing, whether the
        // span is live (telemetry on) or a no-op (off).
        span.setAttribute("k", "v");
        span.setAttributes({ a: 1, b: true });
        span.addEvent("milestone", { detail: "x" });
        span.recordException(new Error("annotated"));
        annotated = true;
        return "value";
      });
      expect(out).toBe("value");
      expect(annotated).toBe(true);
    });

    it("trace propagates an async callback's resolved value", async () => {
      const ctx = await factory();
      const out = await ctx.trace("conformance.async", async () => 7);
      expect(out).toBe(7);
    });

    it("log + metrics are fire-and-forget — never throw into the caller", async () => {
      const ctx = await factory();
      expect(() => {
        ctx.log("info", { msg: "hi" });
        ctx.log("error", { msg: "bad" }, "my.logger");
        ctx.metrics.count("c");
        ctx.metrics.count("c", 3, { op: "X" });
        ctx.metrics.record("r", 1.5, { outcome: "ok" });
        ctx.metrics.gauge("g", 2);
      }).not.toThrow();
    });
  });
}
