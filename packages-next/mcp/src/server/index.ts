/**
 * `@agentick/mcp-next/server` — MCP server harness public surface.
 *
 * Exposes Agentick as an MCP server, symmetric to the outbound
 * `McpClientHarness` already shipped at `@agentick/mcp-next` (default
 * export). Same wire vocabulary; opposite direction.
 *
 * **Skeleton commit (#171b).** This module ships the construction
 * shape + spec-type re-exports. Transport mounting, projection,
 * security pipeline, OAuth, and the Mode-A standalone CLI land in
 * #171c onward. See [ADR 40 §1 — Package layout](../../../../docs/proposals/v2/blueprint/40-mcp-server-harness.md).
 *
 * Import paths:
 *   - `@agentick/mcp-next`            — CLIENT (existing)
 *   - `@agentick/mcp-next/server`     — SERVER (this module)
 *   - `@agentick/mcp-next/oauth`      — shared OAuth utilities
 *
 * Subpath isolation is deliberate: browser/edge bundles that only
 * consume MCP don't pull server-side Node fs / transport code.
 *
 * @see docs/proposals/v2/blueprint/40-mcp-server-harness.md
 * @see packages-next/spec/src/protocol/mcp-server-harness.ts
 */

// Side-effect import — augments `GatewayExtensions.mcpServers` slot.
import "./augment.js";

export { McpServerHarness, type McpServerHarnessOptions } from "./harness.js";
export { type McpServerHandle, toHandle } from "./handle.js";
export { validateConfig } from "./config.js";
export {
  spawnStandaloneMcpServer,
  type SpawnStandaloneOptions,
  type StandaloneServerHandle,
} from "./spawn.js";
export * from "./security/index.js";
export * from "./transports/index.js";
export { buildCapabilities, type WiredCapabilities } from "./protocol/lifecycle.js";
export {
  installToolsHandlers,
  projectTools,
  toWireTool,
  isProjectionError,
  type ToolHandlerResolver,
  type ToolsProjectionOptions,
} from "./projection/tools.js";

// Re-export the spec types so adopters don't need to import from
// `@agentick/spec-next` directly for the common case.
export type {
  McpAuthenticatedUser,
  McpRequestContext,
  McpServerAuthConfig,
  McpServerCapabilitiesConfig,
  McpServerConfig,
  McpServerConnectionInfo,
  McpServerError,
  McpServerHarnessProtocol,
  McpServerPromptsConfig,
  McpServerRegistry,
  McpServerToolsConfig,
  McpServerTransportSpec,
} from "@agentick/spec-next";
