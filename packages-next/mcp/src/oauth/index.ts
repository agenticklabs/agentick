/**
 * OAuth subpath — public re-exports for adopters wiring an MCP client
 * against an OAuth-protected server.
 *
 * ```ts
 * import {
 *   DefaultOAuthProvider,
 *   OAuthCallbackServer,
 *   type OAuthProvider,
 * } from "@agentick/mcp-next/oauth";
 * ```
 */

export {
  createSDKProvider,
  type OAuthProvider,
  type OAuthClientMetadata,
  type OAuthTokens,
  type OAuthClientInformationMixed,
  type OAuthDiscoveryState,
  type SDKOAuthClientProvider,
} from "./provider.js";

export { DefaultOAuthProvider, type DefaultOAuthProviderOptions } from "./default-provider.js";

export { OAuthCallbackServer, type OAuthCallbackServerOptions } from "./callback-server.js";
