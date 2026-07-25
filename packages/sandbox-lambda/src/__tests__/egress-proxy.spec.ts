/**
 * The in-VM egress proxy enforces domain-level {@link NetworkRule}s via the
 * base's shared `matchRequest` matcher (ADR 60) — the mechanism that lets the
 * Lambda provider support per-domain rules where docker's coarse `NetworkMode`
 * cannot. This drives a REAL proxy against a REAL origin over loopback: an
 * allowed host round-trips 200; a host with no matching rule is denied 403
 * (default-deny). No fakes.
 */

import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NetworkRule } from "@agentick/sandbox";
import { AgentEgressProxy } from "../agent/egress-proxy.js";

describe("AgentEgressProxy — domain-level egress enforcement", () => {
  let origin: Server;
  let originPort: number;

  beforeEach(async () => {
    origin = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("origin-ok");
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve()));
    originPort = (origin.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  });

  it("forwards an allowed host and blocks an unlisted host (default-deny)", async () => {
    const rules: NetworkRule[] = [{ action: "allow", domain: "127.0.0.1" }];
    const proxy = new AgentEgressProxy(rules, { host: "127.0.0.1" });
    await proxy.start();
    try {
      // Allowed — 127.0.0.1 matches the rule.
      const allowed = await through(proxy.proxyUrl, `http://127.0.0.1:${originPort}/`, "127.0.0.1");
      expect(allowed.status).toBe(200);
      expect(allowed.body).toBe("origin-ok");

      // Denied — a host with no matching rule falls through to default-deny.
      const denied = await through(proxy.proxyUrl, "http://blocked.invalid/", "blocked.invalid");
      expect(denied.status).toBe(403);

      const audit = proxy.getAuditLog();
      expect(audit.some((r) => r.host === "127.0.0.1" && !r.blocked)).toBe(true);
      expect(audit.some((r) => r.host === "blocked.invalid" && r.blocked)).toBe(true);
    } finally {
      await proxy.stop();
    }
  });
});

/** Issue an HTTP request THROUGH a forward proxy (absolute-URI request line). */
function through(
  proxyUrl: string,
  targetUrl: string,
  hostHeader: string,
): Promise<{ status: number; body: string }> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        method: "GET",
        path: targetUrl, // absolute URI → the proxy routes it
        headers: { Host: hostHeader },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
