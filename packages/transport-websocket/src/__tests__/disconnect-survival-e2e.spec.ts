/**
 * Disconnect ≠ cancel, end-to-end over a real socket.
 *
 * The client fires an RPC whose handler registered a cancel callback, then
 * the connection dies mid-flight. The server's close path must tear down the
 * connection WITHOUT invoking the cancel callback, and the handler must run
 * to completion — the connection is an ephemeral observer, not a proxy for
 * user intent. Explicit `notifications/cancelled` remains the only abort.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createGateway } from "@agentick/gateway";
import { createClient } from "@agentick/client-core";
import { defineWireExtension } from "@agentick/spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { websocket } from "../client/index.js";
import { websocketServer } from "../server/index.js";

let cancelCalls = 0;
let handlerDone: Promise<string>;
let resolveHandlerDone: (v: string) => void;

const probeExtension = defineWireExtension({
  name: "@test/probe",
  namespace: "probe",
  methods: {
    // Fake method — WireMethods is declaration-merged for this test only.
    "probe/slow": (async (
      _params: unknown,
      ctx: { wire: { registerCancel(fn: () => void): void } },
    ) => {
      ctx.wire.registerCancel(() => {
        cancelCalls++;
      });
      await new Promise((r) => setTimeout(r, 250));
      resolveHandlerDone("completed");
      return { ok: true };
    }) as never,
  } as never,
});

describe("WebSocket transport — execution survives disconnect", () => {
  let gateway: Awaited<ReturnType<typeof createGateway>>;
  let server: ReturnType<typeof websocketServer>;
  let httpServer: ReturnType<typeof createServer>;
  let port = 0;

  beforeEach(async () => {
    cancelCalls = 0;
    handlerDone = new Promise((r) => (resolveHandlerDone = r));
    gateway = await createGateway({ wireExtensions: [probeExtension] });
    await gateway.listen();
    httpServer = createServer();
    server = websocketServer({ httpServer, gateway });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await server.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    await gateway.close();
  });

  it("socket death mid-RPC does not fire the handler's cancel; the handler completes", async () => {
    const client = await createClient({
      transport: websocket({ url: `ws://127.0.0.1:${port}` }),
    });
    await client.connect();

    const pending = (
      client as unknown as {
        request(method: string, params: unknown): Promise<unknown>;
      }
    ).request("probe/slow", {});
    // Let the request frame reach the server and enter the handler.
    await new Promise((r) => setTimeout(r, 50));

    await client.close();
    pending.catch(() => {
      /* the response has no wire to ride — the local rejection is expected */
    });

    await expect(handlerDone).resolves.toBe("completed");
    expect(cancelCalls).toBe(0);
  });
});
