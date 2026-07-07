/**
 * AppHarness integration — `withMCP` extension + content mapping.
 */

export {
  mcpContentToBlocks,
  mapCallToolResult,
  mapResourceContents,
  type MappedCallToolResult,
} from "./content-mapper.js";
export {
  withMCP,
  type McpServerConfig,
  type WithMCPOptions,
  type McpHookBridgeImpl,
} from "./with-mcp.js";
export {
  mcpTaskEffect,
  type McpTaskEffectInput,
  type McpRemoteTaskNonCompletedError,
} from "./task-bridge.js";
export {
  isTransportFactory,
  type TransportFactory,
  type TransportFactoryDeps,
} from "./transport-factory.js";
export {
  streamableHttpTransport,
  type StreamableHttpTransportOptions,
  type StreamableHttpOAuthOptions,
} from "./http-transport.js";
export * from "../wire/task-codec.js";
