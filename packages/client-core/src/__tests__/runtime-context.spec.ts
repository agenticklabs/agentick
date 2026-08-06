/**
 * `ClientRuntimeContext` — the trunk. The tests that matter are the two the
 * doc's original sketch got wrong: `connectionId` is not stable, and the
 * observability instance must be shared rather than rebuilt.
 */

import { describe, expect, it } from "vitest";

import { clientObservability } from "../observability.js";
import type { TelemetryAdapter, TelemetrySpan } from "@agentick/spec";
import { clientRuntimeContext } from "../runtime-context.js";

describe("identity is read, not captured", () => {
  it("tracks a connectionId that changes on reconnect", () => {
    let connection: string | undefined;
    const ctx = clientRuntimeContext(clientObservability(undefined), {
      clientId: () => "client-1",
      connectionId: () => connection,
    });

    // Before the first handshake there IS no connection — not an empty string.
    expect(ctx.connectionId).toBeUndefined();

    connection = "conn-a";
    expect(ctx.connectionId).toBe("conn-a");

    // Reconnect mints a new one. A captured value would still read "conn-a",
    // and a targeted tool call would address a connection that is gone.
    connection = "conn-b";
    expect(ctx.connectionId).toBe("conn-b");
  });

  it("keeps clientId stable across the same reads", () => {
    const ctx = clientRuntimeContext(clientObservability(undefined), {
      clientId: () => "client-1",
      connectionId: () => "conn-a",
    });
    expect(ctx.clientId).toBe("client-1");
    expect(ctx.clientId).toBe("client-1");
  });
});

describe("the observability instance is shared", () => {
  it("preserves span nesting across the trunk", async () => {
    const spans: { name: string; parent?: { spanId: string }; spanId: string }[] = [];
    let n = 0;
    const adapter: TelemetryAdapter = {
      startSpan: (name, _attrs, parent): TelemetrySpan => {
        n += 1;
        const rec = { name, ...(parent ? { parent } : {}), spanId: `s${n}` };
        spans.push(rec);
        return {
          setAttribute() {},
          setError() {},
          end() {},
          spanContext: () => ({ traceId: "t", spanId: rec.spanId, sampled: true }),
        };
      },
      currentTraceContext: () => ({}),
    };
    const obs = clientObservability(adapter);
    const ctx = clientRuntimeContext(obs, {
      clientId: () => "c",
      connectionId: () => "x",
    });

    // Nesting must survive going through the trunk — a trunk that rebuilt
    // observability per read would orphan the child.
    await ctx.trace("outer", async () => {
      await ctx.trace("inner", () => undefined);
    });

    const inner = spans.find((s) => s.name === "inner")!;
    const outer = spans.find((s) => s.name === "outer")!;
    expect(inner.parent?.spanId).toBe(outer.spanId);
  });

  it("exposes the active span for wire propagation", async () => {
    const obs = clientObservability({
      startSpan: () => ({
        setAttribute() {},
        setError() {},
        end() {},
        spanContext: () => ({ traceId: "t", spanId: "s", sampled: true }),
      }),
      currentTraceContext: () => ({}),
    });
    const ctx = clientRuntimeContext(obs, {
      clientId: () => "c",
      connectionId: () => "x",
    });
    expect(ctx.activeSpan()).toBeUndefined();
    await ctx.trace("send", () => {
      expect(ctx.activeSpan()).toBeDefined();
    });
    expect(ctx.activeSpan()).toBeUndefined();
  });
});

describe("the facets are live with no sink", () => {
  it("log is callable and trace passes through", async () => {
    const ctx = clientRuntimeContext(clientObservability(undefined), {
      clientId: () => "c",
      connectionId: () => undefined,
    });
    expect(() => ctx.log.info("x")).not.toThrow();
    expect(() => ctx.metrics.count("y")).not.toThrow();
    await expect(ctx.trace("t", () => 7)).resolves.toBe(7);
  });
});
