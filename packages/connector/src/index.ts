/**
 * `@agentick/connector` — bind any external event source to an agent through
 * the gateway's built-in connectors harness (ADR 58 / ADR 104). Pure
 * composition — it's just a session under the hood.
 *
 * ```ts
 * import { createGateway } from "@agentick/gateway";
 * import { defineConnector } from "@agentick/connector";
 *
 * const gateway = await createGateway({
 *   connectors: [
 *     defineConnector({
 *       name: "telegram",
 *       start({ inbound }) {
 *         bot.on("message", (m) => inbound({ messages: m.text, sessionId: `tg:${m.chat.id}` }));
 *         return () => bot.stop();
 *       },
 *       deliver: ({ sessionId, response }) => bot.send(chatOf(sessionId), response),
 *     }),
 *   ],
 * });
 *
 * gateway.connectors.get("telegram")?.status;
 * ```
 *
 * @see README.md
 */

export { defineConnector } from "./define-connector.js";

// The machinery — constructed by the gateway as its own child (ADR 104).
// Adopters normally never touch this class; it's exported for the gateway
// and for tests that mount it standalone.
export { ConnectorsHarness, type ConnectorsHarnessOptions } from "./harness.js";

export type {
  ConnectorSpec,
  ConnectorContext,
  ConnectorTeardown,
  ConnectorStatus,
  ConnectorHandle,
  Connectors,
  ConnectorsConfig,
  ConnectorsSlot,
  InboundMessage,
  InboundSessionInit,
  OutboundDelivery,
  ConfirmationPrompt,
  ConfirmationReply,
  StreamingTurn,
} from "./types.js";

// The StreamEvent → assistant-text projection `StreamingTurn.text()` uses,
// exported for authors composing their own event pipelines.
export { textStream } from "./text-stream.js";

// Thin confirmation helpers — pure functions, exported for connector authors.
export {
  parseTextConfirmation,
  formatConfirmationMessage,
  type ConfirmationDecision,
} from "./confirmations.js";
