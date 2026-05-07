/**
 * Tests for the baggage primitive: `KernelContext.baggage`,
 * `Context.withBaggage`, `Telemetry.startSpan` auto-stamping, and
 * `proc.withBaggage`.
 *
 * Baggage is plain context state — `Context.withBaggage(attrs)` merges into
 * the active context's `baggage` slot. Scoping is the ALS layer's
 * responsibility: any `Context.fork` / `Context.run` you're already inside
 * bounds the mutation. There's no separate scope-callback API.
 *
 * Adversarial coverage:
 * - Merge-not-replace (only overlapping keys override; non-overlapping keys preserved)
 * - Repeated withBaggage calls in the same context layer (last writer wins per key)
 * - Fork isolates: withBaggage in a fork does not leak to parent
 * - Sibling forks don't race
 * - No-op when called outside any context
 * - Baggage propagates to spans via Telemetry.startSpan auto-stamp
 * - Provider without `setAttributes` falls back to per-key `setAttribute`
 * - proc.withBaggage forks and merges; original procedure unaffected
 */

import { Context } from "./context.js";
import {
  Telemetry,
  type AttributeValue,
  type Counter,
  type Histogram,
  type Span,
  type TelemetryProvider,
} from "./telemetry.js";
import { createProcedure } from "./procedure.js";

// ─── Mock provider that records all attribute calls ─────────────────────────

interface CapturedSpan {
  name: string;
  attrCalls: Array<{ method: "setAttribute" | "setAttributes"; payload: any }>;
}

class CapturingProvider implements TelemetryProvider {
  spans: CapturedSpan[] = [];
  /** Toggle to simulate older providers that don't implement `setAttributes`. */
  supportsBatch = true;

  startTrace(_name: string): string {
    return "trace-id";
  }

  startSpan(name: string): Span {
    const captured: CapturedSpan = { name, attrCalls: [] };
    this.spans.push(captured);
    const base: Span = {
      end: () => {},
      setAttribute: (k, v) => {
        captured.attrCalls.push({ method: "setAttribute", payload: { [k]: v } });
      },
      recordError: () => {},
    };
    if (this.supportsBatch) {
      base.setAttributes = (attrs) => {
        captured.attrCalls.push({ method: "setAttributes", payload: attrs });
      };
    }
    return base;
  }

  recordError(): void {}
  endTrace(): void {}
  getCounter(): Counter {
    return { add: () => {} };
  }
  getHistogram(): Histogram {
    return { record: () => {} };
  }
}

describe("Context.withBaggage", () => {
  it("sets baggage on a context that had none", async () => {
    let seen: Record<string, AttributeValue> | undefined;
    await Context.run(Context.create(), async () => {
      Context.withBaggage({ "app.location": "alpha" });
      seen = Context.get().baggage;
    });
    expect(seen).toEqual({ "app.location": "alpha" });
  });

  it("merges with existing baggage (last writer wins per key)", async () => {
    let seen: Record<string, AttributeValue> | undefined;
    await Context.run(Context.create(), async () => {
      Context.withBaggage({ "app.location": "alpha", "app.tenant": "t1" });
      Context.withBaggage({ "app.location": "beta" });
      seen = Context.get().baggage;
    });
    expect(seen).toEqual({ "app.location": "beta", "app.tenant": "t1" });
  });

  it("is a no-op when called outside any context", () => {
    expect(() => Context.withBaggage({ k: "v" })).not.toThrow();
  });

  it("a fork bounds the mutation — parent baggage is preserved on exit", async () => {
    const observations: Record<string, AttributeValue | undefined>[] = [];
    await Context.run(Context.create(), async () => {
      Context.withBaggage({ "app.location": "outer" });
      observations.push({ ...Context.get().baggage });

      await Context.fork({}, async () => {
        Context.withBaggage({ "app.location": "inner" });
        observations.push({ ...Context.get().baggage });
      });

      // Outside the fork — outer mutation is intact, inner is gone.
      observations.push({ ...Context.get().baggage });
    });

    expect(observations).toEqual([
      { "app.location": "outer" },
      { "app.location": "inner" },
      { "app.location": "outer" },
    ]);
  });

  it("a fork inherits parent baggage; child mutations layer on top", async () => {
    let seen: Record<string, AttributeValue> | undefined;
    await Context.run(Context.create(), async () => {
      Context.withBaggage({ "app.location": "outer", "app.tenant": "t1" });

      await Context.fork({}, async () => {
        Context.withBaggage({ "app.location": "inner" });
        seen = Context.get().baggage;
      });
    });
    expect(seen).toEqual({ "app.location": "inner", "app.tenant": "t1" });
  });

  it("isolates parallel forks — sibling baggage does not leak", async () => {
    const results = await Context.run(Context.create(), async () => {
      const a = Context.fork({}, async () => {
        Context.withBaggage({ "app.location": "A" });
        await new Promise((r) => setTimeout(r, 10));
        return Context.get().baggage;
      });
      const b = Context.fork({}, async () => {
        Context.withBaggage({ "app.location": "B" });
        await new Promise((r) => setTimeout(r, 5));
        return Context.get().baggage;
      });
      return Promise.all([a, b]);
    });

    expect(results[0]).toEqual({ "app.location": "A" });
    expect(results[1]).toEqual({ "app.location": "B" });
  });

  it("doesn't mutate the parent's baggage object reference", async () => {
    // Defensive: if a caller stashed a reference to `ctx.baggage`, it
    // shouldn't observe child mutations. Reassignment (vs in-place mutation)
    // gives us this for free.
    let parentRef: Record<string, AttributeValue> | undefined;
    await Context.run(Context.create(), async () => {
      Context.withBaggage({ x: 1 });
      parentRef = Context.get().baggage;

      await Context.fork({}, async () => {
        Context.withBaggage({ x: 2, y: 3 });
      });
    });
    // Parent's captured reference still shows just { x: 1 }.
    expect(parentRef).toEqual({ x: 1 });
  });
});

