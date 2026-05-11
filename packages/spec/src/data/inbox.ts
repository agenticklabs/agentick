/**
 * Inbox envelope types.
 *
 * The inbox is the **inbound** counterpart to the event bus. Wire-safe
 * by construction; routes locally or across the cluster. Same handler
 * signature whether the caller is in-process or on a remote node.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §The MessageInbox
 * @see docs/proposals/v2/blueprint/10-events-handlers-inbox.md §② Inbox
 */

/**
 * Wire-safe envelope for inbound messages addressed to a harness.
 * JSON-serializable. Same shape across local and cluster dispatch.
 */
export interface MessageEnvelope<T = unknown> {
  /**
   * Recipient address — `{surface}:{scopeId}`.
   *   `loop:execution-abc-123`
   *   `session:user-42`
   *   `compiler:mount-xyz`
   *   `supervisor:main`
   */
  readonly addressedTo: string;

  /**
   * Discriminator within the recipient's accepted message set.
   * Each concrete harness declares the message types it accepts.
   */
  readonly type: string;

  /** Optional sender address for response/ack. */
  readonly from?: string;

  /**
   * Idempotency key. Caller-supplied; defaults to system ULID.
   * Same messageId twice → cached result returned (for ask) or
   * ack-only (for tell), with the handler running exactly once.
   */
  readonly messageId: string;

  /** Causality. */
  readonly parentOpId?: string;
  readonly correlationId?: string;

  /** Typed payload (constrained by `type`). */
  readonly payload?: T;

  /** ISO milliseconds since epoch at send time. */
  readonly timestamp: number;
}

/**
 * Acknowledgment shape for `tell`-style sends (fire-and-forget with
 * delivery confirmation).
 */
export interface MessageAck {
  readonly messageId: string;
  /** Recipient timestamp when the message was accepted. */
  readonly receivedAt: number;
}

/**
 * Handler signature for inbox messages.
 *
 * Returns a Promise of the result type (or void for tell-style handlers).
 * Implementations may throw to indicate handler error; the substrate
 * catches and routes to the appropriate error channel.
 *
 * Spec uses Promise as the canonical async return type (zero-dep);
 * implementations using Effect bridge at their handler boundary.
 */
export type MessageHandler<T = unknown, R = unknown> = (
  message: MessageEnvelope<T>,
) => Promise<R>;
