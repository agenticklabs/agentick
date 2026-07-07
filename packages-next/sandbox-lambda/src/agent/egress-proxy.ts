/**
 * In-VM egress proxy for the sandbox-agent (ADR 60).
 *
 * A forward HTTP proxy + CONNECT tunnel, bound inside the microVM, that
 * enforces domain-level {@link NetworkRule}s via the base's shared
 * `matchRequest` matcher (zero new matching code). The agent injects
 * `HTTP(S)_PROXY` into every exec's environment so child processes route
 * through it; each request is logged as a {@link ProxiedRequest} for the
 * `onProxiedRequest` audit hook.
 *
 * This is the ADR-60 answer to what docker's coarse `NetworkMode` cannot
 * express: Lambda's VPC egress connectors govern IP/port/CIDR (security
 * groups + NACLs) but have NO per-domain rules — so PER-DOMAIN enforcement
 * lives here, in-VM, exactly as the local provider does it. The coarse outer
 * switch (`network: true/false`) maps to the egress connector ARN at the
 * provider; this proxy handles the fine-grained rule list.
 *
 * HTTPS is handled at the CONNECT level: allowed connections get a
 * passthrough tunnel, denied ones are rejected. No TLS interception — HTTPS
 * content is opaque (ported faithfully from `sandbox-local`'s proxy; the base
 * exports the matcher, not the proxy, so a same-shape server lives here).
 *
 * @see docs/proposals/v2/blueprint/60-remote-microvm-sandbox.md
 */

import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";
import type { NetworkRule, ProxiedRequest } from "@agentick/sandbox-next";
import { matchRequest } from "@agentick/sandbox-next";

export interface EgressProxyConfig {
  /** Bind host. Default `"127.0.0.1"` (loopback-only within the VM). */
  readonly host?: string;
  /** Port to bind. 0 = auto-assign (default). */
  readonly port?: number;
  /** Called for each request (allowed or blocked) — the audit stream. */
  readonly onProxiedRequest?: (req: ProxiedRequest) => void;
  /** Max audit-log entries retained. Default: 10000. */
  readonly maxAuditEntries?: number;
}

export class AgentEgressProxy {
  readonly rules: readonly NetworkRule[];
  private readonly host: string;
  private readonly port: number;
  private readonly onProxiedRequest: (req: ProxiedRequest) => void;
  private readonly maxAuditEntries: number;
  private server?: Server;
  private auditLog: MutableProxiedRequest[] = [];
  private _proxyUrl?: string;

  constructor(rules: readonly NetworkRule[], config?: EgressProxyConfig) {
    this.rules = rules;
    this.host = config?.host ?? "127.0.0.1";
    this.port = config?.port ?? 0;
    this.onProxiedRequest = config?.onProxiedRequest ?? (() => {});
    this.maxAuditEntries = config?.maxAuditEntries ?? 10_000;
  }

  /** The proxy URL (e.g. "http://127.0.0.1:12345"). Set after `start()`. */
  get proxyUrl(): string {
    if (!this._proxyUrl) throw new Error("egress proxy not started");
    return this._proxyUrl;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handleHttp(req, res));
    this.server.on("connect", (req, socket, head) =>
      this.handleConnect(req, socket as Socket, head),
    );
    await new Promise<void>((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(this.port, this.host, () => {
        const addr = this.server!.address();
        if (typeof addr === "object" && addr) this._proxyUrl = `http://${this.host}:${addr.port}`;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  /** Snapshot of all proxied requests, for audit / observability. */
  getAuditLog(): readonly ProxiedRequest[] {
    return [...this.auditLog];
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    const hostHeader = req.headers.host ?? "unknown";
    const host = hostHeader.split(":")[0] ?? "unknown";
    const port = Number.parseInt(hostHeader.split(":")[1] ?? "80", 10);
    const method = req.method ?? "GET";

    const match = matchRequest({ host, port, method, url }, this.rules);
    const entry = this.log({ url, method, host, port, matchedRule: match.rule });

    if (match.action === "deny") {
      entry.blocked = true;
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Blocked by sandbox network rules");
      return;
    }

    const parsed = new URL(url);
    const proxyReq = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method,
        headers: { ...req.headers, host: parsed.host },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", () => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Proxy connection error");
    });
    req.pipe(proxyReq);
  }

  private handleConnect(req: IncomingMessage, socket: Socket, _head: Buffer): void {
    const [host, portStr] = (req.url ?? "").split(":");
    const port = Number.parseInt(portStr ?? "443", 10);
    const url = `https://${host}:${port}`;

    const match = matchRequest(
      { host: host ?? "unknown", port, method: "CONNECT", url },
      this.rules,
    );
    const entry = this.log({
      url,
      method: "CONNECT",
      host: host ?? "unknown",
      port,
      matchedRule: match.rule,
    });

    if (match.action === "deny") {
      entry.blocked = true;
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.end();
      return;
    }

    // Passthrough tunnel — no TLS interception.
    const remote = netConnect(port, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.pipe(remote);
      remote.pipe(socket);
    });
    remote.on("error", () => socket.destroy());
    socket.on("error", () => remote.destroy());
  }

  private log(
    partial: Pick<ProxiedRequest, "url" | "method" | "host" | "port" | "matchedRule">,
  ): MutableProxiedRequest {
    const entry: MutableProxiedRequest = {
      url: partial.url,
      method: partial.method,
      host: partial.host,
      port: partial.port,
      timestamp: Date.now(),
      blocked: false,
      ...(partial.matchedRule ? { matchedRule: partial.matchedRule } : {}),
    };
    this.auditLog.push(entry);
    if (this.auditLog.length > this.maxAuditEntries) {
      this.auditLog = this.auditLog.slice(-this.maxAuditEntries);
    }
    this.onProxiedRequest(entry);
    return entry;
  }
}

/** Working (mutable) audit entry — {@link ProxiedRequest} is readonly on the wire. */
type MutableProxiedRequest = {
  -readonly [K in keyof ProxiedRequest]: ProxiedRequest[K];
};
