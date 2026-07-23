/**
 * Gateway telemetry (ADR 78) — the two halves of the gateway-level `telemetry`
 * switch:
 *
 *   1. **Gateway's own ops export.** The gateway builds an app-scoped
 *      `ManagedRuntime` from its `telemetry` setting and runs every gateway
 *      operation on it (via `runGatewayOp`), so each op's `Effect.withSpan`
 *      span EXPORTS to the configured tracer. Proven end-to-end against a real
 *      OTel `SpanProcessor` (`spyTelemetrySink`): drive `gateway.authorize` and
 *      assert its `authorizer:command:authorize` span reached the processor.
 *
 *   2. **Substrate inheritance.** Every hosted app that does NOT specify its own
 *      `telemetry` inherits the gateway's setting (default-chained through
 *      `createApp`). Proven by creating an app beneath a telemetry-enabled
 *      gateway WITHOUT its own switch and observing the app's OWN
 *      `app:command:close-app` span land on the SHARED sink — the app built a
 *      real telemetry runtime from the inherited setting. An app-supplied
 *      `telemetry` always wins: its ops export to ITS sink, never the gateway's.
 *
 * `spyTelemetrySink` records at the standard-OTel edge (a real `SpanProcessor`),
 * so these tests exercise the full Effect → @effect/opentelemetry → OTel-SDK
 * pipeline, not just an in-memory tracer.
 *
 * @verifiedBy this file
 * @see docs/proposals/v2/blueprint/78-telemetry-via-runtime-substrate.md
 */

import { describe, expect, it } from "vitest";
import { createTelemetry } from "@agentick/app-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { spyTelemetrySink } from "@agentick/runtime-next/testing";
import { CompilerHarness } from "@agentick/compiler-react-next";

import { createGateway } from "../index.js";

const NULL_ROOT = null as unknown;

/**
 * Minimal app options for a hosted app — a compiler is required; the app is
 * model-less (legal — `closeApp` needs no model). A fresh substrate per app so
 * the compiler's events don't cross-wire.
 */
function mkAppOptions() {
  const sub = { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
  return {
    compiler: new CompilerHarness(
      `r-${Math.random().toString(36).slice(2)}`,
      sub.journal,
      sub.bus,
      sub.inbox,
    ),
  };
}

describe("Gateway telemetry (ADR 78) — gateway ops export + substrate inheritance", () => {
  it("Half A — a gateway op's Effect.withSpan span exports to the gateway's telemetry sink", async () => {
    const spy = spyTelemetrySink();
    const gateway = await createGateway({ telemetry: createTelemetry({}, spy) });

    // `authorize` routes through `runOperation` → `runGatewayOp`, so its op span
    // (`authorizer:command:authorize`) runs on the gateway's telemetry runtime
    // and reaches the recording SpanProcessor. Unauthenticated (no principal)
    // passes the default `unconfiguredAuthorizer` — but the span exports either
    // way (withSpan wraps the whole op).
    const verdict = await gateway.authorize({ scope: "test:op" });
    expect(verdict.allowed).toBe(true);

    expect(spy.spans.some((s) => s.name === "authorizer:command:authorize")).toBe(true);

    await gateway.close();
  });

  it("Half B — an app WITHOUT its own telemetry inherits the gateway's (span lands on the shared sink)", async () => {
    const spy = spyTelemetrySink();
    const gateway = await createGateway({ telemetry: createTelemetry({}, spy) });
    await gateway.listen();

    // App created beneath the gateway with NO telemetry of its own → inherits
    // the gateway's setting and builds a real telemetry runtime from it.
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    // The app's OWN close op runs on the app's (inherited) telemetry runtime.
    // Its `app:command:close-app` span reaching the SHARED sink proves the
    // inheritance wired an exporting runtime into the app.
    await app.closeApp();

    expect(spy.spans.some((s) => s.name === "app:command:close-app")).toBe(true);

    await gateway.close();
  });

  it("Half B — an app-supplied telemetry OVERRIDES the gateway default (its spans go to ITS sink, not the gateway's)", async () => {
    const gatewaySpy = spyTelemetrySink();
    const appSpy = spyTelemetrySink();
    const gateway = await createGateway({ telemetry: createTelemetry({}, gatewaySpy) });
    await gateway.listen();

    // App created WITH its own telemetry → the gateway's inheritance must NOT
    // overwrite it (the `...input.options` spread carries the app's setting;
    // the default-chain only fires when the app omitted one).
    const app = await gateway.createApp({
      rootElement: NULL_ROOT,
      options: { ...mkAppOptions(), telemetry: createTelemetry({}, appSpy) },
    });

    await app.closeApp();

    // The app's close span lands on the APP's sink, never the gateway's.
    expect(appSpy.spans.some((s) => s.name === "app:command:close-app")).toBe(true);
    expect(gatewaySpy.spans.some((s) => s.name === "app:command:close-app")).toBe(false);

    await gateway.close();
  });
});
