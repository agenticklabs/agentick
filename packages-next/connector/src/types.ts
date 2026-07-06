/**
 * Public contract for `@agentick/connector-next`.
 *
 * A **connector** is an INGRESS binding: an external event source
 * (Telegram, iMessage, a webhook, an MQ consumer, a cron tick, …) that
 * holds a session and turns each inbound event into an agentic action —
 * by default `session.send`. It is a server-side `GatewayExtension`
 * composing existing primitives (ADR 58). No new subsystem, no new verb.
 *
 * **Ingress is the base; delivery is a specialization.** The
 * emit-inbound half of {@link ConnectorPlatform} is REQUIRED; the
 * deliver-outbound half is OPTIONAL. A one-way source (webhook, queue
 * consumer, bus subscriber, cron) implements only inbound and never
 * delivers a reply. The conversational reply path is layered on top for
 * platforms that want it.
 *
 * The richer v1 "delivery" behaviors (cadence buffering, content-policy
 * filtering, rate limiting, retry backoff) are deliberately NOT in the
 * base — see the README Roadmap. Delivery here is a thin
 * `deliver?(output)` hand-off; a platform that wants formatting/chunking
 * composes `@agentick/formatters-next` + `splitMessage` itself.
 *
 * @see docs/proposals/v2/blueprint/58-connectors.md
 */

import type { ContentBlock, MessageSource } from "@agentick/spec-next";

// ============================================================================
// Status
// ============================================================================

export type ConnectorStatus = "disconnected" | "connecting" | "connected" | "error";

// ============================================================================
// Connector config
// ============================================================================

export interface ConnectorConfig {
  /**
   * Which hosted app this connector binds to. Defaults to the gateway's
   * sole app when omitted. Resolved lazily at first inbound (apps may
   * not exist at gateway-construction time).
   */
  readonly appId?: string;
  /**
   * Session this connector routes to. Defaults to a stable
   * per-connector id (`connector:<name>`), so a source maps to one
   * long-lived session. Per-event routing (one session per chat/topic)
   * is a platform concern — a port stamps `InboundMessage.sessionId`.
   */
  readonly sessionId?: string;
  /**
   * Allowed sender identifiers. When set, an inbound event whose
   * `senderId` is not listed is dropped. A whitelist gate, not identity
   * (ADR 58 §identity model). Omit to allow all.
   */
  readonly allowlist?: readonly string[];
}

// ============================================================================
// Inbound / outbound payloads (platform ↔ connector)
// ============================================================================

/** Platform → connector: an external event carrying text to send. */
export interface InboundMessage {
  /** The event's message text. */
  readonly text: string;
  /**
   * Provenance stamped at `metadata.source` on the resulting user
   * message. Typed against the module-augmentable {@link MessageSource}
   * empty-seed. Provenance, NOT identity (ADR 58).
   */
  readonly source?: MessageSource;
  /**
   * Sender identifier checked against {@link ConnectorConfig.allowlist}.
   * Unauthenticated platform handle — a gate input, not an actor.
   */
  readonly senderId?: string;
  /**
   * Route to a specific session. Defaults to the connector's configured
   * session. A port that maps each chat/topic to its own session stamps
   * this.
   */
  readonly sessionId?: string;
}

/**
 * Connector → platform: the agent's output for an execution. Handed off
 * raw — no cadence, no content policy, no chunking. A platform that
 * wants those composes `@agentick/formatters-next` + `splitMessage`.
 */
export interface OutboundDelivery {
  readonly sessionId: string;
  /** Concatenated assistant text (`SendResult.response`). */
  readonly response: string;
  /** Full assistant content blocks (`SendResult.output`). */
  readonly output: readonly ContentBlock[];
}

/** Connector → platform: present a confirmation/elicitation to the user. */
export interface ConfirmationPrompt {
  readonly sessionId: string;
  /** Correlation id the reply must echo back via {@link ConnectorHandle.respondConfirmation}. */
  readonly correlationId: string;
  /** Human-readable prompt. */
  readonly message: string;
  /** Elicitation mode. `"url"` prompts carry a {@link url}. */
  readonly mode: "form" | "url";
  /** Present for `"url"` mode — the URL the user should open. */
  readonly url?: string;
}

/** Platform → connector: the user replied to a pending confirmation. */
export interface ConfirmationReply {
  readonly correlationId: string;
  /** The user's raw reply text (parsed to yes/no by the connector). */
  readonly text: string;
}

// ============================================================================
// Platform adapter + handle
// ============================================================================

/**
 * The handle the connector hands a platform at `start()`. The platform
 * pushes events IN through it. `emitInbound` is the required ingress
 * path; `respondConfirmation` is used only by platforms that opt into
 * confirmations.
 */
export interface ConnectorHandle {
  /** Platform → connector: an external event arrived. REQUIRED path. */
  emitInbound(message: InboundMessage): void;
  /** Platform → connector: the user answered a pending confirmation. */
  respondConfirmation(reply: ConfirmationReply): void;
  /** Platform reports its own connection status to the connector. */
  reportStatus(status: ConnectorStatus, error?: Error): void;
}

/**
 * A thin platform adapter. It knows how to talk to its wire; it knows
 * nothing about sessions or elicitation. `ConnectorBridge` (v1) is gone
 * (ADR 58 fork 4).
 *
 * **`start` / `stop` are required; `deliver` / `presentConfirmation` are
 * OPTIONAL.** A one-way ingress source implements only `start` / `stop`
 * (using the handle's `emitInbound`). Implementing `deliver` opts into
 * outbound; implementing `presentConfirmation` opts into confirmations.
 */
export interface ConnectorPlatform {
  /** Platform name, for diagnostics. */
  readonly name?: string;
  /** Optional self-reported health. */
  readonly status?: ConnectorStatus;
  /** Begin operation. The connector supplies the {@link ConnectorHandle}. */
  start(handle: ConnectorHandle): void | Promise<void>;
  /** Tear down. Called from the gateway extension's `onClose`. */
  stop(): void | Promise<void>;
  /**
   * OPTIONAL. Connector → platform: hand off the agent's output for a
   * completed execution. Omit for a one-way ingress-only connector.
   */
  deliver?(delivery: OutboundDelivery): void | Promise<void>;
  /**
   * OPTIONAL. Connector → platform: present a confirmation/elicitation.
   * Implementing this opts into confirmation routing; omit to skip it.
   */
  presentConfirmation?(prompt: ConfirmationPrompt): void | Promise<void>;
}

// ============================================================================
// defineConnector spec
// ============================================================================

export interface DefineConnectorSpec {
  /** Connector name (diagnostics + extension slot routing). */
  readonly name: string;
  /** The platform adapter this connector drives. */
  readonly platform: ConnectorPlatform;
  /** Behavior config — target app/session + allowlist gate. */
  readonly config?: ConnectorConfig;
}
