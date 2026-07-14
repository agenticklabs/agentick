/**
 * Gateway ownership of server transports (ADR 84 §2).
 *
 * Proves the fan-out contract:
 *   - `gateway.listen()` calls every owned transport's `listen(this)`
 *     (host === the gateway itself);
 *   - `gateway.close()` closes every owned transport;
 *   - `listen()` idempotency does NOT re-fire `transport.listen`;
 *   - a gateway with zero transports still `listen()`s cleanly (no-op fan-out).
 *
 * Also runs the `runServerTransportConformance` suite against the
 * `spyServerTransport` double to pin the abstraction contract.
 *
 * @see docs/proposals/v2/blueprint/84-gateway-lifecycle-and-transports.md §2
 */

import { describe, expect, it } from "vitest";
import { runServerTransportConformance } from "@agentick/spec-conformance-next";

import { createGateway } from "../index.js";
import { spyServerTransport } from "../testing/index.js";

describe("GatewayHarness — server transport ownership (ADR 84 §2)", () => {
  it("fans out listen() to every owned transport with `this` as host", async () => {
    const a = spyServerTransport();
    const b = spyServerTransport();
    const gateway = await createGateway({ transports: [a, b] });

    await gateway.listen();

    expect(a.listenCount).toBe(1);
    expect(b.listenCount).toBe(1);
    // The gateway injects itself as the dispatch host.
    expect(a.hosts[0]).toBe(gateway);
    expect(b.hosts[0]).toBe(gateway);

    await gateway.close();
  });

  it("closes every owned transport on close()", async () => {
    const a = spyServerTransport();
    const b = spyServerTransport();
    const gateway = await createGateway({ transports: [a, b] });

    await gateway.listen();
    await gateway.close();

    expect(a.closeCount).toBe(1);
    expect(b.closeCount).toBe(1);
  });

  it("closes transports even when listen() was never called", async () => {
    const a = spyServerTransport();
    const gateway = await createGateway({ transports: [a] });

    await gateway.close();

    expect(a.listenCount).toBe(0);
    expect(a.closeCount).toBe(1);
  });

  it("is idempotent — a second listen() does NOT re-fire transport.listen", async () => {
    const a = spyServerTransport();
    const gateway = await createGateway({ transports: [a] });

    await gateway.listen();
    await gateway.listen();
    await gateway.listen();

    expect(a.listenCount).toBe(1);

    await gateway.close();
  });

  it("listen()s cleanly with zero transports (no-op fan-out)", async () => {
    const gateway = await createGateway();
    await expect(gateway.listen()).resolves.toBeUndefined();
    await gateway.close();
  });

  it("tolerates a transport whose close() rejects (best-effort teardown)", async () => {
    const good = spyServerTransport();
    const bad = spyServerTransport();
    // Override close to reject — teardown must still close the rest.
    (bad as { close: () => Promise<void> }).close = () =>
      Promise.reject(new Error("transport close boom"));
    const gateway = await createGateway({ transports: [bad, good] });

    await gateway.listen();
    await expect(gateway.close()).resolves.toBeUndefined();
    expect(good.closeCount).toBe(1);
  });
});

runServerTransportConformance("spyServerTransport", () => spyServerTransport());