describe("Telemetry.startSpan baggage auto-stamping", () => {
  let provider: CapturingProvider;

  beforeEach(() => {
    provider = new CapturingProvider();
    Telemetry.setProvider(provider);
  });

  afterEach(() => {
    Telemetry.resetProvider();
  });

  it("applies active baggage to the new span via setAttributes", async () => {
    await Context.run(Context.create(), async () => {
      Context.withBaggage({ "app.location": "ernesto" });
      Telemetry.startSpan("op");
    });

    expect(provider.spans).toHaveLength(1);
    expect(provider.spans[0]!.attrCalls).toEqual([
      { method: "setAttributes", payload: { "app.location": "ernesto" } },
    ]);
  });

  it("falls back to per-key setAttribute when provider does not support setAttributes", async () => {
    provider.supportsBatch = false;

    await Context.run(Context.create(), async () => {
      Context.withBaggage({ a: 1, b: "two" });
      Telemetry.startSpan("op");
    });

    expect(provider.spans).toHaveLength(1);
    const calls = provider.spans[0]!.attrCalls;
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.method === "setAttribute")).toBe(true);
    expect(calls.map((c) => c.payload)).toEqual([{ a: 1 }, { b: "two" }]);
  });

  it("makes no attribute calls when there is no baggage", async () => {
    await Context.run(Context.create(), async () => {
      Telemetry.startSpan("op");
    });
    expect(provider.spans).toHaveLength(1);
    expect(provider.spans[0]!.attrCalls).toEqual([]);
  });

  it("makes no attribute calls when there is no active context at all", () => {
    Telemetry.startSpan("op");
    expect(provider.spans).toHaveLength(1);
    expect(provider.spans[0]!.attrCalls).toEqual([]);
  });

  it("each span sees the baggage active at its own startSpan call", async () => {
    await Context.run(Context.create(), async () => {
      Context.withBaggage({ "app.location": "outer" });
      Telemetry.startSpan("outer-op");

      await Context.fork({}, async () => {
        Context.withBaggage({ "app.location": "inner" });
        Telemetry.startSpan("inner-op");
      });

      Telemetry.startSpan("outer-op-after");
    });

    expect(provider.spans.map((s) => ({ name: s.name, attrs: s.attrCalls }))).toEqual([
      {
        name: "outer-op",
        attrs: [{ method: "setAttributes", payload: { "app.location": "outer" } }],
      },
      {
        name: "inner-op",
        attrs: [{ method: "setAttributes", payload: { "app.location": "inner" } }],
      },
      {
        name: "outer-op-after",
        attrs: [{ method: "setAttributes", payload: { "app.location": "outer" } }],
      },
    ]);
  });
});

describe("proc.withBaggage", () => {
  let provider: CapturingProvider;

  beforeEach(() => {
    provider = new CapturingProvider();
    Telemetry.setProvider(provider);
  });

  afterEach(() => {
    Telemetry.resetProvider();
  });

  it("runs the procedure body inside a context with the given baggage", async () => {
    let seen: Record<string, AttributeValue> | undefined;
    const proc = createProcedure({ name: "my-op" }, async () => {
      seen = Context.tryGet()?.baggage;
      return "ok";
    });

    const wrapped = proc.withBaggage({ "app.location": "alpha" });
    const result = await wrapped.exec().result;

    expect(result).toBe("ok");
    expect(seen).toEqual({ "app.location": "alpha" });
  });

  it("does not leak baggage to the caller's context", async () => {
    const proc = createProcedure({ name: "my-op" }, async () => "done");

    let callerBaggage: Record<string, AttributeValue> | undefined;
    await Context.run(Context.create(), async () => {
      Context.withBaggage({ "app.location": "caller" });
      await proc.withBaggage({ "app.location": "proc" }).exec().result;
      callerBaggage = Context.get().baggage;
    });

    // Caller's context still shows its own baggage; proc's override is gone.
    expect(callerBaggage).toEqual({ "app.location": "caller" });
  });

  it("does not mutate the original procedure", async () => {
    let seen: Record<string, AttributeValue> | undefined;
    const proc = createProcedure({ name: "my-op" }, async () => {
      seen = Context.tryGet()?.baggage;
    });

    proc.withBaggage({ tag: "wrapped" });
    await proc.exec().result;
    expect(seen).toBeUndefined();
  });

  it("baggage is auto-stamped onto spans started inside the handler", async () => {
    const proc = createProcedure({ name: "my-op" }, async () => {
      Telemetry.startSpan("inner-span");
    });

    await proc.withBaggage({ "app.location": "ernesto" }).exec().result;

    const inner = provider.spans.find((s) => s.name === "inner-span");
    expect(inner).toBeDefined();
    expect(inner!.attrCalls).toContainEqual({
      method: "setAttributes",
      payload: { "app.location": "ernesto" },
    });
  });

  it("layers on top of caller's baggage (innermost wins)", async () => {
    let seen: Record<string, AttributeValue> | undefined;
    const proc = createProcedure({ name: "my-op" }, async () => {
      seen = Context.tryGet()?.baggage;
    });

    await Context.run(Context.create(), async () => {
      Context.withBaggage({ "app.location": "outer", "app.tenant": "t1" });
      await proc.withBaggage({ "app.location": "proc" }).exec().result;
    });

    // Procedure's baggage overrides "app.location"; tenant inherited.
    expect(seen).toEqual({ "app.location": "proc", "app.tenant": "t1" });
  });
});
