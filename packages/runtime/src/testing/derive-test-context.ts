/**
 * `deriveTestContext` — a branded boundary ctx for tests + adopter tests.
 *
 * A test that needs to hand a framework seam a ctx (an interceptor ctx, a
 * dispatch ctx) must produce the {@link Derived} brand — a hand-assembled bag
 * fails to compile at the seam (ADR 91 §Enforcement). This is the test-side
 * producer: it routes through the real {@link deriveContext} with an off-path
 * telemetry facet (no-op `log`, passthrough `trace`, no-op `metrics`) and a
 * throwing `runOperation` (so `ctx.run` / `ctx.runner` fail loudly if a test
 * reaches for the operation ladder without wiring one).
 *
 * @see docs/proposals/v2/blueprint/91-ctx-spine.md
 */

import { Effect } from "effect";
import type { Derived, Observability, Ops, RuntimeContext } from "@agentick/spec";
import { EMPTY_CONTEXT } from "@agentick/spec";

import { deriveContext, type ContextFacets } from "../substrate/derive-context.js";
import type { RunOperationFn } from "../substrate/ops.js";

/**
 * `runOperation` that fails loudly — the operation ladder is unreachable in a
 * bare test ctx. Returns a dying Effect (not a synchronous throw) to honor the
 * `RunOperationFn` contract; `ctx.run` runs it and surfaces the rejection.
 */
const throwingRunOperation: RunOperationFn = () =>
  Effect.sync(() => {
    throw new Error("deriveTestContext: ctx.run / ctx.runner are unavailable in a test ctx");
  });

/**
 * Build a branded {@link Derived} boundary ctx from an optional parent trunk +
 * optional facet overrides. Defaults: `EMPTY_CONTEXT` parent, `"app"` surface,
 * off-path telemetry, throwing `runOperation`. Pass a real `runOperation` /
 * `telemetry` in `facets` to exercise the ops / metrics ladder.
 */
export function deriveTestContext(
  parent: RuntimeContext = EMPTY_CONTEXT,
  facets: Partial<ContextFacets> = {},
): Derived<RuntimeContext & Observability & Ops> {
  return deriveContext(parent, {
    log: () => {},
    namespace: "test",
    surface: "app",
    scope: parent,
    runOperation: throwingRunOperation,
    ...facets,
  });
}
