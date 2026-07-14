/**
 * `unixSocketServerTransport` — ServerTransport conformance + a real
 * gateway-driven bind (ADR 84 §2).
 *
 * The conformance suite pins the abstract contract. The integration test proves
 * the wrapper defers the host to `listen(host)` and binds the underlying
 * `net.Server`: a gateway that owns the transport accepts a real Unix-socket
 * client on `gateway.listen()` (a `ping` round-trips), and `gateway.close()`
 * releases the socket path.
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connect as netConnect } from "node:net";
import { createGateway } from "@agentick/gateway-next";
import { createClient } from "@agentick/client-next";
import { runServerTransportConformance } from "@agentick/spec-conformance-next";
import { afterAll, describe, expect, it } from "vitest";

import { unixSocket } from "../client/index.js";
import { unixSocketServerTransport } from "../server/index.js";

const socketDir = mkdtempSync(join(tmpdir(), "agentick-unix-st-"));

afterAll(() => {
  rmSync(socketDir, { recursive: true, force: true });
});

runServerTransportConformance("unixSocketServerTransport", () =>
  unixSocketServerTransport({
    path: join(socketDir, `conformance-${Math.random().toString(36).slice(2)}.sock`),
  }),
);

describe("unixSocketServerTransport — real bind through gateway ownership", () => {
  it("gateway.listen() binds the socket; gateway.close() releases it", async () => {
    const socketPath = join(socketDir, "gateway.sock");
    const gateway = await createGateway({
      transports: [unixSocketServerTransport({ path: socketPath })],
    });

    await gateway.listen();

    const client = await createClient({
      transport: unixSocket({ path: socketPath }),
    });
    await client.connect();
    expect(client.state).toBe("open");
    expect(await client.request("ping", {})).toEqual({});
    await client.close();

    await gateway.close();

    // Node unlinks the socket path when the net.Server closes.
    expect(existsSync(socketPath)).toBe(false);
  });
});

describe("unixSocketServerTransport — per-connection admission (gateway:accept, ADR 84 §4)", () => {
  it("a throwing onBeforeGatewayAccept DROPS the connection (server destroys the socket)", async () => {
    const socketPath = join(socketDir, "accept-reject.sock");
    const gateway = await createGateway({
      transports: [unixSocketServerTransport({ path: socketPath })],
    });
    let fired = 0;
    gateway.hook({
      onBeforeGatewayAccept: () => {
        fired++;
        throw new Error("rejected by policy");
      },
    });
    await gateway.listen();

    // A raw net client connects at the socket level; the server authenticates,
    // fires the rejected admission, and destroys the socket — the client sees
    // the connection close/reset without ever exchanging a frame.
    const sock = netConnect(socketPath);
    const dropped = await new Promise<boolean>((resolve) => {
      sock.on("close", () => resolve(true));
      sock.on("error", () => resolve(true));
    });
    expect(dropped).toBe(true);
    expect(fired).toBe(1);

    await gateway.close();
  });

  it("a permitting onBeforeGatewayAccept fires exactly once (with the ConnectionInfo) and lets a request round-trip", async () => {
    const socketPath = join(socketDir, "accept-permit.sock");
    const gateway = await createGateway({
      transports: [unixSocketServerTransport({ path: socketPath })],
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
      transport: unixSocket({ path: socketPath }),
    });
    await client.connect();
    expect(client.state).toBe("open");
    expect(await client.request("ping", {})).toEqual({});
    await client.close();

    expect(fired).toBe(1);
    expect(seenTransportId).toBe(`unix-socket:${socketPath}`);

    await gateway.close();
  });
});
