/**
 * `@agentick/connector` — bind any external event source to an agent as one
 * server-side `GatewayExtension` (ADR 58). Pure composition — it's just a
 * session under the hood.
 *
 * ```ts
 * import { createGateway } from "@agentick/gateway";
 * import { defineConnector } from "@agentick/connector";
 *
 * const gateway = await createGateway({
 *   extensions: [
 *     defineConnector({
 *       name: "telegram",
 *       start({ inbound }) {
 *         bot.on("message", (m) => inbound({ text: m.text, sessionId: `tg:${m.chat.id}` }));
 *         return () => bot.stop();
 *       },
 *       deliver: ({ sessionId, response }) => bot.send(chatOf(sessionId), response),
 *     }),
 *   ],
 * });
 * ```
 *
 * @see README.md
 */

export { defineConnector } from "./define-connector.js";

export type {
  ConnectorSpec,
  ConnectorContext,
  ConnectorTeardown,
  ConnectorStatus,
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
