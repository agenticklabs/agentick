/**
 * OAuth support for the MCP client.
 *
 * Provides a pluggable `OAuthProvider` interface that controls how tokens are
 * stored, how the user authorizes, and how client registration is persisted.
 * The MCP SDK handles discovery, PKCE, code exchange, and refresh — we just
 * bridge our interface to it.
 *
 * Default behavior: any HTTP transport (SSE, streamable-http) that gets a 401
 * automatically triggers the OAuth flow without explicit config.
 */

import type {
  OAuthClientProvider as SDKOAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { Logger } from "@agentick/kernel";

const log = Logger.for("mcp:client:oauth");

// ============================================================================
// OAuthProvider — the agentick abstraction
// ============================================================================

/**
 * OAuth provider hooks for MCP client authentication.
 *
 * Implementations control how tokens are stored, how the user is directed
 * to authorize, and how client registration is persisted. The MCP client
 * handles discovery, PKCE, token exchange, and refresh automatically via
 * the SDK transports.
 *
 * For most use cases, use `DefaultOAuthProvider` which provides in-memory
 * storage and emits events for authorization. For production, implement
 * this interface with persistent storage (file, DB, etc.).
 */
export interface OAuthProvider {
  // ── Identity ──────────────────────────────────────────────────────────

  /** OAuth client metadata for dynamic registration (RFC 7591). */
  clientMetadata: OAuthClientMetadata;

  /** Redirect URI for the authorization callback. undefined for non-interactive flows. */
  redirectUrl: string | URL | undefined;

  // ── Persistence (required) ────────────────────────────────────────────

  /** Load stored tokens for this server, or undefined if none. */
  loadTokens(): OAuthTokens | undefined | Promise<OAuthTokens | undefined>;

  /** Save tokens after successful auth or refresh. */
  saveTokens(tokens: OAuthTokens): void | Promise<void>;

  /** Load stored client registration info, or undefined if not registered. */
  loadClientInfo():
    | OAuthClientInformationMixed
    | undefined
    | Promise<OAuthClientInformationMixed | undefined>;

  /** Save client registration info after dynamic registration. */
  saveClientInfo(info: OAuthClientInformationMixed): void | Promise<void>;

  // ── Authorization UX (required) ───────────────────────────────────────

  /**
   * Direct the user to the authorization URL to begin the OAuth flow.
   *
   * Environments implement this differently:
   * - CLI: open system browser, start local HTTP callback server
   * - Server/gateway: store pending auth state, return URL to caller
   * - Embedded: post message to parent frame
   */
  redirectToAuthorization(url: URL): void | Promise<void>;

  /**
   * Wait for the authorization code after the user completes the browser flow.
   *
   * This is called after `redirectToAuthorization` when the SDK transport
   * throws `UnauthorizedError`. The connect loop blocks on this promise
   * until the code arrives, then calls `transport.finishAuth(code)`.
   *
   * Implementations:
   * - CLI: resolve when the local callback server receives the redirect
   * - Server: resolve when the callback endpoint is hit
   * - Embedded: resolve when postMessage delivers the code
   *
   * Return `undefined` to abort the auth flow (e.g., user cancelled).
   */
  waitForAuthorizationCode(): Promise<string | undefined>;

  // ── PKCE (optional — defaults to in-memory) ───────────────────────────

  /** Save PKCE code verifier. Default: in-memory. */
  saveCodeVerifier?(verifier: string): void | Promise<void>;

  /** Load PKCE code verifier. Default: in-memory. */
  loadCodeVerifier?(): string | Promise<string>;

  // ── Discovery cache (optional — defaults to in-memory) ────────────────

  /** Save discovery state to avoid re-discovery on reconnect. */
  saveDiscoveryState?(state: OAuthDiscoveryState): void | Promise<void>;

  /** Load cached discovery state. */
  loadDiscoveryState?(): OAuthDiscoveryState | undefined | Promise<OAuthDiscoveryState | undefined>;

  // ── Lifecycle (optional) ───────────────────────────────────────────────

  /** Called when credentials are invalidated (server rejected token). */
  onInvalidateCredentials?(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void | Promise<void>;
}

// ============================================================================
// SDK Adapter — bridges OAuthProvider to the SDK's OAuthClientProvider
// ============================================================================

/**
 * Adapts an agentick `OAuthProvider` to the MCP SDK's `OAuthClientProvider`.
 * Fills in in-memory defaults for optional hooks (PKCE, discovery cache).
 */
export function createSDKProvider(provider: OAuthProvider): SDKOAuthClientProvider {
  let memoryCodeVerifier = "";
  let memoryDiscoveryState: OAuthDiscoveryState | undefined;

  return {
    get redirectUrl() {
      return provider.redirectUrl;
    },
    get clientMetadata() {
      return provider.clientMetadata;
    },

    // Persistence
    tokens: () => provider.loadTokens(),
    saveTokens: (tokens) => provider.saveTokens(tokens),
    clientInformation: () => provider.loadClientInfo(),
    saveClientInformation: (info) => provider.saveClientInfo(info),

    // PKCE — delegate or in-memory
    saveCodeVerifier: (v) => {
      if (provider.saveCodeVerifier) return provider.saveCodeVerifier(v);
      memoryCodeVerifier = v;
    },
    codeVerifier: () => {
      if (provider.loadCodeVerifier) return provider.loadCodeVerifier();
      return memoryCodeVerifier;
    },

    // Discovery cache — delegate or in-memory
    saveDiscoveryState: (s) => {
      if (provider.saveDiscoveryState) return provider.saveDiscoveryState(s);
      memoryDiscoveryState = s;
    },
    discoveryState: () => {
      if (provider.loadDiscoveryState) return provider.loadDiscoveryState();
      return memoryDiscoveryState;
    },

    // Authorization redirect
    redirectToAuthorization: (url) => provider.redirectToAuthorization(url),

    // Credential invalidation
    invalidateCredentials: (scope) => provider.onInvalidateCredentials?.(scope),
  };
}

// ============================================================================
// DefaultOAuthProvider — zero-config for HTTP transports
// ============================================================================

export interface DefaultOAuthProviderOptions {
  /** Server name (used for logging and token namespace). */
  serverName: string;
  /** Server URL (used for default client metadata). */
  serverUrl: string;
  /** Custom client metadata. Defaults to a public native client. */
  clientMetadata?: OAuthClientMetadata;
  /** Custom redirect URL. Defaults to http://127.0.0.1:0/callback. */
  redirectUrl?: string | URL;
  /**
   * Called when the user needs to authorize in a browser.
   * If not provided, logs the URL and the caller must handle it.
   */
  onAuthorizationNeeded?: (url: URL) => void | Promise<void>;
}

/**
 * Default OAuth provider for automatic auth on HTTP transports.
 *
 * Uses in-memory storage for tokens, client info, PKCE, and discovery.
 * When authorization is needed, calls `onAuthorizationNeeded` (or logs
 * the URL if no callback is provided).
 *
 * For production use, implement `OAuthProvider` directly with persistent
 * storage and environment-appropriate redirect handling.
 */
export class DefaultOAuthProvider implements OAuthProvider {
  readonly clientMetadata: OAuthClientMetadata;
  readonly redirectUrl: string | URL | undefined;

  private tokens: OAuthTokens | undefined;
  private clientInfo: OAuthClientInformationMixed | undefined;
  private readonly opts: DefaultOAuthProviderOptions;

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

  loadTokens() {
    return this.tokens;
  }

  saveTokens(tokens: OAuthTokens) {
    this.tokens = tokens;
    log.info("Tokens saved for %s", this.opts.serverName);
  }

  loadClientInfo() {
    return this.clientInfo;
  }

  saveClientInfo(info: OAuthClientInformationMixed) {
    this.clientInfo = info;
    log.info("Client registered for %s", this.opts.serverName);
  }

  async redirectToAuthorization(url: URL) {
    // Store for waitForAuthorizationCode to know auth is in progress
    this._pendingAuthResolve = undefined;
    this._pendingAuthPromise = new Promise<string | undefined>((resolve) => {
      this._pendingAuthResolve = resolve;
    });

    if (this.opts.onAuthorizationNeeded) {
      return this.opts.onAuthorizationNeeded(url);
    }
    log.warn(
      "Authorization required for %s. Open this URL:\n  %s",
      this.opts.serverName,
      url.toString(),
    );
  }

  async waitForAuthorizationCode(): Promise<string | undefined> {
    if (this._pendingAuthPromise) {
      return this._pendingAuthPromise;
    }
    // No pending auth — shouldn't happen, but be safe
    return undefined;
  }

  /**
   * Call this from your callback handler to complete the pending auth flow.
   * For example, from a local HTTP server receiving the OAuth redirect.
   */
  resolveAuthorizationCode(code: string): void {
    this._pendingAuthResolve?.(code);
  }

  /**
   * Call this to cancel the pending auth flow (e.g., user closed the browser).
   */
  cancelAuthorization(): void {
    this._pendingAuthResolve?.(undefined);
  }

  private _pendingAuthPromise?: Promise<string | undefined>;
  private _pendingAuthResolve?: (code: string | undefined) => void;
}

// Re-export SDK types that consumers may need
export type { OAuthClientMetadata, OAuthTokens, OAuthClientInformationMixed };
export type { SDKOAuthClientProvider };
export type { OAuthDiscoveryState };
