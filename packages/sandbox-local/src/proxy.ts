/**
 * Local egress proxy — a 127.0.0.1 HTTP proxy + CONNECT tunnel that
 * enforces {@link NetworkRule}s via the `matchRequest` matcher re-exported
 * from the base package `@agentick/sandbox`.
 *
 * HTTPS is handled at the CONNECT level: allowed connections get a
 * passthrough tunnel, denied ones are rejected. No MITM / TLS termination
 * — HTTPS content is opaque. This covers domain-level allow/deny without
 * CA generation. The provider injects `HTTP(S)_PROXY` into the spawned
 * env so child processes route through it (ADR 59).
 *
 * Ported from v1 `@agentick/sandbox-local/network/proxy.ts`.
 */

import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { NetworkRule, ProxiedRequest } from "@agentick/sandbox";
import { matchRequest } from "@agentick/sandbox";

export interface ProxyServerConfig {
  /** Port to bind. 0 = auto-assign (default). */
  readonly port?: number;
  /** Called for each request (before forwarding / blocking). */
  readonly onRequest?: (req: ProxiedRequest) => void;
  /** Called when a request is blocked. */
  readonly onBlock?: (req: ProxiedRequest) => void;
  /** Max audit-log entries retained. Default: 10000. */
  readonly maxAuditEntries?: number;
}

export class NetworkProxyServer {
  readonly rules: readonly NetworkRule[];
  private readonly port: number;
  private readonly onRequest: (req: ProxiedRequest) => void;
  private readonly onBlock: (req: ProxiedRequest) => void;
  private readonly maxAuditEntries: number;
  private server?: Server;
  private auditLog: MutableProxiedRequest[] = [];
  private _proxyUrl?: string;

  constructor(rules: readonly NetworkRule[], config?: ProxyServerConfig) {
    this.rules = rules;
    this.port = config?.port ?? 0;
    this.onRequest = config?.onRequest ?? (() => {});
    this.onBlock = config?.onBlock ?? (() => {});
    this.maxAuditEntries = config?.maxAuditEntries ?? 10_000;
  }

  /** The proxy URL (e.g. "http://127.0.0.1:12345"). Set after `start()`. */
  get proxyUrl(): string {
    if (!this._proxyUrl) throw new Error("proxy not started");
    return this._proxyUrl;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handleHttpRequest(req, res));
    this.server.on("connect", (req, socket, head) =>
      this.handleConnect(req, socket as Socket, head),
    );
    await new Promise<void>((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(this.port, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (typeof addr === "object" && addr) {
          this._proxyUrl = `http://127.0.0.1:${addr.port}`;
        }
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

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    const hostHeader = req.headers.host ?? "unknown";
    const host = hostHeader.split(":")[0];
    const port = parseInt(hostHeader.split(":")[1] ?? "80", 10);
    const method = req.method ?? "GET";

    const match = matchRequest({ host, port, method, url }, this.rules);
    const entry = this.log({ url, method, host, port, matchedRule: match.rule });

    if (match.action === "deny") {
      entry.blocked = true;
      this.onBlock(entry);
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Blocked by sandbox network rules");
      return;
    }

    this.onRequest(entry);

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
    const port = parseInt(portStr ?? "443", 10);
    const url = `https://${host}:${port}`;

    const match = matchRequest({ host, port, method: "CONNECT", url }, this.rules);
    const entry = this.log({ url, method: "CONNECT", host, port, matchedRule: match.rule });

    if (match.action === "deny") {
      entry.blocked = true;
      this.onBlock(entry);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.end();
      return;
    }

    this.onRequest(entry);

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
    return entry;
  }
}

/** Working (mutable) audit entry — {@link ProxiedRequest} is readonly on the wire. */
type MutableProxiedRequest = {
  -readonly [K in keyof ProxiedRequest]: ProxiedRequest[K];
};
