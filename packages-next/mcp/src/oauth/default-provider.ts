/**
 * `DefaultOAuthProvider` — zero-config OAuth provider for HTTP MCP
 * transports.
 *
 * Uses in-memory storage for tokens, client info, PKCE, and discovery.
 * When authorization is needed, calls `onAuthorizationNeeded` (or
 * logs the URL via `console.warn` if no callback is provided).
 *
 * For production, implement {@link OAuthProvider} directly with
 * persistent storage and environment-appropriate redirect handling.
 *
 * **Pending-auth gate.** `redirectToAuthorization` creates a pending
 * promise; `waitForAuthorizationCode` returns it; an external callback
 * (typically the localhost {@link OAuthCallbackServer} or a URL-mode
 * elicitation respond) calls `resolveAuthorizationCode(code)` to
 * complete the flow. `cancelAuthorization()` aborts with `undefined`.
 *
 * **v1 origin:** ported from `packages/mcp/src/client/oauth.ts`. Logger
 * replaced with `console.warn` — substrate logging is bus-based and
 * this utility runs outside any substrate context (bootstrap path).
 */

import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthProvider,
  OAuthTokens,
} from "./provider.js";

export interface DefaultOAuthProviderOptions {
  /** Server name (used for logging + token namespace). */
  readonly serverName: string;
  /** Server URL (used for default client metadata). */
  readonly serverUrl: string;
  /** Custom client metadata. Defaults to a public native client. */
  readonly clientMetadata?: OAuthClientMetadata;
  /** Custom redirect URL. Defaults to `http://127.0.0.1:0/callback`. */
  readonly redirectUrl?: string | URL;
  /**
   * Called when the user needs to authorize in a browser. When
   * omitted, the URL is logged via `console.warn` and the caller is
   * expected to handle it externally.
   */
  readonly onAuthorizationNeeded?: (url: URL) => void | Promise<void>;
}

export class DefaultOAuthProvider implements OAuthProvider {
  readonly clientMetadata: OAuthClientMetadata;
  readonly redirectUrl: string | URL | undefined;

  private currentTokens: OAuthTokens | undefined;
  private currentClientInfo: OAuthClientInformationMixed | undefined;
  private readonly opts: DefaultOAuthProviderOptions;

  private pendingAuthPromise?: Promise<string | undefined>;
  private pendingAuthResolve?: (code: string | undefined) => void;

  constructor(opts: DefaultOAuthProviderOptions) {
    this.opts = opts;
    this.redirectUrl = opts.redirectUrl ?? "http://127.0.0.1:0/callback";
    this.clientMetadata = opts.clientMetadata ?? {
      client_name: opts.serverName,
      redirect_uris: [String(this.redirectUrl)],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  loadTokens(): OAuthTokens | undefined {
    return this.currentTokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.currentTokens = tokens;
  }

  loadClientInfo(): OAuthClientInformationMixed | undefined {
    return this.currentClientInfo;
  }

  saveClientInfo(info: OAuthClientInformationMixed): void {
    this.currentClientInfo = info;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    // Reset any in-flight pending promise; the connect loop is calling
    // us to start a fresh auth flow.
    this.pendingAuthResolve = undefined;
    this.pendingAuthPromise = new Promise<string | undefined>((resolve) => {
      this.pendingAuthResolve = resolve;
    });

    if (this.opts.onAuthorizationNeeded) {
      return this.opts.onAuthorizationNeeded(url);
    }
    // Bootstrap fallback — no substrate, no elicitation harness.
    // Adopters that want UX wire onAuthorizationNeeded or the
    // localhost OAuthCallbackServer.
    console.warn(
      `[agentick mcp] Authorization required for "${this.opts.serverName}". Open this URL: ${url.toString()}`,
    );
  }

  async waitForAuthorizationCode(): Promise<string | undefined> {
    if (this.pendingAuthPromise) return this.pendingAuthPromise;
    // No pending auth — shouldn't happen given the call order in the
    // SDK, but defensive: abort with undefined so the connect loop
    // doesn't hang.
    return undefined;
  }

  /**
   * Resolve the pending auth flow with the authorization code received
   * from the callback. Typically invoked from
   * {@link OAuthCallbackServer}'s success handler or a URL-mode
   * elicitation `respond({outcome:"accepted", value:{code}})`.
   */
  resolveAuthorizationCode(code: string): void {
    this.pendingAuthResolve?.(code);
  }

  /**
   * Cancel the pending auth flow (user dismissed the browser, timeout
   * elapsed, etc.). Resolves with `undefined` so the SDK aborts the
   * connect attempt.
   */
  cancelAuthorization(): void {
    this.pendingAuthResolve?.(undefined);
  }
}
