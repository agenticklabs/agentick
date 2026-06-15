/**
 * Localhost OAuth callback server — convenience utility for CLI and
 * desktop apps.
 *
 * Spins up an ephemeral HTTP server on localhost to receive the OAuth
 * redirect, extract the authorization code, serve a customizable
 * "success" page, and resolve a promise with the code. Pairs
 * idiomatically with {@link DefaultOAuthProvider}:
 *
 * ```ts
 * const callback = new OAuthCallbackServer({ port: 0 });
 * const redirectUrl = await callback.start();
 *
 * const provider = new DefaultOAuthProvider({
 *   serverName: "linear",
 *   serverUrl: "https://mcp.linear.app",
 *   redirectUrl,
 *   onAuthorizationNeeded: (url) => open(url.toString()),
 * });
 *
 * // Wire the callback's resolved code back into the provider:
 * const code = await callback.waitForCode();
 * if (code) provider.resolveAuthorizationCode(code);
 * else provider.cancelAuthorization();
 * ```
 *
 * **v1 origin:** ported from `packages/mcp/src/client/oauth-callback-server.ts`.
 * Logger replaced with `console`; otherwise unchanged.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";

export interface OAuthCallbackServerOptions {
  /** Port to listen on. `0` = random available port. Default: 0. */
  readonly port?: number;
  /** Host to bind to. Default: `"127.0.0.1"`. */
  readonly host?: string;
  /** Path to listen on for the callback. Default: `"/callback"`. */
  readonly path?: string;
  /** Timeout (ms) for waiting on the callback. Default: 300_000 (5 min). */
  readonly timeout?: number;
  /**
   * HTML served after successful authorization. Receives the server
   * name for personalization. Default: a minimal success page.
   */
  readonly successHtml?: string | ((serverName?: string) => string);
  /**
   * HTML served on error (missing code, server-returned error param,
   * etc.). Default: a minimal error page.
   */
  readonly errorHtml?: string | ((error: string) => string);
}

const DEFAULT_SUCCESS_HTML = (serverName?: string): string => `<!DOCTYPE html>
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

const DEFAULT_ERROR_HTML = (error: string): string => `<!DOCTYPE html>
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
  private resolveCode?: (code: string | undefined) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly opts: Required<
    Pick<OAuthCallbackServerOptions, "port" | "host" | "path" | "timeout">
  > &
    OAuthCallbackServerOptions;

  /**
   * Server name surfaced on the success page. Set by the caller for
   * personalization; safe to leave undefined.
   */
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
   * Start the callback server. Returns the redirect URL the OAuth
   * provider should use. The URL reflects the actual bound port (when
   * `port: 0`, the OS allocates a free one).
   */
  start(): Promise<URL> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.opts.port, this.opts.host, () => {
        const addr = this.server!.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("OAuthCallbackServer: failed to bind"));
          return;
        }
        const url = new URL(`http://${this.opts.host}:${addr.port}${this.opts.path}`);
        resolve(url);
      });
      this.server.on("error", reject);
    });
  }

  /**
   * Wait for the authorization code. Resolves with the code, or
   * `undefined` if the timeout elapses, the user is redirected to an
   * error page, or the server is stopped before a callback arrives.
   */
  waitForCode(): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.resolveCode = resolve;
      this.timer = setTimeout(() => {
        console.warn(`[agentick mcp] OAuth callback timeout after ${this.opts.timeout}ms`);
        this.resolveCode?.(undefined);
        void this.stop();
      }, this.opts.timeout);
    });
  }

  /** Stop the callback server and clean up the timeout. Idempotent. */
  stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = undefined;
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
      console.error(`[agentick mcp] OAuth callback error: ${message}`);
      const html =
        typeof this.opts.errorHtml === "function"
          ? this.opts.errorHtml(message)
          : (this.opts.errorHtml ?? DEFAULT_ERROR_HTML(message));
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      this.resolveCode?.(undefined);
      void this.stop();
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

    const html =
      typeof this.opts.successHtml === "function"
        ? this.opts.successHtml(this.serverName)
        : (this.opts.successHtml ?? DEFAULT_SUCCESS_HTML(this.serverName));
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);

    this.resolveCode?.(code);
    // Give the browser a beat to paint the success page before we
    // close the socket out from under it.
    setTimeout(() => void this.stop(), 1000);
  }
}
