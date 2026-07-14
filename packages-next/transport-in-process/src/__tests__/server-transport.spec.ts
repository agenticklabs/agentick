/**
 * `inProcessServerTransport` — ServerTransport conformance + no-op semantics
 * inside a real gateway (ADR 84 §2).
 *
 * In-process is a direct-call transport: there is no wire to bind, so `listen`
 * and `close` are honest no-ops (see `server-transport.ts`). These tests pin
 * that (a) it satisfies the abstract contract and (b) a gateway that owns it
 * `listen()`s / `close()`s cleanly, so an in-process deployment can list its
 * transport alongside the network transports with uniform fan-out.
 */

import { createGateway } from "@agentick/gateway-next";
import { runServerTransportConformance } from "@agentick/spec-conformance-next";
import { describe, expect, it } from "vitest";

import { inProcessServerTransport } from "../server-transport.js";

runServerTransportConformance("inProcessServerTransport", () => inProcessServerTransport());

describe("inProcessServerTransport — no-op fan-out inside a gateway", () => {
  it("gateway.listen() / gateway.close() resolve with the no-op transport owned", async () => {
    const gateway = await createGateway({ transports: [inProcessServerTransport()] });
    await expect(gateway.listen()).resolves.toBeUndefined();
    await expect(gateway.close()).resolves.toBeUndefined();
  });

  it("has a stable, descriptive id", () => {
    expect(inProcessServerTransport().id).toBe("in-process");
  });
});
