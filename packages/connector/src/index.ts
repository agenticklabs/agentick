export { ConnectorSession } from "./connector-session.js";
export { createConnector } from "./create-connector.js";
export type { ConnectorHandle } from "./create-connector.js";
export {
  buildContentFilter,
  applyContentPolicy,
  createToolSummarizer,
} from "./content-pipeline.js";
export type { ToolSummarizer } from "./content-pipeline.js";
export { DeliveryBuffer, RateLimiter } from "./delivery-buffer.js";
export { splitMessage } from "./message-splitter.js";

export type {
  ContentPolicy,
  ContentPolicyFn,
  DeliveryStrategy,
  RateLimitConfig,
  RetryConfig,
  ConnectorConfig,
  ConnectorOutput,
  ConnectorPlatform,
  ConnectorBridge,
  ConnectorStatus,
  ConnectorStatusEvent,
} from "./types.js";

export type { DeliveryBufferOptions } from "./delivery-buffer.js";
export type { SplitOptions } from "./message-splitter.js";

// Re-export extractText from shared — the canonical implementation lives there.
// Connector-specific text utilities (confirmation parsing/formatting) live here.
export { extractText } from "@agentick/shared";

export { parseTextConfirmation, formatConfirmationMessage } from "./text-utils.js";
