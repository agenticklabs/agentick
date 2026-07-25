/**
 * A minimal wire-extension handler ctx for gateway tests — the non-facet fields
 * a handler might touch (`gateway` / `bridges` / `publish` / `transport`). The
 * five Observability + Ops facet slots are left off (cast through `unknown`):
 * `GatewayHarness.runWireDispatch` DEFINES them in-fiber before the handler runs
 * (ADR 64/78), so reading a facet after a dispatch proves the enrichment ran.
 *
 * Mirrors what `@agentick/transport`'s `buildWireExtensionContext` hands the
 * dispatcher, minus the transport-owned `transport` plumbing (stubbed here) — a
 * gateway unit test needs no live connection.
 */

import type { GatewayHarnessProtocol, WireExtensionContext } from "@agentick/spec";

export function fakeWireCtx(gateway: GatewayHarnessProtocol): WireExtensionContext {
  return {
    gateway,
    bridges: () => ({}),
    publish: () => {},
    transport: {
      progress: () => ({ push: () => {} }),
      registerCancel: () => {},
      registerSubscription: () => ({ id: "sub", publish: () => {}, close: () => {} }),
      closeSubscription: () => {},
    },
  } as unknown as WireExtensionContext;
}
