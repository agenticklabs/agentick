/**
 * `streamableHttpTransport({ url })` — client-side Streamable HTTP
 * transport factory for `withMCP({ servers: [{ transport }] })`.
 *
 * Returns a {@link TransportFactory} (deferred construction). At session
 * install time the factory receives the session-bound {@link
 * TransportFactoryDeps} (elicit binding, credentials harness, resolved
 * credential-key composer, interactive flag) and constructs the SDK's
 * `StreamableHTTPClientTransport`. When `oauth` is enabled it wires a
 * {@link DefaultOAuthProvider} — threaded through {@link createSDKProvider}
 * into the SDK transport's `authProvider` — so the SDK's built-in
 * 401 → authorization → `finishAuth` → retry flow is reachable without
 * per-session adopter boilerplate.
 *
 * This is the piece that makes the `oauth/` module reachable in v2:
 * before it, nothing constructed the SDK HTTP transport with the
 * provider bridge, so hosted (Linear / Notion / remote) servers were
 * unreachable.
 *
 *     withMCP({
 *       servers: [{
 *         serverId: "linear",
 *         transport: streamableHttpTransport({
 *           url: "https://mcp.linear.app/mcp",
 *           oauth: true,
 *         }),
 *         reconnect: {},
 *       }],
 *     });
 *
 * Non-OAuth servers (public, or behind a static bearer supplied via
 * `requestInit.headers`) omit `oauth` — no `authProvider` is set.
 *
 * @see ./transport-factory.ts for the `TransportFactory` contract + deps
 * @see ../oauth/default-provider.ts for the provider this wires
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { DefaultOAuthProvider } from "../oauth/default-provider.js";
import { createSDKProvider, type OAuthClientMetadata } from "../oauth/provider.js";

import type { TransportFactory, TransportFactoryDeps } from "./transport-factory.js";

/**
 * OAuth wiring knobs for {@link streamableHttpTransport}. The
 * session-bound pieces (elicit, credentials, credential-key composer,
 * interactive flag) come from {@link TransportFactoryDeps} at build
 * time — these are the adopter-supplied statics.
 */
export interface StreamableHttpOAuthOptions {
  /**
   * OAuth client metadata for dynamic registration (RFC 7591).
   * Defaults to a public native client derived from the server name +
   * redirect url (see {@link DefaultOAuthProvider}).
   */
  readonly clientMetadata?: OAuthClientMetadata;

  /**
   * Redirect URI for the authorization callback. Defaults to
   * `http://127.0.0.1:0/callback` — pair with an {@link
   * OAuthCallbackServer} for the CLI / desktop flow.
   */
  readonly redirectUrl?: string | URL;

  /**
   * Bootstrap fallback invoked with the authorization URL when no
   * session-bound elicit is available (e.g. a CLI script). Fires
   * ALONGSIDE the URL-mode elicit when both are present.
   */
  readonly onAuthorizationNeeded?: (url: URL) => void | Promise<void>;
}

export interface StreamableHttpTransportOptions {
  /** Remote MCP endpoint URL. */
  readonly url: string | URL;

  /**
   * Customizes HTTP requests (static headers, credentials mode, …).
   * Passed through to the SDK transport's `requestInit`. Use this for
   * a static bearer token on servers that don't require OAuth.
   */
  readonly requestInit?: RequestInit;

  /**
   * Enable OAuth. `true` wires a {@link DefaultOAuthProvider} with
   * defaults; an options object customizes client metadata / redirect /
   * bootstrap callback. Omit for public servers or static-bearer
   * servers — no `authProvider` is set on the SDK transport.
   *
   * When enabled, the provider is bound to the session deps:
   *   - `elicit`       → URL-mode elicitation for the authorize step
   *   - `credentials`  → persistent token / client-info storage (when a
   *                      credentials substrate is installed; in-memory
   *                      otherwise)
   *   - `interactive`  → gates the browser prompt to `reauthenticate()`
   */
  readonly oauth?: boolean | StreamableHttpOAuthOptions;
}

/**
 * Build a client-side Streamable HTTP {@link TransportFactory}. See the
 * module header for the OAuth threading rationale.
 */
export function streamableHttpTransport(options: StreamableHttpTransportOptions): TransportFactory {
  const url = options.url instanceof URL ? options.url : new URL(String(options.url));

  return (deps: TransportFactoryDeps): Transport => {
    const sdkOptions: StreamableHTTPClientTransportOptions = {};
    if (options.requestInit !== undefined) {
      sdkOptions.requestInit = options.requestInit;
    }

    if (options.oauth) {
      const oauth = typeof options.oauth === "object" ? options.oauth : {};
      const provider = new DefaultOAuthProvider({
        serverName: deps.serverId,
        serverUrl: url.toString(),
        elicit: deps.elicit,
        interactive: deps.interactive,
        // Credentials read-through: both `credentials` + `keyOf` must be
        // supplied together (the provider enforces this). Absent a
        // substrate, fall back to in-memory persistence.
        ...(deps.credentials !== undefined
          ? { credentials: deps.credentials, keyOf: deps.credentialKey }
          : {}),
        ...(oauth.clientMetadata !== undefined ? { clientMetadata: oauth.clientMetadata } : {}),
        ...(oauth.redirectUrl !== undefined ? { redirectUrl: oauth.redirectUrl } : {}),
        ...(oauth.onAuthorizationNeeded !== undefined
          ? { onAuthorizationNeeded: oauth.onAuthorizationNeeded }
          : {}),
      });
      sdkOptions.authProvider = createSDKProvider(provider);
    }

    return new StreamableHTTPClientTransport(url, sdkOptions);
  };
}
