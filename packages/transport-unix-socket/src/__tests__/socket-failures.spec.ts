/**
 * Socket failures are typed on the way out and visible on the way down.
 *
 * Two habits this pins:
 *
 *   1. **A rejection is an `Error`.** The client rejected a failed connect with
 *      a bare object literal — structurally a `TransportError`, but with no
 *      stack, failing `instanceof Error`, and printing as `[object Object]` in
 *      every logger that expects one. The shape and the class are not a
 *      trade-off: `transportError(...)` returns a value that is both.
 *   2. **A swallowed failure is reported.** The server's per-connection adapter
 *      caught socket errors into empty blocks. A reset peer, a failed write, a
 *      cleanup that threw — all invisible, on the transport whose whole job is
 *      moving bytes between two processes. `onFailure` is the seam; quiet stays
 *      the default, but silence is now a choice the adopter makes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@agentick/client-core";
import { createGateway } from "@agentick/gateway";
import { defineWireExtension, isTransportError, type WireExtension } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";
import { afterEach, describe, expect, it } from "vitest";

import { unixSocket } from "../client/index.js";
import {
  unixSocketServer,
  type UnixSocketFailure,
  type UnixSocketServerHandle,
} from "../server/index.js";

const dirs: string[] = [];
const servers: UnixSocketServerHandle[] = [];
const gateways: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (gateways.length) await gateways.pop()!.close();
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// Synthetic probe methods, merged so the definition and registry types line up.
declare module "@agentick/spec" {
  interface WireMethods {
    "failProbe/subscribe": { params: object; result: null };
    "failProbe/park": { params: object; result: null };
  }
}

/**
 * A wire extension whose teardown callbacks THROW. Those callbacks are the
 * adopter's code running inside the connection's best-effort teardown loops —
 * the sites that must swallow to finish, and therefore the sites where a
 * swallowed failure is most invisible.
 */
function explodingTeardownExtension(): WireExtension {
  // Stands in for the client-allocated `SubscribeParams.subscriptionId` this
  // probe method has no params to carry — the connection refuses a repeat.
  let subscriptionSeq = 0;
  return defineWireExtension({
    name: "test#exploding-teardown",
    namespace: "failProbe",
    version: "1.0.0",
    methods: {
      "failProbe/subscribe": async (_params, ctx) => {
        ctx.wire.registerSubscription(`cli-sub-${++subscriptionSeq}`, async () => {
          throw new Error("cleanup exploded");
        });
        return null;
      },
      // Parks: `dispatchRequest` clears the in-flight entry when an RPC
      // RETURNS, so a cancel callback only outlives its request while the
      // request is still open. Teardown is what fires it.
      "failProbe/park": async (_params, ctx) =>
        new Promise<null>(() => {
          ctx.wire.registerCancel(() => {
            throw new Error("abort exploded");
          });
        }),
    },
  });
}

function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentick-uds-fail-"));
  dirs.push(dir);
  return join(dir, "test.sock");
}

describe("unix socket client — typed connect failure", () => {
  it("rejects a failed connect with an ERROR, not an object literal", async () => {
    const transport = unixSocket({
      path: join(tmpdir(), "agentick-uds-does-not-exist.sock"),
      reconnect: { enabled: false },
    });

    const error = await transport.connect().then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect(typeof (error as Error).stack).toBe("string");
  });

  it("the error is STILL a TransportError — the shape callers switch on", async () => {
    const transport = unixSocket({
      path: join(tmpdir(), "agentick-uds-does-not-exist.sock"),
      reconnect: { enabled: false },
    });

    const error = await transport.connect().then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(isTransportError(error)).toBe(true);
    expect((error as { kind: string }).kind).toBe("connection");
    // The underlying `ENOENT` is preserved for anyone who wants to look.
    expect((error as { cause?: unknown }).cause).toBeDefined();
  });

  it("carries a message naming the socket path", async () => {
    const path = join(tmpdir(), "agentick-uds-does-not-exist.sock");
    const transport = unixSocket({ path, reconnect: { enabled: false } });

    const error = await transport.connect().then(
      () => undefined,
      (e: unknown) => e,
    );

    expect((error as Error).message).toContain("unix socket");
  });
});

describe("unix socket server — failure reporting", () => {
  it("REPORTS a subscription cleanup that threw instead of swallowing it", async () => {
    const path = socketPath();
    const gateway = await createGateway({ wireExtensions: [explodingTeardownExtension()] });
    gateways.push(gateway);
    const seen: UnixSocketFailure[] = [];
    const server = unixSocketServer({
      path,
      gateway,
      onFailure: (failure) => seen.push(failure),
    });
    servers.push(server);
    await server.listening();

    const client = await createClient({ transport: unixSocket({ path }) });
    await client.connect();
    await client.request("failProbe/subscribe", {});

    // Teardown runs every registered cleanup. This one throws — which must not
    // abandon the rest of teardown, and must not vanish either.
    await client.close();

    await waitFor(() => seen.some((f) => f.at === "subscription-cleanup"), {
      description: "the reported cleanup failure",
      timeoutMs: 2_000,
    });
    const failure = seen.find((f) => f.at === "subscription-cleanup")!;
    expect((failure.error as Error).message).toBe("cleanup exploded");
  });

  it("REPORTS an in-flight abort that threw, and still finishes teardown", async () => {
    const path = socketPath();
    const gateway = await createGateway({ wireExtensions: [explodingTeardownExtension()] });
    gateways.push(gateway);
    const seen: UnixSocketFailure[] = [];
    const server = unixSocketServer({
      path,
      gateway,
      onFailure: (failure) => seen.push(failure),
    });
    servers.push(server);
    await server.listening();

    const client = await createClient({ transport: unixSocket({ path }) });
    await client.connect();
    // Never resolves — the cancel callback has to still be registered when the
    // connection tears down, which is the only time teardown can fire it.
    void client.request("failProbe/park", {}).catch(() => {});
    // Let the park reach the server and register before tearing down.
    await new Promise((r) => setTimeout(r, 50));
    await client.close();

    await waitFor(() => seen.some((f) => f.at === "abort"), {
      description: "the reported abort failure",
      timeoutMs: 2_000,
    });
    expect((seen.find((f) => f.at === "abort")!.error as Error).message).toBe("abort exploded");

    // Teardown completed regardless — the server still accepts a new client.
    const second = await createClient({ transport: unixSocket({ path }) });
    await second.connect();
    expect(await second.request("ping", {})).toEqual({});
    await second.close();
  });

  it("stays silent by DEFAULT — reporting is opt-in, teardown is unaffected", async () => {
    const path = socketPath();
    const gateway = await createGateway({ wireExtensions: [explodingTeardownExtension()] });
    gateways.push(gateway);
    // No `onFailure`: a throwing cleanup must still not break teardown.
    const server = unixSocketServer({ path, gateway });
    servers.push(server);
    await server.listening();

    const client = await createClient({ transport: unixSocket({ path }) });
    await client.connect();
    await client.request("failProbe/subscribe", {});
    await expect(client.close()).resolves.toBeUndefined();

    const second = await createClient({ transport: unixSocket({ path }) });
    await second.connect();
    expect(await second.request("ping", {})).toEqual({});
    await second.close();
  });
});
