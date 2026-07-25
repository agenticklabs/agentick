/**
 * Wire-extension ctx facets — the WIRE-SPECIFIC proofs (ADR 64/78, closes
 * `TODO(observability-wire-ctx)`). The gateway attaches the Observability + Ops
 * facets to a handler's ctx IN-FIBER inside `runWireDispatch`, from the captured
 * wire op runtime + its telemetry provider. The surface-independent facet
 * contract (flat shape, callable Log, trace/run behavior, fire-and-forget) is
 * proven against this surface by the shared suites in `wire-ctx-conformance.spec.ts`;
 * THIS file asserts what only the real wire substrate can show:
 *
 *   - `ctx.trace(...)` opens a child span parented under the `wire:<method>`
 *     dispatch op span (the ADR-77 ambient-fiber parenting path).
 *   - `ctx.metrics.*` fans out to the gateway's meter carrying the low-cardinality
 *     `{ method }` ambient label — reaching the gateway-level sink.
 *   - Telemetry OFF → the facets are the frozen off-path singletons: `trace`
 *     passes through (returns the callback's value), `metrics` no-ops.
 *
 * Driven through the public `runWireDispatch` seam (transport's ctx pass-through
 * is covered in `@agentick/transport`), against a REAL gateway wired to a
 * recording OTel sink — so a passing assertion also proves the Effect → OTel bridge.
 *
 * @verifiedBy this file
 */

import { describe, expect, it } from "vitest";
import { createTelemetry } from "@agentick/app";
import { spyTelemetrySink } from "@agentick/runtime/testing";
import type { WireMethod } from "@agentick/spec";

import { createGateway } from "../index.js";
import { fakeWireCtx } from "./fake-wire-ctx.js";

describe("wire-extension ctx facets (ADR 64/78) — wire-specific: span parenting + metric fan-out", () => {
  it("a handler's ctx.trace nests under wire:<method> and ctx.metrics carries { method }", async () => {
    const spy = spyTelemetrySink();
    const gateway = await createGateway({
      telemetry: createTelemetry({ serviceName: "gw" }, spy),
    });
    await gateway.listen();

    const method = "diag/ping" as WireMethod;
    const ctx = fakeWireCtx(gateway);

    const result = await gateway.runWireDispatch(method, {}, ctx, async () => {
      ctx.metrics.count("wire.hits", 1);
      await ctx.trace("wire.sub", (span) => {
        span.setAttribute("handled", true);
      });
      return { ok: true };
    });

    expect(result).toEqual({ ok: true });

    // SPAN: the handler's `ctx.trace("wire.sub")` child span nests under the
    // wire dispatch op span (`wire:diag/ping`), recorded at the OTel edge.
    const sub = spy.spans.find((s) => s.name === "wire.sub");
    expect(sub).toBeDefined();
    expect(sub!.parent).toBe(`wire:${method}`);
    expect(sub!.attributes.get("handled")).toBe(true);

    // METRIC: `ctx.metrics.count` namespaced + carrying the low-cardinality
    // `{ method }` ambient label, exported through the gateway MeterProvider.
    const hit = (await spy.collectMetrics()).find((m) => m.name === "agentick.wire.hits");
    expect(hit).toBeDefined();
    expect(hit!.labels).toMatchObject({ method });

    await gateway.close();
  });

  it("telemetry OFF → ctx.trace passes through and ctx.metrics no-ops (no throw)", async () => {
    // No `telemetry` switch → the gateway builds no provider; the facets take the
    // shared off-path singletons — `trace` runs the callback and returns its
    // value, `metrics` silently swallows the emission.
    const gateway = await createGateway({});
    await gateway.listen();

    const ctx = fakeWireCtx(gateway);
    const out = await gateway.runWireDispatch("diag/ping" as WireMethod, {}, ctx, async () => {
      ctx.metrics.count("wire.hits", 1); // swallowed by the no-op meter — no throw
      return ctx.trace("wire.sub", () => 7); // passthrough, returns fn's value
    });

    expect(out).toBe(7);

    await gateway.close();
  });
});
