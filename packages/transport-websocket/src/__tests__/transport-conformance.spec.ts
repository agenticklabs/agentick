/**
 * runTransportConformance against the WebSocket transport.
 *
 * Stands up a real `ws` server backed by the test-supplied handler,
 * exposes the WebSocket client transport, and runs the shared
 * behavioral suite. Wire-specific tests (subprotocol, origin
 * validation, reconnect, custom WebSocket constructor) stay in their
 * own spec files.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WSConnection } from "ws";
import {
  runTransportConformance,
  type TransportConformanceFactory,
} from "@agentick/spec-conformance";

import { websocket } from "../client/index.js";
import { AGENTICK_SUBPROTOCOL, decodeFrame, encodeFrame } from "../shared/codec.js";

const factory: TransportConformanceFactory = {
  async setup(handler) {
    const httpServer = createServer();
    const wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) =>
        protocols.has(AGENTICK_SUBPROTOCOL) ? AGENTICK_SUBPROTOCOL : false,
    });

    httpServer.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });

    wss.on("connection", (ws: WSConnection) => {
      ws.on("message", async (data) => {
        const decoded = decodeFrame(data as Buffer);
        if (!decoded.ok) return;
        const frame = decoded.value;
        if (Array.isArray(frame)) return;
        if ("id" in frame && "method" in frame) {
          // Request — dispatch to handler; the handler may send
          // notifications back via the callback while it processes.
          const response = await handler(frame, (notification) => {
            try {
              ws.send(
                encodeFrame({
                  jsonrpc: "2.0",
                  method: notification.method,
                  params: notification.params,
                }),
              );
            } catch {
              /* socket may be closing */
            }
          });
          try {
            ws.send(encodeFrame(response));
          } catch {
            /* socket may be closing */
          }
        }
        // Client notifications (e.g., notifications/cancelled) are not
        // dispatched to the handler in this minimal fixture; per-transport
        // tests cover the route.
      });
    });

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const port = (httpServer.address() as AddressInfo).port;
    const transport = websocket({ url: `ws://127.0.0.1:${port}` });

    return {
      transport,
      teardown: async () => {
        wss.close();
        await new Promise<void>((resolve, reject) =>
          httpServer.close((err) => (err ? reject(err) : resolve())),
        );
      },
    };
  },
};

runTransportConformance("WebSocket transport", factory);
