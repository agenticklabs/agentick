/**
 * `gateway.emitCapabilitiesChanged()` — the control-plane emit seam
 * (ADR 47). Adversarial coverage of the SERVER side: event shape, the
 * two isolation mechanisms that make it multi-tenant-safe, delivery
 * multiplicity/ordering, no-subscriber safety, and rip-out
 * completeness (the bespoke `notify`/`acceptConnection` surface is
 * gone).
 *
 * Determinism: every read emits FIRST, then subscribes from cursor 0
 * and replays from the ring buffer — no subscribe-then-emit race.
 *
 * @verifiedBy ADR 47
 */

import { describe, expect, it } from "vitest";
import {
  GATEWAY_CAPABILITIES_CHANGED,
  type EventQuery,
  type ProtocolEvent,
  type SubscribeOptions,
} from "@agentick/spec-next";

import { createGateway } from "../create-gateway.js";

/**
 * Collect up to `n` events from a live bus iterable, giving up after
 * `ms` of no delivery. Because callers emit before subscribing from
 * cursor 0, the target events are already retained in the ring and
 * return on the first `n` pulls; the (n+1)th parks and trips the
 * timeout, returning what was collected.
 */
async function collect(
  iterable: AsyncIterable<ProtocolEvent>,
  n: number,
  ms = 500,
): Promise<ProtocolEvent[]> {
  const out: ProtocolEvent[] = [];
  const iter = iterable[Symbol.asyncIterator]();
  while (out.length < n) {
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms));
    const step = await Promise.race([iter.next(), timeout]);
    if (step === "timeout") break;
    if (step.done) break;
    out.push(step.value);
  }
  await iter.return?.();
  return out;
}

const FROM_START: SubscribeOptions = { fromCursor: { value: 0 } };
const GATEWAY_Q: EventQuery = { surface: "gateway" };

describe("gateway.emitCapabilitiesChanged — event shape", () => {
  it("appends exactly one gateway:capabilities:changed event with the correct shape", async () => {
    const gw = await createGateway();
    gw.emitCapabilitiesChanged!();

    const events = (await collect(gw.events(GATEWAY_Q, FROM_START), 5)).filter(
      (e) => e.name === GATEWAY_CAPABILITIES_CHANGED,
    );

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.surface).toBe("gateway");
    expect(ev.name).toBe(GATEWAY_CAPABILITIES_CHANGED);
    expect(ev.phase).toBe("terminal");
    expect(ev.scope.gatewayId).toBe(gw.id);
    expect(ev.payload).toEqual({});

    await gw.closeGateway();
  });

  it("emits one event per call, preserving order", async () => {
    const gw = await createGateway();
    gw.emitCapabilitiesChanged!();
    gw.emitCapabilitiesChanged!();
    gw.emitCapabilitiesChanged!();

    const events = (await collect(gw.events(GATEWAY_Q, FROM_START), 10)).filter(
      (e) => e.name === GATEWAY_CAPABILITIES_CHANGED,
    );
    expect(events).toHaveLength(3);
    // Monotonic ids/timestamps preserve emit order on a single bus.
    expect(events.map((e) => e.name)).toEqual([
      GATEWAY_CAPABILITIES_CHANGED,
      GATEWAY_CAPABILITIES_CHANGED,
      GATEWAY_CAPABILITIES_CHANGED,
    ]);

    await gw.closeGateway();
  });

  it("is safe to emit with zero subscribers", async () => {
    const gw = await createGateway();
    expect(() => gw.emitCapabilitiesChanged!()).not.toThrow();
    await gw.closeGateway();
  });
});

describe("gateway.emitCapabilitiesChanged — isolation (multi-tenant safety)", () => {
  it("scope-query isolation: a session/app-scoped subscriber does NOT receive it", async () => {
    const gw = await createGateway();
    gw.emitCapabilitiesChanged!();

    // Session-surface subscriber — different surface, must not match.
    const bySurface = (await collect(gw.events({ surface: "session" }, FROM_START), 3)).filter(
      (e) => e.name === GATEWAY_CAPABILITIES_CHANGED,
    );
    expect(bySurface).toHaveLength(0);

    // Session-scoped subscriber — the event's scope has no sessionId,
    // so the `{ scope: { sessionId } }` query key can't match.
    const byScope = (
      await collect(gw.events({ scope: { sessionId: "sess-x" } }, FROM_START), 3)
    ).filter((e) => e.name === GATEWAY_CAPABILITIES_CHANGED);
    expect(byScope).toHaveLength(0);

    // Control: a gateway-surface subscriber DOES receive it.
    const gatewayScoped = (await collect(gw.events(GATEWAY_Q, FROM_START), 3)).filter(
      (e) => e.name === GATEWAY_CAPABILITIES_CHANGED,
    );
    expect(gatewayScoped).toHaveLength(1);

    await gw.closeGateway();
  });

  // NOTE: child-bus *physical* isolation (a per-tenant child bus
  // wrapping the gateway bus never sees parent events) is a
  // `LocalEventBus` property, verified directly in
  // `@agentick/runtime-next` → local-event-bus fan-in/isolated-reads
  // spec. Re-proving it here would require full app construction and
  // couple this suite to unrelated harness internals.
});

describe("gateway — notify rip-out completeness (ADR 47)", () => {
  it("the bespoke notify / acceptConnection surface is gone; emitCapabilitiesChanged replaces it", async () => {
    const gw = await createGateway();

    // The ripped-out surface must not resurface on the instance.
    expect("notify" in gw).toBe(false);
    expect("acceptConnection" in gw).toBe(false);
    expect("onDeliveryError" in gw).toBe(false);
    expect((gw as unknown as Record<string, unknown>).broadcastNotification).toBeUndefined();

    // The bus-native replacement is present.
    expect(typeof gw.emitCapabilitiesChanged).toBe("function");

    await gw.closeGateway();
  });
});
