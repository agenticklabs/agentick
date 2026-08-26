/**
 * The connector contracts live in `@agentick/spec` (`data/connector.ts` +
 * `protocol/connectors-harness.ts`) since ADR 104 promoted connectors to a
 * gateway built-in. Re-exported here so `@agentick/connector` remains the
 * one import connector authors need.
 */

export type {
  ConfirmationPrompt,
  ConfirmationReply,
  ConnectorContext,
  ConnectorHandle,
  ConnectorSpec,
  ConnectorStatus,
  ConnectorTeardown,
  Connectors,
  ConnectorsConfig,
  ConnectorsHarnessProtocol,
  ConnectorsSlot,
  InboundMessage,
  InboundSessionInit,
  OutboundDelivery,
  StreamingTurn,
} from "@agentick/spec";
