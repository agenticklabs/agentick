/**
 * The {@link Observability} + {@link Ops} facet CONTRACT, run against the WIRE
 * surface (ADR 64/78/19/83) — the same shared conformance suites the tool-handler
 * (in-process + MCP) surface runs (`@agentick/spec-conformance-next`
 * observability-conformance.spec.ts). A wire-extension handler's ctx carries the
 * facets flat, so it must pass the surface-independent invariants: facet flat,
 * `log` is the callable RFC-5424 Log, `trace` runs its callback and propagates
 * the value with an annotatable span, `run`/`runner` execute + are a run-only
 * view, and every emit is fire-and-forget.
 *
 * The factory yields a ctx enriched through the REAL `runWireDispatch` seam (the
 * only place the wire facets are attached). Telemetry is OFF here — the contract
 * is telemetry-independent (the off-path facets must conform too); the wire's
 * SURFACE-SPECIFIC proofs (span parenting under `wire:<method>`, `{ method }`
 * metric fan-out, OFF passthrough) live in `telemetry-wire-ctx.spec.ts`.
 *
 * @verifiedBy this file
 */

import { afterAll } from "vitest";
import {
  runObservabilityCtxConformance,
  runOpsCtxConformance,
} from "@agentick/spec-conformance-next";
import type { GatewayHarnessProtocol, WireExtensionContext, WireMethod } from "@agentick/spec-next";

import { createGateway } from "../index.js";
import { fakeWireCtx } from "./fake-wire-ctx.js";

// ONE gateway + ONE ctx enriched via a real dispatch, shared across the suites'
// per-`it` factory calls; the captured op runtime keeps the facets live after the
// dispatch settles (a fresh `ctx.trace` / `ctx.run` still runs on it).
let gateway: GatewayHarnessProtocol | undefined;
let enriched: WireExtensionContext | undefined;

async function wireCtx(): Promise<WireExtensionContext> {
  if (enriched) return enriched;
  gateway = await createGateway({});
  await gateway.listen();
  const base = fakeWireCtx(gateway);
  await gateway.runWireDispatch("diag/ping" as WireMethod, {}, base, async () => {});
  enriched = base;
  return enriched;
}

afterAll(async () => {
  await gateway?.close();
});

runObservabilityCtxConformance("WireExtensionContext (gateway dispatch)", wireCtx);
runOpsCtxConformance("WireExtensionContext (gateway dispatch)", wireCtx);
