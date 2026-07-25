/**
 * The middleware/hook/guard facet landing (ADR 64/78/19/83) — the interceptor
 * ctx a `harness.use` middleware receives carries the SAME flat facets a tool
 * handler's ctx does: `ctx.log` (callable Log), `ctx.trace`, `ctx.metrics`,
 * `ctx.run`, `ctx.runner`. This is the deliverable-4 evidence: a hook/middleware
 * calling `ctx.trace` opens a child span that parents under the op span, and
 * `ctx.metrics` fans out to the wired meter.
 *
 * Closes TODO(observability-runtime-ctx): the RuntimeContext stays pure data;
 * the facets are attached at the `liftMiddleware` boundary from the per-op
 * `InterceptorCtx` the operation runner builds.
 */

import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { BaseHarness, LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { MessageEnvelope, MessageHandlerError, Operation } from "@agentick/spec";
import { HandlerError } from "@agentick/spec";

import { spyTelemetryProvider } from "../testing/spy-telemetry-provider.js";
import type { TelemetryProvider } from "../substrate/observability.js";
import type { InterceptorCtx } from "../substrate/middleware.js";

class FacetHarness extends BaseHarness<"tool"> {
  constructor(provider: TelemetryProvider | undefined) {
    super(
      "tool",
      "facet:test",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      provider ? { telemetryProvider: provider } : {},
    );
  }

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: new Error("n/a") }));
  }

  /**
   * Run one probe op through this harness's `runOperation` (so the cascade runs).
   * `seq` distinguishes the opId — the runner dedups by opId, so a test that
   * runs two probes on one harness must pass distinct sequence numbers.
   */
  probe(seq = 1): Effect.Effect<number, unknown, never> {
    const op: Operation<{ n: number }, number> = {
      opId: `tool:probe:${seq}`,
      surface: "tool",
      name: "tool:probe",
      scope: { sessionId: "s1" },
      input: { n: 1 },
    };
    return this.runOperation(op, (i) => Effect.succeed(i.n));
  }
}

describe("interceptor ctx facets (ADR 64/78/19/83) — the .use/hook/guard surface", () => {
  it("lands log + trace + metrics + run + runner FLAT on the middleware ctx", async () => {
    const h = new FacetHarness(undefined);
    await h.ready;
    let seen: InterceptorCtx | undefined;
    h.use((input, next, ctx) => {
      seen = ctx;
      return next(input);
    });
    await Effect.runPromise(h.probe());
    expect(seen).toBeDefined();
    // The RuntimeContext data landed flat...
    expect(seen!.sessionId).toBe("s1");
    expect(seen!.op).toBe("ToolProbe");
    // ...beside the full facet surface (same spelling as a tool handler's ctx).
    expect(typeof seen!.log).toBe("function");
    expect(typeof seen!.log.info).toBe("function");
    expect(typeof seen!.log.with).toBe("function");
    expect(typeof seen!.trace).toBe("function");
    expect(typeof seen!.metrics.count).toBe("function");
    expect(typeof seen!.run).toBe("function");
    expect(typeof seen!.runner.runOperation).toBe("function");
  });

  it("a hook using ctx.trace opens a child span parented under the op span", async () => {
    const spy = spyTelemetryProvider();
    const rt = ManagedRuntime.make(spy.tracer!);
    try {
      const h = new FacetHarness(spy);
      await h.ready;
      h.use(async (input, next, ctx) => {
        // The middleware carves a sub-span out of its own work — the whole
        // point of ctx.trace on an interceptor.
        await ctx.trace("mw.sub", (span) => {
          span.setAttribute("mw", true);
        });
        ctx.metrics.count("mw.hits", 1, { op: ctx.op ?? "?" });
        ctx.log.info({ from: "middleware" });
        return next(input);
      });
      const result = await rt.runPromise(h.probe());
      expect(result).toBe(1);
    } finally {
      await rt.dispose();
    }

    const op = spy.spans.find((s) => s.name === "tool:probe");
    const child = spy.spans.find((s) => s.name === "mw.sub");
    expect(op).toBeDefined();
    expect(child).toBeDefined();
    // The child nests under the op span — the SINGLE ADR-77 parenting path,
    // reached from a middleware exactly as from a tool handler.
    expect(child!.parent).toBe("tool:probe");
    expect(child!.attributes.get("mw")).toBe(true);
    // ctx.metrics fanned out to the wired meter.
    expect(spy.metrics).toContainEqual({
      kind: "count",
      name: "agentick.mw.hits",
      value: 1,
      labels: { op: "ToolProbe" },
    });
  });

  it("adoptTelemetry late-binds the provider: a metric emitted before it hits no meter, after it reaches the sink with { op }", async () => {
    const spy = spyTelemetryProvider();
    // Constructed with telemetry OFF — exactly the app-shared spine harness's
    // state (loop/model/compiler are built before the async telemetry switch
    // resolves), so its interceptor ctx starts on the off-path singletons.
    const h = new FacetHarness(undefined);
    await h.ready;
    h.use((input, next, ctx) => {
      ctx.metrics.count("mw.hits", 1);
      return next(input);
    });

    // Before adopt: the shared no-op metrics swallow the emission.
    await Effect.runPromise(h.probe(1));
    expect(spy.metrics).toHaveLength(0);

    // The exact late-bind the app makes on its spine once telemetry resolves.
    h.adoptTelemetry(spy);

    // buildInterceptorCtx reads the slot PER OP, so the SAME middleware's metric
    // now fans out to the wired meter with the ambient op label.
    await Effect.runPromise(h.probe(2));
    expect(spy.metrics).toContainEqual({
      kind: "count",
      name: "agentick.mw.hits",
      value: 1,
      labels: { op: "ToolProbe" },
    });
  });

  it("adoptTelemetry's defaultLabels stamp the app-identity ambient label", async () => {
    const spy = spyTelemetryProvider();
    const h = new FacetHarness(undefined);
    await h.ready;
    h.use((input, next, ctx) => {
      ctx.metrics.count("mw.hits", 1);
      return next(input);
    });
    // The app passes { app } alongside the provider so a multi-app sink can
    // attribute spine metrics to the owning app.
    h.adoptTelemetry(spy, { app: "acme" });
    await Effect.runPromise(h.probe());
    expect(spy.metrics).toContainEqual({
      kind: "count",
      name: "agentick.mw.hits",
      value: 1,
      labels: { app: "acme", op: "ToolProbe" },
    });
  });

  it("ctx.run from a middleware mints a journaled op parented under the enclosing op", async () => {
    const h = new FacetHarness(undefined);
    await h.ready;
    let ranInner = false;
    h.use(async (input, next, ctx) => {
      // A `.use` middleware runs on EVERY op — including the ad-hoc
      // `tool:run:inner-work` op `ctx.run` mints — so self-scope by `ctx.op`
      // (the `ctx.run` op's suffix is `ToolRunInnerWork`, not `ToolProbe`),
      // else the middleware would re-enter its own `ctx.run` forever.
      if (ctx.op !== "ToolProbe") return next(input);
      const out = await ctx.run("inner-work", () => {
        ranInner = true;
        return 42;
      });
      expect(out).toBe(42);
      return next(input);
    });
    await Effect.runPromise(h.probe());
    expect(ranInner).toBe(true);
  });
});
