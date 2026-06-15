/**
 * OAuth provider interface for MCP client authentication.
 *
 * Pluggable `OAuthProvider` controls how tokens are stored, how the
 * user authorizes, and how client registration is persisted. The MCP
 * SDK handles discovery, PKCE, code exchange, and refresh; this
 * interface bridges adopter-specific decisions (storage, redirect UX)
 * into the SDK's shape.
 *
 * Default behavior: any HTTP transport (SSE, streamable-http) that
 * receives a 401 automatically triggers the OAuth flow without explicit
 * config — provided an `OAuthProvider` is wired into the McpClientHarness's
 * Auth layer.
 *
 * **v1 origin:** ported from `packages/mcp/src/client/oauth.ts`. The
 * interface and the `createSDKProvider` adapter are framework-agnostic
 * OAuth glue — they hold up across v1 → v2 without changes. The
 * `DefaultOAuthProvider` and `OAuthCallbackServer` live in sibling
 * files; together they cover the CLI / desktop / dev case end-to-end.
 *
 * **v2 integration:** the user-visible authorization step
 * (`redirectToAuthorization` / `waitForAuthorizationCode`) is the
 * substrate's URL-mode elicitation. When that lands, the default
 * provider can route through `bridges.elicitation` instead of a
 * localhost callback server. For now both paths coexist.
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

// ============================================================================
// OAuthProvider — the agentick abstraction
// ============================================================================

/**
 * OAuth provider hooks for MCP client authentication.
 *
 * Implementations control how tokens are stored, how the user is
 * directed to authorize, and how client registration is persisted. The
 * MCP client handles discovery, PKCE, token exchange, and refresh
 * automatically via the SDK transports.
 *
 * For most use cases, use `DefaultOAuthProvider` which provides
 * in-memory storage and either logs the authorize URL or invokes an
 * `onAuthorizationNeeded` callback. For production, implement this
 * interface with persistent storage (file, DB, keychain).
 */
export interface OAuthProvider {
  // ── Identity ──────────────────────────────────────────────────────────

  /** OAuth client metadata for dynamic registration (RFC 7591). */
  readonly clientMetadata: OAuthClientMetadata;

  /**
   * Redirect URI for the authorization callback. `undefined` for
   * non-interactive flows. CLI typically points at a localhost
   * callback server.
   */
  readonly redirectUrl: string | URL | undefined;

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
   *   CLI       — open system browser, start localhost callback server
   *   Server    — store pending auth state, return URL to caller
   *   Embedded  — post message to parent frame
   *   Agentick  — publish a URL-mode elicitation via
   *               bridges.elicitation and wait for response
   */
  redirectToAuthorization(url: URL): void | Promise<void>;

  /**
   * Wait for the authorization code after the user completes the
   * browser flow.
   *
   * Called after `redirectToAuthorization` when the SDK transport
   * throws `UnauthorizedError`. The connect loop blocks on this
   * promise until the code arrives, then calls
   * `transport.finishAuth(code)`. Return `undefined` to abort the
   * auth flow (user cancelled, timeout).
   */
  waitForAuthorizationCode(): Promise<string | undefined>;

  // ── PKCE (optional — defaults to in-memory) ───────────────────────────

  saveCodeVerifier?(verifier: string): void | Promise<void>;
  loadCodeVerifier?(): string | Promise<string>;

  // ── Discovery cache (optional — defaults to in-memory) ────────────────

  saveDiscoveryState?(state: OAuthDiscoveryState): void | Promise<void>;
  loadDiscoveryState?(): OAuthDiscoveryState | undefined | Promise<OAuthDiscoveryState | undefined>;

  // ── Lifecycle (optional) ───────────────────────────────────────────────

  /** Called when credentials are invalidated (server rejected token). */
  onInvalidateCredentials?(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void | Promise<void>;
}

// ============================================================================
// SDK Adapter
// ============================================================================

/**
 * Adapts an agentick `OAuthProvider` to the MCP SDK's
 * `OAuthClientProvider`. Fills in in-memory defaults for optional
 * hooks (PKCE, discovery cache).
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

// Re-export SDK types adopters touch.
export type {
  OAuthClientMetadata,
  OAuthTokens,
  OAuthClientInformationMixed,
  OAuthDiscoveryState,
  SDKOAuthClientProvider,
};
