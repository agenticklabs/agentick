/**
 * `@agentick/connector-next` — bind an external event source to an agent
 * session as one server-side `GatewayExtension` (ADR 58).
 *
 * A connector is an INGRESS binding: inbound event → `session.send`. It
 * is pure composition — no connector subsystem, no new verb. The
 * outbound reply path and confirmation routing are OPTIONAL, wired only
 * when the platform opts in (see {@link ConnectorPlatform}).
 *
 * ```ts
 * import { createGateway } from "@agentick/gateway-next";
 * import { defineConnector } from "@agentick/connector-next";
 *
 * const gateway = await createGateway({
 *   extensions: [defineConnector({ name: "telegram", platform: myPlatform })],
 * });
 * ```
 *
 * Platform ports (`connector-telegram-next`, `connector-imessage-next`)
 * implement the {@link ConnectorPlatform} adapter; they are deferred
 * follow-ups gated on their platform SDKs.
 *
 * @see docs/proposals/v2/blueprint/58-connectors.md
 */

export { defineConnector } from "./define-connector.js";

export type {
  ConnectorPlatform,
  ConnectorHandle,
  ConnectorConfig,
  ConnectorStatus,
  InboundMessage,
  OutboundDelivery,
  ConfirmationPrompt,
  ConfirmationReply,
  DefineConnectorSpec,
} from "./types.js";

// Thin confirmation helpers — pure functions, exported for platform ports.
export {
  parseTextConfirmation,
  formatConfirmationMessage,
  type ConfirmationDecision,
} from "./confirmations.js";
