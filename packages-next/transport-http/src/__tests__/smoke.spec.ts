/**
 * Phase 33.D smoke — real Node `http.Server`, real client transport,
 * real `GatewayHarness`.
 *
 * Exercises: POST roundtrip, GET notification channel, listApps,
 * concurrent RPCs, RPC error → TransportError, clean close.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect } from "effect";
import { createGateway } from "@agentick/gateway-next";
import { createClient } from "@agentick/client-core-next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { http } from "../client/index.js";
import { httpServer } from "../server/index.js";

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
    compiler: {
      mount: () => Effect.succeed({}) as never,
      unmount: () => Effect.succeed(undefined) as never,
      render: () => Effect.succeed({}) as never,
      snapshot: () => Effect.succeed({}) as never,
    } as never,
  };
}

describe("Streamable HTTP transport — end-to-end with real GatewayHarness", () => {
  let gateway: Awaited<ReturnType<typeof createGateway>>;
  let server: ReturnType<typeof httpServer>;
  let serverHttp: ReturnType<typeof createServer>;
  let port = 0;

  beforeEach(async () => {
    gateway = await createGateway();
    await gateway.listen();
    serverHttp = createServer();
    server = httpServer({ httpServer: serverHttp, gateway });
    await new Promise<void>((resolve) => serverHttp.listen(0, "127.0.0.1", () => resolve()));
    port = (serverHttp.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await server.close();
    await new Promise<void>((resolve, reject) =>
      serverHttp.close((err) => (err ? reject(err) : resolve())),
    );
    await gateway.close();
  });

  it("ping roundtrips over POST", async () => {
    const client = await createClient({
      transport: http({ url: `http://127.0.0.1:${port}` }),
    });
    await client.connect();
    expect(client.state).toBe("open");
    const result = await client.request("ping", {});
    expect(result).toEqual({});
    await client.close();
  });

  it("gateway.listApps reflects createApp", async () => {
    await gateway.createApp({
      appId: "app-h",
      rootElement: {} as unknown,
      options: makeAppOptions() as never,
    });
    const client = await createClient({
      transport: http({ url: `http://127.0.0.1:${port}` }),
    });
    await client.connect();
    const { apps } = await client.gateway().listApps();
    expect(apps).toHaveLength(1);
    expect(apps[0]?.id).toBe("app-h");
    await client.close();
  });

  it("a server AgentickError propagates TYPED across the wire (G2-wire-errors)", async () => {
    const client = await createClient({
      transport: http({ url: `http://127.0.0.1:${port}` }),
    });
    await client.connect();
    // The server stamps toJSON() into JSON-RPC error.data; the client
    // rehydrates it above the extension pipeline — instanceof holds.
    await expect(client.gateway().getApp("missing")).rejects.toMatchObject({
      _tag: "AppNotFoundError",
      appId: "missing",
    });
    await client.close();
  });

  it("multiplexes concurrent RPCs on the same client", async () => {
    await gateway.createApp({
      appId: "a-h-1",
      rootElement: {} as unknown,
      options: makeAppOptions() as never,
    });
    await gateway.createApp({
      appId: "a-h-2",
      rootElement: {} as unknown,
      options: makeAppOptions() as never,
    });
    const client = await createClient({
      transport: http({ url: `http://127.0.0.1:${port}` }),
    });
    await client.connect();
    const [a, b, list] = await Promise.all([
      client.gateway().getApp("a-h-1"),
      client.gateway().getApp("a-h-2"),
      client.gateway().listApps(),
    ]);
    expect(a?.id).toBe("a-h-1");
    expect(b?.id).toBe("a-h-2");
    expect(list.apps.map((x) => x.id).sort()).toEqual(["a-h-1", "a-h-2"]);
    await client.close();
  });

  it("close() transitions to closed", async () => {
    const client = await createClient({
      transport: http({ url: `http://127.0.0.1:${port}` }),
    });
    await client.connect();
    await client.close();
    expect(client.state).toBe("closed");
  });
});
