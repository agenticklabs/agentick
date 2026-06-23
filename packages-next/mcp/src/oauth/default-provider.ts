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

import type { ElicitationResult, UrlElicitationRequest } from "@agentick/spec-next";

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
   *
   * `[bootstrap fallback]` — adopters that wire the `elicit` slot
   * (the SessionExtension path via `withMCP`) typically leave this
   * unset; the URL-mode elicit replaces it. Useful for CLI
   * environments without a session-bound elicit harness (the v1
   * `agent()` migration target).
   */
  readonly onAuthorizationNeeded?: (url: URL) => void | Promise<void>;

  /**
   * URL-mode elicit publisher. When set, `redirectToAuthorization`
   * fires a URL-mode elicit ALONGSIDE the bootstrap callback (the
   * elicit notifies the user; the callback path lets adopters keep
   * their bootstrap-only flows working).
   *
   * Typical wiring inside `withMCP` (per-session SessionExtension):
   *
   *   elicit: (req) => installer.elicitation.elicit(req)
   *
   * Consent semantics (`accepted`) signal the user agreed to
   * navigate to the URL — NOT that OAuth completed. Completion is
   * the separate out-of-band code-capture path
   * ({@link OAuthCallbackServer} for CLI; a future
   * gateway-routed handler for cloud). A `declined`/`cancelled`/
   * `failed` outcome short-circuits the pending auth via
   * {@link cancelAuthorization} so the SDK's
   * `waitForAuthorizationCode` doesn't hang.
   */
  readonly elicit?: (request: UrlElicitationRequest) => Promise<ElicitationResult<undefined>>;
}

export class DefaultOAuthProvider implements OAuthProvider {
  readonly clientMetadata: OAuthClientMetadata;
  readonly redirectUrl: string | URL | undefined;

  private currentTokens: OAuthTokens | undefined;
  private currentClientInfo: OAuthClientInformationMixed | undefined;
  private readonly opts: DefaultOAuthProviderOptions;

  private pendingAuthPromise?: Promise<string | undefined>;
  private pendingAuthResolve?: (code: string | undefined) => void;
  /**
   * Monotonic counter for elicitationIds — `oauth:<serverName>:<n>`.
   * The MCP spec requires elicitationIds be unique within the
   * provider's flow; a counter is the simplest stable source.
   * `Date.now()` would also work but creates flakiness in tests
   * that fire two flows in the same millisecond.
   */
  private pendingAuthCounter = 0;

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

    if (this.opts.elicit) {
      // Fire-and-forget the URL-mode elicit. We don't AWAIT it before
      // returning — `redirectToAuthorization` is the "tell the user
      // about the URL" call; the actual gate is the code arrival,
      // which `waitForAuthorizationCode` awaits via `pendingAuthPromise`.
      //
      // Why not await: the SDK calls `redirectToAuthorization` then
      // `waitForAuthorizationCode` in sequence. If we awaited consent
      // here, a slow user would block the SDK from even entering the
      // code wait, AND a user who completed OAuth in their browser
      // BEFORE clicking "accept" on the elicit would deadlock — code
      // captured, but provider still waiting on consent. Fire-and-forget
      // sidesteps both.
      //
      // Decline/cancel of the elicit DOES short-circuit
      // `pendingAuthPromise` via `cancelAuthorization`, so a user who
      // explicitly says no aborts the flow cleanly.
      void this.opts
        .elicit({
          mode: "url",
          url: url.toString(),
          elicitationId: `oauth:${this.opts.serverName}:${this.pendingAuthCounter++}`,
          message: `Authorize agentick to access "${this.opts.serverName}". Open the URL to continue.`,
          hints: { kind: "oauth", server: this.opts.serverName },
        })
        .then((result) => {
          if (result.outcome !== "accepted") {
            this.cancelAuthorization();
          }
        })
        .catch((err) => {
          console.warn(
            `[agentick mcp] OAuth URL elicit failed for "${this.opts.serverName}": ${String(err)}`,
          );
          this.cancelAuthorization();
        });
    }

    if (this.opts.onAuthorizationNeeded) {
      return this.opts.onAuthorizationNeeded(url);
    }

    if (!this.opts.elicit) {
      // No elicit, no callback → bootstrap fallback. Log the URL so
      // adopters running CLI scripts can copy-paste it.
      console.warn(
        `[agentick mcp] Authorization required for "${this.opts.serverName}". Open this URL: ${url.toString()}`,
      );
    }
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
