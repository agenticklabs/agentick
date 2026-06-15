/**
 * Public exports for the MCP client harness layer.
 */

export {
  McpClientHarness,
  type McpClientError,
  type McpClientNotReadyError,
  type McpTransportError,
} from "./harness.js";

export {
  type McpClientHarnessOptions,
  type McpClientState,
  type McpSpecEra,
  type McpToolDescriptor,
  type ReconnectPolicy,
} from "./types.js";

export { type McpAuth, BearerAuth, type BearerAuthOptions, NoneAuth } from "./auth.js";

export { type EraCodec, DraftPassthroughCodec, selectCodec } from "./era-codec.js";

export { McpLifecycle, type McpLifecycleOptions } from "./lifecycle.js";
