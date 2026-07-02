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

import type { Effect } from "effect";
import type { MessageHandlerError } from "./errors.js";

/**
 * Wire-safe envelope for inbound messages addressed to a harness.
 * JSON-serializable. Same shape across local and cluster dispatch.
 *
 * **Construction:** callers don't build `MessageEnvelope` directly.
 * They pass a {@link MessageEnvelopeInput} to {@link MessageInbox.send} /
 * {@link MessageInbox.ask}; the inbox stamps `addressedTo` (from the
 * `address` arg), `timestamp` (send time), and `messageId` (ULID if not
 * supplied) before handlers see the envelope.
 */
export interface MessageEnvelope<T = unknown> {
  /**
   * Recipient address — `{surface}:{scopeId}`.
   *   `loop:execution-abc-123`
   *   `session:user-42`
   *   `reconciler:mount-xyz`
   *   `supervisor:main`
   *
   * Stamped by the inbox at send-time from the `address` argument.
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
   * Idempotency key. Caller-supplied or system ULID. Same messageId
   * twice → cached result returned (for ask) or ack-only (for tell),
   * with the handler running exactly once.
   */
  readonly messageId: string;

  /** Causality. */
  readonly parentOpId?: string;
  readonly correlationId?: string;

  /**
   * Provenance — the gate that injected this message (ADR 51). Set by
   * gates (the wire resolver stamps `"wire"`, tool dispatch `"model"`);
   * command dispatch defaults absent values to `"inbox"`. Carried onto
   * the resulting operation's scope; facts, never decisions.
   */
  readonly origin?: import("./events.js").OperationOrigin;

  /** Typed payload (constrained by `type`). */
  readonly payload?: T;

  /**
   * Milliseconds since epoch at send time. Stamped by the inbox.
   */
  readonly timestamp: number;
}

/**
 * Caller-supplied input for {@link MessageInbox.send} /
 * {@link MessageInbox.ask}. A subset of {@link MessageEnvelope} omitting
 * the fields the inbox stamps:
 *
 *   - `addressedTo` — derived from the `address` argument
 *   - `timestamp`   — stamped at send time
 *   - `messageId`   — defaults to system ULID when not supplied
 *
 * Caller-required: `type`. Caller-optional: `from`, `parentOpId`,
 * `correlationId`, `payload`, and an explicit `messageId` (for
 * idempotency replay).
 */
export interface MessageEnvelopeInput<T = unknown> {
  readonly type: string;
  readonly messageId?: string;
  readonly from?: string;
  readonly parentOpId?: string;
  readonly correlationId?: string;
  /** Provenance gate for the resulting operation (ADR 51). */
  readonly origin?: import("./events.js").OperationOrigin;
  readonly payload?: T;
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
 * Returns an `Effect` of the result type (or `void` for tell-style
 * handlers). Failures flow through the `E` channel as
 * `MessageHandlerError`; routing-side failures stay separate on the
 * inbox protocol surface.
 *
 * Effect's FiberRef scope, structured concurrency, and finalizers
 * propagate into the handler body automatically.
 */
export type MessageHandler<T = unknown, R = unknown> = (
  message: MessageEnvelope<T>,
) => Effect.Effect<R, MessageHandlerError, never>;
