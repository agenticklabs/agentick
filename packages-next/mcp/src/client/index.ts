/**
 * Public exports for the MCP client harness layer.
 */

export {
  McpClientHarness,
  type McpClientError,
  type McpClientNotReadyError,
  type McpTransportError,
  type McpListChangedEvent,
  type McpServerInfo,
} from "./harness.js";

export {
  type McpClientHarnessOptions,
  type McpClientState,
  type McpSpecEra,
  type McpToolDescriptor,
  type ReconnectPolicy,
  // Wave 2 (#146) — resources / prompts / completion / sampling / roots / logging
  type McpSamplingHandler,
  type McpRoot,
  type McpRootsSource,
  type McpLoggingLevel,
  type McpLogMessage,
  type McpResourceDescriptor,
  type McpResourceTemplateDescriptor,
  type McpResourcePage,
  type McpResourceTemplatePage,
  type McpPromptArgumentDescriptor,
  type McpPromptDescriptor,
  type McpPromptPage,
  type McpPromptMessage,
  type McpGetPromptResult,
  type ResourceContents,
} from "./types.js";

export { type McpAuth, BearerAuth, type BearerAuthOptions, NoneAuth } from "./auth.js";

export { type EraCodec, DraftPassthroughCodec, selectCodec } from "./era-codec.js";

export { McpLifecycle, type McpLifecycleOptions } from "./lifecycle.js";

export {
  type McpConnectionStatus,
  type StatusUnsubscribe,
  isTerminalStatus,
} from "./connection-status.js";
