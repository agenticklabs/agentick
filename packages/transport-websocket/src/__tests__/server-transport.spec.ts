/**
 * `webSocketServerTransport` — ServerTransport conformance + a real
 * gateway-driven bind (ADR 84 §2).
 *
 * The conformance suite pins the abstract contract (id / listen / close /
 * idempotency / re-listen). The integration test proves the wrapper owns the
 * Node `http.Server`: a gateway that owns the transport binds a real port on
 * `gateway.listen()` (a WS client round-trips a `ping`), and `gateway.close()`
 * tears the listener down (a fresh connection is refused).
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createGateway } from "@agentick/gateway";
import { createClient } from "@agentick/client-core";
import { runServerTransportConformance } from "@agentick/spec-conformance";
import { describe, expect, it } from "vitest";

import { websocket } from "../client/index.js";
import { webSocketServerTransport } from "../server/index.js";

runServerTransportConformance("webSocketServerTransport", () =>
  webSocketServerTransport({ port: 0 }),
);

/** Grab an ephemeral port, then release it so the transport can claim it. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("webSocketServerTransport — real bind through gateway ownership", () => {
  it("gateway.listen() binds the port; gateway.close() tears it down", async () => {
    const port = await freePort();
    const gateway = await createGateway({
      transports: [webSocketServerTransport({ port, host: "127.0.0.1" })],
    });

    await gateway.listen();

    // A real WS client round-trips through the bound listener.
    const client = await createClient({
      transport: websocket({ url: `ws://127.0.0.1:${port}` }),
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

describe("webSocketServerTransport — per-connection admission (gateway:accept, ADR 84 §4)", () => {
  it("a throwing onBeforeGatewayAccept DROPS the connection (server closes with policy code 1008)", async () => {
    const port = await freePort();
    const gateway = await createGateway({
      transports: [webSocketServerTransport({ port, host: "127.0.0.1" })],
    });
    let fired = 0;
    gateway.hook({
      onBeforeGatewayAccept: () => {
        fired++;
        throw new Error("rejected by policy");
      },
    });
    await gateway.listen();

    // Raw ws client: the upgrade handshake completes (subprotocol negotiated),
    // so `open` fires — then the server's rejected admission closes the socket
    // with the WebSocket policy-violation code (1008). We observe that close.
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, ["agentick-rpc-v1"]);
    const outcome = await new Promise<"closed-1008" | "closed-other" | "errored">((resolve) => {
      ws.on("close", (code) => resolve(code === 1008 ? "closed-1008" : "closed-other"));
      // A bare socket reset (no close frame) surfaces as an error — still a drop.
      ws.on("error", () => resolve("errored"));
    });
    // The connection was DROPPED, never wired for frames — the admission fired once.
    expect(outcome === "closed-1008" || outcome === "errored").toBe(true);
    expect(fired).toBe(1);

    await gateway.close();
  });

  it("a permitting onBeforeGatewayAccept fires exactly once (with the ConnectionInfo) and lets a request round-trip", async () => {
    const port = await freePort();
    const gateway = await createGateway({
      transports: [webSocketServerTransport({ port, host: "127.0.0.1" })],
    });
    let fired = 0;
    let seenTransportId: string | undefined;
    gateway.hook({
      onBeforeGatewayAccept: (info) => {
        fired++;
        seenTransportId = info.transportId;
        return info;
      },
    });
    await gateway.listen();

    const client = await createClient({
      transport: websocket({ url: `ws://127.0.0.1:${port}` }),
    });
    await client.connect();
    expect(client.state).toBe("open");
    expect(await client.request("ping", {})).toEqual({});
    await client.close();

    // One connection → the admission fired exactly once, carrying the transport id.
    expect(fired).toBe(1);
    expect(seenTransportId).toBe(`websocket:${port}`);

    await gateway.close();
  });
});
