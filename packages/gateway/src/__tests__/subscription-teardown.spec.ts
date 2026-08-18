import { describe, expect, it } from "vitest";
import type { GatewayHarnessProtocol, WireExtensionContext } from "@agentick/spec";
import { GatewayHarness } from "../harness.js";

/**
 * The wire cleanup must release the bus subscriber IMMEDIATELY — without
 * waiting for another matching event to arrive. A flag-only cleanup left the
 * drain parked inside `await next()` for scopes that never emit again (dead
 * sessions, idle tenants), so every client refresh accumulated one more
 * permanent bus subscriber (the 2026-08-18 outage's growth term).
 */

function ctxCapturingCleanup(gateway: GatewayHarnessProtocol) {
  let cleanup: (() => Promise<void>) | undefined;
  const ctx = {
    gateway,
    principal: undefined,
    bridges: () => ({}),
    publish: () => {},
    wire: {
      progress: () => ({ push: () => {}, close: () => {} }),
      registerCancel: () => {},
      registerSubscription: (id: string, fn: () => Promise<void>) => {
        cleanup = fn;
        return { id, publish: () => {}, close: () => {} };
      },
      closeSubscription: () => {},
    },
  } as unknown as WireExtensionContext;
  return { ctx, runCleanup: () => cleanup!() };
}

const settle = () => new Promise((r) => setImmediate(r));

describe("sub/subscribe teardown", () => {
  it("cleanup releases the bus subscriber without requiring another event", async () => {
    const gw = new GatewayHarness();
    await gw.ready;
    const handler = gw.wireExtensions().resolve("sub/subscribe")!.extension.methods[
      "sub/subscribe"
    ]!;
    const bus = (gw as unknown as { bus: { subscriberCount(): number } }).bus;
    const baseline = bus.subscriberCount();

    const { ctx, runCleanup } = ctxCapturingCleanup(gw);
    await handler({ subscriptionId: "sub-1", scope: { kind: "gateway" } }, ctx);
    await settle();
    expect(bus.subscriberCount()).toBe(baseline + 1);

    // No events are published between subscribe and cleanup — teardown must
    // not depend on one arriving.
    await runCleanup();
    await settle();
    expect(bus.subscriberCount()).toBe(baseline);

    await gw.close();
  });

  it("repeated subscribe/cleanup cycles do not accumulate subscribers", async () => {
    const gw = new GatewayHarness();
    await gw.ready;
    const handler = gw.wireExtensions().resolve("sub/subscribe")!.extension.methods[
      "sub/subscribe"
    ]!;
    const bus = (gw as unknown as { bus: { subscriberCount(): number } }).bus;
    const baseline = bus.subscriberCount();

    for (let refresh = 0; refresh < 25; refresh++) {
      const { ctx, runCleanup } = ctxCapturingCleanup(gw);
      await handler({ subscriptionId: `sub-${refresh}`, scope: { kind: "gateway" } }, ctx);
      await runCleanup();
    }
    await settle();
    expect(bus.subscriberCount()).toBe(baseline);

    await gw.close();
  });
});
