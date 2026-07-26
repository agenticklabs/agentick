/**
 * Ingress-authentication conformance (ADR 61 slice 1) against the REAL
 * WebSocket server. WS is a stateful, bearer-credential transport that
 * authenticates ONCE per connection at upgrade.
 *
 * Uses a raw `ws` client (not the high-level client) so the test has
 * precise control over the per-socket `Authorization` header and can
 * dispatch multiple frames on one authenticated connection.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createGateway } from "@agentick/gateway";
import {
  collectAdmissionFailures,
  runIngressAuthnConformance,
  spyAuthorizer,
  type IngressAuthnFactory,
  type IngressAuthnServer,
} from "@agentick/transport/testing";

import { AGENTICK_SUBPROTOCOL } from "../shared/codec.js";
import { websocketServer } from "../server/index.js";

interface WsConn {
  request(method: string, params: unknown): Promise<unknown>;
  close(): void;
}

/** Open a socket carrying `token`. Rejects if the server refuses the upgrade. */
function connectWs(url: string, token: string | undefined): Promise<WsConn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      url,
      [AGENTICK_SUBPROTOCOL],
      token !== undefined ? { headers: { Authorization: `Bearer ${token}` } } : {},
    );
    const pending = new Map<number, (r: unknown) => void>();
    let nextId = 0;
    ws.on("message", (data: Buffer | string) => {
      const msg = JSON.parse(data.toString()) as { id?: number };
      if (typeof msg.id === "number") {
        const resolveFn = pending.get(msg.id);
        if (resolveFn) {
          pending.delete(msg.id);
          resolveFn(msg);
        }
      }
    });
    ws.once("open", () => {
      resolve({
        request(method, params) {
          return new Promise((res) => {
            const id = ++nextId;
            pending.set(id, res);
            ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
          });
        },
        close() {
          ws.close();
        },
      });
    });
    ws.once("unexpected-response", () => reject(new Error("ws upgrade refused")));
    ws.once("error", (e) => reject(e));
  });
}

const factory: IngressAuthnFactory = {
  kind: "websocket",
  credentialModel: "bearer",
  crossingModel: "per-connection",
  async withServer(opts, body) {
    const spy = spyAuthorizer();
    const gateway = await createGateway({ authorizer: spy.authorizer });
    const admission = collectAdmissionFailures(gateway);
    const httpServer = createServer();
    const server = websocketServer({
      httpServer,
      gateway,
      ...(opts.authSource ? { authSource: opts.authSource } : {}),
    });
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
    const port = (httpServer.address() as AddressInfo).port;
    const url = `ws://127.0.0.1:${port}`;

    const server_iface: IngressAuthnServer = {
      admissionFailures: admission.admissionFailures,
      async crossing(token) {
        const conn = await connectWs(url, token);
        const before = spy.seen.length;
        await conn.request("gateway/list_apps", {});
        conn.close();
        return { principal: spy.seen[before] };
      },
      async twoCrossingsOneSession(tokenA) {
        // One socket, one authn (at upgrade). Both dispatches carry the
        // connection identity; the second token is irrelevant.
        const conn = await connectWs(url, tokenA);
        const i = spy.seen.length;
        await conn.request("gateway/list_apps", {});
        await conn.request("gateway/list_apps", {});
        conn.close();
        return { first: spy.seen[i], second: spy.seen[i + 1] };
      },
    };

    try {
      return await body(server_iface);
    } finally {
      admission.stop();
      await server.close();
      await new Promise<void>((res, rej) => httpServer.close((e) => (e ? rej(e) : res())));
      await gateway.close();
    }
  },
};

runIngressAuthnConformance(factory);
