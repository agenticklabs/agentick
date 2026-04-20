export { MCPClient, uriMatchesTemplate } from "./client.js";
export type {
  MCPConnectionConfig,
  MCPTransport,
  MCPClientOptions,
  DiscoveredTool,
  DiscoveredResource,
  DiscoveredResourceTemplate,
  DiscoveredPrompt,
  ResourceContent,
  PromptResult,
  ConnectionState,
  ServerHealth,
  ProgressCallback,
  ProgressInfo,
  SamplingHandler,
  SamplingRequest,
  SamplingResult,
  Root,
  LogLevel,
  LogMessage,
  LogHandler,
} from "./types.js";

// OAuth
export { createSDKProvider, DefaultOAuthProvider } from "./oauth.js";
export type {
  OAuthProvider,
  DefaultOAuthProviderOptions,
  OAuthClientMetadata,
  OAuthTokens,
  OAuthClientInformationMixed,
  OAuthDiscoveryState,
} from "./oauth.js";

export { OAuthCallbackServer } from "./oauth-callback-server.js";
export type { OAuthCallbackServerOptions } from "./oauth-callback-server.js";

// MCP Apps — client/host side
export {
  createMCPApp,
  isToolVisibleToApps,
  isToolVisibleToModel,
  getToolAppUri,
  AppBridge,
  PostMessageTransport,
  getToolUiResourceUri,
  isToolVisibilityModelOnly,
  buildAllowAttribute,
} from "./apps.js";
export type {
  CreateMCPAppOptions,
  MCPAppHandle,
  IframeLike,
  McpUiHostCapabilities,
  McpUiResourcePermissions,
} from "./apps.js";

// MCP Apps — relay transport for server-side AppBridge
export { RelayTransport } from "./relay-transport.js";
export type { RelayTransportOptions } from "./relay-transport.js";

// MCP Apps — browser-side multi-app host manager (framework-agnostic)
export { BrowserMCPAppHost } from "./browser-app-host.js";
export type {
  BrowserMCPAppHostOptions,
  AppHostTransport,
  AppHostChannelEvent,
  MountAppOptions,
  MountedApp,
} from "./browser-app-host.js";
