/**
 * Auth layer for the MCP client harness.
 *
 * `McpAuth` is the pluggable seam — the harness asks for a current
 * token before each request and triggers reauth when one is rejected.
 * Three concrete impls ship:
 *
 *   - `NoneAuth`    — stdio (parent process already authenticated)
 *   - `BearerAuth`  — static API key / pre-issued token
 *   - OAuth21 (#5) — full RFC 6749 + PKCE flow via {@link OAuthProvider}
 *
 * The OAuth path doesn't actually run THROUGH this interface — it
 * runs through the SDK's `OAuthClientProvider` plumbed into HTTP
 * transports. `McpAuth` is the harness-side companion that decides
 * WHEN to escalate to URL-mode elicitation; the OAuthProvider decides
 * HOW to complete the flow.
 */

// ============================================================================
// McpAuth — the seam
// ============================================================================

/**
 * Authentication strategy for an MCP server connection. Methods are
 * `async` because real impls hit storage / network; `NoneAuth` resolves
 * synchronously inside Promises.
 */
export interface McpAuth {
  /**
   * Resolves to the current bearer token (Authorization header value
   * minus the `Bearer ` prefix), or `undefined` if no auth is needed
   * (stdio).
   */
  getToken(): Promise<string | undefined>;

  /**
   * Force a token refresh. Called by the harness when a request fails
   * with 401. Implementations exchange the refresh_token for a new
   * access_token at the OAuth token endpoint and call `saveTokens`.
   * No-op for `NoneAuth` / `BearerAuth`.
   */
  refresh?(): Promise<void>;

  /**
   * Triggered when refresh fails OR no token exists at all. The user
   * must reauthenticate from scratch (the full OAuth dance). #5 wires
   * this to URL-mode elicitation so the prompt flows through the
   * client-side surface; #2's `NoneAuth` / `BearerAuth` don't
   * implement it.
   */
  reauth?(): Promise<void>;
}

// ============================================================================
// NoneAuth — no token, no flow
// ============================================================================

/**
 * No authentication. Stdio transports inherit the parent process's
 * permissions; the subprocess MCP server doesn't run an auth layer.
 */
export class NoneAuth implements McpAuth {
  async getToken(): Promise<undefined> {
    return undefined;
  }
}

// ============================================================================
// BearerAuth — static token
// ============================================================================

export interface BearerAuthOptions {
  /** Static bearer token. Embedded in the Authorization header. */
  readonly token: string;
}

/**
 * Static bearer token. Used for servers that accept a pre-issued API
 * key (a personal access token, a service account secret, etc.). No
 * refresh, no reauth — when the token expires the caller has to
 * replace the McpAuth.
 */
export class BearerAuth implements McpAuth {
  private readonly token: string;

  constructor(options: BearerAuthOptions) {
    this.token = options.token;
  }

  async getToken(): Promise<string> {
    return this.token;
  }
}
