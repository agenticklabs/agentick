/**
 * Localhost OAuth callback server — convenience utility for CLI and desktop apps.
 *
 * Spins up an ephemeral HTTP server on localhost to receive the OAuth redirect,
 * extract the authorization code, serve a customizable "success" page to the user,
 * and resolve a promise with the code.
 *
 * Usage with OAuthProvider:
 *
 * ```typescript
 * const callback = new OAuthCallbackServer({ port: 0 }); // 0 = random available port
 * const redirectUrl = await callback.start();
 *
 * const provider: OAuthProvider = {
 *   redirectUrl,
 *   redirectToAuthorization(url) { open(url.toString()); },
 *   waitForAuthorizationCode() { return callback.waitForCode(); },
 *   // ... persistence hooks
 * };
 * ```
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { Logger } from "@agentick/kernel";

const log = Logger.for("mcp:client:oauth-callback");

export interface OAuthCallbackServerOptions {
  /** Port to listen on. 0 = random available port. Default: 0. */
  port?: number;
  /** Host to bind to. Default: "127.0.0.1". */
  host?: string;
  /** Path to listen on for the callback. Default: "/callback". */
  path?: string;
  /** Timeout in ms to wait for the callback. Default: 300_000 (5 min). */
  timeout?: number;
  /**
   * Custom HTML to serve after successful authorization.
   * Receives the server name for personalization.
   * Default: a simple "Authorization complete" page.
   */
  successHtml?: string | ((serverName?: string) => string);
  /**
   * Custom HTML to serve on error (e.g., missing code param).
   * Default: a simple error page.
   */
  errorHtml?: string | ((error: string) => string);
}

const DEFAULT_SUCCESS_HTML = (serverName?: string) => `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Authorization Complete</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; display: flex;
    align-items: center; justify-content: center; min-height: 100vh;
    margin: 0; background: #f8fafc; color: #1e293b; }
  .card { background: #fff; border-radius: 12px; padding: 40px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
  h1 { font-size: 20px; margin-bottom: 8px; }
  p { color: #64748b; font-size: 14px; }
  .check { color: #22c55e; font-size: 48px; margin-bottom: 16px; }
</style></head>
<body>
  <div class="card">
    <div class="check">&#10003;</div>
    <h1>Authorization Complete</h1>
    <p>${serverName ? `Connected to <strong>${serverName}</strong>. ` : ""}You can close this window.</p>
  </div>
</body>
</html>`;

const DEFAULT_ERROR_HTML = (error: string) => `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Authorization Error</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; display: flex;
    align-items: center; justify-content: center; min-height: 100vh;
    margin: 0; background: #fef2f2; color: #1e293b; }
  .card { background: #fff; border-radius: 12px; padding: 40px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
  h1 { font-size: 20px; margin-bottom: 8px; color: #dc2626; }
  p { color: #64748b; font-size: 14px; }
</style></head>
<body>
  <div class="card">
    <h1>Authorization Failed</h1>
    <p>${error}</p>
  </div>
</body>
</html>`;

export class OAuthCallbackServer {
  private server?: Server;
  private resolve?: (code: string | undefined) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly opts: Required<
    Pick<OAuthCallbackServerOptions, "port" | "host" | "path" | "timeout">
  > &
    OAuthCallbackServerOptions;

  /** The server name, set by the caller for the success page. */
  serverName?: string;

  constructor(opts?: OAuthCallbackServerOptions) {
    this.opts = {
      port: 0,
      host: "127.0.0.1",
      path: "/callback",
      timeout: 300_000,
      ...opts,
    };
  }

  /**
   * Start the callback server. Returns the redirect URL to use in the OAuth provider.
   */
  async start(): Promise<URL> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.opts.port, this.opts.host, () => {
        const addr = this.server!.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Failed to start callback server"));
          return;
        }
        const url = new URL(`http://${this.opts.host}:${addr.port}${this.opts.path}`);
        log.info("OAuth callback server listening at %s", url.toString());
        resolve(url);
      });
      this.server.on("error", reject);
    });
  }

  /**
   * Wait for the authorization code. Resolves when the callback is received,
   * or undefined if the timeout elapses or the server is stopped.
   */
  waitForCode(): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.timer = setTimeout(() => {
        log.warn("OAuth callback timeout after %dms", this.opts.timeout);
        this.resolve?.(undefined);
        this.stop();
      }, this.opts.timeout);
    });
  }

  /** Stop the callback server and clean up. */
  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = undefined;
        log.debug("OAuth callback server stopped");
        resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${this.opts.host}`);

    if (url.pathname !== this.opts.path) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");

    if (error) {
      const message = errorDescription || error;
      log.error("OAuth callback error: %s", message);
      const html =
        typeof this.opts.errorHtml === "function"
          ? this.opts.errorHtml(message)
          : (this.opts.errorHtml ?? DEFAULT_ERROR_HTML(message));
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      this.resolve?.(undefined);
      this.stop();
      return;
    }

    if (!code) {
      const html =
        typeof this.opts.errorHtml === "function"
          ? this.opts.errorHtml("No authorization code received")
          : (this.opts.errorHtml ?? DEFAULT_ERROR_HTML("No authorization code received"));
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }

    log.info("OAuth callback received authorization code");
    const html =
      typeof this.opts.successHtml === "function"
        ? this.opts.successHtml(this.serverName)
        : (this.opts.successHtml ?? DEFAULT_SUCCESS_HTML(this.serverName));
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);

    this.resolve?.(code);
    // Give the browser a moment to render the page before closing
    setTimeout(() => this.stop(), 1000);
  }
}
