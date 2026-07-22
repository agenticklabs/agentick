/**
 * Security defaults over the REAL Streamable HTTP server (STATUS A2 §4c).
 *
 * Wire-observable proof that the defaults ship enforced: the CSRF bootstrap
 * handshake, the missing-token deny, cross-site Origin rejection, non-permissive
 * CORS (never `*`), Host allow-list rejection, and the loopback bind default —
 * plus the overrides that widen them. Uses raw `node:http` so the test controls
 * `Host` / `Origin` / `Sec-Fetch-Site` / the CSRF header directly (the exhaustive
 * allow/deny matrix lives in `@agentick/transport-next`'s policy unit spec).
 */

import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { createGateway } from "@agentick/gateway-next";
import { createClient } from "@agentick/client-core-next";
import { afterEach, describe, expect, it } from "vitest";

import { http } from "../client/index.js";
import { httpServer, httpServerTransport, type HttpServerOptions } from "../server/index.js";

type ServerOpts = Omit<HttpServerOptions, "httpServer" | "gateway">;

interface Started {
  readonly port: number;
  close(): Promise<void>;
}

const started: Started[] = [];

afterEach(async () => {
  while (started.length) await started.pop()!.close();
});

async function start(opts: ServerOpts = {}): Promise<Started> {
  const gateway = await createGateway();
  await gateway.listen();
  const node = createServer();
  const server = httpServer({ httpServer: node, gateway, ...opts });
  await new Promise<void>((r) => node.listen(0, "127.0.0.1", () => r()));
  const port = (node.address() as AddressInfo).port;
  const handle: Started = {
    port,
    async close() {
      await server.close();
      await new Promise<void>((res, rej) => node.close((e) => (e ? rej(e) : res())));
      await gateway.close();
    },
  };
  started.push(handle);
  return handle;
}

interface Res {
  readonly status: number;
  readonly body: string;
  readonly headers: IncomingHttpHeaders;
}

function send(
  port: number,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Res> {
  return new Promise<Res>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/", method, headers }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: buf, headers: res.headers }),
      );
    });
    req.on("error", reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

/** Open the GET stream just long enough to read the issued CSRF token, then abort. */
function bootstrapToken(port: number): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        method: "GET",
        headers: { Accept: "text/event-stream" },
      },
      (res) => {
        const t = res.headers["x-agentick-csrf"];
        res.destroy();
        req.destroy();
        resolve(Array.isArray(t) ? t[0] : t);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const PING = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });

describe("CSRF bootstrap handshake", () => {
  it("issues a token on the GET stream; a POST carrying it succeeds", async () => {
    const { port } = await start();
    const token = await bootstrapToken(port);
    expect(typeof token).toBe("string");
    const res = await send(
      port,
      "POST",
      { "Content-Type": "application/json", "x-agentick-csrf": token! },
      PING,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("DENY a mutation with no CSRF token — 403, never dispatched", async () => {
    const { port } = await start();
    const res = await send(port, "POST", { "Content-Type": "application/json" }, PING);
    expect(res.status).toBe(403);
    expect(res.body).not.toContain("result");
  });

  it("DENY a mutation with a WRONG CSRF token — 403", async () => {
    const { port } = await start();
    const res = await send(
      port,
      "POST",
      { "Content-Type": "application/json", "x-agentick-csrf": "forged" },
      PING,
    );
    expect(res.status).toBe(403);
  });

  it("OVERRIDE csrf:false admits a raw POST (non-browser deploy)", async () => {
    const { port } = await start({ csrf: false });
    const res = await send(port, "POST", { "Content-Type": "application/json" }, PING);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ result: {} });
  });
});

describe("cross-site rejection", () => {
  it("DENY a foreign Origin + Sec-Fetch-Site: cross-site — 403 before dispatch", async () => {
    const { port } = await start();
    const token = await bootstrapToken(port);
    const res = await send(
      port,
      "POST",
      {
        "Content-Type": "application/json",
        "x-agentick-csrf": token!,
        Origin: "https://evil.example.com",
        "Sec-Fetch-Site": "cross-site",
      },
      PING,
    );
    expect(res.status).toBe(403);
    expect(res.body).not.toContain("result");
  });

  it("ALLOW same-origin (Origin authority === Host)", async () => {
    const { port } = await start();
    const token = await bootstrapToken(port);
    const res = await send(
      port,
      "POST",
      {
        "Content-Type": "application/json",
        "x-agentick-csrf": token!,
        Origin: `http://127.0.0.1:${port}`,
      },
      PING,
    );
    expect(res.status).toBe(200);
  });
});

describe("Host allow-list", () => {
  it("DENY a spoofed non-loopback Host (DNS-rebinding) — 403", async () => {
    const { port } = await start();
    const res = await send(port, "GET", { Accept: "text/event-stream", Host: "evil.example.com" });
    expect(res.status).toBe(403);
  });

  it("OVERRIDE allowedHosts admits the configured hostname", async () => {
    const { port } = await start({ allowedHosts: ["app.internal"] });
    // A GET is a read (no CSRF); it must pass the host gate under the override.
    const res = await bootstrapToken2(port, "app.internal");
    expect(res).toBe(200);
  });
});

/** Variant of bootstrap that asserts the GET status under a spoofed Host. */
function bootstrapToken2(port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        method: "GET",
        headers: { Accept: "text/event-stream", Host: host },
      },
      (res) => {
        res.destroy();
        req.destroy();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("CORS is never permissive", () => {
  it("echoes an allowlisted Origin exactly on preflight — never `*`", async () => {
    const { port } = await start({ allowedOrigins: ["https://app.example.com"] });
    const res = await send(port, "OPTIONS", { Origin: "https://app.example.com" });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("DENY a preflight from a disallowed Origin — 403, no CORS headers", async () => {
    const { port } = await start({ allowedOrigins: ["https://app.example.com"] });
    const res = await send(port, "OPTIONS", { Origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("loopback bind default + end-to-end with the framework client", () => {
  it("port transport binds loopback and round-trips (CSRF handshake is transparent)", async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));

    // No `host` given → the transport binds DEFAULT_BIND_HOST (127.0.0.1).
    const gateway = await createGateway({ transports: [httpServerTransport({ port })] });
    await gateway.listen();

    const client = await createClient({ transport: http({ url: `http://127.0.0.1:${port}` }) });
    await client.connect();
    expect(client.state).toBe("open");
    // The real client fetched the token on the GET handshake and echoed it here.
    expect(await client.request("ping", {})).toEqual({});
    await client.close();
    await gateway.close();
  });
});
