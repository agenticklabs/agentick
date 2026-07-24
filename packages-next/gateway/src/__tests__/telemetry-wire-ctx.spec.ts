/**
 * Wire-extension ctx facets (ADR 64/78, close-out slice deliverable 2 — closes
 * `TODO(observability-wire-ctx)`). A wire-extension handler's ctx now carries the
 * SAME flat Observability + Ops facets a tool handler / interceptor ctx does. The
 * gateway attaches them IN-FIBER inside `runWireDispatch` (from the captured wire
 * op runtime + its telemetry provider), so:
 *
 *   - `ctx.trace(...)` opens a child span parented under the `wire:<method>`
 *     dispatch op span (the ADR-77 ambient-fiber parenting path).
 *   - `ctx.metrics.*` fans out to the gateway's meter carrying the low-cardinality
 *     `{ method }` ambient label — reaching the gateway-level sink.
 *   - `ctx.log` / `ctx.run` / `ctx.runner` land FLAT beside them (ctx parity with
 *     every other harness surface).
 *
 * Driven directly through the public `runWireDispatch` seam (the transport
 * dispatcher's pass-through of the ctx is covered in
 * `@agentick/transport-next`), against a REAL gateway wired to a recording OTel
 * sink — so a passing assertion also proves the Effect → OTel bridge.
 *
 * @verifiedBy this file
 */

import { describe, expect, it } from "vitest";
import { createTelemetry } from "@agentick/app-next";
import { spyTelemetrySink } from "@agentick/runtime-next/testing";
import type { WireExtensionContext, WireMethod } from "@agentick/spec-next";

import { createGateway } from "../index.js";

/**
 * A minimal wire-extension ctx — only the non-facet fields a handler might touch.
 * The gateway OVERWRITES the five facet slots in-fiber, so they are left off here
 * (cast through `unknown`); reading them after dispatch proves the enrichment ran.
 */
function fakeWireCtx(gateway: unknown): WireExtensionContext {
  return {
    gateway,
    bridges: () => ({}),
    publish: () => {},
    transport: {
      progress: () => ({ push: () => {} }),
      registerCancel: () => {},
      registerSubscription: () => ({ id: "sub", publish: () => {}, close: () => {} }),
      closeSubscription: () => {},
    },
  } as unknown as WireExtensionContext;
}

describe("wire-extension ctx facets (ADR 64/78) — ctx.trace parents under the wire op, ctx.metrics reaches the sink", () => {
  it("a handler's ctx.trace nests under wire:<method> and ctx.metrics carries { method }", async () => {
    const spy = spyTelemetrySink();
    const gateway = await createGateway({
      telemetry: createTelemetry({ serviceName: "gw" }, spy),
    });
    await gateway.listen();

    const method = "diag/ping" as WireMethod;
    const ctx = fakeWireCtx(gateway);

    let facetShape: Record<string, string> = {};
    const result = await gateway.runWireDispatch(method, {}, ctx, async () => {
      // ctx parity — the SAME five facets flat that a tool handler / interceptor
      // ctx carries, now LIVE (the gateway overwrote the dispatcher's off-path
      // placeholders in-fiber).
      facetShape = {
        log: typeof ctx.log,
        info: typeof ctx.log.info,
        trace: typeof ctx.trace,
        metrics: typeof ctx.metrics.count,
        run: typeof ctx.run,
        runner: typeof ctx.runner.runOperation,
      };
      ctx.metrics.count("wire.hits", 1);
      await ctx.trace("wire.sub", (span) => {
        span.setAttribute("handled", true);
      });
      return { ok: true };
    });

    expect(result).toEqual({ ok: true });
    expect(facetShape).toEqual({
      log: "function",
      info: "function",
      trace: "function",
      metrics: "function",
      run: "function",
      runner: "function",
    });

    // SPAN: the handler's `ctx.trace("wire.sub")` child span nests under the
    // wire dispatch op span (`wire:diag/ping`), recorded at the OTel edge.
    const sub = spy.spans.find((s) => s.name === "wire.sub");
    expect(sub).toBeDefined();
    expect(sub!.parent).toBe(`wire:${method}`);
    expect(sub!.attributes.get("handled")).toBe(true);

    // METRIC: `ctx.metrics.count` namespaced + carrying the low-cardinality
    // `{ method }` ambient label, exported through the gateway MeterProvider.
    const metrics = await spy.collectMetrics();
    const hit = metrics.find((m) => m.name === "agentick.wire.hits");
    expect(hit).toBeDefined();
    expect(hit!.labels).toMatchObject({ method });

    await gateway.close();
  });

  it("telemetry OFF → the same handler's facets are the frozen no-ops (no throw, passthrough)", async () => {
    // No `telemetry` switch → the gateway builds no provider; the facets take the
    // shared off-path singletons (ctx.trace passes through, ctx.metrics no-ops).
    const gateway = await createGateway({});
    await gateway.listen();

    const ctx = fakeWireCtx(gateway);
    let facetShape: Record<string, string> = {};
    const out = await gateway.runWireDispatch("diag/ping" as WireMethod, {}, ctx, async () => {
      // Still the live (enriched) FACET SURFACE — just backed by no-ops.
      facetShape = { metrics: typeof ctx.metrics.count, trace: typeof ctx.trace };
      ctx.metrics.count("wire.hits", 1); // swallowed by the no-op meter — no throw
      return ctx.trace("wire.sub", () => 7); // passthrough, returns fn's value
    });

    expect(out).toBe(7);
    expect(facetShape).toEqual({ metrics: "function", trace: "function" });

    await gateway.close();
  });
});
