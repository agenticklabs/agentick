/**
 * Egress proxy — the local-only network enforcement path (ADR 59), not
 * covered by the provider conformance suite (which creates no rules).
 *
 * Verifies the 127.0.0.1 HTTP proxy allows/blocks per the shared matcher
 * and records an audit trail, and that the provider injects `HTTP(S)_PROXY`
 * into the spawned env when `allow.network` is a rule list.
 */

import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { NetworkRule } from "@agentick/sandbox";
import { NetworkProxyServer } from "../proxy.js";
import { localProvider } from "../provider.js";

/** Make a request through the proxy (absolute-form request line). */
function throughProxy(
  proxyUrl: string,
  targetUrl: string,
): Promise<{ status: number; body: string }> {
  const proxy = new URL(proxyUrl);
  const target = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: proxy.hostname,
        port: proxy.port,
        path: targetUrl,
        method: "GET",
        headers: { host: target.host },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("NetworkProxyServer", () => {
  const servers: Server[] = [];
  const proxies: NetworkProxyServer[] = [];

  afterEach(async () => {
    await Promise.all(proxies.map((p) => p.stop()));
    proxies.length = 0;
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers.length = 0;
  });

  async function startTarget(): Promise<number> {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("target-ok");
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return (server.address() as { port: number }).port;
  }

  async function startProxy(rules: NetworkRule[]): Promise<NetworkProxyServer> {
    const proxy = new NetworkProxyServer(rules);
    proxies.push(proxy);
    await proxy.start();
    return proxy;
  }

  it("forwards allowed requests and records the audit trail", async () => {
    const port = await startTarget();
    const proxy = await startProxy([{ action: "allow", domain: "127.0.0.1" }]);
    const res = await throughProxy(proxy.proxyUrl, `http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("target-ok");
    const audit = proxy.getAuditLog();
    expect(audit.at(-1)?.blocked).toBe(false);
  });

  it("blocks denied requests with 403 and marks them blocked", async () => {
    const port = await startTarget();
    const proxy = await startProxy([{ action: "deny", domain: "127.0.0.1" }]);
    const res = await throughProxy(proxy.proxyUrl, `http://127.0.0.1:${port}/`);
    expect(res.status).toBe(403);
    expect(proxy.getAuditLog().at(-1)?.blocked).toBe(true);
  });

  it("defaults to deny when no rule matches", async () => {
    const port = await startTarget();
    const proxy = await startProxy([{ action: "allow", domain: "example.com" }]);
    const res = await throughProxy(proxy.proxyUrl, `http://127.0.0.1:${port}/`);
    expect(res.status).toBe(403);
  });
});

describe("localProvider — proxy env injection", () => {
  it("injects HTTP(S)_PROXY when allow.network is a rule list", async () => {
    const provider = localProvider();
    const sb = await provider.create({
      workspace: true,
      allow: { network: [{ action: "allow", domain: "127.0.0.1" }] },
    });
    try {
      const http = await sb.exec("echo $HTTP_PROXY");
      const https = await sb.exec("echo $HTTPS_PROXY");
      expect(http.stdout.trim()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(https.stdout.trim()).toBe(http.stdout.trim());
    } finally {
      await sb.destroy();
    }
  });

  it("starts no proxy (no HTTP_PROXY) when network is absent", async () => {
    const provider = localProvider();
    const sb = await provider.create({ workspace: true });
    try {
      const http = await sb.exec("echo $HTTP_PROXY");
      expect(http.stdout.trim()).toBe("");
    } finally {
      await sb.destroy();
    }
  });
});
