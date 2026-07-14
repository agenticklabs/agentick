/**
 * Phase 33.E smoke — real `net.Server` Unix-socket server + real
 * `GatewayHarness`.
 *
 * Exercises NDJSON-framed JSON-RPC over a Unix socket: ping roundtrip,
 * listApps reflecting createApp, RPC error → TransportError,
 * concurrent multiplexed RPCs, clean close.
 */

import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { createGateway } from "@agentick/gateway-next";
import { createClient } from "@agentick/client-next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { unixSocket } from "../client/index.js";
import { unixSocketServer } from "../server/index.js";

function makeAppOptions() {
  return {
    rootElement: {} as unknown,
    executor: {
      target: { kind: "language-model" as const, provider: "mock", modelId: "stub" },
      project: () => ({}) as never,
      execute: () => Effect.succeed({}) as never,
      executeStream: undefined,
      normalize: () => ({}) as never,
      run: () => Effect.succeed({}) as never,
      abort: () => Effect.succeed(undefined) as never,
    } as never,
    reconciler: {
      mount: () => Effect.succeed({}) as never,
      unmount: () => Effect.succeed(undefined) as never,
      render: () => Effect.succeed({}) as never,
      snapshot: () => Effect.succeed({}) as never,
    } as never,
  };
}

describe("Unix socket transport — end-to-end with real GatewayHarness", () => {
  let gateway: Awaited<ReturnType<typeof createGateway>>;
  let server: ReturnType<typeof unixSocketServer>;
  let socketDir: string;
  let socketPath: string;

  beforeEach(async () => {
    gateway = await createGateway();
    await gateway.listen();
    socketDir = mkdtempSync(join(tmpdir(), "agentick-unix-"));
    socketPath = join(socketDir, "agentick.sock");
    server = unixSocketServer({ path: socketPath, gateway });
    // Wait for listening
    await new Promise<void>((resolve) => server.server.once("listening", () => resolve()));
  });

  afterEach(async () => {
    await server.close();
    try {
      rmSync(socketDir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
    await gateway.close();
  });

  it("ping roundtrips over the socket", async () => {
    const client = await createClient({
      transport: unixSocket({ path: socketPath }),
    });
    await client.connect();
    expect(client.state).toBe("open");
    const result = await client.request("ping", {});
    expect(result).toEqual({});
    await client.close();
  });

  it("gateway.listApps reflects createApp", async () => {
    await gateway.createApp({
      appId: "app-u",
      rootElement: {} as unknown,
      options: makeAppOptions() as never,
    });
    const client = await createClient({
      transport: unixSocket({ path: socketPath }),
    });
    await client.connect();
    const { apps } = await client.gateway().listApps();
    expect(apps).toHaveLength(1);
    expect(apps[0]?.id).toBe("app-u");
    await client.close();
  });

  it("RPC error → TransportError { kind: 'rpc' }", async () => {
    const client = await createClient({
      transport: unixSocket({ path: socketPath }),
    });
    await client.connect();
    await expect(client.gateway().getApp("missing")).rejects.toMatchObject({
      kind: "rpc",
      error: { code: -32011 },
    });
    await client.close();
  });

  it("multiplexes concurrent RPCs on one socket", async () => {
    await gateway.createApp({
      appId: "u-1",
      rootElement: {} as unknown,
      options: makeAppOptions() as never,
    });
    await gateway.createApp({
      appId: "u-2",
      rootElement: {} as unknown,
      options: makeAppOptions() as never,
    });
    const client = await createClient({
      transport: unixSocket({ path: socketPath }),
    });
    await client.connect();
    const [a, b, list] = await Promise.all([
      client.gateway().getApp("u-1"),
      client.gateway().getApp("u-2"),
      client.gateway().listApps(),
    ]);
    expect(a?.id).toBe("u-1");
    expect(b?.id).toBe("u-2");
    expect(list.apps.map((x) => x.id).sort()).toEqual(["u-1", "u-2"]);
    await client.close();
  });

  it("close() transitions to closed", async () => {
    const client = await createClient({
      transport: unixSocket({ path: socketPath }),
    });
    await client.connect();
    await client.close();
    expect(client.state).toBe("closed");
  });
});
