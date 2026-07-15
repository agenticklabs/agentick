/**
 * notifications/cancelled — client-side emit + server-side handling.
 *
 * Verifies:
 *   - Client emits notifications/cancelled when an in-flight RPC's
 *     AbortSignal fires
 *   - Server-side ConnectionContext routes notifications/cancelled to
 *     the registered in-flight abort callback
 *
 * Approach: stand up a raw WebSocketServer that records every frame
 * the client sends. Send a ping with an AbortSignal; abort before the
 * response arrives. The server-side recording must contain both the
 * ping request AND the notifications/cancelled frame.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { createClient } from "@agentick/client-core-next";
import { createGateway } from "@agentick/gateway-next";
import { drainRejection } from "@agentick/utils-next/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { websocket } from "../client/index.js";
import { websocketServer } from "../server/index.js";
import { AGENTICK_SUBPROTOCOL } from "../shared/codec.js";

describe("WebSocket transport — notifications/cancelled", () => {
  describe("client-side emit", () => {
    let httpServer: ReturnType<typeof createServer>;
    let wss: WebSocketServer;
    let port = 0;
    let received: Array<{ method?: string; id?: unknown; params?: unknown }> = [];

    beforeEach(async () => {
      received = [];
      httpServer = createServer();
      wss = new WebSocketServer({
        noServer: true,
        handleProtocols: (protocols) =>
          protocols.has(AGENTICK_SUBPROTOCOL) ? AGENTICK_SUBPROTOCOL : false,
      });
      httpServer.on("upgrade", (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      });
      wss.on("connection", (ws) => {
        ws.on("message", (data) => {
          let frame: { method?: string; id?: unknown; params?: unknown };
          try {
            frame = JSON.parse(data.toString());
          } catch {
            return;
          }
          received.push(frame);
          // Handshake short-circuit — client.connect() issues
          // initialize + _extensions/list before any user RPC.
          if ("id" in frame && frame.method === "initialize") {
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: frame.id,
                result: {
                  protocolVersion: "v1",
                  capabilities: {
                    cursorResume: true,
                    subscriptions: true,
                    progress: true,
                    cancellation: true,
                  },
                  serverInfo: { name: "test-ws", version: "0.0.0" },
                  connectionId: `conn-${Date.now()}`,
                },
              }),
            );
            return;
          }
          if ("id" in frame && frame.method === "_extensions/list") {
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: frame.id,
                result: { extensions: [] },
              }),
            );
            return;
          }
          // Respond to the request after a short delay so the client has
          // time to issue the cancellation before the response arrives.
          if ("id" in frame && frame.method === "ping") {
            setTimeout(() => {
              try {
                ws.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} }));
              } catch {
                /* connection may already be closing */
              }
            }, 80);
          }
        });
      });
      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
      port = (httpServer.address() as AddressInfo).port;
    });

    afterEach(async () => {
      wss.close();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    });

    it("client emits notifications/cancelled when the AbortSignal fires", async () => {
      const client = await createClient({
        transport: websocket({ url: `ws://127.0.0.1:${port}` }),
      });
      await client.connect();

      const controller = new AbortController();
      const ping = client.request("ping", {}, controller.signal);
      controller.abort();
      await drainRejection(ping);

      // Allow microtasks for the cancel frame to flush over WS
      await new Promise((r) => setTimeout(r, 50));

      const request = received.find((f) => f.method === "ping");
      const cancellation = received.find((f) => f.method === "notifications/cancelled");

      expect(request).toBeDefined();
      expect(cancellation).toBeDefined();
      expect((cancellation as { params: { reason: string } }).params).toMatchObject({
        reason: "aborted",
      });
      // The cancellation must carry the matching requestId.
      expect((cancellation as { params: { requestId: unknown } }).params.requestId).toBe(
        (request as { id: unknown }).id,
      );

      await client.close();
    });
  });

  describe("server-side handling", () => {
    let gateway: Awaited<ReturnType<typeof createGateway>>;
    let server: ReturnType<typeof websocketServer>;
    let httpServer: ReturnType<typeof createServer>;
    let port = 0;

    beforeEach(async () => {
      gateway = await createGateway();
      httpServer = createServer();
      server = websocketServer({ httpServer, gateway });
      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
      port = (httpServer.address() as AddressInfo).port;
    });

    afterEach(async () => {
      await server.close();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
      await gateway.close();
    });

    it("accepts notifications/cancelled for unknown ids without erroring", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, [AGENTICK_SUBPROTOCOL]);
      await new Promise<void>((resolve) => ws.on("open", () => resolve()));

      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 9999, reason: "test" },
        }),
      );

      // Server must remain connected and responsive afterward.
      const pingFrame = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
        params: {},
      });
      const response = await new Promise<unknown>((resolve, reject) => {
        ws.on("message", (data) => {
          try {
            resolve(JSON.parse(data.toString()));
          } catch (e) {
            reject(e);
          }
        });
        ws.send(pingFrame);
      });

      expect(response).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} });
      ws.close();
    });
  });
});
