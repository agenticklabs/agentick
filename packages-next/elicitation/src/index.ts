/**
 * @agentick/elicitation-next — ElicitationHarness.
 *
 * Promotes the request/response correlation pattern (previously buried
 * in `tool-executor`'s confirmation gate) into a first-class, named
 * substrate harness. Every "ask the user for a structured response"
 * step in the framework — tool confirmation, MCP `elicitation/create`,
 * agent-side asks, approval workflows — funnels through this one
 * protocol so wire envelope, channel, correlation engine, and
 * timeout/abort semantics live in exactly one place.
 *
 * Private workspace package. Bundled into the `agentick` metapackage;
 * not published independently.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

// Side-effect import — registers the `bridges.elicitation` slot on
// `HookBridges` via TypeScript module augmentation. Per ADR 27, every
// harness package owns its own slot declaration.
import "./augment.js";

export { ElicitationHarness, type ElicitationHarnessOptions } from "./harness.js";
export { withElicitation } from "./extension.js";
export { runElicitationHarnessConformance } from "./conformance.js";
export {
  ELICITATION_CHANNEL,
  ELICITATION_CHANNEL_FQN,
  type ElicitationChannelName,
} from "./channel.js";
export {
  ELICIT_REQUEST_MESSAGE_TYPE,
  type ElicitRequestInboxPayload,
  type ElicitRequestMessageType,
} from "./inbox-protocol.js";
