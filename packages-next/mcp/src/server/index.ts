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

export { McpServerHarness } from "./harness.js";
export { type McpServerHandle, toHandle } from "./handle.js";
export {
  resolveCompletionsOption,
  resolveElicitOption,
  resolvePromptsOption,
  validateOptions,
  type McpServerAuthOptions,
  type McpServerCapabilitiesOptions,
  type McpServerCompletionsConfig,
  type McpServerCompletionsOptions,
  type McpServerElicitOptions,
  type McpServerOptions,
  type McpServerPromptsConfig,
  type McpServerPromptsOptions,
  type McpServerToolsOptions,
  type PromptsFilter,
  type ResolvedCompletionsOptions,
  type ResolvedPromptsOptions,
} from "./config.js";
export {
  buildMcpElicit,
  inspectElicitationCapabilities,
  ElicitationCancelled,
  ElicitationDeclined,
  ElicitationNotSupported,
  UrlElicitationRequired,
  type BuildMcpElicitOptions,
  type ElicitationCapabilities,
} from "./projection/elicitation.js";
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
export {
  installPromptsHandlers,
  projectPrompts,
  toWirePrompt,
  toWirePromptMessages,
  type PromptsProjectionOptions,
} from "./projection/prompts.js";
export {
  installCompletionsHandlers,
  type CompletionsProjectionOptions,
} from "./projection/completions.js";
// Completion sugar builders — re-exported so server adopters build
// `completions` handlers from the same import path as the harness.
export {
  COMPLETION_MAX_VALUES,
  completeDependent,
  completeFromAsync,
  completeFromEnum,
  completeFromList,
  completePrefixMatch,
  normalizeCompletionResult,
  type CompletionContext,
  type CompletionHandler,
  type CompletionResult,
} from "../protocol/completions.js";
export {
  buildMcpLog,
  createConnectionLogState,
  installLoggingHandler,
  LOG_LEVEL_SEVERITY,
  type ConnectionLogState,
} from "./projection/logging.js";

// Re-export the spec types so adopters don't need to import from
// `@agentick/spec-next` directly for the common case.
export type {
  McpAuthenticatedUser,
  McpLogLevel,
  McpLogSink,
  McpRequestContext,
  McpServerConnectionInfo,
  McpServerError,
  McpServerHarnessProtocol,
  McpServerRegistry,
} from "@agentick/spec-next";
