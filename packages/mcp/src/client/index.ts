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

// MCP Apps client-side
export {
  createMCPApp,
  isToolVisibleToApps,
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
