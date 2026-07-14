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
