/**
 * Spine meter-threading, END TO END (ADR 64/78). The per-harness parity specs
 * prove `adoptTelemetry` lights `ctx.metrics` on a loop / model / compiler
 * harness in isolation. THIS proves the load-bearing wiring: a real
 * `createApp({ telemetry })` THREADS the resolved provider into its SHARED SPINE
 * harnesses — which are constructed before the async telemetry switch resolves,
 * so they miss the construction-time provider a per-session harness gets, and
 * `AppHarness.adoptSpineTelemetry` late-binds it once telemetry is ready.
 *
 * The proof separates two sets:
 *   - `seenOps` — every op a late `app.use` interceptor RAN on. It folds down to
 *     the spine harnesses via live interceptor inheritance (ADR 83 §4), so the
 *     loop's `loop:run-execution` and the model executor's `model:run` are here.
 *   - `sunkOps` — the ops whose emitted metric actually REACHED the sink.
 * A metric reaches the sink ONLY if that harness holds the provider. So
 * `sunkOps ⊇ { a Loop op, a Model op }` is direct evidence the app late-bound the
 * provider onto the spine — absent the threading those emissions hit the
 * off-path no-op and never surface.
 *
 * @verifiedBy this file
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { spyTelemetrySink } from "@agentick/runtime/testing";
import { scriptedAdapter } from "@agentick/model/testing";

import { createApp } from "../react.js";
import { createTelemetry } from "../telemetry-wiring.js";

function Agent() {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement("section" as never, { id: "system", audience: "model" }, "helpful"),
    React.createElement("message" as never, { role: "user" }, "hi"),
  );
}

describe("Spine meter-threading e2e — the app late-binds the provider onto loop + model", () => {
  it("a late app.use metric on the loop + model spine ops reaches the sink (adoptSpineTelemetry)", async () => {
    const spy = spyTelemetrySink();

    // A `model` ADAPTER (not a BYO `modelExecutor`) so the APP constructs the
    // executor — WITH `interceptorParent: this`, the live edge a late `app.use`
    // rides down to the `model:run` op — AND places it on the spine that
    // `adoptSpineTelemetry` late-binds the provider onto. A BYO executor is used
    // as-is, outside that edge.
    const app = await createApp(React.createElement(Agent), {
      name: "spine-app",
      model: scriptedAdapter("done"),
      telemetry: createTelemetry({ serviceName: "spine" }, spy),
    });

    const seenOps = new Set<string>();
    app.use((input, next, ctx) => {
      if (ctx.op !== undefined) {
        seenOps.add(ctx.op);
        ctx.metrics.count("spine.hit", 1);
      }
      return next(input);
    });

    const session = await app.createSession({ sessionId: "spine" });
    await (
      await session.send({ messages: [{ role: "user", content: "hi" }] })
    ).result;

    const hits = (await spy.collectMetrics()).filter((m) => m.name === "agentick.spine.hit");
    const sunkOps = new Set(hits.map((m) => String(m.labels.op)));

    // The middleware ran on the loop + model spine ops during the send…
    expect([...seenOps].some((o) => o.startsWith("Loop"))).toBe(true);
    expect([...seenOps].some((o) => o.startsWith("Model"))).toBe(true);
    // …and those emissions reached the sink — only possible if the app threaded
    // the provider onto the construction-sibling spine harnesses.
    expect([...sunkOps].some((o) => o.startsWith("Loop"))).toBe(true);
    expect([...sunkOps].some((o) => o.startsWith("Model"))).toBe(true);

    // Each spine emission carries the app-identity ambient label the app
    // late-bound ALONGSIDE the provider (multi-app sink disambiguation).
    for (const m of hits.filter((h) => /^(Loop|Model)/.test(String(h.labels.op)))) {
      expect(m.labels.app).toBe("spine-app");
    }

    await session.close();
    await app.closeApp();
  });
});
