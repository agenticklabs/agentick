/**
 * HTTP/HTTPS Proxy Server
 *
 * Binds an HTTP proxy server that intercepts HTTP traffic and applies
 * network rules. HTTPS connections are handled at the CONNECT level:
 * allowed connections get a passthrough tunnel, denied ones are rejected.
 *
 * No MITM/TLS termination — HTTPS content is opaque. This covers the
 * primary use case (domain-level allow/deny) without the complexity of
 * CA generation and TLS interception.
 */

import { createServer, request as httpRequest } from "node:http";
import * as net from "node:net";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { NetworkRule, ProxiedRequest } from "@agentick/sandbox";
import { matchRequest } from "./rules";

export interface ProxyServerConfig {
  /** Port to bind. 0 = auto-assign. */
  port?: number;

  /** Called for each request (before forwarding/blocking). */
  onRequest?: (req: ProxiedRequest) => void;

  /** Called when a request is blocked. */
  onBlock?: (req: ProxiedRequest) => void;

  /** Maximum audit log entries. Default: 10000. */
  maxAuditEntries?: number;
}

export class NetworkProxyServer {
  readonly rules: NetworkRule[];
  private readonly config: Required<ProxyServerConfig>;
  private server?: Server;
  private auditLog: ProxiedRequest[] = [];
  private _proxyUrl?: string;
  private _port?: number;

  constructor(rules: NetworkRule[], config?: ProxyServerConfig) {
    this.rules = rules;
    this.config = {
      port: config?.port ?? 0,
      onRequest: config?.onRequest ?? (() => {}),
      onBlock: config?.onBlock ?? (() => {}),
      maxAuditEntries: config?.maxAuditEntries ?? 10000,
    };
  }

  /** The proxy URL (e.g. "http://127.0.0.1:12345"). Available after start(). */
  get proxyUrl(): string {
    if (!this._proxyUrl) throw new Error("Proxy not started");
    return this._proxyUrl;
  }

  /** Start the proxy server. */
  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handleHttpRequest(req, res));
    this.server.on("connect", (req, socket, head) =>
      this.handleConnect(req, socket as Socket, head),
    );

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (typeof addr === "object" && addr) {
          this._port = addr.port;
          this._proxyUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  /** Stop the proxy server. */
  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /** Get the audit log of all proxied requests. */
  getAuditLog(): ProxiedRequest[] {
    return [...this.auditLog];
  }

  /** Handle an HTTP request (non-CONNECT). */
  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    const host = req.headers.host ?? "unknown";
    const port = parseInt(host.split(":")[1] ?? "80", 10);

    const entry = this.logRequest(url, req.method ?? "GET", host.split(":")[0], port);

    const match = matchRequest(
      { host: host.split(":")[0], port, method: req.method ?? "GET", url },
      this.rules,
    );

    entry.matchedRule = match.rule;

    if (match.action === "deny") {
      entry.blocked = true;
      this.config.onBlock(entry);
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Blocked by sandbox network rules");
      return;
    }

    this.config.onRequest(entry);

    // Forward the request
    const parsedUrl = new URL(url);
    const proxyReq = httpRequest(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: parsedUrl.pathname + parsedUrl.search,
        method: req.method,
        headers: { ...req.headers, host: parsedUrl.host },
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

  /** Handle a CONNECT request (HTTPS tunnel). */
  private handleConnect(req: IncomingMessage, socket: Socket, _head: Buffer): void {
    const [host, portStr] = (req.url ?? "").split(":");
    const port = parseInt(portStr ?? "443", 10);

    const entry = this.logRequest(`https://${host}:${port}`, "CONNECT", host, port);

    const match = matchRequest(
      { host, port, method: "CONNECT", url: `https://${host}:${port}` },
      this.rules,
    );

    entry.matchedRule = match.rule;

    if (match.action === "deny") {
      entry.blocked = true;
      this.config.onBlock(entry);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.end();
      return;
    }

    this.config.onRequest(entry);

    // Passthrough: direct tunnel to target (no TLS interception)
    const { connect } = net;
    const remote = connect(port, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.pipe(remote);
      remote.pipe(socket);
    });

    remote.on("error", () => socket.destroy());
    socket.on("error", () => remote.destroy());
  }

  /** Log a request and trim the audit log if needed. */
  private logRequest(url: string, method: string, host: string, port: number): ProxiedRequest {
    const entry: ProxiedRequest = {
      url,
      method,
      host,
      port,
      timestamp: Date.now(),
      blocked: false,
    };

    this.auditLog.push(entry);
    if (this.auditLog.length > this.config.maxAuditEntries) {
      this.auditLog = this.auditLog.slice(-this.config.maxAuditEntries);
    }

    return entry;
  }
}
