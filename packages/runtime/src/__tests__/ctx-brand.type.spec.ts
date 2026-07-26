/**
 * ADR 91 §Enforcement + §Phase-2 brand totalization — compile-time pins.
 *
 * `deriveContext` is the ONLY producer of the {@link Derived} brand. A
 * framework seam-invocation site typed to accept `Derived<…>` therefore
 * rejects a hand-assembled bag at COMPILE time. The Phase-2 `extras` param mints
 * the WHOLE composed boundary ctx branded — `Derived<OperationCtx & X>` — so the
 * brand survives instead of being erased by a post-derivation spread.
 *
 * These assertions live in the TYPES; the runtime body only exists so vitest
 * has something to execute. `@ts-expect-error` lines FAIL the typecheck if the
 * brand ever stops being enforced.
 */

import { describe, expect, it } from "vitest";
import type { Derived, OperationCtx } from "@agentick/spec";

import { deriveContext, type ContextFacets } from "../substrate/derive-context.js";
import type { RunOperationFn } from "../substrate/ops.js";

const facets: ContextFacets = {
  log: () => {},
  namespace: "test",
  surface: "app",
  scope: {},
  runOperation: (() => {
    throw new Error("unused");
  }) as RunOperationFn,
};

describe("ADR 91 — ctx brand (compile-time)", () => {
  it("deriveContext output is branded and satisfies both Derived and plain ctx", () => {
    const branded = deriveContext({ sessionId: "s" }, facets);
    // A branded value satisfies the Derived seam type…
    const asDerived: Derived<OperationCtx> = branded;
    // …AND the plain interface a handler receives (zero adopter friction).
    const asPlain: OperationCtx = branded;
    expect(asDerived.sessionId).toBe("s");
    expect(asPlain.sessionId).toBe("s");
  });

  it("a hand-assembled bag is REJECTED at a Derived-demanding seam", () => {
    const bag = {
      sessionId: "s",
      log: () => {},
      trace: {},
      metrics: {},
      run: () => {},
      runner: {},
    };
    // @ts-expect-error — a bag that never passed through deriveContext lacks the
    // brand, so it cannot satisfy `Derived<OperationCtx>` (ADR 91 §Enforcement).
    const rejected: Derived<OperationCtx> = bag;
    expect(rejected).toBeDefined();
  });

  it("Phase-2 extras compose INTO the brand (whole ctx branded, not spread)", () => {
    const withExtras = deriveContext({ sessionId: "s" }, facets, {
      toolCallId: "call-1",
      transport: "in-process" as const,
    });
    // The composed type carries the extras AND the brand.
    const typed: Derived<OperationCtx & { toolCallId: string; transport: "in-process" }> =
      withExtras;
    expect(typed.toolCallId).toBe("call-1");
    expect(typed.transport).toBe("in-process");
    // The lazy facet getters survived composition (extras did not clobber them).
    expect(typeof typed.log).toBe("function");
    expect(typeof typed.run).toBe("function");
  });
});
