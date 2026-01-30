/**
 * DevTools Server
 *
 * HTTP server that:
 * 1. Subscribes to devToolsEmitter for events
 * 2. Broadcasts events to connected clients via SSE
 * 3. Provides HTTP API for querying history
 * 4. Serves the DevTools UI
 */
import { createServer, type Server } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { devToolsEmitter, type DevToolsEvent } from "@tentickle/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DevToolsServerConfig {
  /** Port to listen on (default: 3001) */
  port?: number;
  /** Host to bind to (default: '127.0.0.1') */
  host?: string;
  /** Enable debug logging */
  debug?: boolean;
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatInterval?: number;
}

interface SSEClient {
  res: ServerResponse;
  heartbeatInterval: NodeJS.Timeout;
}

interface ResolvedConfig {
  port: number;
  host: string;
  debug: boolean;
  heartbeatInterval: number;
}

export class DevToolsServer {
  private server: Server | null = null;
  private clients = new Set<SSEClient>();
  private config: ResolvedConfig;
  private eventHistory: DevToolsEvent[] = [];
  private maxHistorySize = 1000;
  private unsubscribe: (() => void) | null = null;

  constructor(config: DevToolsServerConfig = {}) {
    this.config = {
      port: config.port ?? 3001,
      host: config.host ?? "127.0.0.1",
      debug: config.debug ?? false,
      heartbeatInterval: config.heartbeatInterval ?? 30000,
    };
  }

  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log("[DevTools]", ...args);
    }
  }

  /**
   * Start the devtools server
   */
  start(): void {
    if (this.server) {
      this.log("Server already running");
      return;
    }

    // Subscribe to devToolsEmitter
    this.unsubscribe = devToolsEmitter.subscribe((event) => {
      this.emit(event);
    });

    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        console.warn(`[DevTools] Port ${this.config.port} is already in use; DevTools disabled.`);
      } else {
        console.error("[DevTools] Server error:", error);
      }
      this.stop();
    });

    this.server.listen(this.config.port, this.config.host, () => {
      console.log(`[DevTools] Server listening on http://${this.config.host}:${this.config.port}`);
    });
  }

  /**
   * Stop the server
   */
  stop(): void {
    // Unsubscribe from events
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    // Close SSE connections
    for (const client of this.clients) {
      clearInterval(client.heartbeatInterval);
      client.res.end();
    }
    this.clients.clear();

    // Close server
    if (this.server) {
      const server = this.server;
      this.server = null;
      try {
        server.close();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ERR_SERVER_NOT_RUNNING") {
          this.log("Failed to close server", error);
        }
      }
    }
    this.log("Server stopped");
  }

  /**
   * Emit event to all connected clients
   */
  private emit(event: DevToolsEvent): void {
    // Store in history
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }

    // Broadcast to SSE clients
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.res.write(data);
      } catch {
        // Client disconnected
      }
    }

    this.log(`Emitted ${event.type} to ${this.clients.size} clients`);
  }

  /**
   * Get the server URL
   */
  getUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || "/", `http://${this.config.host}:${this.config.port}`);

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route handling
    if (url.pathname === "/events") {
      this.handleSSE(req, res);
    } else if (url.pathname === "/api/history") {
      this.handleHistory(res);
    } else if (url.pathname === "/api/clear") {
      this.handleClear(res);
    } else {
      this.handleStatic(url.pathname, res);
    }
  }

  private handleSSE(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send connection event
    res.write(`data: ${JSON.stringify({ type: "connected", timestamp: Date.now() })}\n\n`);

    // Setup heartbeat
    const heartbeatInterval = setInterval(() => {
      try {
        res.write(":heartbeat\n\n");
      } catch {
        // Connection closed
      }
    }, this.config.heartbeatInterval);

    const client: SSEClient = { res, heartbeatInterval };
    this.clients.add(client);

    this.log(`Client connected, total: ${this.clients.size}`);

    res.on("close", () => {
      clearInterval(heartbeatInterval);
      this.clients.delete(client);
      this.log(`Client disconnected, total: ${this.clients.size}`);
    });
  }

  private handleHistory(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.eventHistory));
  }

  private handleClear(res: ServerResponse): void {
    this.eventHistory = [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cleared: true }));
  }

  private handleStatic(pathname: string, res: ServerResponse): void {
    // Serve UI from ui/dist
    const uiDir = join(__dirname, "../../ui/dist");

    let filePath = pathname === "/" ? "/index.html" : pathname;
    filePath = join(uiDir, filePath);

    // Security: prevent directory traversal
    if (!filePath.startsWith(uiDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (!existsSync(filePath)) {
      // SPA fallback
      filePath = join(uiDir, "index.html");
    }

    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found - run pnpm build:ui first");
      return;
    }

    const ext = filePath.split(".").pop() || "";
    const contentTypes: Record<string, string> = {
      html: "text/html",
      js: "application/javascript",
      css: "text/css",
      json: "application/json",
      png: "image/png",
      svg: "image/svg+xml",
    };

    res.writeHead(200, { "Content-Type": contentTypes[ext] || "text/plain" });
    res.end(readFileSync(filePath));
  }
}
