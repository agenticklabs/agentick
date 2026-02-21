import { describe, it, expect, afterEach } from "vitest";
import { NetworkProxyServer } from "../network/proxy.js";
import { request } from "node:http";
import type { NetworkRule, ProxiedRequest } from "@agentick/sandbox";

async function httpGet(url: string, proxy: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const proxyUrl = new URL(proxy);
    const req = request(
      {
        hostname: proxyUrl.hostname,
        port: proxyUrl.port,
        path: url,
        method: "GET",
        headers: { Host: new URL(url).host },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("NetworkProxyServer", () => {
  let server: NetworkProxyServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it("starts and stops", async () => {
    server = new NetworkProxyServer([]);
    await server.start();
    expect(server.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await server.stop();
    server = undefined;
  });

  it("blocks requests when rules deny", async () => {
    const rules: NetworkRule[] = [{ action: "deny", domain: "example.com" }];
    server = new NetworkProxyServer(rules);
    await server.start();

    const result = await httpGet("http://example.com/", server.proxyUrl);
    expect(result.status).toBe(403);
    expect(result.body).toContain("Blocked");
  });

  it("logs blocked requests to audit log", async () => {
    const blocked: ProxiedRequest[] = [];
    const rules: NetworkRule[] = [{ action: "deny", domain: "blocked.com" }];
    server = new NetworkProxyServer(rules, {
      onBlock: (req) => blocked.push(req),
    });
    await server.start();

    await httpGet("http://blocked.com/test", server.proxyUrl);

    const log = server.getAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0].blocked).toBe(true);
    expect(log[0].host).toBe("blocked.com");

    expect(blocked).toHaveLength(1);
  });

  it("returns empty audit log initially", async () => {
    server = new NetworkProxyServer([]);
    await server.start();
    expect(server.getAuditLog()).toEqual([]);
  });

  it("throws if proxyUrl accessed before start", () => {
    server = new NetworkProxyServer([]);
    expect(() => server!.proxyUrl).toThrow("not started");
  });
});
