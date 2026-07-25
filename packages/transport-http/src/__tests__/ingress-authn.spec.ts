/**
 * Ingress-authentication conformance (ADR 61 slice 1) against the REAL
 * Streamable HTTP server. HTTP is stateless: it authenticates PER
 * REQUEST from each POST's own `Authorization` header, so two POSTs on
 * one `Mcp-Session-Id` must resolve to their OWN principals (no bleed).
 *
 * Uses raw `fetch` (not the high-level client) so the test controls the
 * per-request bearer header and the shared session id directly.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createGateway } from "@agentick/gateway";
import {
  runIngressAuthnConformance,
  spyAuthorizer,
  type IngressAuthnFactory,
  type IngressAuthnServer,
} from "@agentick/transport/testing";

import { httpServer } from "../server/index.js";

interface PostResult {
  readonly status: number;
  readonly sessionId?: string;
}

async function post(
  url: string,
  token: string | undefined,
  sessionId?: string,
): Promise<PostResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  if (sessionId !== undefined) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "gateway/list_apps", params: {} }),
  });
  // Drain the body so the socket is released.
  await res.text().catch(() => undefined);
  const sid = res.headers.get("Mcp-Session-Id") ?? undefined;
  return { status: res.status, ...(sid !== undefined ? { sessionId: sid } : {}) };
}

const factory: IngressAuthnFactory = {
  kind: "http",
  credentialModel: "bearer",
  crossingModel: "per-request",
  async withServer(opts, body) {
    const spy = spyAuthorizer();
    const gateway = await createGateway({ authorizer: spy.authorizer });
    const node = createServer();
    const server = httpServer({
      httpServer: node,
      gateway,
      // Isolate the ingress-AUTHN axis under test: the raw-fetch helpers here
      // POST without running the CSRF bootstrap handshake. CSRF is orthogonal
      // to bearer authn and has dedicated coverage in `web-security.spec.ts`.
      csrf: false,
      ...(opts.authSource ? { authSource: opts.authSource } : {}),
    });
    await new Promise<void>((r) => node.listen(0, "127.0.0.1", () => r()));
    const port = (node.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/`;

    const server_iface: IngressAuthnServer = {
      async crossing(token) {
        const before = spy.seen.length;
        const res = await post(url, token);
        if (res.status === 401) throw new Error("http 401");
        return { principal: spy.seen[before] };
      },
      async twoCrossingsOneSession(tokenA, tokenB) {
        const i = spy.seen.length;
        const first = await post(url, tokenA);
        if (first.status === 401) throw new Error("http 401");
        // Reuse the SAME transport session; authenticate independently.
        const second = await post(url, tokenB, first.sessionId);
        if (second.status === 401) throw new Error("http 401");
        return { first: spy.seen[i], second: spy.seen[i + 1] };
      },
    };

    try {
      return await body(server_iface);
    } finally {
      await server.close();
      await new Promise<void>((res, rej) => node.close((e) => (e ? rej(e) : res())));
      await gateway.close();
    }
  },
};

runIngressAuthnConformance(factory);
