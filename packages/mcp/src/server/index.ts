/**
 * `@agentick/mcp/server` — MCP server harness public surface.
 *
 * Exposes Agentick as an MCP server, symmetric to the outbound
 * `McpClientHarness` already shipped at `@agentick/mcp` (default
 * export). Same wire vocabulary; opposite direction.
 *
 * **Skeleton commit (#171b).** This module ships the construction
 * shape + spec-type re-exports. Transport mounting, projection,
 * security pipeline, OAuth, and the Mode-A standalone CLI land in
 * #171c onward. See [ADR 40 §1 — Package layout](../../../../docs/proposals/v2/blueprint/40-mcp-server-harness.md).
 *
 * Import paths:
 *   - `@agentick/mcp`            — CLIENT (existing)
 *   - `@agentick/mcp/server`     — SERVER (this module)
 *   - `@agentick/mcp/oauth`      — shared OAuth utilities
 *
 * Subpath isolation is deliberate: browser/edge bundles that only
 * consume MCP don't pull server-side Node fs / transport code.
 *
 * @see docs/proposals/v2/blueprint/40-mcp-server-harness.md
 * @see packages/spec/src/protocol/mcp-server-harness.ts
 */

// Side-effect import — augments `GatewayExtensions.mcpServers` slot.
import "./augment.js";

export { McpServerHarness } from "./harness.js";
export { type McpServerHandle, toHandle } from "./handle.js";
export {
  resolveCompletionsOption,
  resolveElicitOption,
  resolvePromptsOption,
  resolveResourcesOption,
  validateOptions,
  type McpServerAuthOptions,
  type McpServerCapabilitiesOptions,
  type McpServerCompletionsConfig,
  type McpServerCompletionsOptions,
  type McpServerElicitOptions,
  type McpServerInstructions,
  type McpServerOptions,
  type McpServerPromptsConfig,
  type McpServerPromptsOptions,
  type McpServerResourcesConfig,
  type McpServerResourcesOptions,
  type McpServerToolsOptions,
  type PromptsFilter,
  type ResolvedCompletionsOptions,
  type ResolvedPromptsOptions,
  type ResolvedResourcesOptions,
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
export {
  buildWwwAuthenticate,
  wwwAuthenticateMeta,
  WWW_AUTHENTICATE_META_KEY,
  type WwwAuthenticateParams,
} from "./security/www-authenticate.js";
export {
  MCP_METADATA_KEY,
  mcpToolExtensions,
  mcpResultExtensions,
  readMcpToolExtensions,
  readMcpResultExtensions,
  type McpMetadataFragment,
  type McpToolAnnotationHints,
  type McpToolDeclarationExtensions,
  type McpToolResultExtensions,
} from "./tool-extensions.js";
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
  installResourcesHandlers,
  toWireResource,
  toWireResourceTemplate,
  toWireContents,
  type ResourcesFilter,
  type ResourcesProjectionOptions,
} from "./projection/resources.js";
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
  createConnectionLogState,
  installLoggingHandler,
  installLogProjection,
  installProgressProjection,
  LOG_LEVEL_SEVERITY,
  type ConnectionLogState,
} from "./projection/logging.js";

// Re-export the spec types so adopters don't need to import from
// `@agentick/spec` directly for the common case.
export type {
  McpAuthenticatedUser,
  McpLogLevel,
  McpRequestContext,
  McpServerConnectionInfo,
  McpServerError,
  McpServerHarnessProtocol,
  McpServerRegistry,
} from "@agentick/spec";
