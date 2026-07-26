/**
 * `deriveContext` — the ADR 91 branded boundary-ctx constructor.
 *
 * The trunk-derivation law (ADR 91 §3): every boundary ctx a seam receives
 * carries its parent CROSSING's coordinates (sessionId / opId / principal),
 * NOT fabricated ones. These cases assert that directly on the deriver — the
 * one place every seam's ctx now flows through — plus the off-path facet
 * identity and both overloads (explicit parent + in-fiber ambient).
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { deriveContext, getContext, withContext } from "@agentick/runtime";
import type { RuntimeContext } from "@agentick/spec";

import { NOOP_METRICS, OFF_TRACE } from "../substrate/observability.js";
import type { ContextFacets } from "../substrate/derive-context.js";
import type { RunOperationFn } from "../substrate/ops.js";
import { deriveTestContext } from "../testing/derive-test-context.js";

/** A passthrough `runOperation` — runs the body, no journal/interceptors. */
const passthroughRun: RunOperationFn = (op, body) => body(op.input);

/** Off-path facets (no telemetry, no captured runtime) for a given scope. */
function offPathFacets(
  scope: RuntimeContext,
  runOperation: RunOperationFn = passthroughRun,
): ContextFacets {
  return {
    log: () => {},
    namespace: "test",
    surface: "tool",
    scope,
    runOperation,
  };
}

describe("deriveContext — trunk derivation (ADR 91)", () => {
  it("carries the explicit parent crossing's coordinates, not fabricated ones", () => {
    const parent: RuntimeContext = {
      sessionId: "sess-1",
      opId: "op-42",
      principal: "acme/user-7",
      executionId: "exec-9",
    };
    const ctx = deriveContext(parent, offPathFacets(parent));
    expect(ctx.sessionId).toBe("sess-1");
    expect(ctx.opId).toBe("op-42");
    expect(ctx.principal).toBe("acme/user-7");
    expect(ctx.executionId).toBe("exec-9");
  });

  it("off-path trace/metrics are the shared frozen singletons (zero-cost identity)", () => {
    const ctx = deriveContext({}, offPathFacets({}));
    expect(ctx.trace).toBe(OFF_TRACE);
    expect(ctx.metrics).toBe(NOOP_METRICS);
  });

  it("attaches the Observability + Ops facets", () => {
    const ctx = deriveContext({}, offPathFacets({}));
    expect(typeof ctx.log).toBe("function");
    expect(typeof ctx.trace).toBe("function");
    expect(typeof ctx.run).toBe("function");
    expect(ctx.runner).toBeDefined();
    expect(typeof ctx.runner.runOperation).toBe("function");
  });

  it("`ctx.run` routes through the supplied runOperation", async () => {
    const ctx = deriveContext({}, offPathFacets({}));
    await expect(ctx.run("compute", () => 42)).resolves.toBe(42);
  });

  it("the ambient overload reads the parent trunk from the FiberRef in-fiber", async () => {
    const facets = offPathFacets({ sessionId: "IGNORED-scope-only" });
    const ctx = await Effect.runPromise(
      withContext(
        { sessionId: "sess-ambient", opId: "op-ambient", principal: "acme/u" },
        deriveContext(facets),
      ),
    );
    expect(ctx.sessionId).toBe("sess-ambient");
    expect(ctx.opId).toBe("op-ambient");
    expect(ctx.principal).toBe("acme/u");
  });

  it("the ambient overload reads EMPTY_CONTEXT when no scope is active", async () => {
    const ctx = await Effect.runPromise(deriveContext(offPathFacets({})));
    expect(ctx.sessionId).toBeUndefined();
    expect(ctx.opId).toBeUndefined();
  });
});

describe("getContext sanity — the ambient overload's source", () => {
  it("withContext scopes the trunk visible to getContext", async () => {
    const seen = await Effect.runPromise(withContext({ opId: "abc" }, getContext));
    expect(seen.opId).toBe("abc");
  });
});

describe("deriveTestContext (/testing)", () => {
  it("produces a branded ctx that carries the parent trunk", () => {
    const ctx = deriveTestContext({ sessionId: "t-sess", opId: "t-op" });
    expect(ctx.sessionId).toBe("t-sess");
    expect(ctx.opId).toBe("t-op");
    expect(ctx.trace).toBe(OFF_TRACE);
  });

  it("its `ctx.run` throws — no operation ladder wired in a bare test ctx", async () => {
    const ctx = deriveTestContext();
    await expect(ctx.run("x", () => 1)).rejects.toThrow(/unavailable in a test ctx/);
  });
});
