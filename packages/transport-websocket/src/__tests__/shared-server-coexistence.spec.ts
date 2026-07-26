/**
 * Shared-server coexistence — the ownership-aware citizenship contract.
 *
 * ONE Node `http.Server` carries FOUR consumers at once:
 *   (a) `httpServerTransport({ httpServer, path: "/agentick" })`   — RPC over HTTP
 *   (b) `webSocketServerTransport({ httpServer, path: "/agentick/ws" })` — RPC over WS
 *   (c) a plain adopter `request` listener answering `/health`     — foreign HTTP
 *   (d) a bare `upgrade` listener accepting `/other-ws`            — foreign WS (socket.io-like)
 *
 * This is the slice the first real embedding (Knowify's assistant-api) broke on:
 * the WS transport used to `socket.destroy()` EVERY non-matching upgrade, which on
 * a shared server killed the adopter's other websocket consumers (socket.io's
 * Engine.IO upgrades). The symmetric HTTP hazard: writing a `404` to non-matching
 * requests would double-respond against the adopter's framework (every `request`
 * listener fires per request).
 *
 * The contract, now that both transports are ATTACHED (`ownsServer: false`):
 *   - gateway RPC round-trips over (a);
 *   - a v2 WS client connects + round-trips over (b);
 *   - `/health` still answers 200 (the HTTP transport IGNORED it, did not 404 it);
 *   - the foreign `/other-ws` upgrade reaches its own listener with the socket
 *     ALIVE (the WS transport IGNORED it, did not destroy it).
 */

import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { Effect } from "effect";
import { createGateway } from "@agentick/gateway";
import { createClient } from "@agentick/client-core";
import { http, httpServerTransport } from "@agentick/transport-http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { websocket } from "../client/index.js";
import { webSocketServerTransport } from "../server/index.js";

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

describe("shared Node http.Server — HTTP + WS transports coexist with foreign consumers", () => {
  let gateway: Awaited<ReturnType<typeof createGateway>>;
  let server: HttpServer;
  let otherWss: WebSocketServer;
  let otherConnFired = 0;
  let port = 0;

  beforeEach(async () => {
    otherConnFired = 0;
    server = createServer();

    // (c) A plain adopter `request` listener. It answers ONLY `/health` and
    // leaves everything else untouched — the mirror of what the transports must
    // do. (Every `request` listener fires for every request.)
    server.on("request", (req, res) => {
      if (req.url === "/health") {
        res.statusCode = 200;
        res.end("ok");
      }
      // else: not ours — do NOT write; let the agentick HTTP transport answer.
    });

    // Gateway owns two ATTACHED transports on distinct paths of the SAME server.
    gateway = await createGateway({
      transports: [
        httpServerTransport({ httpServer: server, path: "/agentick" }),
        webSocketServerTransport({ httpServer: server, path: "/agentick/ws" }),
      ],
    });
    // Attaches both handlers to `server` (does NOT bind a port — the server is
    // adopter-owned). Registered here, BEFORE the foreign upgrade listener below,
    // so the WS transport's upgrade handler runs FIRST: the old bug would have
    // destroyed the foreign socket before its listener ever saw it.
    await gateway.listen();

    // (d) A bare foreign `upgrade` listener — a socket.io-like Engine.IO on its
    // own path. Accepts `/other-ws`, ignores anything else.
    otherWss = new WebSocketServer({ noServer: true });
    otherWss.on("connection", () => {
      otherConnFired++;
    });
    server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = req.url ?? "";
      if (!url.startsWith("/other-ws")) return; // not ours — leave it be
      otherWss.handleUpgrade(req, socket, head, (ws) => {
        otherWss.emit("connection", ws, req);
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await gateway.close(); // detaches both transport handlers; never touches `server`
    otherWss.close();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("(a) gateway RPC round-trips over HTTP on /agentick", async () => {
    await gateway.createApp({
      appId: "app-shared",
      rootElement: {} as unknown,
      options: makeAppOptions() as never,
    });

    const client = await createClient({
      transport: http({ url: `http://127.0.0.1:${port}/agentick` }),
    });
    await client.connect();
    expect(await client.request("ping", {})).toEqual({});
    const { apps } = await client.gateway().listApps();
    expect(apps.map((a) => a.id)).toContain("app-shared");
    await client.close();
  });

  it("(b) a v2 WS client connects + round-trips over /agentick/ws", async () => {
    const client = await createClient({
      transport: websocket({ url: `ws://127.0.0.1:${port}/agentick/ws` }),
    });
    await client.connect();
    expect(client.state).toBe("open");
    expect(await client.request("ping", {})).toEqual({});
    await client.close();
  });

  it("(c) the adopter's /health endpoint still answers 200 (HTTP transport ignored it, did not 404)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("(d) a foreign /other-ws upgrade reaches its own listener with the socket ALIVE (WS transport did not destroy it)", async () => {
    const foreign = new WebSocket(`ws://127.0.0.1:${port}/other-ws`);
    await new Promise<void>((resolve, reject) => {
      foreign.on("open", () => resolve());
      foreign.on("error", (err) => reject(err));
    });
    // Socket survived the agentick WS transport's upgrade handler and completed
    // the foreign handshake — the coexistence guarantee.
    expect(otherConnFired).toBe(1);
    foreign.close();
    await new Promise<void>((resolve) => foreign.on("close", () => resolve()));
  });

  it("all four consumers work on the SAME server concurrently", async () => {
    await gateway.createApp({
      appId: "app-concurrent",
      rootElement: {} as unknown,
      options: makeAppOptions() as never,
    });

    const httpClient = await createClient({
      transport: http({ url: `http://127.0.0.1:${port}/agentick` }),
    });
    const wsClient = await createClient({
      transport: websocket({ url: `ws://127.0.0.1:${port}/agentick/ws` }),
    });
    await Promise.all([httpClient.connect(), wsClient.connect()]);

    const foreign = new WebSocket(`ws://127.0.0.1:${port}/other-ws`);
    await new Promise<void>((resolve, reject) => {
      foreign.on("open", () => resolve());
      foreign.on("error", (err) => reject(err));
    });

    const [health, httpApps, wsPing] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/health`).then((r) => r.text()),
      httpClient.gateway().listApps(),
      wsClient.request("ping", {}),
    ]);

    expect(health).toBe("ok");
    expect(httpApps.apps.map((a) => a.id)).toContain("app-concurrent");
    expect(wsPing).toEqual({});
    expect(otherConnFired).toBe(1);

    foreign.close();
    await new Promise<void>((resolve) => foreign.on("close", () => resolve()));
    await Promise.all([httpClient.close(), wsClient.close()]);
  });
});
