/**
 * AppHarness integration — `withMCP` extension + content mapping.
 */

export { mcpContentToBlocks } from "./content-mapper.js";
export {
  withMCP,
  type McpServerConfig,
  type WithMCPOptions,
  type McpClientHandle,
  type McpHookBridgeImpl,
} from "./with-mcp.js";
