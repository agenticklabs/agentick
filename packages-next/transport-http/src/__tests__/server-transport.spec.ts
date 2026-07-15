/**
 * `httpServerTransport` — ServerTransport conformance + a real gateway-driven
 * bind (ADR 84 §2).
 *
 * The conformance suite pins the abstract contract. The integration test proves
 * the wrapper owns the Node `http.Server`: a gateway that owns the transport
 * binds a real port on `gateway.listen()` (an HTTP client round-trips a
 * `ping`), and `gateway.close()` frees the port.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createGateway } from "@agentick/gateway-next";
import { createClient } from "@agentick/client-core-next";
import { runServerTransportConformance } from "@agentick/spec-conformance-next";
import { describe, expect, it } from "vitest";

import { http } from "../client/index.js";
import { httpServerTransport } from "../server/index.js";

runServerTransportConformance("httpServerTransport", () => httpServerTransport({ port: 0 }));

/** Grab an ephemeral port, then release it so the transport can claim it. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("httpServerTransport — real bind through gateway ownership", () => {
  it("gateway.listen() binds the port; gateway.close() tears it down", async () => {
    const port = await freePort();
    const gateway = await createGateway({
      transports: [httpServerTransport({ port, host: "127.0.0.1" })],
    });

    await gateway.listen();

    const client = await createClient({
      transport: http({ url: `http://127.0.0.1:${port}` }),
    });
    await client.connect();
    expect(client.state).toBe("open");
    expect(await client.request("ping", {})).toEqual({});
    await client.close();

    await gateway.close();

    // Teardown released the port — a fresh listener can claim it again.
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });
});
